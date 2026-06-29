# -*- coding: utf-8 -*-
"""
Local cache of the Priority chart-of-accounts (ACCOUNTS entity), synced on
demand. Lets the account picker search locally (fast) instead of hitting
Priority on every transaction. Incremental sync via Priority's UDATE
(last-modified): each sync pulls only accounts changed/created since last time.

Stored per account: account number (ACCNAME), description (ACCDES), branch
(BRANCHNAME -> '000' = main company when empty), trial-balance section
(TRIALBALCODE) and title (TRIALBALDES).

One file: accounts.db, next to the other receipts data (in the volume).
"""
import os
import re
import sqlite3
from datetime import datetime

_DIR = os.path.dirname(__file__)
_DB_FILE = os.path.join(_DIR, "accounts.db")


def _conn():
    c = sqlite3.connect(_DB_FILE)
    c.row_factory = sqlite3.Row
    return c


def _init():
    c = _conn()
    try:
        c.executescript("""
        CREATE TABLE IF NOT EXISTS accounts (
            accname     TEXT PRIMARY KEY,   -- מספר החשבון
            accdes      TEXT DEFAULT '',    -- תיאור החשבון
            branch_code TEXT DEFAULT '000', -- סניף (000 = ראשי)
            branch_des  TEXT DEFAULT '',
            tb_code     TEXT DEFAULT '',    -- סעיף למאזן בוחן (TRIALBALCODE)
            tb_des      TEXT DEFAULT '',    -- כותרת למאזן בוחן (TRIALBALDES)
            udate       TEXT DEFAULT '',    -- Priority last-modified (incremental key)
            synced_at   TEXT DEFAULT ''
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS acc_fts USING fts5(accname, accdes);

        CREATE TRIGGER IF NOT EXISTS acc_ai AFTER INSERT ON accounts BEGIN
            INSERT INTO acc_fts(rowid, accname, accdes) VALUES (new.rowid, new.accname, new.accdes);
        END;
        CREATE TRIGGER IF NOT EXISTS acc_ad AFTER DELETE ON accounts BEGIN
            DELETE FROM acc_fts WHERE rowid = old.rowid;
        END;
        CREATE TRIGGER IF NOT EXISTS acc_au AFTER UPDATE ON accounts BEGIN
            DELETE FROM acc_fts WHERE rowid = old.rowid;
            INSERT INTO acc_fts(rowid, accname, accdes) VALUES (new.rowid, new.accname, new.accdes);
        END;

        CREATE TABLE IF NOT EXISTS acc_sync_state (k TEXT PRIMARY KEY, v TEXT);
        """)
        c.commit()
    finally:
        c.close()


def upsert(accname, accdes="", branch_code="000", branch_des="", tb_code="", tb_des="", udate=""):
    """Insert or update one account by ACCNAME. Returns True if stored."""
    accname = (accname or "").strip()
    if not accname:
        return False
    c = _conn()
    try:
        c.execute(
            """INSERT INTO accounts(accname, accdes, branch_code, branch_des, tb_code, tb_des, udate, synced_at)
               VALUES(?,?,?,?,?,?,?,?)
               ON CONFLICT(accname) DO UPDATE SET
                 accdes=excluded.accdes, branch_code=excluded.branch_code, branch_des=excluded.branch_des,
                 tb_code=excluded.tb_code, tb_des=excluded.tb_des, udate=excluded.udate, synced_at=excluded.synced_at""",
            (accname, accdes or "", (branch_code or "000"), branch_des or "", tb_code or "", tb_des or "",
             udate or "", datetime.now().isoformat(timespec="seconds")),
        )
        c.commit()
        return True
    finally:
        c.close()


def search(q="", branch="", limit=50, acc_suffix=""):
    """Search the local accounts for the picker. q matches account number or
    description (FTS prefix). Optional filters:
      branch     - exact match on the stored branch_code column.
      acc_suffix - the operational branch code (e.g. '200'); accounts are kept
                   only when their number ends with '-<acc_suffix>'. This mirrors
                   the app convention where the branch is encoded as a suffix of
                   the account number (e.g. 60367-200 = supplier 60367, branch
                   200; no suffix = main company 000)."""
    c = _conn()
    try:
        q = (q or "").strip()
        acc_suffix = (acc_suffix or "").strip()
        suffix_clause, suffix_param = "", None
        if acc_suffix and acc_suffix != "000":
            suffix_clause = " AND a.accname LIKE ?"
            suffix_param = f"%-{acc_suffix}"
        if q:
            toks = [t.replace('"', '') for t in re.split(r"\s+", q) if t][:10]
            fq = " ".join(f'"{t}"*' for t in toks) if toks else ""
            sql = ("SELECT a.* FROM acc_fts f JOIN accounts a ON a.rowid=f.rowid "
                   "WHERE acc_fts MATCH ?")
            params = [fq]
            if branch:
                sql += " AND a.branch_code=?"; params.append(branch)
            if suffix_param is not None:
                sql += suffix_clause; params.append(suffix_param)
            sql += " LIMIT ?"; params.append(limit)
            try:
                rows = c.execute(sql, params).fetchall()
            except sqlite3.OperationalError:
                return []
        else:
            sql = "SELECT * FROM accounts a WHERE 1=1"
            params = []
            if branch:
                sql += " AND a.branch_code=?"; params.append(branch)
            if suffix_param is not None:
                sql += suffix_clause; params.append(suffix_param)
            sql += " ORDER BY a.accname LIMIT ?"; params.append(limit)
            rows = c.execute(sql, params).fetchall()
        return [dict(r) for r in rows]
    finally:
        c.close()


def count():
    c = _conn()
    try:
        return c.execute("SELECT COUNT(*) AS n FROM accounts").fetchone()["n"]
    finally:
        c.close()


def last_synced_at():
    c = _conn()
    try:
        r = c.execute("SELECT MAX(synced_at) AS m FROM accounts").fetchone()
        return (r["m"] or "") if r else ""
    finally:
        c.close()


def get_last_udate():
    c = _conn()
    try:
        r = c.execute("SELECT v FROM acc_sync_state WHERE k='last_udate'").fetchone()
        return r["v"] if r else ""
    finally:
        c.close()


def set_last_udate(v):
    if not v:
        return
    c = _conn()
    try:
        c.execute("INSERT INTO acc_sync_state(k, v) VALUES('last_udate', ?) "
                  "ON CONFLICT(k) DO UPDATE SET v=excluded.v", (v,))
        c.commit()
    finally:
        c.close()


_init()
