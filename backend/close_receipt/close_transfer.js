'use strict';
/**
 * Finalize a Priority QINVOICES bank transfer using the Web SDK.
 * Uses procStart('CLOSEQIV') — same pattern as CLOSETIV for receipts.
 *
 * Usage: node close_transfer.js <IVNUM>   e.g. node close_transfer.js T15557
 * Output: JSON to stdout — { ok: true, ivnum, fncnum } or { ok: false, error }
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

function withTimeout(promise, ms, label) {
  const t = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  );
  return Promise.race([promise, t]);
}

async function handleStep(step, internalKey, lastMsg) {
  if (!step) return lastMsg;
  const type = step.type;
  const msg = step.message || '';
  process.stderr.write(`Step type=${type} msg=${msg}\n`);

  if (type === 'inputFields') {
    process.stderr.write(`Providing IV key=${internalKey}...\n`);
    const inputData = { EditFields: [{ field: 1, value: String(internalKey) }] };
    const next = await withTimeout(step.proc.inputFields(1, inputData), 30000, 'proc.inputFields');
    return handleStep(next, internalKey, lastMsg);
  }
  if (type === 'message') {
    process.stderr.write(`Confirming message: ${msg}\n`);
    const next = await withTimeout(step.proc.message(1), 30000, 'proc.message');
    return handleStep(next, internalKey, msg);
  }
  if (type === 'end' || type === 'finished') {
    process.stderr.write('Procedure finished\n');
    return lastMsg;
  }
  if (step.proc && step.proc.continueProc) {
    const next = await withTimeout(step.proc.continueProc(), 30000, 'proc.continueProc');
    return handleStep(next, internalKey, lastMsg);
  }
  throw new Error(`Unhandled procedure step: ${type}`);
}

async function main() {
  const ivnum = process.argv[2];
  if (!ivnum) throw new Error('Usage: node close_transfer.js <IVNUM>');

  const odataUrl = process.env.PRIORITY_URL_REAL || process.env.PRIORITY_URL || '';
  const { odataBase, serviceUrl, tabulaini, company } = parseOdataUrl(odataUrl);
  const user = process.env.PRIORITY_USERNAME;
  const pass = process.env.PRIORITY_PASSWORD;
  const authHeader = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

  // Step 1: Fetch QINVOICES record — get IV (internal key), FINAL, FNCNUM
  process.stderr.write(`Fetching QINVOICES for ${ivnum}...\n`);
  const qKey = `IVNUM='${ivnum}',IVTYPE='Q',DEBIT='D'`;
  const r = await fetch(
    `${odataBase}/QINVOICES(${qKey})?$select=IV,IVNUM,FINAL,FNCNUM`,
    { headers: { Authorization: authHeader, Accept: 'application/json' } }
  );
  if (!r.ok) throw new Error(`QINVOICES lookup failed: HTTP ${r.status} — ${await r.text().catch(() => '')}`);
  const entry = await r.json();
  if (!entry.IV) throw new Error(`QINVOICES ${ivnum} not found in Priority`);
  const internalKey = entry.IV;
  process.stderr.write(`QINVOICES IV=${internalKey} FINAL=${entry.FINAL} FNCNUM=${entry.FNCNUM}\n`);

  if (entry.FINAL === 'Y') {
    const fncnum = entry.FNCNUM || ivnum;
    process.stdout.write(JSON.stringify({ ok: true, ivnum, fncnum, already_final: true }));
    return;
  }

  // Step 2: Login via Web SDK
  process.stderr.write(`Login -> ${serviceUrl} (${company})\n`);
  await priority.login({
    username: user, password: pass,
    url: serviceUrl, tabulaini,
    language: 1, appname: 'TACT-Transfers',
  });
  process.stderr.write('Login OK\n');

  // Step 3: procStart CLOSEQIV
  process.stderr.write('procStart CLOSEQIV...\n');
  const firstStep = await withTimeout(
    priority.procStart('CLOSEQIV', 'P', null, company),
    30000, 'procStart'
  );
  const procMsg = await handleStep(firstStep, internalKey, null);
  process.stderr.write('CLOSEQIV completed\n');

  const isFailure = procMsg && /לא ניתן|שגיאה|error/i.test(procMsg);
  if (isFailure) {
    throw new Error(`CLOSEQIV לא אישר את ההעברה: ${procMsg}`);
  }

  // Step 4: Look up by IV (internal key) — survives IVNUM rename after finalization
  await new Promise(resolve => setTimeout(resolve, 2000));
  let final_ivnum = ivnum;
  let fncnum = ivnum;
  try {
    const r2 = await fetch(
      `${odataBase}/QINVOICES?$filter=IV eq ${internalKey}&$select=IVNUM,FNCNUM,FINAL`,
      { headers: { Authorization: authHeader, Accept: 'application/json' } }
    );
    if (r2.ok) {
      const d2 = await r2.json();
      const rec2 = (d2.value && d2.value[0]) || d2;
      if (rec2.IVNUM) final_ivnum = rec2.IVNUM;
      if (rec2.FNCNUM && !rec2.FNCNUM.startsWith('T')) fncnum = rec2.FNCNUM;
    }
  } catch (e) {
    process.stderr.write(`Post-close lookup failed (non-fatal): ${e.message}\n`);
  }
  process.stderr.write(`Final IVNUM: ${final_ivnum}, FNCNUM: ${fncnum}\n`);

  process.stdout.write(JSON.stringify({ ok: true, ivnum, final_ivnum, fncnum }));
}

main().catch(err => {
  process.stderr.write('ERROR: ' + (err.message || String(err)) + '\n');
  process.stdout.write(JSON.stringify({ ok: false, error: err.message || String(err) }));
  process.exit(1);
});
