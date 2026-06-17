'use strict';
/**
 * Close a Priority receipt draft using the Web SDK (CLOSETIV procedure).
 *
 * CLOSETIV expects one input: the internal numeric IV (not the IVNUM string).
 * Flow:
 *  1. Fetch IV from Priority OData REST API by IVNUM
 *  2. Login via Web SDK (WCF service)
 *  3. procStart('CLOSETIV') → inputFields step
 *  4. Provide IV → procedure runs → receipt closed + journal entry created
 *
 * Usage: node close_receipt.js <IVNUM>   e.g.  node close_receipt.js T12344
 * Output: JSON to stdout — { ok: true, ivnum, iv } or { ok: false, error }
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const priority = require('priority-web-sdk');

function parseOdataUrl(odataUrl) {
  const url = (odataUrl || '').replace(/\/$/, '');
  const match = url.match(/^(https?:\/\/[^\/]+)\/odata\/Priority\/([^\/]+)\/(.+)$/);
  if (!match) throw new Error('Cannot parse Priority URL: ' + url);
  const [, base, tabulaini, company] = match;
  return { odataBase: url, serviceUrl: base + '/wcf/service.svc', tabulaini, company };
}

async function fetchIV(odataBase, ivnum) {
  const user = process.env.PRIORITY_USERNAME;
  const pass = process.env.PRIORITY_PASSWORD;
  const auth = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

  // Try key-based lookup first (draft receipts: IVTYPE='T', DEBIT='D')
  // If that returns 404, fall back to filter-based search (handles already-closed or re-keyed receipts)
  const keyUrl = `${odataBase}/TINVOICES(IVNUM='${ivnum}',IVTYPE='T',DEBIT='D')?$select=IV,IVNUM,FINAL,TOTPRICE,STATDES`;
  const keyResp = await fetch(keyUrl, { headers: { Authorization: auth, Accept: 'application/json' } });

  let data;
  if (keyResp.ok) {
    data = await keyResp.json();
  } else {
    // Fall back: search by IVNUM without assuming IVTYPE/DEBIT
    const filterUrl = `${odataBase}/TINVOICES?$filter=IVNUM eq '${ivnum}'&$select=IV,IVNUM,FINAL,TOTPRICE,STATDES,IVTYPE,DEBIT&$top=1`;
    const filterResp = await fetch(filterUrl, { headers: { Authorization: auth, Accept: 'application/json' } });
    if (!filterResp.ok) throw new Error(`קבלה ${ivnum} לא נמצאה בפריוריטי (HTTP ${filterResp.status}). ייתכן שבוטלה — מחק אותה ממערכת TACT.`);
    const filterData = await filterResp.json();
    const items = filterData.value || [];
    if (!items.length) throw new Error(`קבלה ${ivnum} לא קיימת בפריוריטי. ייתכן שבוטלה — מחק אותה ממערכת TACT.`);
    data = items[0];
  }

  if (!data.IV) throw new Error(`שדה IV לא נמצא עבור ${ivnum} — האם זו טיוטת קבלה תקינה?`);
  return { iv: data.IV, final: data.FINAL, status: data.STATDES, total: data.TOTPRICE };
}

function withTimeout(promise, ms, label) {
  const t = new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms));
  return Promise.race([promise, t]);
}

async function handleStep(step, iv, ivnum) {
  if (!step) return;
  const type = step.type;
  process.stderr.write(`Step: type=${type} message=${step.message || ''}\n`);

  if (type === 'inputFields') {
    // Provide the internal IV as the answer to field 1
    // Format: { EditFields: [{ field: <fieldId>, value: <string> }] }
    process.stderr.write(`Providing IV=${iv} to CLOSETIV...\n`);
    const inputData = { EditFields: [{ field: 1, value: String(iv) }] };
    const next = await withTimeout(step.proc.inputFields(1, inputData), 30000, 'proc.inputFields');
    return handleStep(next, iv, ivnum);
  }
  if (type === 'message') {
    process.stderr.write(`Confirming message: ${step.message}\n`);
    const next = await withTimeout(step.proc.message(1), 30000, 'proc.message');
    return handleStep(next, iv, ivnum);
  }
  if (type === 'end' || type === 'finished') {
    process.stderr.write('Procedure finished successfully\n');
    return;
  }
  // Any other step — try to continue
  process.stderr.write(`Unhandled step type "${type}" — attempting continueProc\n`);
  if (step.proc && step.proc.continueProc) {
    const next = await withTimeout(step.proc.continueProc(), 30000, 'proc.continueProc');
    return handleStep(next, iv, ivnum);
  }
  throw new Error(`Unhandled procedure step: ${type}`);
}

async function main() {
  const ivnum = process.argv[2];
  if (!ivnum) throw new Error('Usage: node close_receipt.js <IVNUM>');

  const odataUrl = process.env.PRIORITY_URL_REAL || process.env.PRIORITY_URL || '';
  const { odataBase, serviceUrl, tabulaini, company } = parseOdataUrl(odataUrl);

  // Step 1: Get internal IV from OData
  process.stderr.write(`Fetching IV for ${ivnum}...\n`);
  const { iv, final, status, total } = await fetchIV(odataBase, ivnum);
  process.stderr.write(`IV=${iv} | FINAL=${final || 'draft'} | STATUS=${status} | TOTAL=${total}\n`);
  if (final === 'Y') throw new Error(`Receipt ${ivnum} is already final (FINAL=Y)`);

  // Step 2: Login via Web SDK
  process.stderr.write(`Login → ${serviceUrl} (${company})\n`);
  await priority.login({
    username:  process.env.PRIORITY_USERNAME,
    password:  process.env.PRIORITY_PASSWORD,
    url:       serviceUrl,
    tabulaini,
    language:  1,
    appname:   'TACT-Receipts',
  });
  process.stderr.write('Login OK\n');

  // Step 3: Start CLOSETIV and handle steps
  process.stderr.write('procStart CLOSETIV...\n');
  const firstStep = await withTimeout(priority.procStart('CLOSETIV', 'P', null, company), 30000, 'procStart');
  await handleStep(firstStep, iv, ivnum);
  process.stderr.write('CLOSETIV completed\n');

  // After CLOSETIV, fetch updated receipt data — get FNCNUM (journal entry) and RC number
  let rcIvnum = null;
  let fncnum = null;
  try {
    const auth2 = 'Basic ' + Buffer.from(`${process.env.PRIORITY_USERNAME}:${process.env.PRIORITY_PASSWORD}`).toString('base64');
    // Give Priority a moment to commit the journal entry
    await new Promise(r => setTimeout(r, 1500));

    // 1. Re-fetch the original draft to get its FNCNUM
    const draftUrl = `${odataBase}/TINVOICES?$filter=IVNUM eq '${ivnum}'&$select=IVNUM,FNCNUM,FINAL,STATDES&$top=1`;
    const dr = await fetch(draftUrl, { headers: { Authorization: auth2, Accept: 'application/json' } });
    if (dr.ok) {
      const draftData = await dr.json();
      const draft = (draftData.value || [])[0];
      if (draft) fncnum = draft.FNCNUM || null;
    }

    // 2. If we have FNCNUM, find the RC receipt with the same journal entry
    if (fncnum) {
      const rcUrl = `${odataBase}/TINVOICES?$filter=FNCNUM eq '${fncnum}' and FINAL eq 'Y'&$select=IVNUM,FNCNUM,FINAL,STATDES&$top=5`;
      const rr = await fetch(rcUrl, { headers: { Authorization: auth2, Accept: 'application/json' } });
      if (rr.ok) {
        const rcData = await rr.json();
        const items = (rcData.value || []).filter(x => x.IVNUM !== ivnum);
        if (items.length) rcIvnum = items[0].IVNUM;
      }
    }
    process.stderr.write(`Post-close: fncnum=${fncnum} rc=${rcIvnum}\n`);
  } catch (e) {
    process.stderr.write(`Post-close fetch failed (non-fatal): ${e.message}\n`);
  }

  process.stdout.write(JSON.stringify({ ok: true, ivnum, iv, fncnum, rc_ivnum: rcIvnum }));
}

main().catch(err => {
  process.stderr.write('ERROR: ' + (err.message || String(err)) + '\n');
  process.stdout.write(JSON.stringify({ ok: false, error: err.message || String(err) }));
  process.exit(1);
});
