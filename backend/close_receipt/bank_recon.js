'use strict';
/**
 * Link a journal entry to its bank transaction and reconcile in BANKRECONSP.
 *
 * Flow:
 *   1. Set FNCREF on FNCTRANS (visible reference link — used when bank REF is available).
 *   2. Look up BPNUMA from BANKLINESA (needed for BANKRECONSP).
 *   3. Open BANKRECONSP form, create a reconciliation pair:
 *        FRST_BOOKNUM = BPNUMA (bank page)  +  SCND_IVNUM = journal FNCNUM
 *      Then run CLOSEBANKRECON to finalise.
 *   4. Fallback: if step 3 fails, run CREDITRECONSP + CLOSECREDITRECONSP.
 *
 * bankFncnum format: "BP{BANKPAGE}-{KLINE}" (the txn_id from the portal)
 *                   OR a raw bank REF string (when passed as bank_ref).
 *
 * Usage: node bank_recon.js <journalFncnum> <cashname> [bankFncnum]
 * Output: JSON to stdout — { ok, journalFncnum, bankFncnum, cashname, fncrefSet, reconOk }
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
const priority = require('priority-web-sdk');

function parseOdataUrl(odataUrl) {
  const url = (odataUrl || '').replace(/\/$/, '');
  const m = url.match(/^(https?:\/\/[^\/]+)\/odata\/Priority\/([^\/]+)\/(.+)$/);
  if (!m) throw new Error('Cannot parse Priority URL: ' + url);
  const [, base, tabulaini, company] = m;
  return { odataBase: url, serviceUrl: base + '/wcf/service.svc', tabulaini, company };
}

function withTimeout(promise, ms, label) {
  const t = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  );
  return Promise.race([promise, t]);
}

async function main() {
  const journalFncnum = (process.argv[2] || '').trim();
  const cashname      = (process.argv[3] || '').trim();
  const bankFncnum    = (process.argv[4] || '').trim();

  if (!cashname) throw new Error('Usage: node bank_recon.js <journalFncnum> <cashname> [bankFncnum]');

  const odataUrl = process.env.PRIORITY_URL_REAL || process.env.PRIORITY_URL || '';
  const { odataBase, serviceUrl, tabulaini, company } = parseOdataUrl(odataUrl);
  const authHeader = 'Basic ' + Buffer.from(
    `${process.env.PRIORITY_USERNAME}:${process.env.PRIORITY_PASSWORD}`
  ).toString('base64');
  const readHeaders  = { Authorization: authHeader, Accept: 'application/json', 'OData-Version': '4.0' };
  const writeHeaders = { ...readHeaders, 'Content-Type': 'application/json' };

  let fncrefSet = false;
  let reconOk   = false;

  // Parse BANKPAGE + KLINE from bankFncnum ("BP{n}-{k}" format = txn_id from portal)
  let bankPage = '', kline = '';
  const bpMatch = bankFncnum.match(/^BP(\d+)-(\d+)$/);
  if (bpMatch) {
    bankPage = bpMatch[1];
    kline    = bpMatch[2];
    process.stderr.write(`Parsed BANKPAGE=${bankPage} KLINE=${kline}\n`);
  }

  // Step 1: Look up BPNUMA + REF from BANKLINESA (single request)
  let bpnuma = '', bankRef = '';
  if (bankPage && kline) {
    try {
      const blResp = await withTimeout(
        fetch(`${odataBase}/BANKLINESA(BANKPAGE=${bankPage},KLINE=${kline})?$select=BPNUMA,REF`, { headers: readHeaders }),
        15000, `GET BANKLINESA`
      );
      if (blResp.ok) {
        const blData = await blResp.json();
        bpnuma  = (blData.BPNUMA || '').trim();
        bankRef = (blData.REF   || '').trim();
        process.stderr.write(`BPNUMA=${bpnuma} REF=${bankRef}\n`);
      }
    } catch (e) {
      process.stderr.write(`BANKLINESA lookup (non-fatal): ${e.message}\n`);
    }
  }

  // Step 2: Resolve actual journal FNCNUM when journalFncnum is a document IVNUM
  // (TINVOICES receipts, EINVOICES invoice-receipts, QINVOICES transfers all create an
  // FNCTRANS journal entry; BANKRECONSP SCND_IVNUM expects that FNCNUM, not the doc IVNUM)
  let resolvedFncnum = journalFncnum;
  if (journalFncnum && !/^\d+$/.test(journalFncnum)) {
    for (const entity of ['TINVOICES', 'EINVOICES', 'QINVOICES']) {
      try {
        const r = await withTimeout(
          fetch(`${odataBase}/${entity}?$filter=IVNUM eq '${journalFncnum}'&$select=FNCNUM&$top=1`, { headers: readHeaders }),
          10000, `GET ${entity} FNCNUM`
        );
        if (r.ok) {
          const data = await r.json();
          const fncnum = ((data.value || [])[0] || {}).FNCNUM;
          if (fncnum) {
            resolvedFncnum = String(fncnum);
            process.stderr.write(`Resolved ${entity} IVNUM=${journalFncnum} → FNCNUM=${resolvedFncnum}\n`);
            break;
          }
        }
      } catch (e) {
        process.stderr.write(`${entity} FNCNUM lookup (non-fatal): ${e.message}\n`);
      }
    }
  }

  // Step 3: FNCREF — link journal entry to bank REF (visible reference in Priority)
  if (resolvedFncnum && bankRef) {
    try {
      const checkResp = await withTimeout(
        fetch(`${odataBase}/FNCTRANS('${resolvedFncnum}')?$select=FNCNUM,FNCREF`, { headers: readHeaders }),
        15000, `GET FNCTRANS ${resolvedFncnum}`
      );
      if (checkResp.ok) {
        const current = await checkResp.json();
        if (!current.FNCREF) {
          const patchResp = await withTimeout(
            fetch(`${odataBase}/FNCTRANS('${resolvedFncnum}')`, {
              method: 'PATCH', headers: writeHeaders,
              body: JSON.stringify({ FNCREF: bankRef }),
            }),
            15000, `PATCH FNCTRANS FNCREF`
          );
          fncrefSet = patchResp.ok;
          process.stderr.write(`FNCREF set to ${bankRef}: ${patchResp.ok}\n`);
        } else {
          process.stderr.write(`FNCREF already set (${current.FNCREF}), skipping\n`);
        }
      }
    } catch (e) {
      process.stderr.write(`FNCREF patch (non-fatal): ${e.message}\n`);
    }
  }

  // Step 4: Login to WCF
  try {
    process.stderr.write(`Login → ${serviceUrl} (${company})\n`);
    await priority.login({
      username: process.env.PRIORITY_USERNAME,
      password: process.env.PRIORITY_PASSWORD,
      url: serviceUrl, tabulaini, language: 1, appname: 'TACT-BankRecon',
    });
    process.stderr.write('Login OK\n');
  } catch (e) {
    process.stderr.write(`Login failed (non-fatal): ${e.message}\n`);
    process.stdout.write(JSON.stringify({ ok: true, journalFncnum, bankFncnum, cashname, fncrefSet, reconOk }));
    return;
  }

  // Step 5: CREDITRECONSP (התאמה אוטומטית — basic bank matching) + CLOSECREDITRECONSP
  // BANKRECONSP manual row marking is not usable — the form requires CASHNAME context
  // that the Priority SDK cannot set when opening the form standalone. The only working
  // approach is CREDITRECONSP (option 1 = basic bank matching), which finds pairs by
  // amount + date + cashname and populates an internal work surface, then
  // CLOSECREDITRECONSP finalises those pairs and updates BANKLINESA.ERECONNUM.
  process.stderr.write('Running CREDITRECONSP (bank auto-match) + CLOSECREDITRECONSP\n');
  try {
    // CREDITRECONSP: choose option 1 = "התאמת בנק בסיסית" (basic bank matching)
    let step = await withTimeout(
      priority.procStart('CREDITRECONSP', 'P', null, company),
      30000, 'procStart CREDITRECONSP'
    );
    if (step?.type === 'inputOptions') {
      step = await withTimeout(step.proc.inputOptions(1, {}), 30000, 'CREDITRECONSP.inputOptions');
      let d = 0;
      while (step && d < 10) {
        const t = step.type;
        if (t === 'end' || t === 'finished') break;
        if (t === 'message' && step.proc?.message) {
          step = await withTimeout(step.proc.message(1), 30000, `CREDITRECONSP.msg${d}`);
        } else if (t === 'inputFields' && step.proc?.inputFields) {
          const fields = (step.input?.EditFields || []).map(f => ({
            field: f.field, op: 0, value: f.value || '', op2: 0, value2: f.value1 || '',
          }));
          step = await withTimeout(step.proc.inputFields(1, { EditFields: fields }), 30000, `CREDITRECONSP.input${d}`);
        } else if (step.proc?.continueProc) {
          step = await withTimeout(step.proc.continueProc(), 60000, `CREDITRECONSP.cont${d}`);
        } else break;
        d++;
      }
    }
    process.stderr.write('CREDITRECONSP done\n');

    // CLOSECREDITRECONSP: close auto-matched pairs
    // Steps: message("להמשיך בפעולה?") → inputFields(USER=<default>) → end
    // Note: "לא קיימים שורות" before end = no pairs found (CREDITRECONSP had nothing to match)
    let step2 = await withTimeout(
      priority.procStart('CLOSECREDITRECONSP', 'P', null, company),
      30000, 'procStart CLOSECREDITRECONSP'
    );
    let d2 = 0;
    let noRowsFound = false;
    while (step2 && d2 < 10) {
      const t = step2.type;
      process.stderr.write(`  CLOSECREDITRECONSP[${d2}] type=${t} msg=${(step2.message || '').slice(0, 80)}\n`);
      if (t === 'end' || t === 'finished') { reconOk = !noRowsFound; break; }
      if (t === 'message' && step2.proc?.message) {
        if ((step2.message || '').includes('לא קיימים')) {
          noRowsFound = true;
          process.stderr.write('  CLOSECREDITRECONSP: no rows to close (CREDITRECONSP found 0 pairs)\n');
        }
        step2 = await withTimeout(step2.proc.message(1), 30000, `CLOSECREDITRECONSP.msg${d2}`);
      } else if (t === 'inputFields' && step2.proc?.inputFields) {
        // USER field (ID=18 by default) — submit with the pre-filled default value
        const fields = (step2.input?.EditFields || []).map(f => ({
          field: f.field, op: 0, value: f.value || '', op2: 0, value2: f.value1 || '',
        }));
        process.stderr.write(`  CLOSECREDITRECONSP inputFields: ${JSON.stringify(fields)}\n`);
        step2 = await withTimeout(step2.proc.inputFields(1, { EditFields: fields }), 30000, `CLOSECREDITRECONSP.input${d2}`);
      } else if (step2.proc?.continueProc) {
        step2 = await withTimeout(step2.proc.continueProc(), 60000, `CLOSECREDITRECONSP.cont${d2}`);
      } else break;
      d2++;
    }
    process.stderr.write(`CLOSECREDITRECONSP done reconOk=${reconOk}\n`);
  } catch (e) {
    process.stderr.write(`CREDITRECONSP/CLOSECREDITRECONSP (non-fatal): ${e.message}\n`);
  }

  // Step 6: Verify reconciliation by checking BANKLINESA.ERECONNUM > 0 for our specific line
  if (bpnuma) {
    try {
      const verResp = await withTimeout(
        fetch(`${odataBase}/BANKLINESA?$filter=BPNUMA eq '${bpnuma}' and CASHNAME eq '${cashname}' and ERECONNUM gt 0&$select=BPNUMA,ERECONNUM&$top=1`, { headers: readHeaders }),
        10000, 'verify BANKLINESA ERECONNUM'
      );
      if (verResp.ok) {
        const verData = await verResp.json();
        const verified = (verData.value || []).length > 0;
        process.stderr.write(`Verification BPNUMA=${bpnuma} CASHNAME=${cashname} reconciled=${verified}\n`);
        if (verified) reconOk = true;
      }
    } catch (e) {
      process.stderr.write(`Verification (non-fatal): ${e.message}\n`);
    }
  }

  process.stdout.write(JSON.stringify({ ok: true, journalFncnum, bankFncnum, cashname, fncrefSet, reconOk }));
}

main().catch(err => {
  process.stderr.write('ERROR: ' + (err.message || String(err)) + '\n');
  process.stdout.write(JSON.stringify({ ok: false, error: err.message || String(err) }));
  process.exit(1);
});
