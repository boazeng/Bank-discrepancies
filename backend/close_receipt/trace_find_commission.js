'use strict';
/**
 * Find the unreconciled 2.70 bank commission line + its journal FNCNUM,
 * then test if BANKRECON WCF newRow+save creates a real reconciliation.
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

  // 1. Find the 2.70 bank line — fetch last 100 entries and search in JS
  // (ERECONNUM/CASHNAME filters don't work reliably via OData)
  console.log('=== BANKLINESA: last 100 entries, search for 2.70 ===');
  const blR = await fetch(`${odataBase}/BANKLINESA?$top=100&$orderby=BANKPAGE desc,KLINE desc&$select=BANKPAGE,KLINE,BPNUMA,CREDIT,DEBIT,FNCDATE,ERECONNUM`, { headers: rh });
  const blD = await blR.json();
  const all = blD.value || [];
  console.log(`Total fetched: ${all.length}`);
  const lines = all.filter(r => Math.abs((r.CREDIT||0) - 2.70) < 0.01 || Math.abs((r.DEBIT||0) - 2.70) < 0.01);
  console.log(`2.70 entries found: ${lines.length}`);
  console.log(JSON.stringify(lines, null, 2));

  if (lines.length === 0) {
    console.log('\nNo 2.70 entry in last 100 rows. Recent entries:');
    console.log(JSON.stringify(all.slice(0,5), null, 2));
    return;
  }

  const line = lines[0];
  const { BANKPAGE, KLINE, BPNUMA } = line;
  const amount = (line.CREDIT || 0) + (line.DEBIT || 0);
  console.log(`\nUsing: BANKPAGE=${BANKPAGE} KLINE=${KLINE} BPNUMA=${BPNUMA} amount=${amount}`);

  // 2. Find journal FNCNUM — show recent FNCTRANS (user created commission journal recently)
  console.log('\n=== FNCTRANS: last 20 by FNCNUM desc ===');
  const ftR2 = await fetch(`${odataBase}/FNCTRANS?$select=FNCNUM,FNCDES,CURDATE,CREDIT,DEBIT&$top=20&$orderby=FNCNUM desc`, { headers: rh });
  const ftD = await ftR2.json();
  console.log(JSON.stringify(ftD.value || [], null, 2));

  // Try JRNL entity for journal entries
  console.log('\n=== JRNL: last 10 journal entries ===');
  const jrR = await fetch(`${odataBase}/JRNL?$select=JRNLNUM,JRNLDES,CURDATE,TOTPRICE&$top=10&$orderby=JRNLNUM desc`, { headers: rh });
  const jrD = await jrR.json();
  console.log(JSON.stringify(jrD.value || [], null, 2).slice(0, 1000));

  // 3. Init BANKRECON for API user (OData POST — needed for WCF saveRow to work)
  console.log('\n=== Init BANKRECON via OData ===');
  await fetch(`${odataBase}/BANKRECON(USER=19,BLINE=1)`, { method: 'DELETE', headers: wh }).catch(() => {});
  const postR = await fetch(`${odataBase}/BANKRECON`, { method: 'POST', headers: wh, body: JSON.stringify({ USER: 19, CASHNAME: '111-201', BLINE: 1 }) });
  console.log(`POST BANKRECON: ${postR.status}`);

  // 4. WCF: create reconciliation record in BANKRECON
  await priority.login({ username: process.env.PRIORITY_USERNAME, password: process.env.PRIORITY_PASSWORD, url: serviceUrl, tabulaini, language: 1, appname: 'tr-commission' });
  console.log('WCF Login OK');

  const br = await wt(priority.formStart('BANKRECON', null, null, company), 20000, 'formStart BANKRECON');
  await wt(br.newRow(), 10000, 'newRow');
  for (const [f, v] of [['CASHNAME','111-201'],['FNCNUM',String(fncnum)],['BOOKNUM',BPNUMA],['BANKSUM',amount],['BOOKSUM',amount]]) {
    const r = await wt(br.fieldUpdate(f, v), 10000, `fu ${f}`);
    console.log(`fieldUpdate(${f},${v}):`, JSON.stringify(r));
  }
  try {
    const sr = await wt(br.saveRow(0), 20000, 'saveRow');
    console.log('saveRow:', JSON.stringify(sr));
  } catch(e) {
    console.log('saveRow FAILED:', e.message);
  }
  await br.endCurrentForm(false).catch(() => {});

  // 5. Verify: did ERECONNUM change?
  await new Promise(r => setTimeout(r, 2000)); // small wait
  const verR = await fetch(`${odataBase}/BANKLINESA(BANKPAGE=${BANKPAGE},KLINE=${KLINE})?$select=ERECONNUM`, { headers: rh });
  const verD = await verR.json();
  console.log(`\nBANKLINESA(${BANKPAGE},${KLINE}) ERECONNUM after: ${verD.ERECONNUM}`);
  console.log(verD.ERECONNUM > 0 ? '✓ RECONCILED!' : '✗ Still unreconciled');
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
