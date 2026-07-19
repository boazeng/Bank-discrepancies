'use strict';
/**
 * Test: procStart BANKMANCASH standalone — what happens after submitting BLINE?
 * Does it ask for CASHNAME next? Does it create a BANKRECON row?
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
  const cashname = (process.argv[2] || '111-201').trim();
  const odataUrl = process.env.PRIORITY_URL_REAL || process.env.PRIORITY_URL || '';
  const { serviceUrl, tabulaini, company } = parseOdataUrl(odataUrl);

  await priority.login({
    username: process.env.PRIORITY_USERNAME,
    password: process.env.PRIORITY_PASSWORD,
    url: serviceUrl, tabulaini, language: 1, appname: 'trace-bmc3',
  });
  console.log('Login OK\n');

  console.log('=== procStart BANKMANCASH (standalone) ===');
  let step = await withTimeout(priority.procStart('BANKMANCASH', 'P', null, company), 15000, 'procStart BANKMANCASH');

  let i = 0;
  while (step && i < 15) {
    const t = step.type;
    console.log(`\nstep[${i}] type=${t}`);
    if (step.message) console.log('  message:', step.message);
    if (step.input)   console.log('  input:', JSON.stringify(step.input));
    if (step.options) console.log('  options:', JSON.stringify(step.options));

    if (t === 'end' || t === 'finished') { console.log('DONE'); break; }

    if (t === 'inputFields') {
      const fields = (step.input?.EditFields || []).map(f => {
        let val = f.value || '';
        const name = (f.columnName || f.fieldName || '').toUpperCase();
        const title = f.title || '';
        console.log(`  field: "${title}" (${name}) default="${val}"`);

        // Inject values based on field name
        if (name === 'BLINE' || title.includes('שורה')) {
          val = '1';
          console.log(`  → injecting BLINE=1`);
        } else if (name.includes('CASH') || name.includes('ACC') || title.includes('חשבון') || title.includes('בנק')) {
          val = cashname;
          console.log(`  → injecting cashname="${cashname}"`);
        }
        return { field: f.field, op: 0, value: val, op2: 0, value2: '' };
      });
      step = await withTimeout(step.proc.inputFields(1, { EditFields: fields }), 30000, `inputFields[${i}]`);

    } else if (t === 'message') {
      step = await withTimeout(step.proc.message(1), 15000, `msg[${i}]`);

    } else if (t === 'inputOptions') {
      console.log('  options:', JSON.stringify(step.options));
      step = await withTimeout(step.proc.inputOptions(1, {}), 15000, `opts[${i}]`);

    } else if (step.proc?.continueProc) {
      step = await withTimeout(step.proc.continueProc(), 30000, `cont[${i}]`);
    } else break;
    i++;
  }

  // After BANKMANCASH, check if BANKRECONSP shows rows
  console.log('\n=== formStart BANKRECONSP after BANKMANCASH ===');
  const sp = await withTimeout(priority.formStart('BANKRECONSP', null, null, company), 30000, 'formStart BANKRECONSP');
  const raw = await withTimeout(sp.getRows(0), 30000, 'getRows');
  const rows = Array.isArray(raw) ? raw : (Object.values(raw || {}).find(v => Array.isArray(v)) || []);
  console.log(`BANKRECONSP rows: ${rows.length}`);
  if (rows.length > 0) console.log('First row:', JSON.stringify(rows[0], null, 2));
  await sp.endCurrentForm(false).catch(() => {});
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
