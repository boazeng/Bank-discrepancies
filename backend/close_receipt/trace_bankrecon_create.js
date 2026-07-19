'use strict';
/**
 * Try to create a reconciliation record via WCF formStart('BANKRECON') + newRow.
 * The OData BANKRECON row (USER=19,BLINE=1,CASHNAME='111-201') was set up earlier.
 * Now we test if WCF saveRow works.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const priority = require('priority-web-sdk');

function parseOdataUrl(odataUrl) {
  const url = (odataUrl || '').replace(/\/$/, '');
  const m = url.match(/^(https?:\/\/[^\/]+)\/odata\/Priority\/([^\/]+)\/(.+)$/);
  if (!m) throw new Error('Cannot parse: ' + url);
  const [, base, tabulaini, company] = m;
  return { serviceUrl: base + '/wcf/service.svc', tabulaini, company };
}
function wt(p, ms, l) {
  return Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error(l + ' timeout')), ms))]);
}

async function main() {
  const fncnum  = process.argv[2] || '26010805';
  const booknum = process.argv[3] || '2';         // BPNUMA
  const amount  = parseFloat(process.argv[4] || '23600');
  const cashname = '111-201';

  const { serviceUrl, tabulaini, company } = parseOdataUrl(process.env.PRIORITY_URL_REAL || process.env.PRIORITY_URL || '');
  await priority.login({ username: process.env.PRIORITY_USERNAME, password: process.env.PRIORITY_PASSWORD,
    url: serviceUrl, tabulaini, language: 1, appname: 'tr-br-create' });
  console.log('Login OK\n');

  // Open BANKRECON form and try to create a reconciliation record
  console.log('=== formStart BANKRECON ===');
  const br = await wt(priority.formStart('BANKRECON', null, null, company), 20000, 'formStart');
  console.log('Columns:', Object.keys(br.columns || {}).join(', '));

  console.log('\n=== getRows(0) — existing records ===');
  const raw = await wt(br.getRows(0), 15000, 'getRows');
  const rows = Array.isArray(raw) ? raw : (Object.values(raw || {}).find(v => Array.isArray(v)) || []);
  console.log(`Existing rows: ${rows.length}`);

  console.log('\n=== newRow ===');
  const nr = await wt(br.newRow(), 15000, 'newRow');
  console.log('newRow result:', JSON.stringify(nr));

  const updates = [
    ['CASHNAME', cashname],
    ['FNCNUM',   fncnum],
    ['BOOKNUM',  booknum],
    ['BANKSUM',  amount],
    ['BOOKSUM',  amount],
  ];
  for (const [field, val] of updates) {
    try {
      const res = await wt(br.fieldUpdate(field, val), 10000, `fieldUpdate ${field}`);
      console.log(`fieldUpdate(${field}, ${val}):`, JSON.stringify(res));
    } catch (e) {
      console.log(`fieldUpdate(${field}) FAILED:`, e.message);
    }
  }

  console.log('\n=== saveRow(0) ===');
  try {
    const sr = await wt(br.saveRow(0), 20000, 'saveRow');
    console.log('saveRow result:', JSON.stringify(sr));

    // Check if BANKLINESA ERECONNUM updated
    console.log('\n=== Check BANKLINESA(16426,84) ERECONNUM ===');
    const base = (process.env.PRIORITY_URL_REAL || process.env.PRIORITY_URL || '').replace(/\/$/, '');
    const auth = 'Basic ' + Buffer.from(`${process.env.PRIORITY_USERNAME}:${process.env.PRIORITY_PASSWORD}`).toString('base64');
    const r = await fetch(`${base}/BANKLINESA(BANKPAGE=16426,KLINE=84)?$select=ERECONNUM`, { headers: { Authorization: auth, Accept: 'application/json', 'OData-Version': '4.0' } });
    const d = await r.json();
    console.log('ERECONNUM:', d.ERECONNUM);
  } catch (e) {
    console.log('saveRow FAILED:', e.message);
  }

  await br.endCurrentForm(false).catch(() => {});
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
