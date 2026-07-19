'use strict';
/**
 * Compare FNCTRANS fields: reconciled (26010805) vs recent unreconciled.
 * Looking for a "RECONNUM" or reconciliation flag field we can set directly.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

async function main() {
  const base = (process.env.PRIORITY_URL_REAL || process.env.PRIORITY_URL || '').replace(/\/$/, '');
  const auth = 'Basic ' + Buffer.from(`${process.env.PRIORITY_USERNAME}:${process.env.PRIORITY_PASSWORD}`).toString('base64');
  const rh = { Authorization: auth, Accept: 'application/json', 'OData-Version': '4.0' };
  const wh = { ...rh, 'Content-Type': 'application/json' };

  // 1. GET the already-reconciled FNCTRANS (all fields, no $select)
  console.log('=== GET FNCTRANS(26010805) — all fields ===');
  const r1 = await fetch(`${base}/FNCTRANS('26010805')`, { headers: rh });
  const d1 = await r1.json();
  console.log(JSON.stringify(d1, null, 2));

  // 2. GET a recent FNCTRANS (likely unreconciled)
  console.log('\n=== GET FNCTRANS — recent entry (all fields) ===');
  const r2 = await fetch(`${base}/FNCTRANS?$top=1&$orderby=FNCNUM desc`, { headers: rh });
  const d2 = await r2.json();
  const recent = (d2.value || [])[0];
  if (recent) {
    const r3 = await fetch(`${base}/FNCTRANS('${recent.FNCNUM}')`, { headers: rh });
    const d3 = await r3.json();
    console.log(`FNCNUM=${recent.FNCNUM}:`);
    console.log(JSON.stringify(d3, null, 2));

    // 3. Show diff: which fields are different between reconciled vs unreconciled
    console.log('\n=== Field comparison (reconciled vs recent) ===');
    for (const key of Object.keys(d1)) {
      const v1 = d1[key], v2 = d3[key];
      if (JSON.stringify(v1) !== JSON.stringify(v2)) {
        console.log(`  ${key}: reconciled=${JSON.stringify(v1)}  recent=${JSON.stringify(v2)}`);
      }
    }
  }

  // 4. Try PATCH on unreconciled FNCTRANS — set RECONNUM (if field exists)
  if (recent && d1.RECONNUM !== undefined) {
    console.log(`\n=== Try PATCH FNCTRANS('${recent.FNCNUM}') RECONNUM=${d1.RECONNUM} ===`);
    const pr = await fetch(`${base}/FNCTRANS('${recent.FNCNUM}')`, {
      method: 'PATCH', headers: wh,
      body: JSON.stringify({ RECONNUM: d1.RECONNUM }),
    });
    const pt = await pr.text();
    console.log(`Status: ${pr.status}`, pr.ok ? '✓' : '✗');
    if (!pr.ok) console.log(pt.slice(0, 300));
  }
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
