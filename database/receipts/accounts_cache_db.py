# -*- coding: utf-8 -*-
import json
from datetime import datetime
from pathlib import Path

_CACHE_FILE = Path(__file__).parent / "accounts_cache.json"


def save_accounts_cache(accounts_list):
    """Save full ACCOUNTS list (accname, accdes) to local JSON file."""
    data = {
        "updated_at": datetime.utcnow().isoformat() + "Z",
        "count": len(accounts_list),
        "accounts": accounts_list,
    }
    _CACHE_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def get_accounts_cache():
    """Return {data: [...], count, updated_at} or None if not cached."""
    if not _CACHE_FILE.exists():
        return None
    try:
        data = json.loads(_CACHE_FILE.read_text(encoding="utf-8"))
        return {
            "data": data.get("accounts", []),
            "count": data.get("count", 0),
            "updated_at": data.get("updated_at", ""),
        }
    except Exception:
        return None
