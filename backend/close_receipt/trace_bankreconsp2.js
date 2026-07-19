'use strict';
/**
 * Two-pronged test:
 * A. Is BANKRECONSP an OData entity? Can we POST to it?
 * B. Can we set hidden fields (USER/CASHNAME/BLINE) in WCF BANKRECONSP before saveRow?
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

  // === Part A: OData BANKRECONSP ===
  console.log('=== A. OData GET BANKRECONSP?$top=1 ===');
  const a1 = await fetch(`${odataBase}/BANKRECONSP?$top=1`, { headers: rh });
  const at = await a1.text();
  console.log(`Status: ${a1.status}`);
  console.log(at.slice(0, 300));

  console.log('\n=== A2. OData POST BANKRECONSP {USER:19,BLINE:1,CASHNAME:"111-201"} ===');
  const a2 = await fetch(`${odataBase}/BANKRECONSP`, { method: 'POST', headers: wh,
    body: JSON.stringify({ USER: 19, BLINE: 1, CASHNAME: '111-201' }) });
  const a2t = await a2.text();
  console.log(`Status: ${a2.status}`);
  console.log(a2t.slice(0, 300));

  // === Part B: WCF — hidden fields before saveRow ===
  console.log('\n=== B. WCF BANKRECONSP — try hidden fields ===');

  // Init BANKRECON context
  await fetch(`${odataBase}/BANKRECON(USER=19,BLINE=1)`, { method: 'DELETE', headers: wh }).catch(() => {});
  await fetch(`${odataBase}/BANKRECON`, { method: 'POST', headers: wh,
    body: JSON.stringify({ USER: 19, CASHNAME: '111-201', BLINE: 1 }) });

  await priority.login({ username: process.env.PRIORITY_USERNAME, password: process.env.PRIORITY_PASSWORD,
    url: serviceUrl, tabulaini, language: 1, appname: 'tr-sp2' });
  console.log('WCF login OK');

  // NEXTBANKRECON
  let nbr = await wt(priority.procStart('NEXTBANKRECON', 'P', null, company), 15000, 'NBR');
  while (nbr && nbr.type !== 'end' && nbr.type !== 'finished') {
    if (nbr.type === 'message') nbr = await wt(nbr.proc.message(1), 10000, 'NBR.msg');
    else if (nbr.proc?.continueProc) nbr = await wt(nbr.proc.continueProc(), 10000, 'NBR.cont');
    else break;
  }
  console.log('NEXTBANKRECON done');

  const sp = await wt(priority.formStart('BANKRECONSP', null, null, company), 20000, 'formStart BANKRECONSP');
  await wt(sp.newRow(), 10000, 'newRow');

  // Try hidden fields — USER, CASHNAME, BLINE
  const hiddenFields = [
    ['USER',      '19'],
    ['CASHNAME',  '111-201'],
    ['BLINE',     '1'],
  ];
  for (const [f, v] of hiddenFields) {
    const r = await wt(sp.fieldUpdate(f, v), 5000, `fu ${f}`).catch(e => `ERROR: ${e.message}`);
    console.log(`fieldUpdate(${f}, ${v}):`, typeof r === 'string' ? r : JSON.stringify(r));
  }

  // Now regular fields
  for (const [f, v] of [['RECON', 'Y'], ['FRST_BOOKNUM', '2'], ['FRST_SUM', 986.79]]) {
    const r = await wt(sp.fieldUpdate(f, v), 5000, `fu ${f}`).catch(e => `ERROR: ${e.message}`);
    console.log(`fieldUpdate(${f}, ${v}):`, typeof r === 'string' ? r : JSON.stringify(r));
  }

  try {
    const sr = await wt(sp.saveRow(0), 20000, 'saveRow');
    console.log('saveRow:', JSON.stringify(sr));
    console.log('✓ saveRow succeeded!');
  } catch (e) {
    console.log('saveRow FAILED:', e.message);
  }
  await sp.endCurrentForm(false).catch(() => {});
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
