# -*- coding: utf-8 -*-
"""
Journal-entry recommendations DB (SQLite + FTS5).

Learns from confirmed journal entries: maps a transaction's DETAILS (+ optional
CASHNAME/branch/direction) to the counterpart GL account that was recorded.
On a new transaction we rank past recommendations by full-text relevance (BM25)
of the details, boosted by CASHNAME match and how often the rule was used.

One file: recommendations.db, next to the other receipts data (lives in the
bind-mounted volume, backed up with everything else).
"""
import os
import re
import uuid
import sqlite3
from datetime import datetime

_DIR = os.path.dirname(__file__)
_DB_FILE = os.path.join(_DIR, "recommendations.db")


def _normalize(text):
    return re.sub(r"\s+", " ", (text or "").strip())


def _now():
    return datetime.now().isoformat(timespec="seconds")


def _conn():
    c = sqlite3.connect(_DB_FILE)
    c.row_factory = sqlite3.Row
    return c


def _init():
    c = _conn()
    try:
        c.executescript("""
        CREATE TABLE IF NOT EXISTS recommendations (
            id                  TEXT PRIMARY KEY,
            details             TEXT NOT NULL,
            cashname            TEXT DEFAULT '',
            branch              TEXT DEFAULT '',
            direction           TEXT DEFAULT '',
            counterpart_account TEXT NOT NULL,
            counterpart_desc    TEXT DEFAULT '',
            action              TEXT DEFAULT 'journal',
            times_used          INTEGER DEFAULT 1,
            last_used           TEXT DEFAULT '',
            created_at          TEXT DEFAULT ''
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS rec_fts USING fts5(details);

        CREATE TRIGGER IF NOT EXISTS rec_ai AFTER INSERT ON recommendations BEGIN
            INSERT INTO rec_fts(rowid, details) VALUES (new.rowid, new.details);
        END;
        CREATE TRIGGER IF NOT EXISTS rec_ad AFTER DELETE ON recommendations BEGIN
            DELETE FROM rec_fts WHERE rowid = old.rowid;
        END;
        CREATE TRIGGER IF NOT EXISTS rec_au AFTER UPDATE ON recommendations BEGIN
            DELETE FROM rec_fts WHERE rowid = old.rowid;
            INSERT INTO rec_fts(rowid, details) VALUES (new.rowid, new.details);
        END;
        """)
        # Migrate DBs created before the `action` column existed.
        try:
            c.execute("ALTER TABLE recommendations ADD COLUMN action TEXT DEFAULT 'journal'")
            c.commit()
        except sqlite3.OperationalError:
            pass
        c.commit()
    finally:
        c.close()


def _row(r):
    return dict(r) if r else None


# ── CRUD ─────────────────────────────────────────────────────────────────────

def add(details, counterpart_account, counterpart_desc="", cashname="",
        branch="", direction="", action="journal", times_used=1):
    """Insert a recommendation, or if one already exists for the same
    (normalized details + cashname), bump its usage and refresh the account."""
    details = _normalize(details)
    counterpart_account = (counterpart_account or "").strip()
    if not details or not counterpart_account:
        return None
    c = _conn()
    try:
        existing = c.execute(
            "SELECT id, times_used FROM recommendations WHERE details=? AND cashname=?",
            (details, cashname or ""),
        ).fetchone()
        if existing:
            c.execute(
                "UPDATE recommendations SET counterpart_account=?, counterpart_desc=?, "
                "branch=?, direction=?, action=?, times_used=times_used+?, last_used=? WHERE id=?",
                (counterpart_account, counterpart_desc, branch, direction, action or "journal",
                 max(1, times_used), _now(), existing["id"]),
            )
            rid = existing["id"]
        else:
            rid = str(uuid.uuid4())
            c.execute(
                "INSERT INTO recommendations(id, details, cashname, branch, direction, "
                "counterpart_account, counterpart_desc, action, times_used, last_used, created_at) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (rid, details, cashname or "", branch or "", direction or "",
                 counterpart_account, counterpart_desc or "", action or "journal",
                 max(1, times_used), _now(), _now()),
            )
        c.commit()
        return get(rid)
    finally:
        c.close()


def get(rid):
    c = _conn()
    try:
        return _row(c.execute("SELECT * FROM recommendations WHERE id=?", (rid,)).fetchone())
    finally:
        c.close()


def update(rid, **fields):
    """Edit allowed columns of a recommendation."""
    allowed = {"details", "cashname", "branch", "direction",
               "counterpart_account", "counterpart_desc", "action"}
    sets = {k: (_normalize(v) if k == "details" else v)
            for k, v in fields.items() if k in allowed}
    if not sets:
        return get(rid)
    c = _conn()
    try:
        cols = ", ".join(f"{k}=?" for k in sets)
        c.execute(f"UPDATE recommendations SET {cols} WHERE id=?",
                  (*sets.values(), rid))
        c.commit()
        return get(rid)
    finally:
        c.close()


def delete(rid):
    c = _conn()
    try:
        cur = c.execute("DELETE FROM recommendations WHERE id=?", (rid,))
        c.commit()
        return cur.rowcount > 0
    finally:
        c.close()


def list_all(q="", limit=500):
    """List recommendations, newest-used first. Optional substring filter on
    details / account / desc."""
    c = _conn()
    try:
        if q:
            like = f"%{q.strip()}%"
            rows = c.execute(
                "SELECT * FROM recommendations WHERE details LIKE ? OR counterpart_account "
                "LIKE ? OR counterpart_desc LIKE ? ORDER BY times_used DESC, last_used DESC LIMIT ?",
                (like, like, like, limit),
            ).fetchall()
        else:
            rows = c.execute(
                "SELECT * FROM recommendations ORDER BY times_used DESC, last_used DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [dict(r) for r in rows]
    finally:
        c.close()


def count():
    c = _conn()
    try:
        return c.execute("SELECT COUNT(*) AS n FROM recommendations").fetchone()["n"]
    finally:
        c.close()


def record_usage(rid):
    c = _conn()
    try:
        c.execute("UPDATE recommendations SET times_used=times_used+1, last_used=? WHERE id=?",
                  (_now(), rid))
        c.commit()
    finally:
        c.close()


# ── Matching (the recommender) ───────────────────────────────────────────────

def _fts_query(details):
    """Build an FTS5 OR-query from a transaction's details (quoted tokens)."""
    toks = [t for t in re.split(r"\s+", _normalize(details)) if len(t) >= 2]
    toks = [t.replace('"', '') for t in toks][:20]
    if not toks:
        return ""
    return " OR ".join(f'"{t}"' for t in toks)


def match(details, cashname="", branch="", direction="", limit=5):
    """Rank recommendations for a new transaction.
    Score = full-text relevance (BM25) boosted by CASHNAME match, branch/direction
    match and usage frequency. Returns a list of dicts with a 0-100 `confidence`."""
    fq = _fts_query(details)
    if not fq:
        return []
    c = _conn()
    try:
        try:
            rows = c.execute(
                "SELECT r.*, bm25(rec_fts) AS bm "
                "FROM rec_fts JOIN recommendations r ON r.rowid = rec_fts.rowid "
                "WHERE rec_fts MATCH ? ORDER BY bm LIMIT 50",
                (fq,),
            ).fetchall()
        except sqlite3.OperationalError:
            return []
        results = []
        for r in rows:
            d = dict(r)
            bm = d.pop("bm", 0) or 0
            # bm25: lower (more negative) = better match. Negate so a strong
            # match (bm far below zero) produces a high base score.
            base = max(0.0, 10.0 - bm)
            if cashname and d.get("cashname") == cashname:
                base += 6                          # same bank account → strong signal
            if branch and d.get("branch") == branch:
                base += 1
            if direction and d.get("direction") == direction:
                base += 1
            base += min(3.0, (d.get("times_used") or 1) * 0.3)  # frequency, capped
            d["score"] = round(base, 2)
            results.append(d)
        results.sort(key=lambda x: x["score"], reverse=True)
        top = results[:limit]
        if top:
            hi = top[0]["score"] or 1
            for d in top:
                d["confidence"] = min(100, round(d["score"] / hi * 100))
        return top
    finally:
        c.close()


# ── Seeding / migration ──────────────────────────────────────────────────────

def seed_from_templates(templates):
    """One-time import from the old journal_templates.json
    ({normalized_details: {counterpart_account, counterpart_desc}})."""
    n = 0
    for key, entry in (templates or {}).items():
        acc = (entry or {}).get("counterpart_account", "")
        if key and acc:
            if add(key, acc, (entry or {}).get("counterpart_desc", "")):
                n += 1
    return n


# Initialise the schema on import.
_init()
