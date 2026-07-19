'use strict';
/**
 * BANKRECONSP is an OData entity. Try POST with USER+BLINE (no CASHNAME).
 * If it has USER+BLINE keys like BANKRECON, POST might init the USER context
 * so that WCF BANKRECONSP.saveRow stops saying "USER חסר".
 *
 * Also probe what fields BANKRECONSP actually accepts.
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
  const { odataBase, serviceUrl, tabulaini, company } = parseOdataUrl(process.env.PRIORITY_URL_REAL || process.env.PRIORITY_URL || '');
  const auth = 'Basic ' + Buffer.from(`${process.env.PRIORITY_USERNAME}:${process.env.PRIORITY_PASSWORD}`).toString('base64');
  const rh = { Authorization: auth, Accept: 'application/json', 'OData-Version': '4.0' };
  const wh = { ...rh, 'Content-Type': 'application/json' };

  // Test A: POST with USER+BLINE only
  console.log('=== A. POST BANKRECONSP {USER:19, BLINE:1} ===');
  const a1 = await fetch(`${odataBase}/BANKRECONSP`, { method: 'POST', headers: wh,
    body: JSON.stringify({ USER: 19, BLINE: 1 }) });
  const a1t = await a1.text();
  console.log(`Status: ${a1.status}`);
  console.log(a1t.slice(0, 400));

  // Test B: POST with just USER
  console.log('\n=== B. POST BANKRECONSP {USER:19} ===');
  const b1 = await fetch(`${odataBase}/BANKRECONSP`, { method: 'POST', headers: wh,
    body: JSON.stringify({ USER: 19 }) });
  const b1t = await b1.text();
  console.log(`Status: ${b1.status}`);
  console.log(b1t.slice(0, 400));

  // Test C: PATCH BANKRECONSP(USER=19,BLINE=1)
  console.log('\n=== C. PATCH BANKRECONSP(USER=19,BLINE=1) ===');
  const c1 = await fetch(`${odataBase}/BANKRECONSP(USER=19,BLINE=1)`, { method: 'PATCH', headers: wh,
    body: JSON.stringify({ RECON: 'Y' }) });
  const c1t = await c1.text();
  console.log(`Status: ${c1.status}`);
  console.log(c1t.slice(0, 400));

  // Test D: GET BANKRECONSP(USER=19,BLINE=1)
  console.log('\n=== D. GET BANKRECONSP(USER=19,BLINE=1) ===');
  const d1 = await fetch(`${odataBase}/BANKRECONSP(USER=19,BLINE=1)`, { headers: rh });
  const d1t = await d1.text();
  console.log(`Status: ${d1.status}`);
  console.log(d1t.slice(0, 400));

  // Now test WCF after any successful POST
  console.log('\n=== WCF: BANKRECONSP.saveRow after OData BANKRECONSP init ===');
  await priority.login({ username: process.env.PRIORITY_USERNAME, password: process.env.PRIORITY_PASSWORD,
    url: serviceUrl, tabulaini, language: 1, appname: 'tr-sp3' });

  // NEXTBANKRECON
  let nbr = await wt(priority.procStart('NEXTBANKRECON', 'P', null, company), 15000, 'NBR');
  while (nbr && nbr.type !== 'end' && nbr.type !== 'finished') {
    if (nbr.type === 'message') nbr = await wt(nbr.proc.message(1), 10000, 'NBR.msg');
    else if (nbr.proc?.continueProc) nbr = await wt(nbr.proc.continueProc(), 10000, 'NBR.cont');
    else break;
  }

  const sp = await wt(priority.formStart('BANKRECONSP', null, null, company), 20000, 'formStart');
  await wt(sp.newRow(), 10000, 'newRow');
  for (const [f, v] of [['RECON', 'Y'], ['FRST_BOOKNUM', '2'], ['FRST_SUM', 986.79]]) {
    const r = await wt(sp.fieldUpdate(f, v), 5000, `fu ${f}`).catch(e => `ERROR: ${e.message}`);
    console.log(`fieldUpdate(${f}, ${v}):`, typeof r === 'string' ? r : JSON.stringify(r));
  }
  try {
    const sr = await wt(sp.saveRow(0), 20000, 'saveRow');
    console.log('saveRow:', JSON.stringify(sr));
    console.log('✓ WORKED!');
  } catch (e) {
    console.log('saveRow FAILED:', e.message);
  }
  await sp.endCurrentForm(false).catch(() => {});
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
