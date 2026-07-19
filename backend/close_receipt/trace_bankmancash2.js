'use strict';
/**
 * FIXED: activateStart signature is (ename, type, onProgress, onSuccess, onError)
 * Previous attempt had wrong param order — onSuccess was passed as onError position.
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

function dump(s) {
  return JSON.stringify({ type: s?.type, message: s?.message, input: s?.input }, null, 2);
}

async function main() {
  const cashname = (process.argv[2] || '111-201').trim();
  const odataUrl = process.env.PRIORITY_URL_REAL || process.env.PRIORITY_URL || '';
  const { serviceUrl, tabulaini, company } = parseOdataUrl(odataUrl);

  console.log(`Login → ${serviceUrl} (${company})`);
  await priority.login({
    username: process.env.PRIORITY_USERNAME,
    password: process.env.PRIORITY_PASSWORD,
    url: serviceUrl, tabulaini, language: 1, appname: 'trace2',
  });
  console.log('Login OK');

  const form = await withTimeout(priority.formStart('BANKRECON', null, null, company), 30000, 'formStart BANKRECON');
  console.log('BANKRECON open. activating BANKMANCASH...');

  // Correct signature: activateStart(ename, type, onProgress, onSuccess, onError)
  let step = await withTimeout(
    new Promise((resolve, reject) => {
      form.activateStart(
        'BANKMANCASH',  // ename
        null,            // type
        null,            // onProgress  (null = no progress cb)
        (s) => resolve(s),   // onSuccess ← 4th param
        (e) => reject(new Error(typeof e === 'string' ? e : JSON.stringify(e)))  // onError ← 5th param
      );
    }),
    120000, 'activateStart BANKMANCASH first step'  // 2-minute timeout
  );

  console.log('First step received!');
  console.log(dump(step));

  // Handle subsequent steps
  let i = 0;
  while (step && i < 20) {
    const t = step.type;
    console.log(`\n--- step[${i}] type=${t} ---`);
    if (t === 'end' || t === 'finished') { console.log('DONE'); break; }

    if (t === 'message') {
      step = await withTimeout(step.proc.message(1), 60000, `msg[${i}]`);
    } else if (t === 'inputFields') {
      const fields = (step.input?.EditFields || []).map(f => {
        let val = f.value || '';
        const isBank = (f.columnName || '').toUpperCase().includes('CASH')
                    || (f.title || '').includes('בנק')
                    || (f.title || '').includes('חשבון');
        if (cashname && isBank) {
          console.log(`  Injecting "${cashname}" into "${f.title}" (${f.columnName})`);
          val = cashname;
        } else {
          console.log(`  Field "${f.title}" (${f.columnName}) = "${val}"`);
        }
        return { field: f.field, op: 0, value: val, op2: 0, value2: '' };
      });
      step = await withTimeout(step.proc.inputFields(1, { EditFields: fields }), 300000, `inputFields[${i}]`);
    } else if (step.proc?.continueProc) {
      console.log('continueProc...');
      step = await withTimeout(step.proc.continueProc(), 300000, `cont[${i}]`);
    } else { break; }
    i++;
  }

  await form.endCurrentForm(false).catch(() => {});

  // Check if BANKRECON now has rows
  console.log('\nChecking BANKRECON rows after BANKMANCASH...');
  const form2 = await withTimeout(priority.formStart('BANKRECON', null, null, company), 30000, 'formStart2 BANKRECON');
  const rows = await withTimeout(form2.getRows(0), 30000, 'getRows BANKRECON');
  const arr = Array.isArray(rows) ? rows : Object.values(rows || {})[0] || [];
  console.log(`BANKRECON rows: ${arr.length}`);
  if (arr.length > 0) {
    console.log('First row:', JSON.stringify(arr[0]));
    console.log('Last row:', JSON.stringify(arr[arr.length - 1]));
  }
  await form2.endCurrentForm(false).catch(() => {});
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
