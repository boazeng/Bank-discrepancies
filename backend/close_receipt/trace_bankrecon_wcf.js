'use strict';
/**
 * Open BANKRECON via WCF — show columns and any existing rows.
 * Then check BANKRECONSP rows.
 * (After OData POST+PATCH created BLINE=1 for USER=19, does WCF see it now?)
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
  const { serviceUrl, tabulaini, company } = parseOdataUrl(process.env.PRIORITY_URL_REAL || process.env.PRIORITY_URL || '');
  await priority.login({ username: process.env.PRIORITY_USERNAME, password: process.env.PRIORITY_PASSWORD,
    url: serviceUrl, tabulaini, language: 1, appname: 'tr-bankrecon-wcf' });
  console.log('Login OK\n');

  // 1. Open BANKRECON — show columns and rows
  console.log('=== formStart BANKRECON ===');
  const br = await wt(priority.formStart('BANKRECON', null, null, company), 20000, 'formStart BANKRECON');
  console.log('Columns:', Object.keys(br.columns || {}).join(', '));
  const brRaw = await wt(br.getRows(0), 20000, 'getRows BANKRECON');
  const brRows = Array.isArray(brRaw) ? brRaw : (Object.values(brRaw || {}).find(v => Array.isArray(v)) || []);
  console.log(`BANKRECON rows: ${brRows.length}`);
  if (brRows.length > 0) {
    console.log('Row[0]:', JSON.stringify(brRows[0], null, 2));
  }
  await br.endCurrentForm(false).catch(() => {});

  // 2. Run NEXTBANKRECON then open BANKRECONSP
  console.log('\n=== NEXTBANKRECON ===');
  let nbr = await wt(priority.procStart('NEXTBANKRECON', 'P', null, company), 15000, 'NBR');
  while (nbr && nbr.type !== 'end' && nbr.type !== 'finished') {
    if (nbr.type === 'message') nbr = await wt(nbr.proc.message(1), 10000, 'NBR.msg');
    else if (nbr.proc?.continueProc) nbr = await wt(nbr.proc.continueProc(), 10000, 'NBR.cont');
    else break;
  }
  console.log('NEXTBANKRECON done');

  console.log('\n=== formStart BANKRECONSP ===');
  const sp = await wt(priority.formStart('BANKRECONSP', null, null, company), 20000, 'formStart BANKRECONSP');
  const spRaw = await wt(sp.getRows(0), 20000, 'getRows BANKRECONSP');
  const spRows = Array.isArray(spRaw) ? spRaw : (Object.values(spRaw || {}).find(v => Array.isArray(v)) || []);
  console.log(`BANKRECONSP rows: ${spRows.length}`);
  if (spRows.length > 0) console.log('Row[0]:', JSON.stringify(spRows[0], null, 2));
  await sp.endCurrentForm(false).catch(() => {});
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
