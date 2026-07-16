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

  // Step 5: BANKRECONSP (split reconciliation surface) — mark matching row RECON=Y
  // CREDITRECONSP never finds pairs in this company because it needs the BANKRECON work table
  // to be pre-populated (only done by Priority's browser session, not via API).
  // BANKRECONSP is a direct view of BANKLINESA+FNCTRANS entries: when unreconciled entries
  // exist, the form returns them as rows. We find our specific row and mark RECON=Y, then
  // CLOSEBANKRECONISP creates the reconciliation record.
  // Fallback: CREDITRECONSP as backup in case BANKRECONSP approach fails.
  process.stderr.write('Attempting BANKRECONSP reconciliation\n');

  // Determine the credit/debit amount of our bank line for matching
  let bankLineCredit = 0, bankLineDebit = 0;
  if (bankPage && kline) {
    try {
      const blAmt = await withTimeout(
        fetch(`${odataBase}/BANKLINESA(BANKPAGE=${bankPage},KLINE=${kline})?$select=CREDIT,DEBIT`, { headers: readHeaders }),
        10000, 'GET BANKLINESA amounts'
      );
      if (blAmt.ok) {
        const d = await blAmt.json();
        bankLineCredit = d.CREDIT || 0;
        bankLineDebit  = d.DEBIT  || 0;
        process.stderr.write(`Bank line amounts: CREDIT=${bankLineCredit} DEBIT=${bankLineDebit}\n`);
      }
    } catch (e) {
      process.stderr.write(`BANKLINESA amounts (non-fatal): ${e.message}\n`);
    }
  }
  const bankAmount = bankLineCredit || bankLineDebit;

  try {
    // Initialize bank account context (selects the configured bank account for reconciliation)
    let nbr = await withTimeout(priority.procStart('NEXTBANKRECON', 'P', null, company), 15000, 'NEXTBANKRECON');
    while (nbr && nbr.type !== 'end' && nbr.type !== 'finished') {
      if (nbr.type === 'message') nbr = await withTimeout(nbr.proc.message(1), 10000, 'NBR.msg');
      else if (nbr.proc?.continueProc) nbr = await withTimeout(nbr.proc.continueProc(), 15000, 'NBR.cont');
      else break;
    }
    process.stderr.write('NEXTBANKRECON done\n');

    // Open BANKRECONSP — shows unreconciled BANKLINESA and FNCTRANS rows when they exist
    const sp = await withTimeout(priority.formStart('BANKRECONSP', null, null, company), 30000, 'formStart BANKRECONSP');
    const rawRows = await withTimeout(sp.getRows(0), 30000, 'getRows BANKRECONSP');

    // SDK returns { 'BANKRECONSP': [...] } or flat array
    const spRows = Array.isArray(rawRows)
      ? rawRows
      : (Object.values(rawRows || {}).find(v => Array.isArray(v)) || []);
    process.stderr.write(`BANKRECONSP rows visible: ${spRows.length}\n`);

    // Find matching rows:
    //   Bank-side row:  FRST_SUM == bankAmount  AND  FRST_BOOKNUM == bpnuma (if known)
    //   Books-side row: SCND_IVNUM == resolvedFncnum  OR  SCND_SUM == bankAmount
    const matchRow = (row) => {
      const bankMatch = bankAmount > 0 && Math.abs((row.FRST_SUM || 0) - bankAmount) < 0.01;
      const bpMatch   = bpnuma && row.FRST_BOOKNUM === bpnuma;
      const fncMatch  = resolvedFncnum && row.SCND_IVNUM === resolvedFncnum;
      const booksAmt  = bankAmount > 0 && Math.abs((row.SCND_SUM || 0) - bankAmount) < 0.01;
      return (bankMatch && (bpMatch || !bpnuma)) || fncMatch || (booksAmt && fncMatch);
    };

    let markedCount = 0;
    for (let i = 0; i < spRows.length; i++) {
      const row = spRows[i];
      if (row.RECON === 'Y') continue;
      if (!matchRow(row)) continue;

      process.stderr.write(
        `Marking row[${i}]: FRST_BOOKNUM=${row.FRST_BOOKNUM} FRST_SUM=${row.FRST_SUM} ` +
        `SCND_IVNUM=${row.SCND_IVNUM} SCND_SUM=${row.SCND_SUM}\n`
      );
      try {
        await withTimeout(sp.setActiveRow(i), 10000, `setActiveRow[${i}]`);
        await withTimeout(sp.fieldUpdate('RECON', 'Y'), 10000, `fieldUpdate RECON[${i}]`);
        await withTimeout(sp.saveRow(0), 20000, `saveRow[${i}]`);
        markedCount++;
        process.stderr.write(`Row[${i}] marked RECON=Y\n`);
      } catch (rowErr) {
        process.stderr.write(`Mark row[${i}] failed (non-fatal): ${rowErr.message}\n`);
      }
    }

    if (markedCount > 0) {
      // CLOSEBANKRECONISP finalises RECON=Y-marked pairs into reconciliation records
      let cbi = await withTimeout(priority.procStart('CLOSEBANKRECONISP', 'P', null, company), 15000, 'CLOSEBANKRECONISP');
      while (cbi && cbi.type !== 'end' && cbi.type !== 'finished') {
        const ct = cbi.type;
        process.stderr.write(`CLOSEBANKRECONISP type=${ct} msg=${(cbi.message || '').slice(0, 80)}\n`);
        if (ct === 'message') cbi = await withTimeout(cbi.proc.message(1), 15000, 'CBI.msg');
        else if (ct === 'inputFields') {
          const f = (cbi.input?.EditFields || []).map(x => ({ field: x.field, op: 0, value: x.value || '', op2: 0, value2: '' }));
          cbi = await withTimeout(cbi.proc.inputFields(1, { EditFields: f }), 15000, 'CBI.if');
        } else if (cbi.proc?.continueProc) cbi = await withTimeout(cbi.proc.continueProc(), 30000, 'CBI.cont');
        else break;
      }
      process.stderr.write('CLOSEBANKRECONISP done\n');
    } else {
      process.stderr.write('BANKRECONSP: no matching rows to mark (entry may not exist yet, already reconciled, or USER context missing)\n');
    }

    await sp.endCurrentForm(false).catch(() => {});
  } catch (e) {
    process.stderr.write(`BANKRECONSP (non-fatal): ${e.message}\n`);
  }

  // Step 5b: CREDITRECONSP fallback (usually finds 0 pairs but kept as safety net)
  process.stderr.write('Running CREDITRECONSP fallback\n');
  try {
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

    let step2 = await withTimeout(
      priority.procStart('CLOSECREDITRECONSP', 'P', null, company),
      30000, 'procStart CLOSECREDITRECONSP'
    );
    let d2 = 0;
    let noRowsFound = false;
    while (step2 && d2 < 10) {
      const t = step2.type;
      if (t === 'end' || t === 'finished') { if (!noRowsFound) reconOk = true; break; }
      if (t === 'message' && step2.proc?.message) {
        if ((step2.message || '').includes('לא קיימים')) noRowsFound = true;
        step2 = await withTimeout(step2.proc.message(1), 30000, `CLOSECREDITRECONSP.msg${d2}`);
      } else if (t === 'inputFields' && step2.proc?.inputFields) {
        const fields = (step2.input?.EditFields || []).map(f => ({
          field: f.field, op: 0, value: f.value || '', op2: 0, value2: f.value1 || '',
        }));
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

  // Step 6: Verify reconciliation by checking BANKLINESA.ERECONNUM > 0 for this specific line.
  // Uses BANKPAGE+KLINE composite key (unique) rather than BPNUMA (not unique across pages).
  if (bankPage && kline) {
    try {
      const verResp = await withTimeout(
        fetch(`${odataBase}/BANKLINESA(BANKPAGE=${bankPage},KLINE=${kline})?$select=BPNUMA,ERECONNUM`, { headers: readHeaders }),
        10000, 'verify BANKLINESA ERECONNUM'
      );
      if (verResp.ok) {
        const verData = await verResp.json();
        const verified = (verData.ERECONNUM || 0) > 0;
        process.stderr.write(`Verification BANKPAGE=${bankPage} KLINE=${kline} ERECONNUM=${verData.ERECONNUM} reconciled=${verified}\n`);
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
