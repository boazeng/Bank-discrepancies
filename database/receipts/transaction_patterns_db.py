# -*- coding: utf-8 -*-
import json, os, re
from datetime import datetime

_DIR = os.path.dirname(__file__)
_PATTERNS_FILE = os.path.join(_DIR, "transaction_patterns.json")


def _normalize(text):
    return re.sub(r"\s+", " ", (text or "").strip())


def _load():
    try:
        with open(_PATTERNS_FILE, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _save(data):
    with open(_PATTERNS_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def save_pattern(details, direction, action, accname, accdes="", cashname="", branchname=""):
    """Record that a transaction with this description was handled with action+account."""
    key = _normalize(details)
    if not key:
        return
    data = _load()
    prev = data.get(key, {})
    data[key] = {
        "action":     action,
        "accname":    accname,
        "accdes":     accdes,
        "direction":  direction,
        "cashname":   cashname,
        "branchname": branchname,
        "use_count":  prev.get("use_count", 0) + 1,
        "updated_at": datetime.now().isoformat(),
    }
    _save(data)


def find_pattern(details, direction=None, cashname=None):
    """Return matching pattern dict or None.

    Match priority:
    1. Exact normalised DETAILS (+ optional direction check)
    2. Stored key is a substring of details — never the reverse: a short/
       generic line (e.g. "העברה מהבנק") must not inherit the account of a
       longer, more specific saved pattern (e.g. "העברה מהבנק-פלסקוב") just
       because it's a prefix of it; that would apply one counterparty's
       account to any similarly-worded but unrelated transfer.
    Ignores cashname — same description in different banks should reuse.
    """
    data = _load()
    key = _normalize(details)

    def _dir_ok(p):
        return direction is None or not p.get("direction") or p["direction"] == direction

    # 1. Exact
    if key in data and _dir_ok(data[key]):
        return data[key]

    # 2. Substring (one direction only, see docstring)
    for stored_key, p in data.items():
        if stored_key and _dir_ok(p) and stored_key in key:
            return p

    return None


def list_patterns():
    return _load()


def delete_pattern(details):
    data = _load()
    key = _normalize(details)
    if key in data:
        del data[key]
        _save(data)
        return True
    return False
