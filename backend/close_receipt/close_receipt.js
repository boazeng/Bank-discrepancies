'use strict';
/**
 * Close a Priority receipt draft using the Web SDK (CLOSETIV procedure).
 *
 * Flow:
 *  1. Fetch internal IV number from Priority OData by IVNUM
 *  2. Login via Web SDK
 *  3. procStart('CLOSETIV') → loop over steps until 'end'
 *  4. After close: fetch final RC ivnum + journal FNCNUM
 *
 * Usage: node close_receipt.js <IVNUM>
 * Output (stdout): { ok: true, ivnum, iv, fncnum, rc_ivnum } or { ok: false, error }
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

function basicAuth() {
  const user = process.env.PRIORITY_USERNAME;
  const pass = process.env.PRIORITY_PASSWORD;
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

async function fetchIV(odataBase, ivnum) {
  const auth = basicAuth();
  const keyUrl = `${odataBase}/TINVOICES(IVNUM='${ivnum}',IVTYPE='T',DEBIT='D')?$select=IV,IVNUM,FINAL,TOTPRICE,STATDES`;
  const keyResp = await fetch(keyUrl, { headers: { Authorization: auth, Accept: 'application/json' } });

  let data;
  if (keyResp.ok) {
    data = await keyResp.json();
  } else {
    const filterUrl = `${odataBase}/TINVOICES?$filter=IVNUM eq '${ivnum}'&$select=IV,IVNUM,FINAL,TOTPRICE,STATDES,IVTYPE,DEBIT&$top=1`;
    const filterResp = await fetch(filterUrl, { headers: { Authorization: auth, Accept: 'application/json' } });
    if (!filterResp.ok) throw new Error(`קבלה ${ivnum} לא נמצאה בפריוריטי (HTTP ${filterResp.status})`);
    const items = (await filterResp.json()).value || [];
    if (!items.length) throw new Error(`קבלה ${ivnum} לא קיימת בפריוריטי`);
    data = items[0];
  }

  if (!data.IV) throw new Error(`שדה IV לא נמצא עבור ${ivnum}`);
  return { iv: data.IV, final: data.FINAL, status: data.STATDES, total: data.TOTPRICE };
}

function withTimeout(promise, ms, label) {
  const t = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  );
  return Promise.race([promise, t]);
}

async function runClosetiv(iv, ivnum, company) {
  process.stderr.write('procStart CLOSETIV...\n');
  let pd = await withTimeout(priority.procStart('CLOSETIV', 'P', null, company), 30000, 'procStart');

  for (let i = 0; i < 50; i++) {
    process.stderr.write(`Step ${i}: type=${pd.type} message=${pd.message || ''}\n`);

    switch (pd.type) {

      case 'inputFields': {
        // CLOSETIV expects the internal IV number in field 1
        const fields = pd.input.EditFields.map(f => ({
          field:  f.field,
          op:     0,
          value:  f.field === 1 ? String(iv) : (f.value || ''),
          op2:    0,
          value2: '',
        }));
        process.stderr.write(`inputFields: providing IV=${iv}\n`);
        pd = await withTimeout(pd.proc.inputFields(1, { EditFields: fields }), 30000, 'inputFields');
        break;
      }

      case 'choose': {
        process.stderr.write(`choose: ${JSON.stringify(pd.Choose)}\n`);
        pd = await withTimeout(pd.proc.choose(1, pd.Choose[0].key), 30000, 'choose');
        break;
      }

      case 'message': {
        process.stderr.write(`message: ${pd.message}\n`);
        pd = await withTimeout(pd.proc.message(1), 30000, 'message');
        break;
      }

      case 'client': {
        pd = await withTimeout(pd.proc.continueProc(), 30000, 'continueProc');
        break;
      }

      case 'documentOptions': {
        pd = await withTimeout(pd.proc.documentOptions(1, pd.formats[0].format, 1), 30000, 'documentOptions');
        break;
      }

      case 'reportOptions': {
        pd = await withTimeout(pd.proc.reportOptions(1, pd.formats[0].format), 30000, 'reportOptions');
        break;
      }

      case 'displayUrl': {
        // CLOSETIV shouldn't produce a document, but handle gracefully
        process.stderr.write('displayUrl (unexpected for CLOSETIV) — continuing\n');
        return;
      }

      case 'end':
      case 'finished': {
        process.stderr.write('CLOSETIV completed\n');
        return;
      }

      default: {
        process.stderr.write(`Unknown step "${pd.type}" — trying continueProc\n`);
        if (pd.proc && pd.proc.continueProc) {
          pd = await withTimeout(pd.proc.continueProc(), 30000, 'continueProc');
        } else {
          throw new Error('Unhandled procedure step: ' + pd.type);
        }
      }
    }
  }

  throw new Error('CLOSETIV: too many steps (> 50)');
}

async function fetchPostClose(odataBase, ivnum) {
  const auth = basicAuth();
  await new Promise(r => setTimeout(r, 1500));  // give Priority time to commit

  let fncnum = null;
  let rcIvnum = null;

  try {
    const draftUrl = `${odataBase}/TINVOICES?$filter=IVNUM eq '${ivnum}'&$select=IVNUM,FNCNUM,FINAL&$top=1`;
    const dr = await fetch(draftUrl, { headers: { Authorization: auth, Accept: 'application/json' } });
    if (dr.ok) {
      const draft = ((await dr.json()).value || [])[0];
      if (draft) fncnum = draft.FNCNUM || null;
    }

    if (fncnum) {
      const rcUrl = `${odataBase}/TINVOICES?$filter=FNCNUM eq '${fncnum}' and FINAL eq 'Y'&$select=IVNUM,FNCNUM&$top=5`;
      const rr = await fetch(rcUrl, { headers: { Authorization: auth, Accept: 'application/json' } });
      if (rr.ok) {
        const items = ((await rr.json()).value || []).filter(x => x.IVNUM !== ivnum);
        if (items.length) rcIvnum = items[0].IVNUM;
      }
    }
  } catch (e) {
    process.stderr.write(`Post-close fetch failed (non-fatal): ${e.message}\n`);
  }

  process.stderr.write(`Post-close: fncnum=${fncnum} rc=${rcIvnum}\n`);
  return { fncnum, rcIvnum };
}

async function main() {
  const ivnum = process.argv[2];
  if (!ivnum) throw new Error('Usage: node close_receipt.js <IVNUM>');

  const odataUrl = process.env.PRIORITY_URL_REAL || process.env.PRIORITY_URL || '';
  const { odataBase, serviceUrl, tabulaini, company } = parseOdataUrl(odataUrl);

  process.stderr.write(`Fetching IV for ${ivnum}...\n`);
  const { iv, final, status, total } = await fetchIV(odataBase, ivnum);
  process.stderr.write(`IV=${iv} | FINAL=${final || 'draft'} | STATUS=${status} | TOTAL=${total}\n`);
  if (final === 'Y') {
    process.stderr.write(`Receipt ${ivnum} already FINAL=Y — looking up existing final numbers\n`);
    // Fetch FNCNUM from the record (not included in fetchIV — re-query)
    let existingFncnum = null;
    let existingRcIvnum = null;
    try {
      const fncResp = await fetch(
        `${odataBase}/TINVOICES?$filter=IVNUM eq '${ivnum}'&$select=IVNUM,FNCNUM,FINAL&$top=1`,
        { headers: { Authorization: basicAuth(), Accept: 'application/json' } }
      );
      if (fncResp.ok) {
        const items = (await fncResp.json()).value || [];
        if (items.length) existingFncnum = items[0].FNCNUM || null;
      }
    } catch (e) {
      process.stderr.write(`FNCNUM lookup failed: ${e.message}\n`);
    }
    if (existingFncnum) {
      try {
        const rcResp = await fetch(
          `${odataBase}/TINVOICES?$filter=FNCNUM eq '${existingFncnum}' and FINAL eq 'Y'&$select=IVNUM,FNCNUM&$top=5`,
          { headers: { Authorization: basicAuth(), Accept: 'application/json' } }
        );
        if (rcResp.ok) {
          const rcItems = (await rcResp.json()).value || [];
          const rc = rcItems.find(x => x.IVNUM !== ivnum && !x.IVNUM.startsWith('T'));
          if (rc) existingRcIvnum = rc.IVNUM;
        }
      } catch (e) {
        process.stderr.write(`RC lookup failed: ${e.message}\n`);
      }
    }
    if (!existingRcIvnum) existingRcIvnum = ivnum;
    process.stdout.write(JSON.stringify({ ok: true, ivnum, iv, fncnum: existingFncnum, rc_ivnum: existingRcIvnum, already_final: true }));
    return;
  }

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

  await runClosetiv(iv, ivnum, company);

  const { fncnum, rcIvnum } = await fetchPostClose(odataBase, ivnum);

  process.stdout.write(JSON.stringify({ ok: true, ivnum, iv, fncnum, rc_ivnum: rcIvnum }));
}

main().catch(err => {
  process.stderr.write('ERROR: ' + (err.message || String(err)) + '\n');
  process.stdout.write(JSON.stringify({ ok: false, error: err.message || String(err) }));
  process.exit(1);
});
