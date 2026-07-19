'use strict';
/**
 * Diagnostic: read RECONMETHODS + RECONMETHODSTEPS via OData (not WCF).
 * Usage: node diagnose_reconmethods.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

function parseOdataUrl(odataUrl) {
  const url = (odataUrl || '').replace(/\/$/, '');
  const m = url.match(/^(https?:\/\/[^\/]+)\/odata\/Priority\/([^\/]+)\/(.+)$/);
  if (!m) throw new Error('Cannot parse Priority URL: ' + url);
  const [, base, tabulaini, company] = m;
  return { odataBase: url, serviceUrl: base + '/wcf/service.svc', tabulaini, company };
}

async function oget(url, headers) {
  const r = await fetch(url, { headers });
  const text = await r.text();
  if (!r.ok) return { error: r.status, body: text.slice(0, 300) };
  try { return JSON.parse(text); } catch { return { raw: text.slice(0, 300) }; }
}

async function main() {
  const odataUrl = process.env.PRIORITY_URL_REAL || process.env.PRIORITY_URL || '';
  const { odataBase } = parseOdataUrl(odataUrl);
  const auth = 'Basic ' + Buffer.from(
    `${process.env.PRIORITY_USERNAME}:${process.env.PRIORITY_PASSWORD}`
  ).toString('base64');
  const headers = { Authorization: auth, Accept: 'application/json', 'OData-Version': '4.0' };

  console.log('Base:', odataBase, '\n');

  // 1. Read RECONMETHODS
  console.log('=== GET RECONMETHODS ===');
  const rm = await oget(`${odataBase}/RECONMETHODS`, headers);
  console.log(JSON.stringify(rm, null, 2));

  // 2. Try $expand to get RECONMETHODSTEPS inline
  console.log('\n=== GET RECONMETHODS?$expand=RECONMETHODSTEPS_SUBFORM ===');
  const rmExpand = await oget(`${odataBase}/RECONMETHODS?$expand=RECONMETHODSTEPS_SUBFORM`, headers);
  console.log(JSON.stringify(rmExpand, null, 2));

  // 3. Try direct RECONMETHODSTEPS entity
  console.log('\n=== GET RECONMETHODSTEPS ===');
  const rms = await oget(`${odataBase}/RECONMETHODSTEPS`, headers);
  console.log(JSON.stringify(rms, null, 2));

  // 4. Navigate from method B
  console.log('\n=== GET RECONMETHODS(\'B\')/RECONMETHODSTEPS_SUBFORM ===');
  const rmB = await oget(`${odataBase}/RECONMETHODS('B')/RECONMETHODSTEPS_SUBFORM`, headers);
  console.log(JSON.stringify(rmB, null, 2));

  // 5. Try common subform navigation names
  const navNames = ['RECONMETHODSTEPS', 'RECONMETHODSSTEPS', 'RECONMETHODSTEP'];
  for (const nav of navNames) {
    console.log(`\n=== RECONMETHODS('B')/${nav} ===`);
    const r = await oget(`${odataBase}/RECONMETHODS('B')/${nav}`, headers);
    console.log(JSON.stringify(r, null, 2));
  }
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
