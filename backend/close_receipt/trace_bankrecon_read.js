'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

async function main() {
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

  // 1. Find the manually reconciled record (RECONNUM=61)
  console.log('=== GET BANKRECON?$filter=RECONNUM eq 61 ===');
  let r = await get(`${base}/BANKRECON?$filter=RECONNUM eq 61`);
  console.log(`Status: ${r.status}`);
  console.log(JSON.stringify(r.data, null, 2));

  // 2. Try without filter — maybe returns all records accessible
  console.log('\n=== GET BANKRECON (no filter) ===');
  r = await get(`${base}/BANKRECON`);
  console.log(`Status: ${r.status} — rows: ${(r.data?.value || []).length}`);

  // 3. Try top 1 with orderby to see any record
  console.log('\n=== GET BANKRECON?$top=3&$orderby=RECONNUM desc ===');
  r = await get(`${base}/BANKRECON?$top=3&$orderby=RECONNUM desc`);
  console.log(`Status: ${r.status}`);
  console.log(JSON.stringify(r.data, null, 2).slice(0, 1000));

  // 4. Try POST to BANKRECON with the reconciliation data we know
  // For the manually reconciled receipt RC26111000001:
  //   BANKPAGE=16426, KLINE=84, BPNUMA='2', CREDIT=23600, ERECONNUM=61
  //   FNCNUM=26010805 (from memory/previous session)
  console.log('\n=== POST BANKRECON (attempt to create reconciliation record) ===');
  const body = {
    CASHNAME: '111-201',
    BOOKNUM: '2',
    FNCNUM: '26010805',   // string!
    BPNUMA: '2',
    BANKSUM: 23600,
    BOOKSUM: 23600,
  };
  console.log('Body:', JSON.stringify(body));
  r = await fetch(`${base}/BANKRECON`, { method: 'POST', headers: wh, body: JSON.stringify(body) });
  const rt = await r.text();
  let rd; try { rd = JSON.parse(rt); } catch { rd = { raw: rt.slice(0, 600) }; }
  console.log(`Status: ${r.status}`, r.ok ? '✓ SUCCESS' : '✗ FAIL');
  console.log(JSON.stringify(rd, null, 2));
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
