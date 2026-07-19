'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

async function main() {
  const base = (process.env.PRIORITY_URL_REAL || process.env.PRIORITY_URL || '').replace(/\/$/, '');
  const auth = 'Basic ' + Buffer.from(`${process.env.PRIORITY_USERNAME}:${process.env.PRIORITY_PASSWORD}`).toString('base64');
  const rh = { Authorization: auth, Accept: 'application/json', 'OData-Version': '4.0' };
  const wh = { ...rh, 'Content-Type': 'application/json' };

  // 1. Fetch full $metadata XML — search for BANKRECON entity type
  console.log('=== Fetching $metadata XML for BANKRECON ===');
  const metaR = await fetch(`${base}/$metadata`, {
    headers: { Authorization: auth, Accept: 'application/xml' }
  });
  const metaXml = await metaR.text();
  // Find the BANKRECON EntityType block
  const start = metaXml.indexOf('EntityType Name="BANKRECON"');
  if (start < 0) {
    console.log('BANKRECON not found in metadata!');
    console.log('First 500 chars:', metaXml.slice(0, 500));
  } else {
    const end = metaXml.indexOf('</EntityType>', start) + '</EntityType>'.length;
    console.log(metaXml.slice(start, end));
  }

  // 2. Check what fields CASH entity has
  console.log('\n=== CASH entity fields (via $metadata) ===');
  const startC = metaXml.indexOf('EntityType Name="CASH"');
  if (startC < 0) {
    console.log('CASH not found');
  } else {
    const endC = metaXml.indexOf('</EntityType>', startC) + '</EntityType>'.length;
    console.log(metaXml.slice(startC, endC));
  }

  // 3. Try GET CASH to find our account
  console.log('\n=== GET CASH?$top=5 ===');
  const cr = await fetch(`${base}/CASH?$top=5`, { headers: rh });
  const cd = await cr.json();
  console.log(JSON.stringify(cd, null, 2).slice(0, 1000));
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
