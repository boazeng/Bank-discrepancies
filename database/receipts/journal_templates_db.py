import json, os, re
from datetime import datetime

_DIR = os.path.dirname(__file__)
_TEMPLATES_FILE  = os.path.join(_DIR, "journal_templates.json")
_BANK_GL_FILE    = os.path.join(_DIR, "bank_gl_accounts.json")


def _load_templates():
    try:
        with open(_TEMPLATES_FILE, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _save_templates(data):
    with open(_TEMPLATES_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def _normalize(text):
    return re.sub(r"\s+", " ", (text or "").strip())


def get_suggestion(details):
    """Return (counterpart_account, counterpart_desc) for a transaction description, or (None, None)."""
    data = _load_templates()
    key = _normalize(details)
    if key in data:
        entry = data[key]
        return entry.get("counterpart_account", ""), entry.get("counterpart_desc", "")
    # Partial match: check if any stored key is a substring of details or vice-versa
    for stored_key, entry in data.items():
        if stored_key and (stored_key in key or key in stored_key):
            return entry.get("counterpart_account", ""), entry.get("counterpart_desc", "")
    return None, None


def save_template(details, counterpart_account, counterpart_desc="", branchname=""):
    data = _load_templates()
    key = _normalize(details)
    # Strip branch suffix so template works across branches (e.g. "620-0-103" → "620-0")
    base_acc = counterpart_account
    if branchname and base_acc.endswith(f"-{branchname}"):
        base_acc = base_acc[: -len(f"-{branchname}")]
    data[key] = {
        "counterpart_account": base_acc,
        "counterpart_desc": counterpart_desc,
        "updated_at": datetime.now().isoformat(),
    }
    _save_templates(data)


def list_templates():
    return _load_templates()


# ── Bank GL account mapping ──────────────────────────────────────────────────

def _load_bank_gl():
    try:
        with open(_BANK_GL_FILE, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _save_bank_gl(data):
    with open(_BANK_GL_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def get_bank_gl(cashname):
    """Return GL account code for a CASHNAME (e.g. '026-201' → '4021-026')."""
    return _load_bank_gl().get(cashname, {}).get("gl_account", "")


def save_bank_gl(cashname, gl_account, bank_desc=""):
    data = _load_bank_gl()
    data[cashname] = {
        "gl_account": gl_account,
        "bank_desc": bank_desc,
        "updated_at": datetime.now().isoformat(),
    }
    _save_bank_gl(data)


def list_bank_gl():
    return _load_bank_gl()
