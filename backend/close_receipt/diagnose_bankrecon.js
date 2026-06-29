'use strict';
/**
 * Diagnostic: open BANKRECONSP and dump everything Priority returns.
 * Usage: node diagnose_bankrecon.js <cashname> [bpnuma] [fncnum]
 * Example: node diagnose_bankrecon.js 10-14 123456 987654
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const priority = require('priority-web-sdk');

function parseOdataUrl(odataUrl) {
  const url = (odataUrl || '').replace(/\/$/, '');
  const m = url.match(/^(https?:\/\/[^\/]+)\/odata\/Priority\/([^\/]+)\/(.+)$/);
  if (!m) throw new Error('Cannot parse Priority URL: ' + url);
  const [, base, tabulaini, company] = m;
  return { serviceUrl: base + '/wcf/service.svc', tabulaini, company };
}

async function main() {
  const cashname = (process.argv[2] || '').trim();
  const bpnuma   = (process.argv[3] || '').trim();
  const fncnum   = (process.argv[4] || '').trim();

  const odataUrl = process.env.PRIORITY_URL_REAL || process.env.PRIORITY_URL || '';
  const { serviceUrl, tabulaini, company } = parseOdataUrl(odataUrl);

  console.log(`=== Login → ${serviceUrl} (${company}) ===`);
  await priority.login({
    username: process.env.PRIORITY_USERNAME,
    password: process.env.PRIORITY_PASSWORD,
    url: serviceUrl, tabulaini, language: 1, appname: 'diagnose',
  });
  console.log('Login OK\n');

  console.log('=== formStart BANKRECONSP ===');
  const form = await priority.formStart('BANKRECONSP', null, null, company);
  console.log('Form object keys:', Object.keys(form || {}));

  // ── dump current rows ──────────────────────────────────────────
  console.log('\n=== getRows(0) ===');
  try {
    const rows = await form.getRows(0);
    console.log('Type:', typeof rows, Array.isArray(rows) ? 'array' : '');
    console.log('Top-level keys:', Object.keys(rows || {}));
    const arr = Array.isArray(rows) ? rows : (rows?.Rows || rows?.rows || rows?.value || []);
    console.log('Row count:', arr.length);
    arr.slice(0, 5).forEach((r, i) => {
      console.log(`\nRow[${i}]:`, JSON.stringify(r, null, 2));
    });
  } catch (e) {
    console.log('getRows error:', e.message);
  }

  // ── try activating row 0 to see its fields ────────────────────
  console.log('\n=== activateRow(0) ===');
  try {
    const ar = await form.activateRow(0);
    console.log('activateRow(0):', JSON.stringify(ar, null, 2).slice(0, 1000));
  } catch (e) {
    console.log('activateRow(0) error:', e.message);
  }

  // ── try newRow to see what fields Priority expects ─────────────
  console.log('\n=== newRow() ===');
  try {
    const nr = await form.newRow();
    console.log('newRow():', JSON.stringify(nr, null, 2).slice(0, 1000));
    await form.undo().catch(() => {});
  } catch (e) {
    console.log('newRow() error:', e.message);
    await form.undo().catch(() => {});
  }

  // ── list available subforms ────────────────────────────────────
  console.log('\n=== openForm (subform discovery) ===');
  const subformCandidates = [
    'BANKRECONSP_BANK', 'BANKRECONSP_BOOKS', 'BANKRECONSP_FNCTRANS',
    'BANKRECONLINES', 'BANKRECLINES', 'BANKRECONSP_BANKLINES',
    'BANKRECONSP_BOOKLIST', 'BANKRECONSP_BANKLIST',
  ];
  for (const sf of subformCandidates) {
    try {
      const sub = await form.openForm(sf);
      console.log(`  openForm(${sf}) OK — keys:`, Object.keys(sub || {}));
      try {
        const sr = await sub.getRows(0);
        const sarr = Array.isArray(sr) ? sr : (sr?.Rows || sr?.rows || sr?.value || []);
        console.log(`    rows: ${sarr.length}`);
        if (sarr.length > 0) console.log(`    Row[0]:`, JSON.stringify(sarr[0]).slice(0, 300));
      } catch (e2) { console.log(`    getRows: ${e2.message}`); }
      await sub.endCurrentForm(false).catch(() => {});
    } catch (e) {
      console.log(`  openForm(${sf}): ${e.message}`);
    }
  }

  await form.endCurrentForm(false).catch(() => {});
  console.log('\n=== Done ===');
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
