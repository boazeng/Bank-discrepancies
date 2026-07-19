'use strict';
/**
 * Trace BANKRECONSP rows — what does getRows() actually return?
 * Usage: node trace_bankreconsp.js [amount]
 * e.g.:  node trace_bankreconsp.js 2.70
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const priority = require('priority-web-sdk');

function parseOdataUrl(odataUrl) {
  const url = (odataUrl || '').replace(/\/$/, '');
  const m = url.match(/^(https?:\/\/[^\/]+)\/odata\/Priority\/([^\/]+)\/(.+)$/);
  if (!m) throw new Error('Cannot parse Priority URL: ' + url);
  const [, base, tabulaini, company] = m;
  return { serviceUrl: base + '/wcf/service.svc', tabulaini, company };
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timeout after ${ms}ms`)), ms)),
  ]);
}

async function main() {
  const targetAmount = parseFloat(process.argv[2] || '0');
  const odataUrl = process.env.PRIORITY_URL_REAL || process.env.PRIORITY_URL || '';
  const { serviceUrl, tabulaini, company } = parseOdataUrl(odataUrl);

  // Step 0: Initialize BANKRECON for API user via OData (USER=19, CASHNAME, BLINE=1)
  // This is required before BANKRECONSP will show any rows.
  const odataBase = odataUrl.replace(/\/$/, '');
  const auth = 'Basic ' + Buffer.from(`${process.env.PRIORITY_USERNAME}:${process.env.PRIORITY_PASSWORD}`).toString('base64');
  const wh = { Authorization: auth, Accept: 'application/json', 'OData-Version': '4.0', 'Content-Type': 'application/json' };
  const cashname = process.argv[3] || '111-201';

  console.log('=== Step 0: Init BANKRECON via OData ===');
  // Delete old row first (if exists), then create fresh
  await fetch(`${odataBase}/BANKRECON(USER=19,BLINE=1)`, { method: 'DELETE', headers: wh }).catch(() => {});
  const postR = await fetch(`${odataBase}/BANKRECON`, {
    method: 'POST', headers: wh,
    body: JSON.stringify({ USER: 19, CASHNAME: cashname, BLINE: 1 }),
  });
  console.log(`POST BANKRECON: ${postR.status} ${postR.ok ? 'OK' : 'FAIL'}`);
  if (!postR.ok) {
    const t = await postR.text();
    console.log('Error:', t.slice(0, 300));
  }

  // Verify
  const getR = await fetch(`${odataBase}/BANKRECON`, { headers: { ...wh, 'Content-Type': undefined } });
  const getD = await getR.json();
  console.log('BANKRECON rows after POST:', JSON.stringify(getD.value || [], null, 2));

  console.log('Login...');
  await priority.login({
    username: process.env.PRIORITY_USERNAME,
    password: process.env.PRIORITY_PASSWORD,
    url: serviceUrl, tabulaini, language: 1, appname: 'trace-bankreconsp',
  });
  console.log('Login OK\n');

  // Step 1: NEXTBANKRECON
  console.log('=== NEXTBANKRECON ===');
  let nbr = await withTimeout(priority.procStart('NEXTBANKRECON', 'P', null, company), 15000, 'NEXTBANKRECON');
  let i = 0;
  while (nbr && i < 10) {
    console.log(`  step[${i}] type=${nbr.type} msg=${(nbr.message||'').slice(0,80)}`);
    if (nbr.type === 'end' || nbr.type === 'finished') break;
    if (nbr.type === 'message') nbr = await withTimeout(nbr.proc.message(1), 10000, 'NBR.msg');
    else if (nbr.proc?.continueProc) nbr = await withTimeout(nbr.proc.continueProc(), 15000, 'NBR.cont');
    else break;
    i++;
  }
  console.log('NEXTBANKRECON done\n');

  // Step 2: Open BANKRECONSP
  console.log('=== formStart BANKRECONSP ===');
  const sp = await withTimeout(priority.formStart('BANKRECONSP', null, null, company), 30000, 'formStart');
  console.log('Form open. Columns:', Object.keys(sp.columns || {}).join(', ') || '(none)');

  // Step 2b: Try activating NEXTBANKRECON INSIDE the form (sets bank account context for the form)
  console.log('\n=== activateStart NEXTBANKRECON inside BANKRECONSP ===');
  try {
    let act = await withTimeout(
      new Promise((resolve, reject) => {
        sp.activateStart('NEXTBANKRECON', null, null, resolve, reject);
      }),
      20000, 'activateStart NEXTBANKRECON'
    );
    let j = 0;
    while (act && j < 10) {
      console.log(`  act[${j}] type=${act.type} msg=${(act.message||'').slice(0,80)}`);
      if (act.type === 'end' || act.type === 'finished') break;
      if (act.type === 'message') act = await withTimeout(act.proc.message(1), 10000, `act.msg${j}`);
      else if (act.proc?.continueProc) act = await withTimeout(act.proc.continueProc(), 15000, `act.cont${j}`);
      else break;
      j++;
    }
    console.log('activateStart NEXTBANKRECON done');
  } catch (e) {
    console.log('activateStart NEXTBANKRECON failed:', e.message);
  }

  // Step 3: getRows — try both 0 and 1 as start index
  for (const startIdx of [0, 1]) {
    console.log(`\n=== getRows(${startIdx}) ===`);
    try {
      const raw = await withTimeout(sp.getRows(startIdx), 30000, `getRows(${startIdx})`);
      console.log('Raw type:', typeof raw, Array.isArray(raw) ? `array[${raw.length}]` : '');
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        console.log('Keys:', Object.keys(raw));
      }

      const rows = Array.isArray(raw)
        ? raw
        : (Object.values(raw || {}).find(v => Array.isArray(v)) || []);
      console.log(`Total rows from getRows(${startIdx}): ${rows.length}`);
      if (rows.length > 0) {
        console.log('First row:', JSON.stringify(rows[0], null, 2));
        break; // found rows — no need to try other index
      }
    } catch (e) {
      console.log(`getRows(${startIdx}) error:`, e.message);
    }
  }

  // re-fetch for the rest of the script
  const raw2 = await withTimeout(sp.getRows(0), 30000, 'getRows final').catch(() => ({}));
  const rows = Array.isArray(raw2)
    ? raw2
    : (Object.values(raw2 || {}).find(v => Array.isArray(v)) || []);

  console.log(`\nTotal rows (final): ${rows.length}`);

  if (rows.length === 0) {
    console.log('NO ROWS — BANKRECONSP is empty (no unreconciled entries visible)');
  } else {
    console.log('\n--- First 3 rows (all fields): ---');
    rows.slice(0, 3).forEach((r, idx) => {
      console.log(`\nRow[${idx}]:`, JSON.stringify(r, null, 2));
    });

    if (targetAmount > 0) {
      console.log(`\n--- Searching for amount ${targetAmount} ---`);
      rows.forEach((r, idx) => {
        const frstMatch = Math.abs((r.FRST_SUM || 0) - targetAmount) < 0.01 ||
                          Math.abs((r.FRST_SUM || 0) + targetAmount) < 0.01;
        const scndMatch = Math.abs((r.SCND_SUM || 0) - targetAmount) < 0.01 ||
                          Math.abs((r.SCND_SUM || 0) + targetAmount) < 0.01;
        if (frstMatch || scndMatch) {
          console.log(`MATCH row[${idx}]:`, JSON.stringify(r));
        }
      });
    }
  }

  await sp.endCurrentForm(false).catch(() => {});
  console.log('\nDone.');
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
