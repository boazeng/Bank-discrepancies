'use strict';
/**
 * Find the real field names of BANKRECON and update the row (USER=19, BLINE=1)
 * with the correct bank account identifier.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

async function main() {
  const cashname = (process.argv[2] || '111-201').trim();
  const base = (process.env.PRIORITY_URL_REAL || process.env.PRIORITY_URL || '').replace(/\/$/, '');
  const auth = 'Basic ' + Buffer.from(`${process.env.PRIORITY_USERNAME}:${process.env.PRIORITY_PASSWORD}`).toString('base64');
  const rh = { Authorization: auth, Accept: 'application/json', 'OData-Version': '4.0' };
  const wh = { ...rh, 'Content-Type': 'application/json' };

  const get = async (url) => {
    const r = await fetch(url, { headers: rh });
    const t = await r.text();
    try { return { status: r.status, ok: r.ok, data: JSON.parse(t) }; }
    catch { return { status: r.status, ok: r.ok, data: { raw: t.slice(0, 600) } }; }
  };
  const patch = async (url, body) => {
    const r = await fetch(url, { method: 'PATCH', headers: wh, body: JSON.stringify(body) });
    const t = await r.text();
    try { return { status: r.status, ok: r.ok, data: JSON.parse(t) }; }
    catch { return { status: r.status, ok: r.ok, data: { raw: t.slice(0, 600) } }; }
  };

  // 1. Try to GET BANKRECON filtered by USER=19 (the row BANKMANCASH can see)
  console.log('=== GET BANKRECON?$filter=USER eq 19 ===');
  let r = await get(`${base}/BANKRECON?$filter=USER eq 19`);
  console.log(`Status: ${r.status}`);
  console.log(JSON.stringify(r.data, null, 2).slice(0, 800));

  // 2. Try to GET the specific row by composite key
  console.log('\n=== GET BANKRECON(USER=19,BLINE=1) ===');
  r = await get(`${base}/BANKRECON(USER=19,BLINE=1)`);
  console.log(`Status: ${r.status}`);
  console.log(JSON.stringify(r.data, null, 2).slice(0, 800));

  // 3. Try $select with wrong field names to discover what Priority accepts
  console.log('\n=== GET BANKRECON?$select=USER,BLINE,CASHNAME,FNCNAME,ACCNAME,ACCNUM,CURNAME ===');
  r = await get(`${base}/BANKRECON?$select=USER,BLINE,CASHNAME,FNCNAME,ACCNAME,ACCNUM,CURNAME`);
  console.log(`Status: ${r.status}`);
  console.log(JSON.stringify(r.data, null, 2).slice(0, 800));

  // 4. PATCH the existing row (USER=19, BLINE=1) with different field names
  const patchAttempts = [
    { CASHNAME: cashname },
    { FNCNAME: cashname },
    { ACCNAME: cashname },
    { ACCNUM: cashname },
    { BNKNAME: cashname },
    { CASHNAME: cashname, CURNAME: 'ILS' },
  ];
  for (const body of patchAttempts) {
    console.log(`\n=== PATCH BANKRECON(USER=19,BLINE=1) ${JSON.stringify(body)} ===`);
    r = await patch(`${base}/BANKRECON(USER=19,BLINE=1)`, body);
    console.log(`Status: ${r.status}`, r.ok ? '✓ SUCCESS' : '✗ FAIL');
    if (!r.ok) console.log(JSON.stringify(r.data, null, 2).slice(0, 300));
    else break;
  }

  // 5. Check CASH entity — find the right identifier for our bank account
  console.log('\n=== GET CASH?$filter=CASHNAME eq \'111-201\'&$select=CASHNAME,CASHDES,ACCNAME,CURNAME ===');
  r = await get(`${base}/CASH?$filter=CASHNAME eq '111-201'&$select=CASHNAME,CASHDES,ACCNAME,CURNAME`);
  console.log(`Status: ${r.status}`);
  console.log(JSON.stringify(r.data, null, 2).slice(0, 800));
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
