# -*- coding: utf-8 -*-
import json
import uuid
from datetime import datetime
from pathlib import Path

_DB_FILE = Path(__file__).parent / "action_queue.json"


def _load():
    if not _DB_FILE.exists():
        return []
    try:
        return json.loads(_DB_FILE.read_text(encoding="utf-8"))
    except Exception:
        return []


def _save(records):
    _DB_FILE.write_text(json.dumps(records, ensure_ascii=False, indent=2), encoding="utf-8")


def list_pending():
    return [r for r in _load() if r.get("status") == "pending"]


def get_fncnums():
    """Return set of FNCNUMs in the queue (pending or done) so they stay off the bank table."""
    return {r["fncnum"] for r in _load() if r.get("status") in ("pending", "done")}


def add_item(fncnum, curdate, details, accname1, accdes1, accname2, accdes2,
             sum1, direction, branchname, action, priority_fncnum="", cashname=""):
    records = _load()
    if any(r.get("fncnum") == fncnum and r.get("status") == "pending" for r in records):
        return None  # already queued
    item = {
        "id": str(uuid.uuid4()),
        "fncnum": fncnum,
        "curdate": curdate,
        "details": details,
        "accname1": accname1,
        "accdes1": accdes1,
        "accname2": accname2,
        "accdes2": accdes2,
        "sum1": sum1,
        "direction": direction,
        "branchname": branchname,
        "action": action,
        "priority_fncnum": priority_fncnum,
        "cashname": cashname,
        "status": "pending",
        "created_at": datetime.now().isoformat(),
    }
    records.append(item)
    _save(records)
    return item


def set_action(item_id, action):
    records = _load()
    for r in records:
        if r.get("id") == item_id:
            r["action"] = action
            _save(records)
            return r
    return None


def mark_done(item_id):
    records = _load()
    for r in records:
        if r.get("id") == item_id:
            r["status"] = "done"
            r["done_at"] = datetime.now().isoformat()
            _save(records)
            return r
    return None


def remove_item(item_id):
    records = _load()
    new_records = [r for r in records if r.get("id") != item_id]
    if len(new_records) == len(records):
        return None
    _save(new_records)
    return item_id


def get_by_priority_fncnum(priority_fncnum):
    """Return the action_queue item with this priority_fncnum (or None)."""
    for r in _load():
        if r.get("priority_fncnum") == priority_fncnum:
            return r
    return None


def mark_final_by_priority_fncnum(priority_fncnum, final_fncnum=None, journal_fncnum=None):
    records = _load()
    for r in records:
        if r.get("priority_fncnum") == priority_fncnum and r.get("status") == "done":
            r["is_final"] = True
            r["final_at"] = datetime.now().isoformat()
            if final_fncnum and final_fncnum != priority_fncnum:
                r["priority_fncnum"] = final_fncnum
            if journal_fncnum:
                r["journal_fncnum"] = journal_fncnum
            _save(records)
            return r
    return None


def list_done():
    items = [r for r in _load() if r.get("status") == "done"]
    for item in items:
        item.setdefault("priority_fncnum", "")
        item.setdefault("is_final", False)
        item.setdefault("journal_fncnum", "")
    return items
