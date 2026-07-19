'use strict';
/**
 * KEY TEST: Does WCF BANKRECONSP.saveRow work after OData BANKRECON init?
 * Previous failure: "USER חסר" on saveRow.
 * New discovery: OData POST BANKRECON(USER=19,BLINE=1) fixed WCF BANKRECON saveRow.
 * Theory: same fix applies to BANKRECONSP saveRow.
 *
 * Flow:
 * 1. OData POST BANKRECON (init user context)
 * 2. NEXTBANKRECON (set bank account context)
 * 3. formStart('BANKRECONSP') → newRow → fieldUpdates (RECON=Y, bank+books refs) → saveRow
 * 4. CLOSEBANKRECONISP (if saveRow worked)
 * 5. Verify BANKLINESA.ERECONNUM
 *
 * Usage: node trace_bankreconsp_create.js <BANKPAGE> <KLINE> <BPNUMA> <FNCNUM> <AMOUNT>
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
  const BANKPAGE = parseInt(process.argv[2] || '16426');
  const KLINE    = parseInt(process.argv[3] || '98');
  const BPNUMA   =          process.argv[4] || '2';
  const FNCNUM   =          process.argv[5] || '';    // journal FNCNUM (books side)
  const AMOUNT   = parseFloat(process.argv[6] || '986.79');
  const CASHNAME = '111-201';

  const { odataBase, serviceUrl, tabulaini, company } = parseOdataUrl(process.env.PRIORITY_URL_REAL || process.env.PRIORITY_URL || '');
  const auth = 'Basic ' + Buffer.from(`${process.env.PRIORITY_USERNAME}:${process.env.PRIORITY_PASSWORD}`).toString('base64');
  const rh = { Authorization: auth, Accept: 'application/json', 'OData-Version': '4.0' };
  const wh = { ...rh, 'Content-Type': 'application/json' };

  // Check ERECONNUM before
  const before = await (await fetch(`${odataBase}/BANKLINESA(BANKPAGE=${BANKPAGE},KLINE=${KLINE})?$select=ERECONNUM,BPNUMA,CREDIT,DEBIT`, { headers: rh })).json();
  console.log(`BEFORE: BANKLINESA(${BANKPAGE},${KLINE}) BPNUMA=${before.BPNUMA} CREDIT=${before.CREDIT} DEBIT=${before.DEBIT} ERECONNUM=${before.ERECONNUM}`);
  if (before.ERECONNUM > 0) { console.log('Already reconciled — skipping'); return; }

  // Step 1: OData POST BANKRECON — init user context (this fixed BANKRECON saveRow!)
  console.log('\n=== Step 1: Init BANKRECON user context via OData ===');
  await fetch(`${odataBase}/BANKRECON(USER=19,BLINE=1)`, { method: 'DELETE', headers: wh }).catch(() => {});
  const pr = await fetch(`${odataBase}/BANKRECON`, { method: 'POST', headers: wh,
    body: JSON.stringify({ USER: 19, CASHNAME, BLINE: 1 }) });
  console.log(`POST BANKRECON: ${pr.status} ${pr.ok ? 'OK' : 'FAIL'}`);

  // WCF login
  await priority.login({ username: process.env.PRIORITY_USERNAME, password: process.env.PRIORITY_PASSWORD,
    url: serviceUrl, tabulaini, language: 1, appname: 'tr-sp-create' });
  console.log('WCF Login OK');

  // Step 2: NEXTBANKRECON
  console.log('\n=== Step 2: NEXTBANKRECON ===');
  let nbr = await wt(priority.procStart('NEXTBANKRECON', 'P', null, company), 15000, 'NBR');
  while (nbr && nbr.type !== 'end' && nbr.type !== 'finished') {
    if (nbr.type === 'message') nbr = await wt(nbr.proc.message(1), 10000, 'NBR.msg');
    else if (nbr.proc?.continueProc) nbr = await wt(nbr.proc.continueProc(), 10000, 'NBR.cont');
    else break;
  }
  console.log('NEXTBANKRECON done');

  // Step 3: formStart BANKRECONSP → newRow → fieldUpdates → saveRow
  console.log('\n=== Step 3: BANKRECONSP newRow + saveRow ===');
  const sp = await wt(priority.formStart('BANKRECONSP', null, null, company), 20000, 'formStart BANKRECONSP');
  const nr = await wt(sp.newRow(), 10000, 'newRow');
  console.log('newRow:', JSON.stringify(nr));

  const fields = [
    ['RECON',       'Y'],
    ['FRST_BOOKNUM', BPNUMA],   // bank side reference
    ['FRST_SUM',    AMOUNT],    // bank amount
  ];
  if (FNCNUM) {
    fields.push(['SCND_IVNUM', FNCNUM]);  // books side reference
    fields.push(['SCND_SUM',   AMOUNT]);  // books amount
  }
  for (const [f, v] of fields) {
    const r = await wt(sp.fieldUpdate(f, v), 10000, `fu ${f}`).catch(e => ({ error: e.message }));
    console.log(`fieldUpdate(${f}, ${v}):`, JSON.stringify(r));
  }

  let saveOk = false;
  try {
    const sr = await wt(sp.saveRow(0), 20000, 'saveRow BANKRECONSP');
    console.log('saveRow:', JSON.stringify(sr));
    saveOk = true;
  } catch (e) {
    console.log('saveRow FAILED:', e.message);
  }
  await sp.endCurrentForm(false).catch(() => {});

  if (!saveOk) {
    console.log('\n✗ saveRow failed — USER init did not fix BANKRECONSP');
    return;
  }

  // Step 4: CLOSEBANKRECONISP
  console.log('\n=== Step 4: CLOSEBANKRECONISP ===');
  let cbi = await wt(priority.procStart('CLOSEBANKRECONISP', 'P', null, company), 15000, 'CLOSEBANKRECONISP');
  while (cbi && cbi.type !== 'end' && cbi.type !== 'finished') {
    const ct = cbi.type;
    console.log(`  step type=${ct} msg=${(cbi.message||'').slice(0,100)}`);
    if (ct === 'message') cbi = await wt(cbi.proc.message(1), 15000, 'CBI.msg');
    else if (ct === 'inputFields') {
      const f = (cbi.input?.EditFields||[]).map(x => ({ field: x.field, op: 0, value: x.value||'', op2: 0, value2: '' }));
      cbi = await wt(cbi.proc.inputFields(1, { EditFields: f }), 15000, 'CBI.if');
    } else if (cbi.proc?.continueProc) cbi = await wt(cbi.proc.continueProc(), 30000, 'CBI.cont');
    else break;
  }
  console.log('CLOSEBANKRECONISP done');

  // Step 5: verify
  await new Promise(r => setTimeout(r, 1500));
  const after = await (await fetch(`${odataBase}/BANKLINESA(BANKPAGE=${BANKPAGE},KLINE=${KLINE})?$select=ERECONNUM`, { headers: rh })).json();
  console.log(`\nAFTER: BANKLINESA(${BANKPAGE},${KLINE}) ERECONNUM=${after.ERECONNUM}`);
  console.log(after.ERECONNUM > 0 ? '✓ RECONCILED!' : '✗ Still 0');
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
