"""
Backend API server for Bank Discrepancies (הפקת קבלות).
Standalone server — receipts routes only.
"""

import sys
import os
import io
import json
import tempfile
import importlib.util
import logging
from pathlib import Path
from datetime import datetime
try:
    from zoneinfo import ZoneInfo
    _IL_TZ = ZoneInfo("Asia/Jerusalem")
except (ImportError, KeyError):
    from datetime import timezone, timedelta
    _IL_TZ = timezone(timedelta(hours=2))


def _now_il():
    """Return current datetime in Israel timezone."""
    return datetime.now(_IL_TZ)


_HEB_MONTHS = [
    'ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני',
    'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר',
]

def _advance_month(text):
    """Replace first Hebrew month name in text with the next month. December→January increments year."""
    import re
    if not text:
        return text
    for i, month in enumerate(_HEB_MONTHS):
        if month in text:
            next_month = _HEB_MONTHS[(i + 1) % 12]
            result = text.replace(month, next_month, 1)
            if i == 11:  # December → January: bump year
                result = re.sub(r'\b(\d{4})\b', lambda m: str(int(m.group(1)) + 1), result, count=1)
            return result
    return text


logger = logging.getLogger("bankdiscrepancies")
logger.setLevel(logging.INFO)
if not logger.handlers:
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(logging.Formatter("%(message)s"))
    logger.addHandler(handler)

import requests
import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from requests.auth import HTTPBasicAuth

# Shared HTTP session for all Priority calls: keep-alive (one DNS lookup + TLS
# handshake per host, then the connection is REUSED across calls) plus automatic
# retries on transient connection failures. This fixes the slow/erratic loads
# caused by OrbStack's embedded DNS resolver intermittently timing out under the
# concurrent lookups gunicorn makes — keep-alive means follow-up calls (e.g.
# BANKPAGES right after BANKLINESA) don't re-resolve at all.
# `connect` retries cover DNS/connection errors for ALL methods (safe — nothing
# was sent yet); read/status retries use urllib3's default idempotent set, so
# POSTs that create documents are never silently re-sent.
http_requests = requests.Session()
_prio_retry = Retry(total=4, connect=4, read=2, backoff_factor=0.4,
                    status_forcelist=(502, 503, 504))
_prio_adapter = HTTPAdapter(max_retries=_prio_retry, pool_connections=20, pool_maxsize=20)
http_requests.mount("https://", _prio_adapter)
http_requests.mount("http://", _prio_adapter)
http_requests.verify = False  # Priority's cert CA doesn't include key usage extension
http_requests.exceptions = requests.exceptions  # keep existing `http_requests.exceptions.X`

import threading
_gl_cache_lock = threading.Lock()  # serialize bank-GL cache writes during parallel resolution
from flask import Flask, jsonify, send_file, request, send_from_directory
from flask_cors import CORS

# PROJECT_ROOT = the "Bank discrepancies" folder (parent of this backend dir)
PROJECT_ROOT = Path(__file__).resolve().parent.parent

# Load env vars. Resolution order:
#   1. BANK_ENV_FILE env var (explicit path — used by the systemd unit in production)
#   2. The shared central env folder next to the project (Aiprojects/env/.env — local dev)
#   3. A local .env in the project root (fallback)
# Real secrets live ONLY in one of these files on disk, never in git.
try:
    from dotenv import load_dotenv
    _override = os.getenv("BANK_ENV_FILE")
    _shared = PROJECT_ROOT.parent / "env" / ".env"
    _local = PROJECT_ROOT / ".env"
    if _override and Path(_override).exists():
        _env_path = Path(_override)
    elif _shared.exists():
        _env_path = _shared
    else:
        _env_path = _local
    load_dotenv(_env_path, override=True)
    logger.info(f"env loaded from {_env_path}")
except ImportError:
    pass

# Load receipts database module
try:
    receipts_db_path = PROJECT_ROOT / "database" / "receipts" / "receipts_db.py"
    spec_rec_db = importlib.util.spec_from_file_location("receipts_db", receipts_db_path)
    receipts_db = importlib.util.module_from_spec(spec_rec_db)
    sys.modules["receipts_db"] = receipts_db
    spec_rec_db.loader.exec_module(receipts_db)
    logger.info(f"receipts_db loaded from {receipts_db_path}")
except Exception as _rec_db_err:
    logger.error(f"receipts_db load FAILED: {_rec_db_err}")
    receipts_db = None

# Load action-queue database module
try:
    aq_db_path = PROJECT_ROOT / "database" / "receipts" / "action_queue_db.py"
    spec_aq_db = importlib.util.spec_from_file_location("action_queue_db", aq_db_path)
    action_queue_db = importlib.util.module_from_spec(spec_aq_db)
    sys.modules["action_queue_db"] = action_queue_db
    spec_aq_db.loader.exec_module(action_queue_db)
    logger.info(f"action_queue_db loaded from {aq_db_path}")
except Exception as _aq_db_err:
    logger.error(f"action_queue_db load FAILED: {_aq_db_err}")
    action_queue_db = None

# Load accounts cache database module
try:
    ac_db_path = PROJECT_ROOT / "database" / "receipts" / "accounts_cache_db.py"
    spec_ac_db = importlib.util.spec_from_file_location("accounts_cache_db", ac_db_path)
    accounts_cache_db = importlib.util.module_from_spec(spec_ac_db)
    sys.modules["accounts_cache_db"] = accounts_cache_db
    spec_ac_db.loader.exec_module(accounts_cache_db)
    logger.info(f"accounts_cache_db loaded from {ac_db_path}")
except Exception as _ac_db_err:
    logger.error(f"accounts_cache_db load FAILED: {_ac_db_err}")
    accounts_cache_db = None

# Load journal-templates database module
try:
    jt_db_path = PROJECT_ROOT / "database" / "receipts" / "journal_templates_db.py"
    spec_jt_db = importlib.util.spec_from_file_location("journal_templates_db", jt_db_path)
    journal_templates_db = importlib.util.module_from_spec(spec_jt_db)
    sys.modules["journal_templates_db"] = journal_templates_db
    spec_jt_db.loader.exec_module(journal_templates_db)
    logger.info(f"journal_templates_db loaded from {jt_db_path}")
except Exception as _jt_db_err:
    logger.error(f"journal_templates_db load FAILED: {_jt_db_err}")
    journal_templates_db = None

# Load journal-recommendations database module (SQLite + FTS5)
try:
    rec_db_path = PROJECT_ROOT / "database" / "receipts" / "recommendations_db.py"
    spec_rec2_db = importlib.util.spec_from_file_location("recommendations_db", rec_db_path)
    recommendations_db = importlib.util.module_from_spec(spec_rec2_db)
    sys.modules["recommendations_db"] = recommendations_db
    spec_rec2_db.loader.exec_module(recommendations_db)
    # One-time seed from the old journal_templates.json on an empty DB.
    if recommendations_db.count() == 0 and journal_templates_db:
        try:
            seeded = recommendations_db.seed_from_templates(journal_templates_db.list_templates())
            logger.info(f"recommendations_db seeded {seeded} rows from journal_templates")
        except Exception as _seed_err:
            logger.warning(f"recommendations_db seed skipped: {_seed_err}")
    logger.info(f"recommendations_db loaded from {rec_db_path}")
except Exception as _rec2_db_err:
    logger.error(f"recommendations_db load FAILED: {_rec2_db_err}")
    recommendations_db = None

app = Flask(__name__)
CORS(app)

PRIORITY_URL_REAL = os.getenv("PRIORITY_URL_REAL", "").rstrip("/")


# ── Receipts (הפקת קבלות) ─────────────────────────────────────
# Flow: bank txn → saved locally → accountant approves → THEN draft created in Priority

def _prio_auth():
    return HTTPBasicAuth(os.getenv("PRIORITY_USERNAME", ""), os.getenv("PRIORITY_PASSWORD", ""))


def _prio_url():
    return PRIORITY_URL_REAL


_PRIO_READ_HEADERS = {"Accept": "application/json", "OData-Version": "4.0"}
_PRIO_WRITE_HEADERS = {"Accept": "application/json", "Content-Type": "application/json", "OData-Version": "4.0"}

_CASHNAME_MAP_FILE = PROJECT_ROOT / "database" / "receipts" / "cashname_mapping.json"


def _load_cashname_map():
    """Load locally-saved ACCNAME1 → CASHNAME mapping."""
    try:
        return json.loads(_CASHNAME_MAP_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_cashname_map(mapping):
    _CASHNAME_MAP_FILE.write_text(json.dumps(mapping, ensure_ascii=False, indent=2), encoding="utf-8")


@app.route("/api/receipts/cashname-map", methods=["POST"])
def receipts_save_cashname_map():
    """Save a user-confirmed ACCNAME1 → CASHNAME mapping for future auto-fill."""
    try:
        body = request.get_json(force=True) or {}
        accname1 = body.get("accname1", "").strip()
        cashname = body.get("cashname", "").strip()
        if not accname1 or not cashname:
            return jsonify({"ok": False, "error": "Missing fields"}), 400
        mapping = _load_cashname_map()
        mapping[accname1] = cashname
        _save_cashname_map(mapping)
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


_PROCESSED_TXNS_FILE = PROJECT_ROOT / "database" / "receipts" / "processed_txns.json"


def _load_processed_txns():
    if not _PROCESSED_TXNS_FILE.exists():
        return set()
    try:
        return set(json.loads(_PROCESSED_TXNS_FILE.read_text(encoding="utf-8")).get("fncnums", []))
    except Exception:
        return set()


def _save_processed_txns(fncnums):
    _PROCESSED_TXNS_FILE.write_text(
        json.dumps({"fncnums": sorted(fncnums)}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _bank_txn_type(accname1):
    """Classify a bank-statement entry by its non-bank account code (ACCNAME1)."""
    seg = (accname1 or "").split("-")[0]
    if not seg.isdigit():
        return "other"
    n, c = len(seg), seg[0]
    if n >= 5 and c == "5":
        return "receipt"        # 50xxx-51xxx — ועד בית / clients
    if n <= 3:
        return "fee"            # 620-x-x, 400-x-x, 205-x-x — עמלה / הוצאה
    if n == 4 and seg.startswith("40"):
        return "transfer"       # בנק-לבנק
    if n == 4 and c == "7":
        return "intercompany"   # חו"ז עובד / בעל מניות
    if n == 4 and c == "3":
        return "internal"       # חשבון פנימי
    if n >= 5 and c == "6":
        return "supplier"       # ספק / חברה חיצונית
    if n >= 5 and c in ("8", "9"):
        return "loan"           # הלוואה
    return "other"


_TXN_ACTION_MAP = {
    "receipt":      "receipt",   # הפקת קבלה
    "fee":          "journal",   # רישום פקודת התאמה
    "transfer":     "transfer",  # הפקת העברה בנקאית
    "intercompany": "journal",
    "internal":     "transfer",
    "supplier":     "transfer",
    "loan":         "journal",
    "other":        "journal",
}

_TXN_DIRECTION_MAP = {
    "receipt":      "+",   # כסף נכנס לבנק → ירוק
    "fee":          "-",   # כסף יוצא מהבנק → אדום
    "transfer":     "-",
    "intercompany": "-",
    "internal":     "-",
    "supplier":     "-",
    "loan":         "-",
    "other":        "-",
}


@app.route("/api/receipts/bank-transactions", methods=["GET"])
def receipts_bank_transactions():
    """Bank statement lines from BANKLINESA that have not yet been reconciled (ERECONNUM eq 0)."""
    try:
        days = int(request.args.get("days", 180))
        branch = (request.args.get("branch") or "").strip()
        # Force a fresh GL re-detection for unresolved CASHNAMEs (bypass the 1-day
        # negative-cache TTL). Resolved/manually-set GLs are kept untouched.
        refresh_gl = (request.args.get("refresh_gl") or "").lower() in ("1", "true", "yes")
        from datetime import timedelta
        since_date = (_now_il() - timedelta(days=days)).strftime("%Y-%m-%dT00:00:00Z")

        branch_safe = branch.replace("'", "") if branch and branch != "all" else ""

        flt = f"ERECONNUM eq 0 and CURDATE ge {since_date}"
        r_lines = http_requests.get(
            f"{_prio_url()}/BANKLINESA"
            f"?$filter={flt}"
            "&$select=CASHNAME,BPYEAR,CURDATE,DETAILS,CREDIT,DEBIT,BTCODE,FNCNUM,REF,BANKPAGE,KLINE"
            "&$orderby=CURDATE desc&$top=500",
            headers=_PRIO_READ_HEADERS, auth=_prio_auth(), timeout=30, verify=False,
        )
        r_lines.raise_for_status()
        raw_lines = r_lines.json().get("value", [])

        if branch_safe:
            raw_lines = [l for l in raw_lines if (l.get("CASHNAME") or "").startswith(f"{branch_safe}-")]

        bankpage_info = {}
        try:
            unique_pages = list({l["BANKPAGE"] for l in raw_lines if l.get("BANKPAGE")})[:100]
            if unique_pages:
                page_filter = " or ".join([f"BANKPAGE eq {p}" for p in unique_pages])
                r_pages = http_requests.get(
                    f"{_prio_url()}/BANKPAGES?$filter=({page_filter})"
                    "&$select=BANKPAGE,CASHNAME,BANKNAME,BRANCH,PAYACCOUNT",
                    headers=_PRIO_READ_HEADERS, auth=_prio_auth(), timeout=30, verify=False,
                )
                if r_pages.status_code == 200:
                    for p in r_pages.json().get("value", []):
                        bankpage_info[p["BANKPAGE"]] = p
        except Exception:
            pass

        # ── Resolve bank GL accounts from CASH_BANKS ─────────────────────────
        # Load the full CASH_BANKS table in one request (~80 records).
        # Every active account has ACCNAME set; inactive/unmapped ones are skipped.
        cash_gl_map: dict = {}  # CASHNAME → GL account

        try:
            r_cash = http_requests.get(
                f"{_prio_url()}/CASH_BANKS?$select=CASHNAME,CASHDES,ACCNAME",
                headers=_PRIO_READ_HEADERS, auth=_prio_auth(), timeout=20, verify=False,
            )
            if r_cash.status_code == 200:
                for cash_rec in r_cash.json().get("value", []):
                    cn  = (cash_rec.get("CASHNAME") or "").strip()
                    gl  = (cash_rec.get("ACCNAME")  or "").strip()
                    des = (cash_rec.get("CASHDES")   or "").strip()
                    if cn and gl:
                        cash_gl_map[cn] = gl
                        if journal_templates_db:
                            journal_templates_db.save_bank_gl(cn, gl, des)
        except Exception as _ce:
            logger.warning(f"CASH_BANKS GL lookup failed: {_ce}")

        # ── Load CASH_CREDITCARDS — authoritative credit-card list ────────────
        # Maps CASHNAME → last-4 digits (for display).  Cards found here are
        # always typed as "credit" regardless of their CASHNAME format.
        credit_card_set: set = set()   # CASHNAMEs that are credit cards
        credit_last4_map: dict = {}    # CASHNAME → last-4 string

        def _extract_last4(cashname: str, cashdes: str = "") -> str:
            """Best-effort extraction of 4-digit card suffix."""
            import re
            parts = cashname.split("-")
            if len(parts) >= 2:
                last = parts[-1]
                if len(last) == 4 and last.isdigit():
                    return last
            # fall back to last 4-digit group in description
            groups = re.findall(r'\b(\d{4})\b', cashdes or "")
            return groups[-1] if groups else ""

        try:
            r_cc = http_requests.get(
                f"{_prio_url()}/CASH_CREDITCARDS?$select=CASHNAME,CASHDES,ACCNAME",
                headers=_PRIO_READ_HEADERS, auth=_prio_auth(), timeout=20, verify=False,
            )
            if r_cc.status_code == 200:
                for cc_rec in r_cc.json().get("value", []):
                    cn  = (cc_rec.get("CASHNAME") or "").strip()
                    des = (cc_rec.get("CASHDES")  or "").strip()
                    gl  = (cc_rec.get("ACCNAME")  or "").strip()
                    if cn:
                        credit_card_set.add(cn)
                        credit_last4_map[cn] = _extract_last4(cn, des)
                        if gl:
                            cash_gl_map.setdefault(cn, gl)
        except Exception as _cce:
            logger.warning(f"CASH_CREDITCARDS lookup failed: {_cce}")

        valid_bank_cn = set(cash_gl_map.keys())

        processed_ids = _load_processed_txns()
        action_queued_ids = action_queue_db.get_fncnums() if action_queue_db else set()

        all_branches = sorted({(l.get("CASHNAME") or "").split("-")[0]
                                for l in raw_lines if l.get("CASHNAME")})

        txns = []
        for line in raw_lines:
            bp   = line.get("BANKPAGE", "")
            kl   = line.get("KLINE", "")
            txn_id = f"BP{bp}-{kl}"

            if txn_id in processed_ids:
                continue
            if txn_id in action_queued_ids:
                continue

            credit = float(line.get("CREDIT") or 0)
            debit  = float(line.get("DEBIT")  or 0)
            amount = credit if credit > 0 else debit
            direction = "+" if credit > 0 else "-"
            txn_type  = "receipt" if credit > 0 else "other"

            page_info = bankpage_info.get(bp, {})
            bank_name    = page_info.get("BANKNAME", "")
            bank_branch  = page_info.get("BRANCH", "")
            pay_account  = page_info.get("PAYACCOUNT", "")
            cashname     = line.get("CASHNAME", "")
            branch_code  = cashname.split("-")[0] if cashname else ""
            if bank_name:
                bank_desc = f"{bank_name} {bank_branch}/{pay_account}".strip(" /")
            else:
                bank_desc = cashname

            txns.append({
                "FNCNUM":           txn_id,
                "CURDATE":          line.get("CURDATE"),
                "DETAILS":          line.get("DETAILS"),
                "CASHNAME":         cashname,
                "bank_code":        cashname,
                "bank_desc":        bank_desc,
                "bank_name":        bank_name,
                "other_code":       "",
                "other_desc":       line.get("DETAILS", ""),
                "BRANCHNAME":       branch_code,
                "SUM1":             amount,
                "CREDIT":           credit,
                "DEBIT":            debit,
                "direction":        direction,
                "txn_type":         txn_type,
                "suggested_action": _TXN_ACTION_MAP.get(txn_type, "journal"),
                "FNCPATNAME":       "",
                "already_queued":   False,
                "BANKPAGE":         bp,
                "KLINE":            kl,
                "REF":              line.get("REF") or "",
                "bank_gl":          cash_gl_map.get(cashname, ""),
                "account_type":     "credit" if (
                    cashname in credit_card_set or len(cashname.split("-")) != 2
                ) else "bank",
                "card_last4":       credit_last4_map.get(cashname) or (
                    _extract_last4(cashname) if (
                        cashname in credit_card_set or len(cashname.split("-")) != 2
                    ) else ""
                ),
            })

        return jsonify({"ok": True, "transactions": txns, "days": days,
                        "since": since_date[:10], "branch": branch})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/receipts/bank-transactions/process", methods=["POST"])
def mark_bank_txn_processed():
    """Mark a bank transaction as manually processed (hide from the queue)."""
    try:
        data = request.get_json() or {}
        fncnum = str(data.get("fncnum", "")).strip()
        if not fncnum:
            return jsonify({"ok": False, "error": "Missing fncnum"}), 400
        processed = _load_processed_txns()
        processed.add(fncnum)
        _save_processed_txns(processed)
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/receipts/bank-line/create-receipt", methods=["POST"])
def bank_line_create_receipt():
    """Create a TINVOICES receipt in Priority directly from a BANKLINESA line."""
    try:
        data       = request.get_json(force=True) or {}
        txn_id     = str(data.get("txn_id",     "")).strip()
        bank_ref   = str(data.get("bank_ref",   "")).strip()
        accname    = str(data.get("accname",    "")).strip()
        accdes     = str(data.get("accdes",     "")).strip()
        amount     = float(data.get("amount",   0))
        ivdate     = str(data.get("ivdate",     ""))[:10]
        cashname   = str(data.get("cashname",   "")).strip()
        branchname = str(data.get("branchname", "")).strip()
        details    = str(data.get("details",    "")).strip()
        doc_type   = str(data.get("doc_type",   "receipt")).strip()

        open_invoices = data.get("open_invoices", [])

        if not txn_id or not accname or amount <= 0:
            return jsonify({"ok": False, "error": "חסרים שדות חובה (txn_id, accname, amount)"}), 400

        if branchname and branchname != "000" and not accname.endswith(f"-{branchname}"):
            full_accname = f"{accname}-{branchname}"
        else:
            full_accname = accname

        payload = {
            "ACCNAME":     full_accname,
            "CASHNAME":    cashname,
            "TOTPRICE":    amount,
            "IVDATE":      ivdate,
            "PAYDATE":     ivdate,
            "BRANCHNAME":  branchname,
            "DETAILS":     details,
            "CASHPAYMENT": 0,
        }
        logger.info(f"bank_line_create_receipt payload: {payload}")

        resp = http_requests.post(
            f"{_prio_url()}/TINVOICES", json=payload,
            headers=_PRIO_WRITE_HEADERS, auth=_prio_auth(), timeout=20,
        )
        if not resp.ok:
            try:
                err_body = resp.json()
            except Exception:
                err_body = resp.text
            logger.error(f"TINVOICES create failed {resp.status_code}: {err_body}")
            def _extract_msg(b):
                if isinstance(b, dict):
                    m = b.get("error", {}).get("message", "")
                    if isinstance(m, dict):
                        return m.get("value", str(b))
                    return m or str(b)
                return str(b)
            return jsonify({"ok": False, "error": _extract_msg(err_body), "detail": err_body}), 400
        resp_data      = resp.json()
        priority_ivnum = resp_data.get("IVNUM", "")
        ivtype         = resp_data.get("IVTYPE", "T")
        debit_val      = resp_data.get("DEBIT",  "D")

        key = f"IVNUM='{priority_ivnum}',IVTYPE='{ivtype}',DEBIT='{debit_val}'"
        pay_payload = {
            "PAYMENTCODE": "3",
            "PAYDATE":     ivdate,
            "QPRICE":      amount,
            "FIRSTPAY":    amount,
            "TOTPRICE":    amount,
            "DETAILS":     details,
        }
        try:
            http_requests.post(
                f"{_prio_url()}/TINVOICES({key})/TPAYMENT2_SUBFORM",
                json=pay_payload, headers=_PRIO_WRITE_HEADERS, auth=_prio_auth(), timeout=15,
            ).raise_for_status()
        except Exception as pay_err:
            logger.warning(f"TPAYMENT2_SUBFORM failed (non-fatal): {pay_err}")

        if open_invoices:
            inv_ivnums = {(inv.get("IVNUM") or "").strip() for inv in open_invoices if inv.get("IVNUM")}
            try:
                rows_resp = http_requests.get(
                    f"{_prio_url()}/TINVOICES({key})/TFNCITEMS2_SUBFORM",
                    headers=_PRIO_READ_HEADERS, auth=_prio_auth(), timeout=15,
                )
                if rows_resp.ok:
                    for row in rows_resp.json().get("value", []):
                        row_ivnum = (row.get("IVNUM") or "").strip()
                        if row_ivnum not in inv_ivnums:
                            continue
                        fnctrans = row.get("FNCTRANS")
                        kline    = row.get("KLINE")
                        if fnctrans is None:
                            continue
                        row_key = f"FNCTRANS={fnctrans},KLINE={kline}"
                        try:
                            patch_resp = http_requests.patch(
                                f"{_prio_url()}/TINVOICES({key})/TFNCITEMS2_SUBFORM({row_key})",
                                json={"PAYFLAG": "Y"},
                                headers=_PRIO_WRITE_HEADERS, auth=_prio_auth(), timeout=15,
                            )
                            if patch_resp.ok:
                                logger.info(f"TFNCITEMS2 PAYFLAG=Y set for {row_ivnum}")
                            else:
                                logger.warning(f"TFNCITEMS2 PATCH {row_ivnum} failed {patch_resp.status_code}: {patch_resp.text[:300]}")
                        except Exception as pe:
                            logger.warning(f"TFNCITEMS2 PATCH {row_ivnum} error: {pe}")
                else:
                    logger.warning(f"TFNCITEMS2_SUBFORM GET failed {rows_resp.status_code}")
            except Exception as e:
                logger.warning(f"TFNCITEMS2_SUBFORM error (non-fatal): {e}")

        rec = receipts_db.add_receipt(
            fncnum=txn_id,
            accname=accname,
            accdes=accdes or accname,
            cashname=cashname,
            totprice=amount,
            ivdate=ivdate,
            branchname=branchname,
            details=details,
            doc_type=doc_type,
        )
        if rec:
            receipts_db.approve_receipt(rec["id"], priority_ivnum)

        processed = _load_processed_txns()
        processed.add(txn_id)
        _save_processed_txns(processed)

        _launch_bank_recon(priority_ivnum, cashname, txn_id, label="receipt")

        return jsonify({"ok": True, "priority_ivnum": priority_ivnum})

    except http_requests.exceptions.HTTPError as e:
        try:
            detail = e.response.json()
        except Exception:
            detail = str(e)
        return jsonify({"ok": False, "error": str(e), "detail": detail}), 500
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/receipts/last-einvoice", methods=["GET"])
def last_einvoice():
    """Fetch most recent EINVOICES + line items for a customer, with Hebrew month advanced for auto-fill."""
    try:
        accname    = request.args.get("accname", "").strip()
        branchname = request.args.get("branchname", "").strip()
        if not accname:
            return jsonify({"ok": False, "error": "Missing accname"}), 400

        if branchname and branchname != "000" and not accname.endswith(f"-{branchname}"):
            full_accname = f"{accname}-{branchname}"
        else:
            full_accname = accname

        def _fetch_einvoices(cust_filter):
            u = (
                f"{_prio_url()}/EINVOICES?$filter={cust_filter}"
                f"&$orderby=IVDATE desc&$top=1"
                f"&$select=IV,IVNUM,IVTYPE,DEBIT,IVDATE,CUSTNAME,DETAILS,BRANCHNAME,TOTPRICE"
            )
            r = http_requests.get(u, headers=_PRIO_READ_HEADERS, auth=_prio_auth(), timeout=15)
            r.raise_for_status()
            return r.json().get("value", [])

        candidates = [f"CUSTNAME eq '{full_accname}'"]
        if full_accname != accname:
            candidates.append(f"CUSTNAME eq '{accname}'")
        if branchname:
            candidates.append(f"BRANCHNAME eq '{branchname}'")

        items_list = []
        for filt in candidates:
            items_list = _fetch_einvoices(filt)
            if items_list:
                logger.info(f"last_einvoice: found with filter '{filt}'")
                break

        if not items_list:
            logger.info(f"last_einvoice: no EINVOICES for accname={accname} branch={branchname}")
            return jsonify({"ok": True, "found": False})

        inv    = items_list[0]
        ivnum  = inv.get("IVNUM", "")
        ivtype = inv.get("IVTYPE", "I")
        debit  = inv.get("DEBIT",  "T")

        line_items = []
        if ivnum:
            key      = f"IVNUM='{ivnum}',IVTYPE='{ivtype}',DEBIT='{debit}'"
            sub_url  = f"{_prio_url()}/EINVOICES({key})/EINVOICEITEMS_SUBFORM?$select=PARTNAME,PDES,TQUANT,PRICE"
            try:
                ir = http_requests.get(sub_url, headers=_PRIO_READ_HEADERS, auth=_prio_auth(), timeout=15)
                if ir.ok:
                    line_items = ir.json().get("value", [])
            except Exception as sub_err:
                logger.warning(f"EINVOICEITEMS_SUBFORM fetch failed (non-fatal): {sub_err}")

        advanced_items = [
            {
                "PARTNAME": it.get("PARTNAME", "000"),
                "PDES":     _advance_month(it.get("PDES", "")),
                "TQUANT":   it.get("TQUANT", 1),
                "PRICE":    it.get("PRICE", 0),
            }
            for it in line_items
        ]

        inv_ivdate = inv.get("IVDATE", "")
        same_month = False
        try:
            inv_d = datetime.strptime(inv_ivdate[:7], "%Y-%m")
            now_d = _now_il().replace(day=1)
            same_month = (inv_d.year == now_d.year and inv_d.month == now_d.month)
        except Exception:
            pass

        return jsonify({
            "ok":           True,
            "found":        True,
            "ivnum":        ivnum,
            "ivdate":       inv_ivdate,
            "details":      inv.get("DETAILS", ""),
            "details_next": _advance_month(inv.get("DETAILS", "")),
            "branchname":   inv.get("BRANCHNAME", ""),
            "totprice":     inv.get("TOTPRICE", 0),
            "items":        advanced_items,
            "same_month":   same_month,
        })
    except http_requests.exceptions.HTTPError as e:
        return jsonify({"ok": False, "error": str(e)}), 500
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/receipts/bank-line/create-invoice-receipt", methods=["POST"])
def bank_line_create_invoice_receipt():
    """Create an EINVOICES (חשבונית מס קבלה) document in Priority, then add line items."""
    try:
        data       = request.get_json(force=True) or {}
        txn_id     = str(data.get("txn_id",     "")).strip()
        accname    = str(data.get("accname",    "")).strip()
        accdes     = str(data.get("accdes",     "")).strip()
        amount     = float(data.get("amount",   0))
        ivdate     = str(data.get("ivdate",     ""))[:10]
        cashname   = str(data.get("cashname",   "")).strip()
        branchname = str(data.get("branchname", "")).strip()
        details    = str(data.get("details",    "")).strip()
        items      = data.get("items", [])

        if not txn_id or not accname or amount <= 0:
            return jsonify({"ok": False, "error": "חסרים שדות חובה (txn_id, accname, amount)"}), 400

        if branchname and branchname != "000" and not accname.endswith(f"-{branchname}"):
            full_accname = f"{accname}-{branchname}"
        else:
            full_accname = accname

        custname = accname.split("-")[0]

        header_payload = {
            "CUSTNAME": custname,
            "IVDATE":   ivdate,
            "DETAILS":  details,
        }
        if branchname and branchname != "000":
            header_payload["BRANCHNAME"] = branchname
        logger.info(f"create_invoice_receipt header: {header_payload}")
        resp = http_requests.post(
            f"{_prio_url()}/EINVOICES", json=header_payload,
            headers=_PRIO_WRITE_HEADERS, auth=_prio_auth(), timeout=20, verify=False,
        )
        if not resp.ok:
            try:
                err_body = resp.json()
            except Exception:
                err_body = resp.text
            logger.error(f"EINVOICES create failed {resp.status_code}: {err_body}")
            def _prio_msg(body):
                if isinstance(body, dict):
                    m = body.get("error", {}).get("message", "")
                    if isinstance(m, dict):
                        return m.get("value", str(body))
                    return m or str(body)
                return str(body)
            return jsonify({"ok": False, "error": _prio_msg(err_body), "detail": err_body}), 400
        resp.raise_for_status()
        resp_data      = resp.json()
        priority_ivnum = resp_data.get("IVNUM", "")
        ivtype         = resp_data.get("IVTYPE", "I")
        debit          = resp_data.get("DEBIT",  "T")
        key            = f"IVNUM='{priority_ivnum}',IVTYPE='{ivtype}',DEBIT='{debit}'"

        import math as _math
        import time as _time_ir
        VAT_RATE = 0.18

        for item in items:
            inclusive = round(float(item.get("PRICE", 0)), 2)
            pre_vat = _math.ceil(inclusive / (1 + VAT_RATE) * 100) / 100
            tquant  = float(item.get("TQUANT", 1))
            item_payload = {
                "PARTNAME": str(item.get("PARTNAME", "000")),
                "PDES":     str(item.get("PDES", "")),
                "TQUANT":   tquant,
                "PRICE":    pre_vat,
            }
            try:
                http_requests.post(
                    f"{_prio_url()}/EINVOICES({key})/EINVOICEITEMS_SUBFORM",
                    json=item_payload, headers=_PRIO_WRITE_HEADERS, auth=_prio_auth(), timeout=15, verify=False,
                ).raise_for_status()
            except Exception as item_err:
                logger.warning(f"EINVOICEITEMS_SUBFORM item failed (non-fatal): {item_err}")

        def _query_totprice(retries=3, wait=1.5):
            for _ in range(retries):
                _time_ir.sleep(wait)
                try:
                    r = http_requests.get(
                        f"{_prio_url()}/EINVOICES({key})?$select=TOTPRICE",
                        headers=_PRIO_READ_HEADERS, auth=_prio_auth(), timeout=15, verify=False,
                    )
                    if r.ok:
                        v = float(r.json().get("TOTPRICE") or 0)
                        if v > 0:
                            return v
                except Exception:
                    pass
            return 0.0

        actual_total = _query_totprice(retries=3, wait=1.5)
        logger.info(f"EINVOICES {priority_ivnum}: TOTPRICE={actual_total}, bank={amount}")

        overshoot = round(actual_total - amount, 2)
        if actual_total > 0 and 0 < overshoot <= 2.0:
            try:
                patch_r = http_requests.patch(
                    f"{_prio_url()}/EINVOICES({key})",
                    json={"DISCOUNT": overshoot},
                    headers=_PRIO_WRITE_HEADERS, auth=_prio_auth(), timeout=15, verify=False,
                )
                logger.info(f"EINVOICES {priority_ivnum}: DISCOUNT={overshoot} → status {patch_r.status_code}")
                if patch_r.ok:
                    actual_total = _query_totprice(retries=2, wait=1.0)
                    logger.info(f"EINVOICES {priority_ivnum}: TOTPRICE after DISCOUNT={actual_total}")
            except Exception as _de:
                logger.warning(f"DISCOUNT patch failed (non-fatal): {_de}")
        elif actual_total > 0 and abs(overshoot) < 0.005:
            logger.info(f"EINVOICES {priority_ivnum}: TOTPRICE exact, no DISCOUNT needed")

        pay_amount = round(amount, 2)
        logger.info(f"EINVOICES {priority_ivnum}: QPRICE={pay_amount} (bank amount), actual_total={actual_total}")

        epay_payload = {
            "PAYMENTCODE": "3",
            "PAYDATE":     ivdate,
            "QPRICE":      pay_amount,
            "FIRSTPAY":    pay_amount,
            "CASHNAME":    cashname,
            "DETAILS":     details,
        }
        logger.info(f"EINVOICES {priority_ivnum}: EPAYMENT2_SUBFORM QPRICE={pay_amount}")
        epay_resp = http_requests.post(
            f"{_prio_url()}/EINVOICES({key})/EPAYMENT2_SUBFORM",
            json=epay_payload, headers=_PRIO_WRITE_HEADERS, auth=_prio_auth(), timeout=15, verify=False,
        )
        if not epay_resp.ok:
            try:
                epay_err = epay_resp.json()
            except Exception:
                epay_err = epay_resp.text
            logger.error(f"EPAYMENT2_SUBFORM failed {epay_resp.status_code}: {epay_err}")
            return jsonify({"ok": False, "error": f"EPAYMENT2_SUBFORM שגיאה: {epay_err}", "priority_ivnum": priority_ivnum}), 500

        rec = receipts_db.add_receipt(
            fncnum=txn_id,
            accname=accname,
            accdes=accdes or accname,
            cashname=cashname,
            totprice=amount,
            ivdate=ivdate,
            branchname=branchname,
            details=details,
            doc_type='invoice_receipt',
        )
        if rec:
            receipts_db.approve_receipt(rec["id"], priority_ivnum)

        processed = _load_processed_txns()
        processed.add(txn_id)
        _save_processed_txns(processed)

        return jsonify({"ok": True, "priority_ivnum": priority_ivnum})

    except http_requests.exceptions.HTTPError as e:
        try:
            detail = e.response.json()
        except Exception:
            detail = str(e)
        return jsonify({"ok": False, "error": str(e), "detail": detail}), 500
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/receipts/bank-line/dismiss", methods=["POST"])
def bank_line_dismiss():
    """Mark a BANKLINESA line as handled — hides it from the unmatched list."""
    try:
        data   = request.get_json(force=True) or {}
        txn_id = str(data.get("txn_id", "")).strip()
        if not txn_id:
            return jsonify({"ok": False, "error": "Missing txn_id"}), 400
        processed = _load_processed_txns()
        processed.add(txn_id)
        _save_processed_txns(processed)
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


def _detect_bank_gl(cashname, branchname, bank_name_hint=""):
    """Return the Priority GL account for a CASHNAME.
    Priority 1: local cache (journal_templates_db).
    Priority 2: CASH OData entity (ACCNAME field on the cash account record).
    Priority 3: scan recent FNCTRANS for 40xx- accounts (legacy fallback).
    """
    if journal_templates_db:
        cached = journal_templates_db.get_bank_gl(cashname)
        if cached:
            return cached, ""

    # ── Primary: query Priority's CASH_BANKS entity ─────────────────────────
    try:
        r = http_requests.get(
            f"{_prio_url()}/CASH_BANKS?$filter=CASHNAME eq '{cashname}'"
            "&$select=CASHNAME,CASHDES,ACCNAME",
            headers=_PRIO_READ_HEADERS, auth=_prio_auth(), timeout=15, verify=False,
        )
        if r.status_code == 200:
            items = r.json().get("value", [])
            if items:
                gl   = (items[0].get("ACCNAME") or "").strip()
                desc = (items[0].get("CASHDES")  or "").strip()
                if gl:
                    if journal_templates_db:
                        with _gl_cache_lock:
                            journal_templates_db.save_bank_gl(cashname, gl, desc)
                    return gl, desc
    except Exception as _e:
        logger.warning(f"_detect_bank_gl CASH_BANKS lookup failed: {_e}")

    # ── Fallback: scan recent FNCTRANS for 40xx- accounts ───────────────────
    try:
        import re as _re
        since = (_now_il().replace(year=_now_il().year - 2)).strftime("%Y-%m-%dT00:00:00Z")
        flt = f"BRANCHNAME eq '{branchname}' and FNCDATE ge {since}"
        r = http_requests.get(
            f"{_prio_url()}/FNCTRANS"
            f"?$filter={flt}"
            "&$expand=FNCITEMS_SUBFORM($select=ACCNAME,ACCDES)"
            "&$select=FNCNUM&$top=100",
            headers=_PRIO_READ_HEADERS, auth=_prio_auth(), timeout=15, verify=False,
        )
        r.raise_for_status()
        bank_accs = {}
        for entry in r.json().get("value", []):
            for item in entry.get("FNCITEMS_SUBFORM", []):
                acc = item.get("ACCNAME", "")
                if _re.match(r"^40\d\d-", acc):
                    bank_accs[acc] = item.get("ACCDES", "")

        if not bank_accs:
            return "", ""

        if len(bank_accs) == 1:
            gl, desc = list(bank_accs.items())[0]
            if journal_templates_db:
                with _gl_cache_lock:
                    journal_templates_db.save_bank_gl(cashname, gl, desc)
            return gl, desc

        if bank_name_hint:
            for acc, desc in bank_accs.items():
                if bank_name_hint in desc:
                    if journal_templates_db:
                        with _gl_cache_lock:
                            journal_templates_db.save_bank_gl(cashname, acc, desc)
                    return acc, desc

        return "", str(list(bank_accs.keys()))
    except Exception as _e:
        logger.warning(f"_detect_bank_gl failed: {_e}")
        return "", ""


def _find_node():
    """Return path to node executable, works on Windows and Linux."""
    import shutil, glob as _glob
    for exe_name in ("node", "nodejs"):
        found = shutil.which(exe_name)
        if found and os.path.isfile(found):
            return found
    candidates = [
        r"C:\Program Files\nodejs\node.exe",
        r"C:\Program Files (x86)\nodejs\node.exe",
        "/usr/bin/node",
        "/usr/bin/nodejs",
        "/usr/local/bin/node",
        "/usr/local/bin/nodejs",
        "/usr/local/nvm/versions/node/current/bin/node",
    ]
    # nvm installed under any home directory or /root
    nvm_patterns = [
        "/root/.nvm/versions/node/*/bin/node",
        "/home/*/.nvm/versions/node/*/bin/node",
    ]
    for pattern in nvm_patterns:
        matches = sorted(_glob.glob(pattern))
        if matches:
            return matches[-1]  # pick highest version
    for c in candidates:
        if os.path.isfile(c):
            return c
    raise RuntimeError(
        "Node.js לא נמצא על השרת. "
        "יש להתקין Node.js ולהריץ 'npm install' בתיקיית backend/close_receipt"
    )


def _node_run(script_dir, args, timeout=90):
    """subprocess.run for a node script — handles spaces in node path on Windows."""
    import subprocess
    node_exe = _find_node()
    logger.info(f"node executable: {node_exe}")
    # On Windows, paths with spaces need quoting when building a cmd string
    def _q(s):
        return f'"{s}"' if " " in s else s
    cmd_str = " ".join([_q(node_exe)] + [_q(str(a)) for a in args])
    return subprocess.run(
        cmd_str,
        shell=True,
        cwd=script_dir,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
    )


def _launch_bank_recon(journal_fncnum, cashname, bank_fncnum="", label=""):
    """Launch bank_recon.js in a background thread (non-blocking, non-fatal)."""
    if not cashname:
        return
    try:
        import threading
        script_dir = os.path.join(os.path.dirname(__file__), "close_receipt")
        tag = label or f"recon({journal_fncnum},{bank_fncnum})"
        def _run():
            try:
                r = _node_run(script_dir, ["bank_recon.js",
                              journal_fncnum or "", cashname, bank_fncnum or ""], timeout=120)
                out = r.stdout.decode("utf-8", errors="replace").strip()
                err = r.stderr.decode("utf-8", errors="replace").strip()
                logger.info(f"bank_recon [{tag}] stdout: {out}")
                if err:
                    logger.info(f"bank_recon [{tag}] stderr: {err}")
            except Exception as ex:
                logger.warning(f"bank_recon [{tag}] error: {ex}")
        threading.Thread(target=_run, daemon=True).start()
    except Exception as ex:
        logger.warning(f"bank_recon launch failed [{label}]: {ex}")


@app.route("/api/receipts/bank-line/create-journal", methods=["POST"])
def bank_line_create_journal():
    """Create an FNCTRANS journal entry in Priority for a bank line."""
    try:
        data             = request.get_json(force=True) or {}
        txn_id           = str(data.get("txn_id",            "")).strip()
        bank_ref         = str(data.get("bank_ref",           "")).strip()
        direction        = str(data.get("direction",          "-")).strip()
        amount           = float(data.get("amount",           0))
        cashname         = str(data.get("cashname",           "")).strip()
        bank_name_hint   = str(data.get("bank_name",          "")).strip()
        counterpart      = str(data.get("counterpart_account","")).strip()
        counterpart_desc = str(data.get("counterpart_desc",   "")).strip()
        details          = str(data.get("details",            "")).strip()
        ivdate           = str(data.get("ivdate",             ""))[:10]
        branchname       = str(data.get("branchname",         "")).strip()
        save_tpl         = data.get("save_template", True)
        manual_bank_gl   = str(data.get("bank_gl_account",   "")).strip()
        fncref_value     = bank_ref or txn_id

        if not txn_id or not counterpart or amount <= 0:
            return jsonify({"ok": False, "error": "חסרים שדות חובה (txn_id, counterpart_account, amount)"}), 400

        if manual_bank_gl:
            bank_gl_account = manual_bank_gl
            bank_gl_desc    = ""
            if journal_templates_db:
                journal_templates_db.save_bank_gl(cashname, bank_gl_account, bank_gl_desc)
        else:
            bank_gl_account, bank_gl_desc = _detect_bank_gl(cashname, branchname, bank_name_hint)
        if not bank_gl_account:
            return jsonify({
                "ok": False,
                "error": f"לא נמצא חשבון GL לבנק (CASHNAME={cashname}, סניף={branchname}). "
                          f"הזן אותו ידנית בשדה 'חשבון בנק GL'.",
            }), 422

        def _with_branch(acc, branch):
            if branch and branch != "000" and not acc.endswith(f"-{branch}"):
                return f"{acc}-{branch}"
            return acc

        bank_acc = bank_gl_account
        cp_acc   = _with_branch(counterpart, branchname)

        if direction == "+":
            bank_debit,  bank_credit = amount, 0.0
            cp_debit,    cp_credit   = 0.0,    amount
        else:
            bank_debit,  bank_credit = 0.0,    amount
            cp_debit,    cp_credit   = amount,  0.0

        payload = {
            "FNCDATE":    ivdate,
            "BALDATE":    ivdate,
            "BRANCHNAME": branchname,
            "DETAILS":    details,
            "FNCREF":     fncref_value,
            "FNCITEMS_SUBFORM": [
                {"ACCNAME": bank_acc, "DEBIT1": bank_debit, "CREDIT1": bank_credit, "DETAILS": details},
                {"ACCNAME": cp_acc,   "DEBIT1": cp_debit,   "CREDIT1": cp_credit,   "DETAILS": details},
            ],
        }
        logger.info(f"bank_line_create_journal payload: {payload}")

        resp = http_requests.post(
            f"{_prio_url()}/FNCTRANS", json=payload,
            headers=_PRIO_WRITE_HEADERS, auth=_prio_auth(), timeout=20,
        )
        resp.raise_for_status()
        result = resp.json()
        fncnum = result.get("FNCNUM", "")

        if journal_templates_db and save_tpl and counterpart:
            journal_templates_db.save_template(details, counterpart, counterpart_desc, branchname)

        if action_queue_db:
            item = action_queue_db.add_item(
                fncnum=txn_id,
                curdate=ivdate,
                details=details,
                accname1=bank_acc,
                accdes1=bank_gl_desc,
                accname2=cp_acc,
                accdes2=counterpart_desc,
                sum1=amount,
                direction=direction,
                branchname=branchname,
                action="journal",
                priority_fncnum=fncnum,
                cashname=cashname,
            )
            if item:
                action_queue_db.mark_done(item["id"])

        processed = _load_processed_txns()
        processed.add(txn_id)
        _save_processed_txns(processed)

        _launch_bank_recon(fncnum, cashname, txn_id, label="journal")

        return jsonify({"ok": True, "fncnum": fncnum})

    except http_requests.exceptions.HTTPError as e:
        try:
            detail = e.response.json()
        except Exception:
            detail = str(e)
        return jsonify({"ok": False, "error": str(e), "detail": detail}), 500
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/receipts/bank-line/create-transfer", methods=["POST"])
def bank_line_create_transfer():
    """Create a QINVOICES bank transfer document in Priority for a bank line."""
    try:
        data       = request.get_json(force=True) or {}
        txn_id     = str(data.get("txn_id",     "")).strip()
        bank_ref   = str(data.get("bank_ref",   "")).strip()
        amount     = float(data.get("amount",    0))
        cashname   = str(data.get("cashname",   "")).strip()
        branchname = str(data.get("branchname", "")).strip()
        accname    = str(data.get("accname",    "")).strip()
        details    = str(data.get("details",    "")).strip()
        ivdate     = str(data.get("ivdate",     ""))[:10]
        direction  = str(data.get("direction",  "-")).strip()

        if not txn_id or not accname or amount <= 0:
            return jsonify({"ok": False, "error": "חסרים שדות חובה: חשבון ספק וסכום"}), 400

        if not details:
            details = "תשלום"

        wtax_percent = 0
        try:
            acc_safe = accname.replace("'", "")
            fncsup_resp = http_requests.get(
                f"{_prio_url()}/FNCSUP?$filter=ACCNAME eq '{acc_safe}'&$select=WTAXPERCENT&$top=1",
                headers=_PRIO_READ_HEADERS, auth=_prio_auth(), timeout=10, verify=False,
            )
            if fncsup_resp.ok:
                fncsup_rows = fncsup_resp.json().get("value", [])
                if fncsup_rows:
                    wtax_percent = fncsup_rows[0].get("WTAXPERCENT") or 0
        except Exception as wtax_err:
            logger.warning(f"Could not fetch WTAXPERCENT for {accname}: {wtax_err}")

        wtax_amount = round(amount * wtax_percent / 100, 2) if wtax_percent else 0

        payload = {
            "ACCNAME":      accname,
            "IVDATE":       ivdate,
            "PAYDATE":      ivdate,
            "BRANCHNAME":   branchname,
            "CASHNAME":     cashname,
            "DETAILS":      details,
            "QPRICE":       amount,
            "FNCITEMSFLAG": "Y",
            "WTAXPERCENT":  wtax_percent,
            "WTAX":         wtax_amount,
        }
        logger.info(f"bank_line_create_transfer QINVOICES payload: {payload}")

        resp = http_requests.post(
            f"{_prio_url()}/QINVOICES", json=payload,
            headers=_PRIO_WRITE_HEADERS, auth=_prio_auth(), timeout=20, verify=False,
        )
        if not resp.ok:
            logger.error(f"QINVOICES POST {resp.status_code}: {resp.text[:500]}")
        resp.raise_for_status()
        result = resp.json()
        ivnum = result.get("IVNUM", "")
        debit = result.get("DEBIT", "D")
        ivtype = result.get("IVTYPE", "Q")

        if ivnum:
            q_key = f"IVNUM='{ivnum}',IVTYPE='{ivtype}',DEBIT='{debit}'"
            hfnc_resp = http_requests.post(
                f"{_prio_url()}/QINVOICES({q_key})/HFNCITEMS_SUBFORM",
                json={"ACCNAME": accname, "DEBIT": amount, "DETAILS": details},
                headers=_PRIO_WRITE_HEADERS, auth=_prio_auth(), timeout=20, verify=False,
            )
            if not hfnc_resp.ok:
                logger.warning(f"HFNCITEMS_SUBFORM POST {hfnc_resp.status_code}: {hfnc_resp.text[:300]}")

        if action_queue_db:
            item = action_queue_db.add_item(
                fncnum=txn_id,
                curdate=ivdate,
                details=details,
                accname1=accname,
                accdes1=result.get("CDES", ""),
                accname2=cashname,
                accdes2="",
                sum1=amount,
                direction=direction,
                branchname=branchname,
                action="transfer",
                priority_fncnum=ivnum,
                cashname=cashname,
            )
            if item:
                action_queue_db.mark_done(item["id"])

        processed = _load_processed_txns()
        processed.add(txn_id)
        _save_processed_txns(processed)

        _launch_bank_recon(ivnum, cashname, txn_id, label="transfer")

        return jsonify({"ok": True, "ivnum": ivnum})

    except http_requests.exceptions.HTTPError as e:
        try:
            detail = e.response.json()
        except Exception:
            detail = str(e)
        return jsonify({"ok": False, "error": str(e), "detail": detail}), 500
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/receipts/journal/<priority_fncnum>/finalize", methods=["POST"])
def journal_finalize(priority_fncnum):
    """Register a journal entry via Web SDK (CLOSEANFNCTRANS via WCF — not OData)."""
    import subprocess, shutil
    try:
        data = request.get_json(force=True) or {}
        manual_fncnum = (data.get("final_fncnum") or "").strip()

        if manual_fncnum:
            if action_queue_db:
                action_queue_db.mark_final_by_priority_fncnum(priority_fncnum, manual_fncnum)
            return jsonify({"ok": True, "fncnum": manual_fncnum, "draft_fncnum": priority_fncnum})

        queue_item_early = action_queue_db.get_by_priority_fncnum(priority_fncnum) if action_queue_db else None

        def _search_final_by_details():
            if not queue_item_early:
                return None
            details_esc = (queue_item_early.get("details") or "").replace("'", "''")
            curdate_q   = (queue_item_early.get("curdate") or "")[:10]
            try:
                sr = http_requests.get(
                    f"{_prio_url()}/FNCTRANS?$filter=DETAILS eq '{details_esc}' and FINAL eq 'Y'"
                    f"&$select=FNCNUM,CURDATE&$orderby=FNCTRANS desc&$top=10",
                    headers={"Accept": "application/json", "OData-Version": "4.0"},
                    auth=_prio_auth(), timeout=15, verify=False,
                )
                if sr.ok:
                    for entry in sr.json().get("value", []):
                        if not curdate_q or (entry.get("CURDATE") or "")[:10] == curdate_q:
                            fn = entry.get("FNCNUM", "")
                            if fn and not fn.startswith("T"):
                                return fn
            except Exception as _e:
                logger.warning(f"FNCTRANS details search failed: {_e}")
            return None

        found_final = _search_final_by_details()
        if found_final:
            if action_queue_db:
                action_queue_db.mark_final_by_priority_fncnum(priority_fncnum, found_final)
            return jsonify({"ok": True, "fncnum": found_final, "draft_fncnum": priority_fncnum, "already_registered": True})

        check_resp = http_requests.get(
            f"{_prio_url()}/FNCTRANS('{priority_fncnum}')?$select=FNCTRANS,FNCNUM,FINAL",
            headers={"Accept": "application/json", "OData-Version": "4.0"},
            auth=_prio_auth(), timeout=15, verify=False,
        )
        already_final = False
        current_fncnum = priority_fncnum
        internal_key = None
        if check_resp.ok:
            rec = check_resp.json()
            already_final = rec.get("FINAL") == "Y"
            current_fncnum = rec.get("FNCNUM") or priority_fncnum
            internal_key = rec.get("FNCTRANS")

        if already_final:
            final_fncnum = current_fncnum
            if internal_key:
                seq_resp = http_requests.get(
                    f"{_prio_url()}/FNCTRANS?$filter=FNCTRANS eq {internal_key} and FINAL eq 'Y'"
                    "&$select=FNCNUM,FINAL&$orderby=FNCNUM desc&$top=5",
                    headers={"Accept": "application/json", "OData-Version": "4.0"},
                    auth=_prio_auth(), timeout=15, verify=False,
                )
                if seq_resp.ok:
                    for entry in seq_resp.json().get("value", []):
                        fn = entry.get("FNCNUM", "")
                        if fn and not fn.startswith("T"):
                            final_fncnum = fn
                            break
            if action_queue_db:
                action_queue_db.mark_final_by_priority_fncnum(priority_fncnum, final_fncnum)
            return jsonify({"ok": True, "fncnum": final_fncnum, "draft_fncnum": priority_fncnum, "already_registered": True})

        script_dir = os.path.join(os.path.dirname(__file__), "close_receipt")
        result = _node_run(script_dir, ["close_journal.js", priority_fncnum])
        stdout = (result.stdout or b"").decode("utf-8", errors="replace").strip()
        stderr = (result.stderr or b"").decode("utf-8", errors="replace").strip()
        if stderr:
            logger.info(f"close_journal stderr: {stderr}")

        try:
            sdk_data = json.loads(stdout) if stdout else {}
        except Exception:
            sdk_data = {}

        if result.returncode != 0 or not sdk_data.get("ok"):
            err = sdk_data.get("error") or stderr or "שגיאה לא ידועה"
            logger.error(f"close_journal.js failed for {priority_fncnum}: {err}")
            return jsonify({"ok": False, "error": err, "needs_manual": True}), 500

        final_fncnum = sdk_data.get("final_fncnum") or priority_fncnum

        if final_fncnum.startswith("T"):
            import time as _time; _time.sleep(1)
            found = _search_final_by_details()
            if found:
                final_fncnum = found
            elif internal_key:
                try:
                    seq_resp = http_requests.get(
                        f"{_prio_url()}/FNCTRANS?$filter=FNCTRANS eq {internal_key} and FINAL eq 'Y'"
                        "&$select=FNCNUM,FINAL&$orderby=FNCNUM desc&$top=5",
                        headers={"Accept": "application/json", "OData-Version": "4.0"},
                        auth=_prio_auth(), timeout=15, verify=False,
                    )
                    if seq_resp.ok:
                        for entry in seq_resp.json().get("value", []):
                            fn = entry.get("FNCNUM", "")
                            if fn and not fn.startswith("T"):
                                final_fncnum = fn
                                break
                except Exception as _e:
                    logger.warning(f"post-close FNCTRANS lookup failed: {_e}")

        queue_item = action_queue_db.get_by_priority_fncnum(priority_fncnum) if action_queue_db else None
        recon_cashname = (queue_item or {}).get("cashname", "")

        if action_queue_db:
            action_queue_db.mark_final_by_priority_fncnum(priority_fncnum, final_fncnum)
        if recon_cashname:
            recon_bank_fncnum = (queue_item or {}).get("fncnum", "")
            _launch_bank_recon(final_fncnum, recon_cashname, recon_bank_fncnum, label="journal-final")

        return jsonify({"ok": True, "fncnum": final_fncnum, "draft_fncnum": priority_fncnum})

    except subprocess.TimeoutExpired:
        return jsonify({"ok": False, "error": "close_journal.js timed out (90s)", "needs_manual": True}), 500
    except Exception as e:
        logger.error(f"journal_finalize error for {priority_fncnum}: {e}")
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/receipts/transfer/<ivnum>/finalize", methods=["POST"])
def transfer_finalize(ivnum):
    """Finalize a QINVOICES bank transfer via CLOSEQIV (Web SDK)."""
    import subprocess, shutil
    try:
        data = request.get_json(force=True) or {}
        manual_fncnum = (data.get("final_fncnum") or "").strip()

        if manual_fncnum:
            if action_queue_db:
                action_queue_db.mark_final_by_priority_fncnum(ivnum, ivnum, journal_fncnum=manual_fncnum)
            return jsonify({"ok": True, "ivnum": ivnum, "final_ivnum": ivnum, "fncnum": manual_fncnum})

        qkey = f"IVNUM='{ivnum}',IVTYPE='Q',DEBIT='D'"
        check = http_requests.get(
            f"{_prio_url()}/QINVOICES({qkey})?$select=IV,FINAL,FNCNUM",
            headers=_PRIO_READ_HEADERS, auth=_prio_auth(), timeout=15, verify=False,
        )
        if check.ok:
            rec = check.json()
            if rec.get("FINAL") == "Y":
                fncnum = rec.get("FNCNUM") or ivnum
                if action_queue_db:
                    action_queue_db.mark_final_by_priority_fncnum(ivnum, ivnum, journal_fncnum=fncnum)
                return jsonify({"ok": True, "ivnum": ivnum, "final_ivnum": ivnum, "fncnum": fncnum, "already_final": True})

        script_dir = os.path.join(os.path.dirname(__file__), "close_receipt")
        result = _node_run(script_dir, ["close_transfer.js", ivnum])
        stdout = (result.stdout or b"").decode("utf-8", errors="replace").strip()
        stderr = (result.stderr or b"").decode("utf-8", errors="replace").strip()
        if stderr:
            logger.info(f"close_transfer stderr: {stderr}")

        try:
            sdk_data = json.loads(stdout) if stdout else {}
        except Exception:
            sdk_data = {}

        if result.returncode != 0 or not sdk_data.get("ok"):
            err = sdk_data.get("error") or stderr or "שגיאה לא ידועה"
            logger.error(f"close_transfer.js failed for {ivnum}: {err}")
            return jsonify({"ok": False, "error": err, "needs_manual": True}), 500

        final_ivnum = sdk_data.get("final_ivnum") or ivnum
        fncnum      = sdk_data.get("fncnum") or ivnum

        queue_item = action_queue_db.get_by_priority_fncnum(ivnum) if action_queue_db else None
        if action_queue_db:
            action_queue_db.mark_final_by_priority_fncnum(ivnum, final_ivnum, journal_fncnum=fncnum)
        recon_cashname = (queue_item or {}).get("cashname", "")
        if recon_cashname:
            _launch_bank_recon(fncnum, recon_cashname, (queue_item or {}).get("fncnum", ""), label="transfer-final")

        return jsonify({"ok": True, "ivnum": ivnum, "final_ivnum": final_ivnum, "fncnum": fncnum})

    except subprocess.TimeoutExpired:
        return jsonify({"ok": False, "error": "close_transfer.js timed out (90s)", "needs_manual": True}), 500
    except Exception as e:
        logger.error(f"transfer_finalize error for {ivnum}: {e}")
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/receipts/journal-template", methods=["GET"])
def journal_template_suggest():
    """Return saved counterpart-account suggestion for a transaction description."""
    try:
        details = (request.args.get("details") or "").strip()
        if not details or not journal_templates_db:
            return jsonify({"ok": True, "counterpart_account": "", "counterpart_desc": ""})
        acc, desc = journal_templates_db.get_suggestion(details)
        return jsonify({"ok": True, "counterpart_account": acc or "", "counterpart_desc": desc or ""})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/receipts/bank-gl-map", methods=["GET"])
def list_bank_gl_map():
    """Return all saved CASHNAME → GL account mappings."""
    try:
        data = journal_templates_db.list_bank_gl() if journal_templates_db else {}
        return jsonify({"ok": True, "map": data})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/receipts/bank-gl-map", methods=["POST"])
def save_bank_gl_map():
    """Save a CASHNAME → GL account mapping."""
    try:
        body       = request.get_json(force=True) or {}
        cashname   = body.get("cashname",   "").strip()
        gl_account = body.get("gl_account", "").strip()
        bank_desc  = body.get("bank_desc",  "").strip()
        if not cashname or not gl_account:
            return jsonify({"ok": False, "error": "חסרים שדות cashname / gl_account"}), 400
        if journal_templates_db:
            journal_templates_db.save_bank_gl(cashname, gl_account, bank_desc)
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/receipts/bank-gl", methods=["GET"])
def get_bank_gl_account():
    """Detect and return the bank GL account for a CASHNAME."""
    try:
        cashname   = (request.args.get("cashname")   or "").strip()
        branchname = (request.args.get("branchname") or cashname.split("-")[0]).strip()
        bank_name  = (request.args.get("bank_name")  or "").strip()
        if not cashname:
            return jsonify({"ok": True, "gl_account": "", "gl_desc": ""})
        gl, desc = _detect_bank_gl(cashname, branchname, bank_name)
        return jsonify({"ok": True, "gl_account": gl or "", "gl_desc": desc or ""})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/receipts/priority-accounts", methods=["GET"])
def priority_accounts_search():
    """Search Priority chart of accounts (ACCOUNTS) for autocomplete."""
    try:
        q          = (request.args.get("q")          or "").strip()
        branchname = (request.args.get("branchname") or "").strip()
        if len(q) < 1:
            return jsonify({"ok": True, "accounts": []})

        suffix = f"-{branchname}" if (branchname and branchname != "000") else ""

        cached = accounts_cache_db.get_accounts_cache()
        if cached and cached.get("data"):
            q_lower = q.lower()
            results = [
                a for a in cached["data"]
                if (q_lower in a["accname"].lower() or q_lower in a["accdes"].lower())
                and (not suffix or a["accname"].endswith(suffix))
            ][:50]
            return jsonify({"ok": True, "accounts": results, "from_cache": True})

        if len(q) < 2:
            return jsonify({"ok": True, "accounts": []})
        q_safe = q.replace("'", "")
        flt = f"contains(ACCNAME,'{q_safe}') or contains(ACCDES,'{q_safe}')"
        r = http_requests.get(
            f"{_prio_url()}/ACCOUNTS?$filter={flt}&$select=ACCNAME,ACCDES&$top=50",
            headers=_PRIO_READ_HEADERS, auth=_prio_auth(), timeout=10,
        )
        r.raise_for_status()
        accounts = [
            {"accname": a["ACCNAME"], "accdes": a.get("ACCDES", "")}
            for a in r.json().get("value", [])
            if not suffix or a["ACCNAME"].endswith(suffix)
        ]
        return jsonify({"ok": True, "accounts": accounts})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e), "accounts": []}), 500


@app.route("/api/receipts/priority-suppliers", methods=["GET"])
def priority_suppliers_search():
    """Search Priority suppliers (SUPPLIERS) for autocomplete."""
    try:
        q = (request.args.get("q") or "").strip()
        if len(q) < 1:
            return jsonify({"ok": True, "suppliers": []})
        q_safe = q.replace("'", "")
        flt = f"contains(SUPNAME,'{q_safe}') or contains(SUPDES,'{q_safe}')"
        r = http_requests.get(
            f"{_prio_url()}/SUPPLIERS?$filter={flt}&$select=SUPNAME,SUPDES&$top=30",
            headers=_PRIO_READ_HEADERS, auth=_prio_auth(), timeout=10, verify=False,
        )
        r.raise_for_status()
        suppliers = [
            {"supname": s["SUPNAME"], "supdes": s.get("SUPDES", "")}
            for s in r.json().get("value", [])
        ]
        return jsonify({"ok": True, "suppliers": suppliers})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e), "suppliers": []}), 500


@app.route("/api/receipts/bank-line/record-action", methods=["POST"])
def bank_line_record_action():
    """Record a manual action (journal / transfer) for a bank line and mark it done immediately."""
    try:
        data       = request.get_json(force=True) or {}
        txn_id     = str(data.get("txn_id",     "")).strip()
        action     = str(data.get("action",     "journal")).strip()
        details    = str(data.get("details",    "")).strip()
        sum1       = data.get("sum1", 0)
        direction  = str(data.get("direction",  "-")).strip()
        branchname = str(data.get("branchname", "")).strip()
        bank_desc  = str(data.get("bank_desc",  "")).strip()
        curdate    = str(data.get("curdate",    "")).strip()
        cashname   = str(data.get("cashname",   "")).strip()

        if not txn_id:
            return jsonify({"ok": False, "error": "Missing txn_id"}), 400

        if action_queue_db:
            item = action_queue_db.add_item(
                fncnum=txn_id,
                curdate=curdate,
                details=details,
                accname1="",
                accdes1=bank_desc,
                accname2="",
                accdes2="",
                sum1=sum1,
                direction=direction,
                branchname=branchname,
                action=action,
                cashname=cashname,
            )
            if item:
                action_queue_db.mark_done(item["id"])

        processed = _load_processed_txns()
        processed.add(txn_id)
        _save_processed_txns(processed)

        _launch_bank_recon("", cashname, txn_id, label=action)

        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/receipts/customer-search", methods=["GET"])
def customer_search():
    """Search customers matching the given amount and branch."""
    try:
        amount_str = (request.args.get("amount") or "").strip()
        branchname = (request.args.get("branchname") or "").strip()
        curdate    = (request.args.get("curdate") or "").strip()[:10]

        if not amount_str:
            return jsonify({"ok": True, "results": []})
        try:
            amount = float(amount_str)
        except ValueError:
            return jsonify({"ok": True, "results": []})

        branch_safe = branchname.replace("'", "") if branchname and branchname not in ("000", "all") else ""

        flt = f"TOTPRICE eq {amount} and STATDES ne 'מבוטלת'"
        if branch_safe:
            flt += f" and BRANCHNAME eq '{branch_safe}'"

        r = http_requests.get(
            f"{_prio_url()}/CINVOICES?$filter={flt}"
            "&$select=CUSTNAME,CDES,IVNUM,IVDATE,TOTPRICE,STATDES,BRANCHNAME"
            "&$orderby=IVDATE desc&$top=20",
            headers=_PRIO_READ_HEADERS, auth=_prio_auth(), timeout=20,
        )
        r.raise_for_status()
        items = r.json().get("value", [])

        seen = {}
        for inv in items:
            custname = (inv.get("CUSTNAME") or "").strip()
            if not custname or custname in seen:
                continue
            inv_branch = (inv.get("BRANCHNAME") or "").strip()
            accname_full = f"{custname}-{inv_branch}" if inv_branch and inv_branch != "000" else custname
            seen[custname] = {
                "accname":    accname_full,
                "accdes":     (inv.get("CDES") or "").strip(),
                "branchname": inv_branch,
                "ivnum":      inv.get("IVNUM", ""),
                "ivdate":     inv.get("IVDATE", ""),
                "totprice":   inv.get("TOTPRICE", 0),
                "statdes":    inv.get("STATDES", ""),
            }

        if not seen:
            try:
                eflt = f"TOTPRICE eq {amount}"
                if branch_safe:
                    eflt += f" and BRANCHNAME eq '{branch_safe}'"
                er = http_requests.get(
                    f"{_prio_url()}/EINVOICES?$filter={eflt}"
                    "&$select=CUSTNAME,CDES,IVNUM,IVDATE,TOTPRICE,BRANCHNAME"
                    "&$orderby=IVDATE desc&$top=10",
                    headers=_PRIO_READ_HEADERS, auth=_prio_auth(), timeout=15,
                )
                if er.ok:
                    for inv in er.json().get("value", []):
                        custname = (inv.get("CUSTNAME") or "").strip()
                        if not custname or custname in seen:
                            continue
                        inv_branch = (inv.get("BRANCHNAME") or "").strip()
                        accname_full = f"{custname}-{inv_branch}" if inv_branch and inv_branch != "000" else custname
                        seen[custname] = {
                            "accname":    accname_full,
                            "accdes":     (inv.get("CDES") or "").strip(),
                            "branchname": inv_branch,
                            "ivnum":      inv.get("IVNUM", ""),
                            "ivdate":     inv.get("IVDATE", ""),
                            "totprice":   inv.get("TOTPRICE", 0),
                            "statdes":    "",
                            "from_einvoice": True,
                        }
            except Exception:
                pass

        if seen:
            try:
                or_clauses = " or ".join(
                    f"ACCNAME eq '{v['accname']}'" for v in seen.values()
                )
                rc_r = http_requests.get(
                    f"{_prio_url()}/TINVOICES?$filter=({or_clauses}) and TOTPRICE eq {amount} and FINAL eq 'Y'"
                    "&$select=IVNUM,ACCNAME,FNCNUM,IVDATE&$orderby=IVDATE desc&$top=20",
                    headers=_PRIO_READ_HEADERS, auth=_prio_auth(), timeout=10,
                )
                if rc_r.status_code == 200:
                    from collections import defaultdict as _dd
                    from datetime import datetime as _dt
                    rc_by_acc = _dd(list)
                    for item in rc_r.json().get("value", []):
                        acc   = item.get("ACCNAME", "")
                        ivnum = item.get("IVNUM", "")
                        if acc and ivnum:
                            rc_by_acc[acc].append({
                                "rc_ivnum": ivnum,
                                "fncnum":   item.get("FNCNUM", "") or "",
                                "ivdate":   (item.get("IVDATE", "") or "")[:10],
                            })
                    for cust_data in seen.values():
                        candidates = rc_by_acc.get(cust_data["accname"], [])
                        if not candidates:
                            continue
                        best, best_diff = None, 31
                        for rc in candidates:
                            if curdate and rc["ivdate"]:
                                try:
                                    diff = abs((_dt.strptime(curdate, "%Y-%m-%d") - _dt.strptime(rc["ivdate"], "%Y-%m-%d")).days)
                                except ValueError:
                                    diff = 0
                            else:
                                diff = 0
                            if diff < best_diff:
                                best, best_diff = rc, diff
                        if best and best_diff <= 30:
                            cust_data["existing_rc"]     = best["rc_ivnum"]
                            cust_data["existing_fncnum"] = best["fncnum"]
                            cust_data["existing_ivdate"] = best["ivdate"]
            except Exception:
                pass

        return jsonify({"ok": True, "results": list(seen.values())[:5]})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/receipts/open-invoices", methods=["GET"])
def receipts_open_invoices():
    """Find CINVOICES matching customer + amount for receipt modal auto-matching."""
    try:
        accname    = (request.args.get("accname")    or "").strip()
        amount_str = (request.args.get("amount")     or "").strip()
        branchname = (request.args.get("branchname") or "").strip()

        if not accname:
            return jsonify({"ok": True, "invoices": []})

        base_accname = accname.split("-")[0] if "-" in accname else accname

        flt = f"CUSTNAME eq '{base_accname}' and STATDES ne 'מבוטלת'"

        filters_to_try = []
        if branchname and branchname not in ("000", "all"):
            branch_safe = branchname.replace("'", "")
            filters_to_try.append(f"{flt} and BRANCHNAME eq '{branch_safe}'")
        filters_to_try.append(flt)

        invoices = []
        for f_try in filters_to_try:
            r = http_requests.get(
                f"{_prio_url()}/CINVOICES?$filter={f_try}"
                "&$select=IVNUM,CUSTNAME,CDES,IVDATE,TOTPRICE,STATDES,BRANCHNAME,IVRECONDATE"
                "&$orderby=IVDATE desc&$top=50",
                headers=_PRIO_READ_HEADERS, auth=_prio_auth(), timeout=20,
            )
            r.raise_for_status()
            all_inv = r.json().get("value", [])
            invoices = [inv for inv in all_inv if not inv.get("IVRECONDATE")]
            if invoices:
                break

        return jsonify({"ok": True, "invoices": invoices})
    except Exception as e:
        logger.warning(f"open-invoices error: {e}")
        return jsonify({"ok": False, "error": str(e), "invoices": []}), 500


# ── Action queue (non-receipt bank transactions pending treatment) ──────────

@app.route("/api/receipts/action-queue", methods=["GET"])
def get_action_queue():
    try:
        return jsonify({"ok": True, "items": action_queue_db.list_pending()})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/receipts/action-queue/add", methods=["POST"])
def add_to_action_queue():
    try:
        d = request.get_json() or {}
        item = action_queue_db.add_item(
            fncnum=str(d.get("fncnum", "")),
            curdate=d.get("curdate", ""),
            details=d.get("details", ""),
            accname1=d.get("accname1", ""),
            accdes1=d.get("accdes1", ""),
            accname2=d.get("accname2", ""),
            accdes2=d.get("accdes2", ""),
            sum1=d.get("sum1", 0),
            direction=d.get("direction", ""),
            branchname=d.get("branchname", ""),
            action=d.get("action", "journal"),
        )
        if item is None:
            return jsonify({"ok": False, "error": "כבר בתור"}), 409
        return jsonify({"ok": True, "item": item})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/receipts/action-queue/<item_id>/set-action", methods=["POST"])
def set_action_queue_action(item_id):
    try:
        d = request.get_json() or {}
        action = d.get("action", "journal")
        item = action_queue_db.set_action(item_id, action)
        if item is None:
            return jsonify({"ok": False, "error": "לא נמצא"}), 404
        return jsonify({"ok": True, "item": item})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/receipts/action-queue/<item_id>/done", methods=["POST"])
def done_action_queue(item_id):
    """Mark item as done: remove from queue + add FNCNUM to processed list."""
    try:
        items = action_queue_db.list_pending()
        target = next((i for i in items if i["id"] == item_id), None)
        if target is None:
            return jsonify({"ok": False, "error": "לא נמצא"}), 404
        action_queue_db.mark_done(item_id)
        processed = _load_processed_txns()
        processed.add(target["fncnum"])
        _save_processed_txns(processed)
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/receipts/action-queue/<item_id>/remove", methods=["POST"])
def remove_from_action_queue(item_id):
    """Remove action-queue item and restore bank line to unmatched list."""
    try:
        all_items = action_queue_db._load() if action_queue_db else []
        item = next((r for r in all_items if r.get("id") == item_id), None)

        result = action_queue_db.remove_item(item_id)
        if result is None:
            return jsonify({"ok": False, "error": "לא נמצא"}), 404

        if item:
            fncnum = item.get("fncnum", "")
            if fncnum:
                processed = _load_processed_txns()
                processed.discard(fncnum)
                _save_processed_txns(processed)

        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/receipts/action-queue/<item_id>/delete", methods=["POST"])
def delete_from_action_queue(item_id):
    """Delete action-queue item without restoring bank line."""
    try:
        result = action_queue_db.remove_item(item_id)
        if result is None:
            return jsonify({"ok": False, "error": "לא נמצא"}), 404
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/receipts/action-queue/done-list", methods=["GET"])
def get_done_action_queue():
    try:
        return jsonify({"ok": True, "items": action_queue_db.list_done()})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/receipts/<receipt_id>/delete", methods=["DELETE", "POST"])
def delete_receipt_endpoint(receipt_id):
    """Remove a receipt from the local queue (approved/pending/closed)."""
    try:
        rec = receipts_db.get_receipt(receipt_id)
        if rec is None:
            return jsonify({"ok": False, "error": "קבלה לא נמצאה"}), 404

        fncnums_to_release = set()
        for field in ("fncnum", "bank_fncnum"):
            val = rec.get(field)
            if val:
                fncnums_to_release.add(val)

        result = receipts_db.delete_receipt(receipt_id)
        if result is None:
            return jsonify({"ok": False, "error": "קבלה לא נמצאה"}), 404

        if fncnums_to_release:
            processed = _load_processed_txns()
            processed -= fncnums_to_release
            _save_processed_txns(processed)

        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/receipts/cash-accounts", methods=["GET"])
def receipts_cash_accounts():
    """Return valid CASHNAME codes from Priority's PAYOBLIG table."""
    try:
        all_cashnames = []
        r_pay = http_requests.get(
            f"{_prio_url()}/PAYOBLIG?$select=PAYOBLIGNAME,PAYOBLIGDES,BRANCHNAME&$top=200",
            headers=_PRIO_READ_HEADERS, auth=_prio_auth(), timeout=15,
        )
        if r_pay.status_code == 200:
            for rec in r_pay.json().get("value", []):
                name = rec.get("PAYOBLIGNAME", "")
                branch = rec.get("BRANCHNAME", "")
                if name:
                    all_cashnames.append({"name": name, "des": rec.get("PAYOBLIGDES", ""), "branch": branch})
        else:
            r = http_requests.get(
                f"{_prio_url()}/TINVOICES?$top=300&$select=CASHNAME,BRANCHNAME&$orderby=IVDATE desc",
                headers=_PRIO_READ_HEADERS, auth=_prio_auth(), timeout=20,
            )
            r.raise_for_status()
            seen = set()
            for rec in r.json().get("value", []):
                name = rec.get("CASHNAME", "")
                branch = rec.get("BRANCHNAME", "")
                if name and name not in seen:
                    seen.add(name)
                    all_cashnames.append({"name": name, "des": name, "branch": branch})

        by_branch = {}
        for item in all_cashnames:
            branch = item["branch"]
            name = item["name"]
            if name:
                by_branch.setdefault(branch, [])
                if name not in by_branch[branch]:
                    by_branch[branch].append(name)
        return jsonify({"ok": True, "byBranch": by_branch, "all": all_cashnames})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/receipts/pending", methods=["GET"])
def receipts_pending():
    """List locally-queued receipts pending accountant approval."""
    try:
        return jsonify({"ok": True, "receipts": receipts_db.list_pending()})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/receipts/approved", methods=["GET"])
def receipts_approved():
    """List receipts that were sent to Priority, newest first."""
    try:
        limit = int(request.args.get("limit", 50))
        all_recs = receipts_db.list_all()
        approved = [r for r in all_recs if r.get("status") in ("approved", "closed")]
        approved.sort(key=lambda r: r.get("approved_at", ""), reverse=True)
        return jsonify({"ok": True, "receipts": approved[:limit]})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/receipts/queue", methods=["POST"])
def receipts_queue():
    """Save an open invoice as a local pending receipt (no Priority call)."""
    try:
        body = request.get_json(force=True) or {}
        fncnum = body.get("fncnum") or body.get("ivnum", "")
        accname = body.get("accname") or body.get("custname", "")
        accdes = body.get("accdes") or body.get("cdes", "")
        cashname = body.get("cashname", "")
        totprice = body.get("totprice", 0)
        ivdate = body.get("ivdate", "")
        branchname = body.get("branchname", "")
        details = body.get("details", "תקבול")
        source_ivnum = body.get("source_ivnum", "")

        if not fncnum or not accname or not cashname or not totprice:
            return jsonify({"ok": False, "error": "Missing required fields"}), 400

        rec = receipts_db.add_receipt(fncnum, accname, accdes, cashname, totprice, ivdate, branchname, details, source_ivnum)
        if rec is None:
            return jsonify({"ok": False, "error": "חשבונית זו כבר קיימת בתור"}), 409
        return jsonify({"ok": True, "receipt": rec})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/receipts/<receipt_id>/approve", methods=["POST"])
def receipts_approve(receipt_id):
    """Approve a local receipt — creates a DRAFT in Priority TINVOICES."""
    try:
        rec = receipts_db.get_receipt(receipt_id)
        if not rec:
            return jsonify({"ok": False, "error": "Not found"}), 404
        if rec.get("status") != "pending":
            return jsonify({"ok": False, "error": "לא ניתן לאשר — סטטוס " + rec.get("status", "")}), 400

        raw_accname = rec["accname"]
        branchname = rec.get("branchname", "")
        branch = (branchname or "").strip()
        if branch and branch != "000" and not raw_accname.endswith(f"-{branch}"):
            accname = f"{raw_accname}-{branch}"
        else:
            accname = raw_accname
        ivdate_str = (rec.get("ivdate") or "")[:10]

        payload = {
            "ACCNAME":     accname,
            "CASHNAME":    rec["cashname"],
            "TOTPRICE":    float(rec["totprice"]),
            "IVDATE":      ivdate_str,
            "PAYDATE":     ivdate_str,
            "BRANCHNAME":  branchname,
            "DETAILS":     rec["details"],
            "CASHPAYMENT": float(rec["totprice"]),
        }

        logger.info(f"TINVOICES payload: {payload}")
        resp = http_requests.post(
            f"{_prio_url()}/TINVOICES", json=payload,
            headers=_PRIO_WRITE_HEADERS, auth=_prio_auth(), timeout=20,
        )
        resp.raise_for_status()
        resp_data     = resp.json()
        priority_ivnum = resp_data.get("IVNUM", "")
        ivtype        = resp_data.get("IVTYPE", "T")
        debit_val     = resp_data.get("DEBIT",  "D")

        key = f"IVNUM='{priority_ivnum}',IVTYPE='{ivtype}',DEBIT='{debit_val}'"
        amount = float(rec["totprice"])
        pay_payload = {
            "PAYMENTCODE": "3",
            "PAYDATE":     ivdate_str,
            "QPRICE":      amount,
            "FIRSTPAY":    amount,
            "TOTPRICE":    amount,
            "DETAILS":     rec["details"],
        }
        try:
            http_requests.post(
                f"{_prio_url()}/TINVOICES({key})/TPAYMENT2_SUBFORM",
                json=pay_payload, headers=_PRIO_WRITE_HEADERS, auth=_prio_auth(), timeout=15,
            ).raise_for_status()
            logger.info(f"TPAYMENT2_SUBFORM filled for {priority_ivnum}")
        except Exception as pay_err:
            logger.warning(f"TPAYMENT2_SUBFORM fill failed (non-fatal): {pay_err}")

        receipts_db.approve_receipt(receipt_id, priority_ivnum)
        return jsonify({"ok": True, "priority_ivnum": priority_ivnum})
    except http_requests.exceptions.HTTPError as e:
        try:
            detail = e.response.json()
        except Exception:
            detail = str(e)
        return jsonify({"ok": False, "error": str(e), "detail": detail, "payload_sent": payload}), 500
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/receipts/<receipt_id>/edit", methods=["POST"])
def receipts_edit(receipt_id):
    """Update cashname / details on a pending receipt (before approval)."""
    try:
        body = request.get_json(force=True) or {}
        rec = receipts_db.get_receipt(receipt_id)
        if not rec:
            return jsonify({"ok": False, "error": "Not found"}), 404
        if rec.get("status") != "pending":
            return jsonify({"ok": False, "error": "ניתן לערוך רק קבלות ממתינות"}), 400
        if "cashname" in body:
            rec["cashname"] = body["cashname"]
        if "details" in body:
            rec["details"] = body["details"]
        receipts_db._save_receipt(rec)
        return jsonify({"ok": True, "receipt": rec})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/receipts/<receipt_id>/reject", methods=["POST"])
def receipts_reject(receipt_id):
    """Reject a locally-queued receipt (no Priority call)."""
    try:
        body = request.get_json(force=True) or {}
        reason = body.get("reason", "")
        rec = receipts_db.reject_receipt(receipt_id, reason)
        if not rec:
            return jsonify({"ok": False, "error": "Not found"}), 404
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/receipts/<receipt_id>/close", methods=["POST"])
def receipts_close(receipt_id):
    """Close a Priority draft receipt via Web SDK (CLOSETIV procedure)."""
    import subprocess
    try:
        rec = receipts_db.get_receipt(receipt_id)
        if not rec:
            return jsonify({"ok": False, "error": "קבלה לא נמצאה"}), 404

        priority_ivnum = rec.get("priority_ivnum")
        if not priority_ivnum:
            return jsonify({"ok": False, "error": "הקבלה עוד לא נשלחה לפריוריטי"}), 400

        script_dir = os.path.join(os.path.dirname(__file__), "close_receipt")

        result = _node_run(script_dir, ["close_receipt.js", priority_ivnum])

        stdout = (result.stdout or b"").decode("utf-8", errors="replace").strip()
        stderr = (result.stderr or b"").decode("utf-8", errors="replace").strip()
        if stderr:
            app.logger.info("close_receipt stderr: %s", stderr)

        try:
            data = json.loads(stdout) if stdout else {}
        except Exception:
            data = {}

        if result.returncode != 0 or not data.get("ok"):
            err = data.get("error") or stderr or "שגיאה לא ידועה"
            return jsonify({"ok": False, "error": err}), 500

        fncnum   = data.get("fncnum")   or None
        rc_ivnum = data.get("rc_ivnum") or None

        if not rc_ivnum:
            import time as _time
            _time.sleep(2)
            accname_key = rec.get("accname", "")
            totprice    = rec.get("totprice", 0)
            ivdate_key  = (rec.get("ivdate") or "")[:10]
            if accname_key and totprice:
                try:
                    rr = http_requests.get(
                        f"{_prio_url()}/TINVOICES?$filter=ACCNAME eq '{accname_key}'"
                        f" and TOTPRICE eq {totprice} and FINAL eq 'Y'"
                        "&$select=IVNUM,FNCNUM,IVDATE&$orderby=IV desc&$top=5",
                        headers=_PRIO_READ_HEADERS, auth=_prio_auth(), timeout=15, verify=False,
                    )
                    if rr.ok:
                        items = rr.json().get("value", [])
                        best = None
                        for item in items:
                            if not ivdate_key or (item.get("IVDATE") or "")[:10] == ivdate_key:
                                best = item
                                break
                        if not best and items:
                            best = items[0]
                        if best:
                            rc_ivnum = best.get("IVNUM")
                            fncnum   = fncnum or (best.get("FNCNUM") or None)
                except Exception as _e:
                    logger.warning(f"post-close RC lookup failed: {_e}")

        bank_fncnum_orig = rec.get("bank_fncnum") or rec.get("fncnum") or ""
        cashname         = rec.get("cashname", "")
        receipts_db._save_receipt({
            **rec,
            "status":      "closed",
            "closed_at":   _now_il().isoformat(),
            "fncnum":      fncnum,
            "rc_ivnum":    rc_ivnum,
            "bank_fncnum": bank_fncnum_orig,
        })
        _launch_bank_recon(fncnum or "", cashname, bank_fncnum_orig, label="receipt-close")
        return jsonify({"ok": True, "ivnum": priority_ivnum, "fncnum": fncnum, "rc_ivnum": rc_ivnum})

    except subprocess.TimeoutExpired:
        return jsonify({"ok": False, "error": "Timeout — בדוק בפריוריטי ידנית"}), 504
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/receipts/<receipt_id>/refresh-final", methods=["POST"])
def receipts_refresh_final(receipt_id):
    """Re-fetch final invoice/receipt number and journal FNCNUM from Priority."""
    try:
        rec = receipts_db.get_receipt(receipt_id)
        if not rec:
            return jsonify({"ok": False, "error": "קבלה לא נמצאה"}), 404

        fncnum     = rec.get("fncnum")      or None
        totprice   = rec.get("totprice", 0)
        ivdate_key = (rec.get("ivdate") or "")[:10]
        doc_type   = rec.get("doc_type", "receipt")

        if not totprice:
            return jsonify({"ok": False, "error": "חסר totprice"}), 400

        if doc_type == "invoice_receipt":
            custname_key = rec.get("accname", "").split("-")[0]
            rr = http_requests.get(
                f"{_prio_url()}/EINVOICES?$filter=CUSTNAME eq '{custname_key}'"
                f" and TOTPRICE eq {totprice} and FINAL eq 'Y'"
                "&$select=IVNUM,FNCNUM,IVDATE&$orderby=IV desc&$top=10",
                headers=_PRIO_READ_HEADERS, auth=_prio_auth(), timeout=15, verify=False,
            )
            if not rr.ok:
                return jsonify({"ok": False, "error": f"Priority {rr.status_code}: {rr.text[:200]}"}), 500
            items = rr.json().get("value", [])
            best = next((x for x in items if not ivdate_key or (x.get("IVDATE") or "")[:10] == ivdate_key), None)
            if not best and items:
                best = items[0]
            final_ivnum = best.get("IVNUM") if best else None
            fncnum      = (best.get("FNCNUM") or fncnum) if best else fncnum
            receipts_db._save_receipt({**rec, "fncnum": fncnum, "final_ivnum": final_ivnum})
            return jsonify({"ok": True, "fncnum": fncnum, "final_ivnum": final_ivnum})

        else:
            accname_key = rec.get("accname", "")
            rr = http_requests.get(
                f"{_prio_url()}/TINVOICES?$filter=ACCNAME eq '{accname_key}'"
                f" and TOTPRICE eq {totprice} and FINAL eq 'Y'"
                "&$select=IVNUM,FNCNUM,IVDATE&$orderby=IV desc&$top=10",
                headers=_PRIO_READ_HEADERS, auth=_prio_auth(), timeout=15, verify=False,
            )
            if not rr.ok:
                return jsonify({"ok": False, "error": f"Priority {rr.status_code}: {rr.text[:200]}"}), 500
            items = rr.json().get("value", [])
            best = next((x for x in items if not ivdate_key or (x.get("IVDATE") or "")[:10] == ivdate_key), None)
            if not best and items:
                best = items[0]
            rc_ivnum = best.get("IVNUM") if best else None
            fncnum   = (best.get("FNCNUM") or fncnum) if best else fncnum
            receipts_db._save_receipt({**rec, "fncnum": fncnum, "rc_ivnum": rc_ivnum})
            return jsonify({"ok": True, "fncnum": fncnum, "rc_ivnum": rc_ivnum})

    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/receipts/<receipt_id>/close-einvoice", methods=["POST"])
def receipts_close_einvoice(receipt_id):
    """Finalize a Priority draft EINVOICES (חשבונית מס קבלה) via REST PATCH."""
    import subprocess, shutil
    try:
        rec = receipts_db.get_receipt(receipt_id)
        if not rec:
            return jsonify({"ok": False, "error": "קבלה לא נמצאה"}), 404

        priority_ivnum = rec.get("priority_ivnum")
        if not priority_ivnum:
            return jsonify({"ok": False, "error": "החשבונית עוד לא נשלחה לפריוריטי"}), 400

        script_dir = os.path.join(os.path.dirname(__file__), "close_receipt")
        result = _node_run(script_dir, ["close_einvoice.js", priority_ivnum], timeout=60)

        stdout = (result.stdout or b"").decode("utf-8", errors="replace").strip()
        stderr = (result.stderr or b"").decode("utf-8", errors="replace").strip()
        if stderr:
            app.logger.info("close_einvoice stderr: %s", stderr)

        try:
            data = json.loads(stdout) if stdout else {}
        except Exception:
            data = {}

        if result.returncode != 0 or not data.get("ok"):
            err = data.get("error") or stderr or "שגיאה לא ידועה"
            return jsonify({"ok": False, "error": err}), 500

        final_ivnum = data.get("final_ivnum") or None
        fncnum      = data.get("fncnum")      or None

        if not final_ivnum or not fncnum:
            import time as _time_ei
            _time_ei.sleep(2)
            custname_key = rec.get("accname", "").split("-")[0]
            totprice_ei  = rec.get("totprice", 0)
            ivdate_ei    = (rec.get("ivdate") or "")[:10]
            if custname_key and totprice_ei:
                try:
                    ei_resp = http_requests.get(
                        f"{_prio_url()}/EINVOICES?$filter=CUSTNAME eq '{custname_key}'"
                        f" and TOTPRICE eq {totprice_ei} and FINAL eq 'Y'"
                        "&$select=IVNUM,FNCNUM,IVDATE&$orderby=IV desc&$top=5",
                        headers=_PRIO_READ_HEADERS, auth=_prio_auth(), timeout=15, verify=False,
                    )
                    if ei_resp.ok:
                        ei_items = ei_resp.json().get("value", [])
                        best = None
                        for item in ei_items:
                            if not ivdate_ei or (item.get("IVDATE") or "")[:10] == ivdate_ei:
                                best = item
                                break
                        if not best and ei_items:
                            best = ei_items[0]
                        if best:
                            final_ivnum = final_ivnum or best.get("IVNUM")
                            fncnum      = fncnum or (best.get("FNCNUM") or None)
                except Exception as _e:
                    logger.warning(f"post-close EINVOICES lookup failed: {_e}")

        bank_fncnum_orig = rec.get("bank_fncnum") or rec.get("fncnum") or ""
        cashname         = rec.get("cashname", "")
        receipts_db._save_receipt({
            **rec,
            "status":      "closed",
            "closed_at":   _now_il().isoformat(),
            "final_ivnum": final_ivnum,
            "fncnum":      fncnum,
            "bank_fncnum": bank_fncnum_orig,
        })
        _launch_bank_recon(fncnum or "", cashname, bank_fncnum_orig, label="einvoice-close")
        return jsonify({"ok": True, "ivnum": priority_ivnum, "final_ivnum": final_ivnum, "fncnum": fncnum})

    except subprocess.TimeoutExpired:
        return jsonify({"ok": False, "error": "Timeout — בדוק בפריוריטי ידנית"}), 504
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/receipts/auto-scan", methods=["POST"])
def auto_scan_receipts():
    """Batch-detect existing Priority final receipts for untracked credit bank lines."""
    try:
        from collections import defaultdict
        body = request.get_json(force=True) or {}
        txns = body.get("transactions", [])
        if not txns:
            return jsonify({"ok": True, "imported": 0})

        all_records = receipts_db.list_all()
        tracked = {r.get("bank_fncnum") for r in all_records if r.get("bank_fncnum")}
        tracked |= {r.get("fncnum") for r in all_records if r.get("status") in ("pending", "approved")}
        pending = [t for t in txns if t.get("fncnum") not in tracked][:25]
        if not pending:
            return jsonify({"ok": True, "imported": 0})

        txn_by_key = defaultdict(list)
        for t in pending:
            key = (float(t.get("amount", 0)), (t.get("branchname") or "").strip())
            txn_by_key[key].append(t)

        unique_amounts = list({k[0] for k in txn_by_key})[:15]
        amt_filter = " or ".join(f"TOTPRICE eq {a}" for a in unique_amounts)
        cinv_r = http_requests.get(
            f"{_prio_url()}/CINVOICES?$filter=({amt_filter}) and STATDES ne 'מבוטלת'"
            "&$select=CUSTNAME,CDES,TOTPRICE,BRANCHNAME&$orderby=IVDATE desc&$top=200",
            headers=_PRIO_READ_HEADERS, auth=_prio_auth(), timeout=20,
        )
        if cinv_r.status_code != 200:
            return jsonify({"ok": True, "imported": 0})

        cinv_by_key = defaultdict(list)
        cinv_seen = set()
        for inv in cinv_r.json().get("value", []):
            custname = (inv.get("CUSTNAME") or "").strip()
            if not custname:
                continue
            inv_branch = (inv.get("BRANCHNAME") or "").strip()
            accname_full = f"{custname}-{inv_branch}" if inv_branch and inv_branch != "000" else custname
            key = (float(inv.get("TOTPRICE", 0)), inv_branch)
            dedup = (key, accname_full)
            if dedup in cinv_seen:
                continue
            cinv_seen.add(dedup)
            cinv_by_key[key].append({"accname": accname_full, "accdes": (inv.get("CDES") or "").strip(), "branchname": inv_branch})

        single = {k: v[0] for k, v in cinv_by_key.items() if len(v) == 1 and k in txn_by_key}
        if not single:
            return jsonify({"ok": True, "imported": 0})

        accnames = list({v["accname"] for v in single.values()})[:15]
        acc_filter = " or ".join(f"ACCNAME eq '{a}'" for a in accnames)
        amounts_filter = " or ".join(f"TOTPRICE eq {k[0]}" for k in single)
        tinv_r = http_requests.get(
            f"{_prio_url()}/TINVOICES?$filter=({acc_filter}) and ({amounts_filter}) and FINAL eq 'Y'"
            "&$select=IVNUM,ACCNAME,FNCNUM,TOTPRICE,IVDATE&$orderby=IVDATE desc&$top=200",
            headers=_PRIO_READ_HEADERS, auth=_prio_auth(), timeout=20,
        )
        if tinv_r.status_code != 200:
            return jsonify({"ok": True, "imported": 0})

        tinv_map = defaultdict(list)
        for item in tinv_r.json().get("value", []):
            if not item.get("IVNUM"):
                continue
            key = (item.get("ACCNAME", ""), float(item.get("TOTPRICE", 0)))
            tinv_map[key].append({
                "rc_ivnum": item["IVNUM"],
                "fncnum":   item.get("FNCNUM", "") or "",
                "ivdate":   (item.get("IVDATE") or "")[:10],
            })

        def _closest_receipt(receipts, txn_date_str, max_days=30):
            if not txn_date_str or not receipts:
                return None
            try:
                from datetime import datetime as _dt
                txn_d = _dt.strptime(txn_date_str[:10], "%Y-%m-%d")
            except ValueError:
                return None
            best, best_diff = None, max_days + 1
            for r in receipts:
                try:
                    r_d = _dt.strptime(r["ivdate"][:10], "%Y-%m-%d")
                    diff = abs((txn_d - r_d).days)
                    if diff < best_diff:
                        best, best_diff = r, diff
                except (ValueError, KeyError):
                    continue
            return best

        processed = _load_processed_txns()
        imported = 0
        for (amount, branchname), cust in single.items():
            candidates = tinv_map.get((cust["accname"], amount), [])
            for txn in txn_by_key[(amount, branchname)]:
                tinv = _closest_receipt(candidates, txn.get("curdate", ""), max_days=30)
                if not tinv:
                    continue
                rec = receipts_db.add_closed_receipt(
                    bank_fncnum=txn.get("fncnum", ""),
                    accname=cust["accname"],
                    accdes=cust["accdes"],
                    cashname=txn.get("cashname", ""),
                    totprice=amount,
                    ivdate=tinv["ivdate"] or (txn.get("curdate") or "")[:10],
                    branchname=cust["branchname"],
                    details="קבלה",
                    rc_ivnum=tinv["rc_ivnum"],
                    fncnum_journal=tinv["fncnum"],
                )
                if rec:
                    processed.add(txn.get("fncnum", ""))
                    imported += 1

        if imported:
            _save_processed_txns(processed)

        return jsonify({"ok": True, "imported": imported})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/receipts/import-existing", methods=["POST"])
def import_existing_receipt():
    """Save an already-closed Priority receipt to the local DB so it appears in the table."""
    try:
        body = request.get_json(force=True) or {}
        bank_fncnum   = body.get("bank_fncnum", "")
        accname       = body.get("accname", "")
        accdes        = body.get("accdes", "")
        cashname      = body.get("cashname", "")
        totprice      = float(body.get("totprice", 0))
        ivdate        = body.get("ivdate", "")
        branchname    = body.get("branchname", "")
        rc_ivnum      = body.get("rc_ivnum", "")
        fncnum_journal = body.get("fncnum", "")

        if not rc_ivnum:
            return jsonify({"ok": False, "error": "rc_ivnum is required"}), 400

        rec = receipts_db.add_closed_receipt(
            bank_fncnum=bank_fncnum,
            accname=accname, accdes=accdes, cashname=cashname,
            totprice=totprice, ivdate=ivdate, branchname=branchname,
            details="קבלה", rc_ivnum=rc_ivnum, fncnum_journal=fncnum_journal,
        )
        if rec is None:
            return jsonify({"ok": True, "duplicate": True})
        return jsonify({"ok": True, "id": rec["id"]})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


# ── Journal recommendations (SQLite + FTS5) ──────────────────────────────────

@app.route("/api/receipts/recommendations", methods=["GET"])
def recommendations_list():
    if not recommendations_db:
        return jsonify({"ok": False, "error": "recommendations DB unavailable"}), 500
    try:
        q = (request.args.get("q") or "").strip()
        rows = recommendations_db.list_all(q=q)
        return jsonify({"ok": True, "recommendations": rows, "total": recommendations_db.count()})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/receipts/recommendations", methods=["POST"])
def recommendations_add():
    if not recommendations_db:
        return jsonify({"ok": False, "error": "recommendations DB unavailable"}), 500
    try:
        d = request.get_json(force=True) or {}
        rec = recommendations_db.add(
            details=d.get("details", ""),
            counterpart_account=d.get("counterpart_account", ""),
            counterpart_desc=d.get("counterpart_desc", ""),
            cashname=d.get("cashname", ""),
            branch=d.get("branch", ""),
            direction=d.get("direction", ""),
        )
        if not rec:
            return jsonify({"ok": False, "error": "חסר פירוט או חשבון נגדי"}), 400
        return jsonify({"ok": True, "recommendation": rec})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/receipts/recommendations/<rid>/update", methods=["POST"])
def recommendations_update(rid):
    if not recommendations_db:
        return jsonify({"ok": False, "error": "recommendations DB unavailable"}), 500
    try:
        d = request.get_json(force=True) or {}
        rec = recommendations_db.update(rid, **d)
        if not rec:
            return jsonify({"ok": False, "error": "לא נמצא"}), 404
        return jsonify({"ok": True, "recommendation": rec})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/receipts/recommendations/<rid>/delete", methods=["POST"])
def recommendations_delete(rid):
    if not recommendations_db:
        return jsonify({"ok": False, "error": "recommendations DB unavailable"}), 500
    try:
        return jsonify({"ok": recommendations_db.delete(rid)})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/receipts/recommendations/match", methods=["GET"])
def recommendations_match():
    """Rank recommendations for a transaction's details (test/preview)."""
    if not recommendations_db:
        return jsonify({"ok": False, "error": "recommendations DB unavailable"}), 500
    try:
        rows = recommendations_db.match(
            details=request.args.get("details", ""),
            cashname=request.args.get("cashname", ""),
            branch=request.args.get("branch", ""),
            direction=request.args.get("direction", ""),
        )
        return jsonify({"ok": True, "matches": rows})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


# ── Serve Bank Discrepancies React frontend ──────────────────────────────────
_BANK_DIST = Path(__file__).resolve().parent.parent / "dist"

@app.route("/", defaults={"path": ""})
@app.route("/<path:path>")
def serve_bank_app(path):
    """Serve the built Bank Discrepancies React app."""
    if path and (_BANK_DIST / path).exists():
        return send_from_directory(_BANK_DIST, path)
    return send_from_directory(_BANK_DIST, "index.html")


if __name__ == "__main__":
    print("Bank Discrepancies Backend API")
    print(f"Priority Real: {PRIORITY_URL_REAL}")
    if _BANK_DIST.exists():
        print(f"UI: http://localhost:5000/")
    else:
        print(f"UI dist not built yet (run: npm run build)")
    port = int(os.environ.get("PORT", 5002))
    print(f"Starting on http://localhost:{port}")
    app.run(
        host="0.0.0.0",
        port=port,
        debug=False,
    )
