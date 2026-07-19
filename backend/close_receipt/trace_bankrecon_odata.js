'use strict';
/**
 * Test: can we access/write BANKRECON via OData directly?
 * If yes, we can populate it for the API user and then BANKRECONSP will show rows.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

function parseOdataUrl(odataUrl) {
  const url = (odataUrl || '').replace(/\/$/, '');
  const m = url.match(/^(https?:\/\/[^\/]+)\/odata\/Priority\/([^\/]+)\/(.+)$/);
  if (!m) throw new Error('Cannot parse Priority URL: ' + url);
  return { odataBase: url };
}

async function oReq(method, url, headers, body) {
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 500) }; }
  return { status: r.status, ok: r.ok, data };
}

async function main() {
  const cashname = (process.argv[2] || '111-201').trim();
  const { odataBase } = parseOdataUrl(process.env.PRIORITY_URL_REAL || process.env.PRIORITY_URL || '');
  const auth = 'Basic ' + Buffer.from(`${process.env.PRIORITY_USERNAME}:${process.env.PRIORITY_PASSWORD}`).toString('base64');
  const rh = { Authorization: auth, Accept: 'application/json', 'OData-Version': '4.0' };
  const wh = { ...rh, 'Content-Type': 'application/json' };

  console.log('OData base:', odataBase);
  console.log('CASHNAME:', cashname);

  // 1. Try GET BANKRECON
  console.log('\n=== GET BANKRECON ===');
  let r = await oReq('GET', `${odataBase}/BANKRECON`, rh);
  console.log(`Status: ${r.status}`, r.ok ? '' : '(FAIL)');
  console.log(JSON.stringify(r.data, null, 2).slice(0, 500));

  // 2. Try GET BANKRECON with $top=5
  if (r.ok) {
    console.log('\n=== GET BANKRECON?$top=5 ===');
    r = await oReq('GET', `${odataBase}/BANKRECON?$top=5`, rh);
    console.log(`Status: ${r.status}`);
    console.log(JSON.stringify(r.data, null, 2).slice(0, 1000));
  }

  // 3. Try POST to BANKRECON with explicit USER=19
  console.log('\n=== POST BANKRECON with USER=19 ===');
  r = await oReq('POST', `${odataBase}/BANKRECON`, wh, { USER: 19, CASHNAME: cashname });
  console.log(`Status: ${r.status}`, r.ok ? 'OK' : '(FAIL)');
  console.log(JSON.stringify(r.data, null, 2).slice(0, 500));

  // 3b. Also try with string USER
  console.log('\n=== POST BANKRECON with USER="API" ===');
  r = await oReq('POST', `${odataBase}/BANKRECON`, wh, { USER: 'API', CASHNAME: cashname });
  console.log(`Status: ${r.status}`, r.ok ? 'OK' : '(FAIL)');
  console.log(JSON.stringify(r.data, null, 2).slice(0, 500));

  // 3c. Try different field combinations
  const attempts = [
    { USER: 19, CASHNAME: cashname, BLINE: 1 },
    { USER: 19, ACCNAME: cashname },
    { USER: 19, CASHNAME: cashname, FNCNAME: cashname },
    { USER: 19, CASHNAME: cashname, BLINE: 1, FNCNAME: cashname },
  ];
  for (const body of attempts) {
    console.log(`\n=== POST BANKRECON ${JSON.stringify(body)} ===`);
    r = await oReq('POST', `${odataBase}/BANKRECON`, wh, body);
    console.log(`Status: ${r.status}`, r.ok ? '*** SUCCESS ***' : '(FAIL)');
    console.log(JSON.stringify(r.data, null, 2).slice(0, 400));
    if (r.ok) break;
  }

  // 3d. OData $metadata for the whole service — find BANKRECON entity definition
  console.log('\n=== GET $metadata (search for BANKRECON EntityType) ===');
  r = await oReq('GET', `${odataBase}/$metadata`, rh);
  const metaText = typeof r.data === 'object' ? JSON.stringify(r.data) : String(r.data);
  const idx = metaText.indexOf('BANKRECON');
  if (idx >= 0) {
    console.log('Found BANKRECON in metadata at char', idx);
    console.log(metaText.slice(Math.max(0, idx - 50), idx + 1000));
  } else {
    console.log('BANKRECON not found in metadata (first 200 chars):', metaText.slice(0, 200));
  }

  // 4. Try PATCH BANKLINESA ERECONNUM directly (just to see the error)
  console.log('\n=== PATCH BANKLINESA ERECONNUM=1 (expect readonly error) ===');
  // Use a dummy BANKPAGE+KLINE — just checking the error message
  r = await oReq('PATCH', `${odataBase}/BANKLINESA(BANKPAGE=16426,KLINE=84)`, wh, { ERECONNUM: 1 });
  console.log(`Status: ${r.status}`, r.ok ? 'OK (unexpected!)' : '(expected fail)');
  console.log(JSON.stringify(r.data, null, 2).slice(0, 500));

  // 5. Check current BANKLINESA row 16426/84 (the one we manually reconciled)
  console.log('\n=== GET BANKLINESA(16426,84) — check ERECONNUM ===');
  r = await oReq('GET', `${odataBase}/BANKLINESA(BANKPAGE=16426,KLINE=84)?$select=BPNUMA,ERECONNUM,CREDIT,DEBIT`, rh);
  console.log(`Status: ${r.status}`);
  console.log(JSON.stringify(r.data, null, 2));
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
