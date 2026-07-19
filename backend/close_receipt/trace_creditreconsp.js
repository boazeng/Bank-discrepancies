'use strict';
/**
 * Trace every step that CREDITRECONSP + CLOSECREDITRECONSP sends.
 * Usage: node trace_creditreconsp.js [cashname]
 * e.g.:  node trace_creditreconsp.js "111-201"
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
  const t = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  );
  return Promise.race([promise, t]);
}

function dump(step) {
  return JSON.stringify({
    type:       step?.type,
    message:    step?.message,
    title:      step?.title,
    inputType:  step?.inputType,
    input:      step?.input,
    options:    step?.options,
  }, null, 2);
}

async function runProc(name, company, cashname) {
  console.log(`\n${'='.repeat(60)}\n=== ${name} ===\n${'='.repeat(60)}`);

  let step = await withTimeout(priority.procStart(name, 'P', null, company), 30000, `procStart ${name}`);
  let i = 0;

  while (step && i < 20) {
    console.log(`\n--- step[${i}] ---`);
    console.log(dump(step));

    const t = step.type;
    if (t === 'end' || t === 'finished') {
      console.log(`>>> ${name} ENDED at step ${i}`);
      break;
    }

    if (t === 'inputOptions') {
      // always pick option 1 (bank matching)
      console.log('>>> inputOptions → picking option 1');
      step = await withTimeout(step.proc.inputOptions(1, {}), 30000, `inputOptions[${i}]`);

    } else if (t === 'message') {
      console.log('>>> message → ACK (1)');
      step = await withTimeout(step.proc.message(1), 30000, `message[${i}]`);

    } else if (t === 'inputFields') {
      // Log exact fields and inject cashname if asked
      const fields = (step.input?.EditFields || []).map(f => {
        let val = f.value || '';
        // If field looks like a bank account / CASHNAME field and cashname was given
        if (cashname && (
          (f.fieldName || '').toUpperCase().includes('CASH') ||
          (f.fieldDes  || '').includes('חשבון') ||
          (f.fieldDes  || '').includes('בנק')
        )) {
          console.log(`   >>> Injecting cashname "${cashname}" into field ${f.field} (${f.fieldName}/${f.fieldDes})`);
          val = cashname;
        }
        return { field: f.field, op: 0, value: val, op2: 0, value2: f.value1 || '' };
      });
      console.log('>>> inputFields → submitting:', JSON.stringify(fields));
      step = await withTimeout(step.proc.inputFields(1, { EditFields: fields }), 30000, `inputFields[${i}]`);

    } else {
      if (step.proc?.continueProc) {
        console.log('>>> continueProc');
        step = await withTimeout(step.proc.continueProc(), 60000, `continueProc[${i}]`);
      } else {
        console.log('>>> UNKNOWN TYPE — stopping');
        break;
      }
    }
    i++;
  }
}

async function main() {
  const cashname = (process.argv[2] || '').trim();
  const odataUrl = process.env.PRIORITY_URL_REAL || process.env.PRIORITY_URL || '';
  const { serviceUrl, tabulaini, company } = parseOdataUrl(odataUrl);

  console.log(`Login → ${serviceUrl} (${company})`);
  await priority.login({
    username: process.env.PRIORITY_USERNAME,
    password: process.env.PRIORITY_PASSWORD,
    url: serviceUrl, tabulaini, language: 1, appname: 'trace',
  });
  console.log('Login OK');

  await runProc('CREDITRECONSP', company, cashname);
  await runProc('CLOSECREDITRECONSP', company, cashname);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
