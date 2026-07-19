'use strict';
/**
 * Direct test: does WCF BANKRECON saveRow actually set BANKLINESA.ERECONNUM?
 * Using unreconciled entry: BANKPAGE=16495, KLINE=21, BPNUMA='260716', DEBIT=2.70
 * (no FNCNUM — test bank-side only)
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const priority = require('priority-web-sdk');

function parseOdataUrl(odataUrl) {
  const url = (odataUrl || '').replace(/\/$/, '');
  const m = url.match(/^(https?:\/\/[^\/]+)\/odata\/Priority\/([^\/]+)\/(.+)$/);
  if (!m) throw new Error('Cannot parse: ' + url);
  const [, base, tabulaini, company] = m;
  return { odataBase: url, serviceUrl: base + '/wcf/service.svc', tabulaini, company };
}
function wt(p, ms, l) {
  return Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error(l + ' timeout')), ms))]);
}

async function main() {
  const BANKPAGE = 16495, KLINE = 21, BPNUMA = '260716', AMOUNT = 2.70;

  const { odataBase, serviceUrl, tabulaini, company } = parseOdataUrl(process.env.PRIORITY_URL_REAL || process.env.PRIORITY_URL || '');
  const auth = 'Basic ' + Buffer.from(`${process.env.PRIORITY_USERNAME}:${process.env.PRIORITY_PASSWORD}`).toString('base64');
  const rh = { Authorization: auth, Accept: 'application/json', 'OData-Version': '4.0' };
  const wh = { ...rh, 'Content-Type': 'application/json' };

  // Check ERECONNUM before
  const before = await (await fetch(`${odataBase}/BANKLINESA(BANKPAGE=${BANKPAGE},KLINE=${KLINE})?$select=ERECONNUM`, { headers: rh })).json();
  console.log(`BEFORE: BANKLINESA(${BANKPAGE},${KLINE}) ERECONNUM=${before.ERECONNUM}`);
  if (before.ERECONNUM > 0) { console.log('Already reconciled — pick different entry'); return; }

  // Init BANKRECON user context via OData
  await fetch(`${odataBase}/BANKRECON(USER=19,BLINE=1)`, { method: 'DELETE', headers: wh }).catch(() => {});
  const pr = await fetch(`${odataBase}/BANKRECON`, { method: 'POST', headers: wh, body: JSON.stringify({ USER: 19, CASHNAME: '111-201', BLINE: 1 }) });
  console.log(`BANKRECON init: ${pr.status}`);

  // WCF: create reconciliation record
  await priority.login({ username: process.env.PRIORITY_USERNAME, password: process.env.PRIORITY_PASSWORD, url: serviceUrl, tabulaini, language: 1, appname: 'tr-recon-test' });
  console.log('WCF Login OK');

  const br = await wt(priority.formStart('BANKRECON', null, null, company), 20000, 'formStart');
  const nr = await wt(br.newRow(), 10000, 'newRow');
  console.log('newRow:', JSON.stringify(nr));

  for (const [f, v] of [
    ['CASHNAME', '111-201'],
    ['BOOKNUM',  BPNUMA],
    ['BANKSUM',  AMOUNT],
    ['BOOKSUM',  AMOUNT],
  ]) {
    const r = await wt(br.fieldUpdate(f, v), 10000, `fu ${f}`).catch(e => ({ error: e.message }));
    console.log(`fieldUpdate(${f}, ${v}):`, JSON.stringify(r));
  }

  try {
    const sr = await wt(br.saveRow(0), 20000, 'saveRow');
    console.log('saveRow:', JSON.stringify(sr));
  } catch (e) {
    console.log('saveRow FAILED:', e.message);
  }
  await br.endCurrentForm(false).catch(() => {});

  // Check ERECONNUM after
  await new Promise(r => setTimeout(r, 1500));
  const after = await (await fetch(`${odataBase}/BANKLINESA(BANKPAGE=${BANKPAGE},KLINE=${KLINE})?$select=ERECONNUM`, { headers: rh })).json();
  console.log(`\nAFTER:  BANKLINESA(${BANKPAGE},${KLINE}) ERECONNUM=${after.ERECONNUM}`);
  console.log(after.ERECONNUM > 0 ? '✓ RECONCILED!' : '✗ Still 0 — saveRow does not update ERECONNUM');
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
