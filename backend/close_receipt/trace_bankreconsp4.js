'use strict';
/**
 * PROMISING: BANKRECONSP(USER=19,BLINE=1) record EXISTS (POST→409).
 * PATCH worked (200). Try:
 *   1. PATCH BANKRECONSP(USER=19,BLINE=1) with RECON=Y + bank/books refs
 *   2. WCF BANKRECONSP.getRows → does it now show the row?
 *   3. CLOSEBANKRECONISP → does it reconcile?
 *   4. Verify BANKLINESA.ERECONNUM
 *
 * Fields we're trying from WCF form columns:
 *   RECON, FRST_BOOKNUM, SCND_IVNUM, FRST_SUM, SCND_SUM
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
  const BANKPAGE = 16426, KLINE = 98, BPNUMA = '2', AMOUNT = 986.79;
  // FNCNUM for this bank line — needed for books side. Leave empty for now.
  const FNCNUM = process.argv[2] || '';

  const { odataBase, serviceUrl, tabulaini, company } = parseOdataUrl(process.env.PRIORITY_URL_REAL || process.env.PRIORITY_URL || '');
  const auth = 'Basic ' + Buffer.from(`${process.env.PRIORITY_USERNAME}:${process.env.PRIORITY_PASSWORD}`).toString('base64');
  const rh = { Authorization: auth, Accept: 'application/json', 'OData-Version': '4.0' };
  const wh = { ...rh, 'Content-Type': 'application/json' };

  // Check ERECONNUM before
  const before = await (await fetch(`${odataBase}/BANKLINESA(BANKPAGE=${BANKPAGE},KLINE=${KLINE})?$select=ERECONNUM`, { headers: rh })).json();
  console.log(`BEFORE: BANKLINESA(${BANKPAGE},${KLINE}) ERECONNUM=${before.ERECONNUM}`);
  if (before.ERECONNUM > 0) { console.log('Already reconciled'); return; }

  // Step 1: PATCH BANKRECONSP(USER=19,BLINE=1) with reconciliation data
  console.log('\n=== Step 1: PATCH BANKRECONSP(USER=19,BLINE=1) with data ===');
  const patchBody = {
    RECON: 'Y',
    FRST_BOOKNUM: BPNUMA,
    FRST_SUM: AMOUNT,
  };
  if (FNCNUM) {
    patchBody.SCND_IVNUM = FNCNUM;
    patchBody.SCND_SUM = AMOUNT;
  }
  console.log('PATCH body:', JSON.stringify(patchBody));
  const p1 = await fetch(`${odataBase}/BANKRECONSP(USER=19,BLINE=1)`, { method: 'PATCH', headers: wh,
    body: JSON.stringify(patchBody) });
  const p1t = await p1.text();
  console.log(`Status: ${p1.status}`, p1.ok ? 'OK' : 'FAIL');
  if (!p1.ok) console.log(p1t.slice(0, 300));

  // Also try PATCH with additional fields
  const allFields = { RECON: 'Y', RECONMARK: 'Y', FRST_BOOKNUM: BPNUMA, FRST_SUM: AMOUNT };
  if (FNCNUM) { allFields.SCND_IVNUM = FNCNUM; allFields.SCND_SUM = AMOUNT; }
  const p2 = await fetch(`${odataBase}/BANKRECONSP(USER=19,BLINE=1)`, { method: 'PATCH', headers: wh,
    body: JSON.stringify(allFields) });
  const p2t = await p2.text();
  console.log(`PATCH with RECONMARK: ${p2.status}`, p2.ok ? 'OK' : p2t.slice(0, 200));

  // Step 2: WCF login + NEXTBANKRECON + BANKRECONSP.getRows → should now see data?
  await priority.login({ username: process.env.PRIORITY_USERNAME, password: process.env.PRIORITY_PASSWORD,
    url: serviceUrl, tabulaini, language: 1, appname: 'tr-sp4' });
  console.log('\nWCF Login OK');

  let nbr = await wt(priority.procStart('NEXTBANKRECON', 'P', null, company), 15000, 'NBR');
  while (nbr && nbr.type !== 'end' && nbr.type !== 'finished') {
    if (nbr.type === 'message') nbr = await wt(nbr.proc.message(1), 10000, 'NBR.msg');
    else if (nbr.proc?.continueProc) nbr = await wt(nbr.proc.continueProc(), 10000, 'NBR.cont');
    else break;
  }
  console.log('NEXTBANKRECON done');

  const sp = await wt(priority.formStart('BANKRECONSP', null, null, company), 20000, 'formStart BANKRECONSP');
  const rawRows = await wt(sp.getRows(0), 20000, 'getRows BANKRECONSP');
  const rows = Array.isArray(rawRows) ? rawRows : (Object.values(rawRows || {}).find(v => Array.isArray(v)) || []);
  console.log(`\nBANKRECONSP rows AFTER patch: ${rows.length}`);
  if (rows.length > 0) {
    console.log('First row:', JSON.stringify(rows[0], null, 2));
  } else {
    console.log('Still 0 rows — PATCH data not visible in WCF');
  }

  await sp.endCurrentForm(false).catch(() => {});

  if (rows.length === 0) {
    console.log('\n✗ PATCH did not make rows appear in WCF BANKRECONSP');
    return;
  }

  // Step 3: CLOSEBANKRECONISP
  console.log('\n=== Step 3: CLOSEBANKRECONISP ===');
  let cbi = await wt(priority.procStart('CLOSEBANKRECONISP', 'P', null, company), 15000, 'CBI');
  while (cbi && cbi.type !== 'end' && cbi.type !== 'finished') {
    const ct = cbi.type;
    console.log(`  step type=${ct} msg=${(cbi.message||'').slice(0,120)}`);
    if (ct === 'message') cbi = await wt(cbi.proc.message(1), 15000, 'CBI.msg');
    else if (ct === 'inputFields') {
      const f = (cbi.input?.EditFields||[]).map(x => ({ field: x.field, op: 0, value: x.value||'', op2: 0, value2: '' }));
      cbi = await wt(cbi.proc.inputFields(1, { EditFields: f }), 15000, 'CBI.if');
    } else if (cbi.proc?.continueProc) cbi = await wt(cbi.proc.continueProc(), 30000, 'CBI.cont');
    else break;
  }
  console.log('CLOSEBANKRECONISP done');

  // Verify
  await new Promise(r => setTimeout(r, 1500));
  const after = await (await fetch(`${odataBase}/BANKLINESA(BANKPAGE=${BANKPAGE},KLINE=${KLINE})?$select=ERECONNUM`, { headers: rh })).json();
  console.log(`\nAFTER: BANKLINESA(${BANKPAGE},${KLINE}) ERECONNUM=${after.ERECONNUM}`);
  console.log(after.ERECONNUM > 0 ? '✓ RECONCILED!' : '✗ Still 0');
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
