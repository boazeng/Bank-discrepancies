'use strict';
/**
 * Try creating BANKRECONSP rows as BLINE=2,3,... via OData POST
 * (BLINE=1 is a header/session row; real transaction rows might use BLINE>1)
 * Then check if WCF getRows sees them.
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

  // Clean up any old rows first
  console.log('=== Cleanup: DELETE BLINE=2,3 ===');
  await fetch(`${odataBase}/BANKRECONSP(USER=19,BLINE=2)`, { method: 'DELETE', headers: wh }).catch(() => {});
  await fetch(`${odataBase}/BANKRECONSP(USER=19,BLINE=3)`, { method: 'DELETE', headers: wh }).catch(() => {});

  // POST bank-side row (BLINE=2, COND=1 = bank side)
  console.log('\n=== POST BANKRECONSP {USER:19, BLINE:2} — bank-side row ===');
  const bankRow = {
    USER: 19,
    BLINE: 2,
    RECON: 'Y',
    COND: 1,          // 1=bank side, 2=books side (guess)
    FRST_BOOKNUM: '2',
    FRST_SUM: 986.79,
  };
  const p2 = await fetch(`${odataBase}/BANKRECONSP`, { method: 'POST', headers: wh, body: JSON.stringify(bankRow) });
  const p2t = await p2.text();
  console.log(`Status: ${p2.status}`, p2.ok ? 'OK' : 'FAIL');
  console.log(p2t.slice(0, 400));

  // POST books-side row (BLINE=3)
  console.log('\n=== POST BANKRECONSP {USER:19, BLINE:3} — books-side row ===');
  const booksRow = {
    USER: 19,
    BLINE: 3,
    RECON: 'Y',
    COND: 2,
    SCND_IVNUM: '26010805',  // some FNCNUM for test
    SCND_SUM: 986.79,
  };
  const p3 = await fetch(`${odataBase}/BANKRECONSP`, { method: 'POST', headers: wh, body: JSON.stringify(booksRow) });
  const p3t = await p3.text();
  console.log(`Status: ${p3.status}`, p3.ok ? 'OK' : 'FAIL');
  console.log(p3t.slice(0, 400));

  // WCF: does getRows now see anything?
  await priority.login({ username: process.env.PRIORITY_USERNAME, password: process.env.PRIORITY_PASSWORD,
    url: serviceUrl, tabulaini, language: 1, appname: 'tr-sp5' });
  console.log('\nWCF Login OK');

  let nbr = await wt(priority.procStart('NEXTBANKRECON', 'P', null, company), 15000, 'NBR');
  while (nbr && nbr.type !== 'end' && nbr.type !== 'finished') {
    if (nbr.type === 'message') nbr = await wt(nbr.proc.message(1), 10000, 'NBR.msg');
    else if (nbr.proc?.continueProc) nbr = await wt(nbr.proc.continueProc(), 10000, 'NBR.cont');
    else break;
  }

  const sp = await wt(priority.formStart('BANKRECONSP', null, null, company), 20000, 'formStart BANKRECONSP');
  const rawRows = await wt(sp.getRows(0), 20000, 'getRows BANKRECONSP');
  const rows = Array.isArray(rawRows) ? rawRows : (Object.values(rawRows || {}).find(v => Array.isArray(v)) || []);
  console.log(`\nBANKRECONSP rows: ${rows.length}`);
  if (rows.length > 0) {
    console.log('Rows:', JSON.stringify(rows, null, 2));
    console.log('\n✓ Rows visible! Trying CLOSEBANKRECONISP...');

    let cbi = await wt(priority.procStart('CLOSEBANKRECONISP', 'P', null, company), 15000, 'CBI');
    while (cbi && cbi.type !== 'end' && cbi.type !== 'finished') {
      const ct = cbi.type;
      console.log(`  CBI step type=${ct} msg=${(cbi.message||'').slice(0,120)}`);
      if (ct === 'message') cbi = await wt(cbi.proc.message(1), 15000, 'CBI.msg');
      else if (cbi.proc?.continueProc) cbi = await wt(cbi.proc.continueProc(), 30000, 'CBI.cont');
      else break;
    }
    console.log('CLOSEBANKRECONISP done');

    await new Promise(r => setTimeout(r, 1500));
    const after = await (await fetch(`${odataBase}/BANKLINESA(BANKPAGE=16426,KLINE=98)?$select=ERECONNUM`, { headers: rh })).json();
    console.log(`BANKLINESA(16426,98) ERECONNUM=${after.ERECONNUM}`, after.ERECONNUM > 0 ? '✓ RECONCILED!' : '✗');
  } else {
    console.log('✗ Still 0 rows — OData POST rows not visible in WCF');
  }

  await sp.endCurrentForm(false).catch(() => {});
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
