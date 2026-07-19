'use strict';
/**
 * Trace BANKMANCASH form activation on BANKRECON — handle all inputFields steps.
 * Usage: node trace_bankmancash.js <cashname>
 * e.g.:  node trace_bankmancash.js "111-201"
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

function dumpStep(step) {
  return JSON.stringify({
    type: step?.type,
    message: step?.message,
    input: step?.input,
    options: step?.options,
  }, null, 2);
}

async function main() {
  const cashname = (process.argv[2] || '').trim();
  const odataUrl = process.env.PRIORITY_URL_REAL || process.env.PRIORITY_URL || '';
  const { serviceUrl, tabulaini, company } = parseOdataUrl(odataUrl);

  console.log(`Login → ${serviceUrl} (${company})`);
  await priority.login({
    username: process.env.PRIORITY_USERNAME,
    password: process.env.PRIORITY_PASSWORD,
    url: serviceUrl, tabulaini, language: 1, appname: 'trace-bankmancash',
  });
  console.log('Login OK\n');

  // Open BANKRECON form
  console.log('=== formStart BANKRECON ===');
  const form = await withTimeout(priority.formStart('BANKRECON', null, null, company), 30000, 'formStart BANKRECON');
  console.log('BANKRECON opened. columns:', Object.keys(form.columns || {}).join(', '));

  // Activate BANKMANCASH — use callback form so we can intercept steps
  console.log(`\n=== activateStart BANKMANCASH (cashname="${cashname}") ===`);

  let step;
  try {
    step = await withTimeout(
      new Promise((resolve, reject) => {
        form.activateStart('BANKMANCASH', null, null, null,
          (s) => resolve(s),   // onSuccess
          (e) => reject(new Error(typeof e === 'string' ? e : JSON.stringify(e)))
        );
      }),
      15000, 'activateStart BANKMANCASH initial'
    );
  } catch (e) {
    console.error('activateStart error:', e.message);
    await form.endCurrentForm(false).catch(() => {});
    return;
  }

  console.log('Initial step:', dumpStep(step));

  // Process subsequent steps
  let i = 0;
  while (step && i < 15) {
    const t = step.type;
    console.log(`\n--- step[${i}] type=${t} ---`);

    if (t === 'end' || t === 'finished') {
      console.log('>>> DONE');
      break;
    }

    if (t === 'message') {
      console.log('>>> message ACK');
      step = await withTimeout(step.proc.message(1), 60000, `message[${i}]`);

    } else if (t === 'inputFields') {
      const fields = (step.input?.EditFields || []).map(f => {
        let val = f.value || '';
        // Inject cashname into any bank account field
        if (cashname && (
          (f.fieldName || '').toUpperCase().includes('CASH') ||
          (f.columnName || '').toUpperCase().includes('CASH') ||
          (f.title || '').includes('חשבון') ||
          (f.title || '').includes('בנק')
        )) {
          console.log(`   Injecting "${cashname}" into field ${f.field} "${f.title}" (${f.columnName || f.fieldName})`);
          val = cashname;
        } else {
          console.log(`   Field ${f.field} "${f.title}" (${f.columnName || f.fieldName}) = "${val}" [default]`);
        }
        return { field: f.field, op: 0, value: val, op2: 0, value2: '' };
      });
      console.log('>>> inputFields submitting:', JSON.stringify(fields));
      // Give it a long timeout — loading BANKRECON work table takes time
      step = await withTimeout(step.proc.inputFields(1, { EditFields: fields }), 300000, `inputFields[${i}]`);

    } else if (t === 'inputOptions') {
      console.log('>>> inputOptions → pick 1');
      step = await withTimeout(step.proc.inputOptions(1, {}), 30000, `inputOptions[${i}]`);

    } else {
      if (step.proc?.continueProc) {
        console.log('>>> continueProc');
        step = await withTimeout(step.proc.continueProc(), 300000, `continueProc[${i}]`);
      } else {
        console.log('>>> Unknown step type, stopping');
        break;
      }
    }
    i++;
  }

  await form.endCurrentForm(false).catch(() => {});
  console.log('\n=== Done ===');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
