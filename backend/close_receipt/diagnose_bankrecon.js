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
  // ── columns = field names ──────────────────────────────────────
  console.log('\n=== form.columns ===');
  console.log(JSON.stringify(form.columns, null, 2));

  // ── subforms list ──────────────────────────────────────────────
  console.log('\n=== form.subForms ===');
  console.log(JSON.stringify(form.subForms, null, 2));

  // ── newRow then fieldUpdate to see real field names ────────────
  console.log('\n=== newRow() + fieldUpdate probing ===');
  try {
    const nr = await form.newRow();
    console.log('newRow():', JSON.stringify(nr));

    // Try every plausible field name, log what Priority says
    const candidates = [
      'CASHNAME', 'BOOKNUM', 'BANKNUM', 'BPNUMA', 'FNCNUM',
      'FRST_BOOKNUM', 'SCND_IVNUM', 'RECON', 'RECONNUM',
      'BOOKLINE', 'BANKLINE', 'IVNUM', 'DETAILS',
    ];
    for (const field of candidates) {
      try {
        const r = await form.fieldUpdate(field, 'TEST');
        console.log(`  fieldUpdate(${field}): OK —`, JSON.stringify(r).slice(0, 120));
      } catch (e) {
        console.log(`  fieldUpdate(${field}): ${e.message.slice(0, 80)}`);
      }
    }
    await form.undo().catch(() => {});
  } catch (e) {
    console.log('newRow error:', e.message);
  }

  // ── startSubForm discovery ─────────────────────────────────────
  console.log('\n=== startSubForm discovery ===');
  const sfCandidates = [
    'BANKRECONSP_BANK', 'BANKRECONSP_BOOKS', 'BANKRECONSP_FNCTRANS',
    'BANKRECONLINES', 'BANKRECLINES', 'BANKRECONSP_BANKLINES',
    'BANKRECONSP_BOOKLIST', 'BANKRECONSP_BANKLIST',
    'FNCTRANS', 'BANKLINESA',
  ];
  for (const sf of sfCandidates) {
    try {
      const sub = await form.startSubForm(sf);
      console.log(`  startSubForm(${sf}) OK`);
      if (sub && sub.columns) console.log(`    columns:`, JSON.stringify(sub.columns).slice(0, 300));
      try {
        const sr = await sub.getRows(0);
        const sarr = Array.isArray(sr) ? sr : Object.values(sr || {})[0] || [];
        console.log(`    rows: ${Array.isArray(sarr) ? sarr.length : JSON.stringify(sarr).slice(0,100)}`);
        if (Array.isArray(sarr) && sarr.length > 0)
          console.log(`    Row[0]:`, JSON.stringify(sarr[0]).slice(0, 300));
      } catch (e2) { console.log(`    getRows: ${e2.message}`); }
      await sub.endCurrentForm(false).catch(() => {});
    } catch (e) {
      console.log(`  startSubForm(${sf}): ${e.message.slice(0, 80)}`);
    }
  }

  await form.endCurrentForm(false).catch(() => {});
  console.log('\n=== Done ===');
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
