'use strict';
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

  // 1. What ERECONNUM was assigned to the manually-reconciled 2.70 entries?
  console.log('=== BANKLINESA 2.70 entries — ERECONNUM after manual reconciliation ===');
  const bl = await (await fetch(`${odataBase}/BANKLINESA?$top=100&$orderby=BANKPAGE desc,KLINE desc&$select=BANKPAGE,KLINE,BPNUMA,CREDIT,DEBIT,ERECONNUM`, { headers: rh })).json();
  const entries = (bl.value || []).filter(r => Math.abs((r.CREDIT||0) - 2.70) < 0.01 || Math.abs((r.DEBIT||0) - 2.70) < 0.01);
  console.log(JSON.stringify(entries, null, 2));

  const reconNum = entries.find(e => e.ERECONNUM > 0)?.ERECONNUM;
  console.log(`\nNew RECONNUM assigned: ${reconNum}`);

  // 2. WCF BANKRECON — does it now show the manually-created reconciliation record?
  await priority.login({ username: process.env.PRIORITY_USERNAME, password: process.env.PRIORITY_PASSWORD,
    url: serviceUrl, tabulaini, language: 1, appname: 'tr-after-manual' });

  let nbr = await wt(priority.procStart('NEXTBANKRECON', 'P', null, company), 15000, 'NBR');
  while (nbr && nbr.type !== 'end' && nbr.type !== 'finished') {
    if (nbr.type === 'message') nbr = await wt(nbr.proc.message(1), 10000, 'NBR.msg');
    else if (nbr.proc?.continueProc) nbr = await wt(nbr.proc.continueProc(), 10000, 'NBR.cont');
    else break;
  }

  const br = await wt(priority.formStart('BANKRECON', null, null, company), 20000, 'formStart BANKRECON');
  const raw = await wt(br.getRows(0), 20000, 'getRows BANKRECON');
  const rows = Array.isArray(raw) ? raw : (Object.values(raw || {}).find(v => Array.isArray(v)) || []);
  console.log(`\nWCF BANKRECON rows after manual reconciliation: ${rows.length}`);
  if (rows.length > 0) {
    console.log('First row:', JSON.stringify(rows[0], null, 2));
  }

  // 3. Try to find the RECONNUM in BANKRECON via OData
  if (reconNum) {
    console.log(`\n=== OData: GET BANKRECON?$filter=RECONNUM eq ${reconNum} ===`);
    const r = await (await fetch(`${odataBase}/BANKRECON?$filter=RECONNUM eq ${reconNum}`, { headers: rh })).json();
    console.log(JSON.stringify(r, null, 2));
  }

  await br.endCurrentForm(false).catch(() => {});
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
