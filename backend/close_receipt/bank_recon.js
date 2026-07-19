'use strict';
/**
 * Link a journal entry to its bank transaction via FNCREF.
 *
 * Flow:
 *   1. Look up BPNUMA + REF from BANKLINESA (needed for FNCREF).
 *   2. Resolve IVNUM → FNCNUM (if journalFncnum is a document number, not a journal number).
 *   3. Set FNCREF on FNCTRANS (links journal to bank reference — visible in reconciliation screen).
 *   4. Verify BANKLINESA.ERECONNUM (bank reconciliation must be done manually in Priority browser).
 *
 * Note: automatic bank reconciliation via API is not possible in Priority.
 * Pending Priority support response — see git history to restore the BANKRECONSP/CREDITRECONSP attempts.
 *
 * Usage: node bank_recon.js <journalFncnum> <cashname> [bankFncnum]
 * Output: JSON to stdout — { ok, journalFncnum, bankFncnum, cashname, fncrefSet, reconOk }
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

async function main() {
  const journalFncnum = (process.argv[2] || '').trim();
  const cashname      = (process.argv[3] || '').trim();
  const bankFncnum    = (process.argv[4] || '').trim();

  if (!cashname) throw new Error('Usage: node bank_recon.js <journalFncnum> <cashname> [bankFncnum]');

  const odataBase = (process.env.PRIORITY_URL_REAL || process.env.PRIORITY_URL || '').replace(/\/$/, '');
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

  // Step 1: Look up BPNUMA + REF from BANKLINESA
  let bankRef = '';
  if (bankPage && kline) {
    try {
      const blResp = await withTimeout(
        fetch(`${odataBase}/BANKLINESA(BANKPAGE=${bankPage},KLINE=${kline})?$select=BPNUMA,REF`, { headers: readHeaders }),
        15000, 'GET BANKLINESA'
      );
      if (blResp.ok) {
        const blData = await blResp.json();
        bankRef = (blData.REF || '').trim();
        process.stderr.write(`BPNUMA=${blData.BPNUMA} REF=${bankRef}\n`);
      }
    } catch (e) {
      process.stderr.write(`BANKLINESA lookup (non-fatal): ${e.message}\n`);
    }
  }

  // Step 2: Resolve IVNUM → FNCNUM when journalFncnum is a document number
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

  // Step 3: FNCREF — link journal entry to bank REF
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
            15000, 'PATCH FNCTRANS FNCREF'
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

  // Step 4: Verify BANKLINESA.ERECONNUM (informational — cannot be set via API)
  if (bankPage && kline) {
    try {
      const verResp = await withTimeout(
        fetch(`${odataBase}/BANKLINESA(BANKPAGE=${bankPage},KLINE=${kline})?$select=ERECONNUM`, { headers: readHeaders }),
        10000, 'verify BANKLINESA ERECONNUM'
      );
      if (verResp.ok) {
        const verData = await verResp.json();
        reconOk = (verData.ERECONNUM || 0) > 0;
        process.stderr.write(`ERECONNUM=${verData.ERECONNUM} reconciled=${reconOk}\n`);
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
