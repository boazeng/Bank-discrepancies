'use strict';
/**
 * Test CLOSEBANKRECON (non-SP version) — might work differently than CLOSEBANKRECONISP.
 * Also try BANKRECON WCF form with FNCNUM field set before saveRow.
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
async function runProc(name, company, label) {
  let p = await wt(priority.procStart(name, 'P', null, company), 15000, label);
  const steps = [];
  while (p && p.type !== 'end' && p.type !== 'finished') {
    const ct = p.type;
    steps.push({ type: ct, msg: (p.message||'').slice(0,100) });
    if (ct === 'message') p = await wt(p.proc.message(1), 15000, label+'.msg');
    else if (ct === 'inputFields') {
      const f = (p.input?.EditFields||[]).map(x => ({ field: x.field, op: 0, value: x.value||'', op2: 0, value2: '' }));
      p = await wt(p.proc.inputFields(1, { EditFields: f }), 15000, label+'.if');
    } else if (p.proc?.continueProc) p = await wt(p.proc.continueProc(), 30000, label+'.cont');
    else { steps.push({ type: 'STUCK' }); break; }
  }
  return steps;
}

async function main() {
  const BANKPAGE = 16426, KLINE = 98;

  const { odataBase, serviceUrl, tabulaini, company } = parseOdataUrl(process.env.PRIORITY_URL_REAL || process.env.PRIORITY_URL || '');
  const auth = 'Basic ' + Buffer.from(`${process.env.PRIORITY_USERNAME}:${process.env.PRIORITY_PASSWORD}`).toString('base64');
  const rh = { Authorization: auth, Accept: 'application/json', 'OData-Version': '4.0' };
  const wh = { ...rh, 'Content-Type': 'application/json' };

  // Init via OData
  await fetch(`${odataBase}/BANKRECON(USER=19,BLINE=1)`, { method: 'DELETE', headers: wh }).catch(() => {});
  await fetch(`${odataBase}/BANKRECON`, { method: 'POST', headers: wh,
    body: JSON.stringify({ USER: 19, CASHNAME: '111-201', BLINE: 1 }) });

  await priority.login({ username: process.env.PRIORITY_USERNAME, password: process.env.PRIORITY_PASSWORD,
    url: serviceUrl, tabulaini, language: 1, appname: 'tr-cbrecon' });
  console.log('WCF Login OK');

  // Test 1: CLOSEBANKRECON (non-SP)
  console.log('\n=== Test 1: CLOSEBANKRECON (non-SP) ===');
  const cbr = await runProc('CLOSEBANKRECON', company, 'CLOSEBANKRECON');
  console.log('Steps:', JSON.stringify(cbr, null, 2));

  // Test 2: NEXTBANKRECON + WCF BANKRECON with FNCNUM
  console.log('\n=== Test 2: WCF BANKRECON with FNCNUM field ===');
  let nbr = await wt(priority.procStart('NEXTBANKRECON', 'P', null, company), 15000, 'NBR');
  while (nbr && nbr.type !== 'end' && nbr.type !== 'finished') {
    if (nbr.type === 'message') nbr = await wt(nbr.proc.message(1), 10000, 'NBR.msg');
    else if (nbr.proc?.continueProc) nbr = await wt(nbr.proc.continueProc(), 10000, 'NBR.cont');
    else break;
  }
  console.log('NEXTBANKRECON done');

  const br = await wt(priority.formStart('BANKRECON', null, null, company), 20000, 'formStart BANKRECON');
  await wt(br.newRow(), 10000, 'newRow');

  // From WCF BANKRECON columns: RECONNUM, ABSSUM, BANKSUM, BOOKSUM, CODE, FNCDATE,
  // DETAILS, IVNUM, BOOKNUM, FNCNUM, BPNUMA, BTCODE
  // FNCNUM is books-side reference. BOOKNUM=BPNUMA (bank ref). BANKSUM=bank amount.
  for (const [f, v] of [
    ['CASHNAME', '111-201'],
    ['FNCNUM',   '26010805'],   // books: some fncnum
    ['BOOKNUM',  '2'],           // bank: BPNUMA
    ['BANKSUM',  986.79],
    ['BOOKSUM',  986.79],
    ['BPNUMA',   '2'],
  ]) {
    const r = await wt(br.fieldUpdate(f, v), 5000, `fu ${f}`).catch(e => `ERROR: ${e.message}`);
    console.log(`fieldUpdate(${f}, ${v}):`, typeof r === 'string' ? r : JSON.stringify(r));
  }

  try {
    const sr = await wt(br.saveRow(0), 20000, 'saveRow');
    console.log('saveRow:', JSON.stringify(sr));
  } catch (e) {
    console.log('saveRow FAILED:', e.message);
  }
  await br.endCurrentForm(false).catch(() => {});

  // After saveRow, check ERECONNUM
  await new Promise(r => setTimeout(r, 1000));
  const after = await (await fetch(`${odataBase}/BANKLINESA(BANKPAGE=${BANKPAGE},KLINE=${KLINE})?$select=ERECONNUM`, { headers: rh })).json();
  console.log(`\nBANKLINESA(${BANKPAGE},${KLINE}) ERECONNUM=${after.ERECONNUM}`);

  // Test 3: Now CLOSEBANKRECONISP after the saveRow
  console.log('\n=== Test 3: CLOSEBANKRECONISP after BANKRECON saveRow ===');
  const cbi = await runProc('CLOSEBANKRECONISP', company, 'CBI');
  console.log('Steps:', JSON.stringify(cbi, null, 2));

  await new Promise(r => setTimeout(r, 1000));
  const after2 = await (await fetch(`${odataBase}/BANKLINESA(BANKPAGE=${BANKPAGE},KLINE=${KLINE})?$select=ERECONNUM`, { headers: rh })).json();
  console.log(`BANKLINESA ERECONNUM after CBI: ${after2.ERECONNUM}`);
  console.log(after2.ERECONNUM > 0 ? '✓ RECONCILED!' : '✗ Still 0');
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
