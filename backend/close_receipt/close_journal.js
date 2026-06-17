'use strict';
/**
 * Register a Priority draft journal entry (FNCTRANS) using the Web SDK.
 * Uses procStart('CLOSEANFNCTRANS') — standalone procedure like CLOSETIV for receipts.
 * The entry must be a DRAFT (not already FINAL='Y' via OData PATCH).
 *
 * Usage: node close_journal.js <FNCNUM>   e.g. node close_journal.js T127760
 * Output: JSON to stdout — { ok: true, fncnum, final_fncnum } or { ok: false, error }
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

async function handleStep(step, internalKey, fncnum, lastMsg) {
  if (!step) return lastMsg;
  const type = step.type;
  const msg = step.message || '';
  process.stderr.write(`Step type=${type} msg=${msg}\n`);

  if (type === 'inputFields') {
    process.stderr.write(`Providing FNCTRANS key=${internalKey}...\n`);
    const inputData = { EditFields: [{ field: 1, value: String(internalKey) }] };
    const next = await withTimeout(step.proc.inputFields(1, inputData), 30000, 'proc.inputFields');
    return handleStep(next, internalKey, fncnum, lastMsg);
  }
  if (type === 'message') {
    process.stderr.write(`Confirming message: ${msg}\n`);
    const next = await withTimeout(step.proc.message(1), 30000, 'proc.message');
    return handleStep(next, internalKey, fncnum, msg);
  }
  if (type === 'end' || type === 'finished') {
    process.stderr.write('Procedure finished\n');
    return lastMsg;
  }
  if (step.proc && step.proc.continueProc) {
    const next = await withTimeout(step.proc.continueProc(), 30000, 'proc.continueProc');
    return handleStep(next, internalKey, fncnum, lastMsg);
  }
  throw new Error(`Unhandled procedure step: ${type}`);
}

async function main() {
  const fncnum = process.argv[2];
  if (!fncnum) throw new Error('Usage: node close_journal.js <FNCNUM>');

  const odataUrl = process.env.PRIORITY_URL_REAL || process.env.PRIORITY_URL || '';
  const { odataBase, serviceUrl, tabulaini, company } = parseOdataUrl(odataUrl);
  const user = process.env.PRIORITY_USERNAME;
  const pass = process.env.PRIORITY_PASSWORD;
  const authHeader = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

  // Step 1: Fetch internal FNCTRANS numeric key and verify it's a draft
  // Use direct key lookup (FNCTRANS filter by FNCNUM string doesn't work in Priority OData)
  process.stderr.write(`Fetching FNCTRANS record for ${fncnum}...\n`);
  const r = await fetch(
    `${odataBase}/FNCTRANS('${fncnum}')?$select=FNCTRANS,FNCNUM,FINAL`,
    { headers: { Authorization: authHeader, Accept: 'application/json' } }
  );
  if (!r.ok) throw new Error(`OData FNCTRANS lookup failed: HTTP ${r.status} — ${await r.text().catch(() => '')}`);
  const entry = await r.json();
  if (!entry.FNCTRANS) throw new Error(`FNCTRANS ${fncnum} not found in Priority`);
  const internalKey = entry.FNCTRANS;
  process.stderr.write(`FNCTRANS internal key=${internalKey} FINAL=${entry.FINAL}\n`);
  if (entry.FINAL === 'Y') {
    throw new Error(`תנועה ${fncnum} כבר רשומה כסופית בפריוריטי (FINAL=Y) — לא ניתן לרשום שוב`);
  }

  // Step 2: Login via Web SDK
  process.stderr.write(`Login -> ${serviceUrl} (${company})\n`);
  await priority.login({
    username: user, password: pass,
    url: serviceUrl, tabulaini,
    language: 1, appname: 'TACT-Journals',
  });
  process.stderr.write('Login OK\n');

  // Step 3: procStart CLOSEANFNCTRANS (standalone, like CLOSETIV for receipts)
  process.stderr.write('procStart CLOSEANFNCTRANS...\n');
  const firstStep = await withTimeout(
    priority.procStart('CLOSEANFNCTRANS', 'P', null, company),
    30000, 'procStart'
  );
  const procMsg = await handleStep(firstStep, internalKey, fncnum, null);
  process.stderr.write('CLOSEANFNCTRANS completed\n');

  // Failure detection: if the Priority message contains "לא ניתן" it's an explicit rejection
  const isFailure = procMsg && /לא ניתן|שגיאה|error/i.test(procMsg);
  if (isFailure) {
    throw new Error(`CLOSEANFNCTRANS לא רשם את הפקודה: ${procMsg}`);
  }

  // Step 4: Find the resulting sequential FNCNUM by internal key (after registration Priority creates a new record)
  await new Promise(resolve => setTimeout(resolve, 2000));
  let finalFncnum = fncnum;
  try {
    // Search for the registered (FINAL='Y') entry by internal numeric key
    const r2 = await fetch(
      `${odataBase}/FNCTRANS?$filter=FNCTRANS eq ${internalKey} and FINAL eq 'Y'&$select=FNCNUM,FINAL&$top=1`,
      { headers: { Authorization: authHeader, Accept: 'application/json' } }
    );
    if (r2.ok) {
      const d2 = await r2.json();
      const found = (d2.value || [])[0];
      if (found && found.FNCNUM && !found.FNCNUM.startsWith('T')) {
        finalFncnum = found.FNCNUM;
      }
    }
  } catch (e) {
    process.stderr.write(`Post-close fetch failed (non-fatal): ${e.message}\n`);
  }
  process.stderr.write(`Final FNCNUM: ${finalFncnum}\n`);

  process.stdout.write(JSON.stringify({ ok: true, fncnum, final_fncnum: finalFncnum }));
}

main().catch(err => {
  process.stderr.write('ERROR: ' + (err.message || String(err)) + '\n');
  process.stdout.write(JSON.stringify({ ok: false, error: err.message || String(err) }));
  process.exit(1);
});
