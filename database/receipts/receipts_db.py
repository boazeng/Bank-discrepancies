# -*- coding: utf-8 -*-
import json
import uuid
from datetime import datetime
from pathlib import Path

_DB_FILE = Path(__file__).parent / "receipts_data.json"


def _load():
    if not _DB_FILE.exists():
        return []
    try:
        return json.loads(_DB_FILE.read_text(encoding="utf-8"))
    except Exception:
        return []


def _save(records):
    _DB_FILE.write_text(json.dumps(records, ensure_ascii=False, indent=2), encoding="utf-8")


def add_receipt(fncnum, accname, accdes, cashname, totprice, ivdate, branchname, details, source_ivnum="", doc_type="receipt"):
    records = _load()
    for r in records:
        if r.get("fncnum") == fncnum and r.get("status") in ("pending", "approved"):
            return None  # already exists
    rec = {
        "id": str(uuid.uuid4()),
        "fncnum": fncnum,
        "accname": accname,        # customer code e.g. "50440"
        "accdes": accdes,          # customer name
        "cashname": cashname,      # bank/cash account code in Priority
        "totprice": totprice,
        "ivdate": ivdate,
        "branchname": branchname,
        "details": details,
        "source_ivnum": source_ivnum,
        "doc_type": doc_type,          # 'receipt' | 'invoice_receipt'
        "status": "pending",
        "created_at": datetime.now().isoformat(),
        "priority_ivnum": None,
    }
    records.append(rec)
    _save(records)
    return rec


def list_pending():
    return [r for r in _load() if r.get("status") == "pending"]


def list_all():
    return _load()


def get_receipt(receipt_id):
    for r in _load():
        if r.get("id") == receipt_id:
            return r
    return None


def approve_receipt(receipt_id, priority_ivnum):
    records = _load()
    for r in records:
        if r.get("id") == receipt_id:
            r["status"] = "approved"
            r["priority_ivnum"] = priority_ivnum
            r["approved_at"] = datetime.now().isoformat()
            _save(records)
            return r
    return None


def close_receipt_direct(receipt_id, priority_ivnum):
    """Mark a receipt as closed immediately (for EINVOICES which are final on creation)."""
    records = _load()
    now = datetime.now().isoformat()
    for r in records:
        if r.get("id") == receipt_id:
            r["status"] = "closed"
            r["priority_ivnum"] = priority_ivnum
            r["approved_at"] = now
            r["closed_at"] = now
            _save(records)
            return r
    return None


def reject_receipt(receipt_id, reason=""):
    records = _load()
    for r in records:
        if r.get("id") == receipt_id:
            r["status"] = "rejected"
            r["reject_reason"] = reason
            r["rejected_at"] = datetime.now().isoformat()
            _save(records)
            return r
    return None


def _save_receipt(updated_rec):
    records = _load()
    for i, r in enumerate(records):
        if r.get("id") == updated_rec.get("id"):
            records[i] = updated_rec
            _save(records)
            return updated_rec
    return None


def add_closed_receipt(bank_fncnum, accname, accdes, cashname, totprice, ivdate, branchname, details, rc_ivnum, fncnum_journal=""):
    """Import an already-closed Priority receipt. Dedup by rc_ivnum."""
    records = _load()
    if any(r.get("rc_ivnum") == rc_ivnum for r in records if rc_ivnum):
        return None  # already imported
    now = datetime.now().isoformat()
    rec = {
        "id": str(uuid.uuid4()),
        "fncnum": fncnum_journal or bank_fncnum,
        "bank_fncnum": bank_fncnum,
        "accname": accname,
        "accdes": accdes,
        "cashname": cashname,
        "totprice": totprice,
        "ivdate": ivdate,
        "branchname": branchname,
        "details": details,
        "status": "closed",
        "priority_ivnum": rc_ivnum,
        "rc_ivnum": rc_ivnum,
        "approved_at": now,
        "closed_at": now,
        "created_at": now,
    }
    records.append(rec)
    _save(records)
    return rec


def is_duplicate(fncnum):
    return any(r.get("fncnum") == fncnum and r.get("status") in ("pending", "approved", "closed")
               for r in _load())


def delete_receipt(receipt_id):
    records = _load()
    new_records = [r for r in records if r.get("id") != receipt_id]
    if len(new_records) == len(records):
        return None
    _save(new_records)
    return receipt_id
