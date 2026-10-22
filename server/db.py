"""SQLite storage for Tome & Table (spec §2).

One shared connection in WAL mode and autocommit, guarded by a re-entrant lock. ``tx()`` wraps
multi-statement changes in ``BEGIN IMMEDIATE`` / ``COMMIT``. Rows come back as plain dicts.
The schema is created with ``CREATE TABLE IF NOT EXISTS`` at start-up (no migrations).
Timestamps are Unix milliseconds (JavaScript ``Date.now()`` compatible); IDs are ``uuid4().hex``.
"""
from __future__ import annotations

import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, Sequence

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    token   TEXT PRIMARY KEY,           -- SHA-256 of the cookie value, never the value itself
    user_id TEXT NOT NULL,
    created INTEGER NOT NULL,
    expires INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);

CREATE TABLE IF NOT EXISTS campaigns (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    dm_id       TEXT NOT NULL,
    invite_code TEXT NOT NULL UNIQUE,
    created     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS campaigns_dm ON campaigns (dm_id);

-- The DM is NOT listed as a member.
CREATE TABLE IF NOT EXISTS campaign_members (
    campaign_id TEXT NOT NULL,
    user_id     TEXT NOT NULL,
    joined      INTEGER NOT NULL,
    PRIMARY KEY (campaign_id, user_id)
);
CREATE INDEX IF NOT EXISTS campaign_members_user ON campaign_members (user_id);

CREATE TABLE IF NOT EXISTS characters (
    id          TEXT PRIMARY KEY,
    owner_id    TEXT NOT NULL,
    campaign_id TEXT,
    source      TEXT NOT NULL DEFAULT 'manual',   -- 'aurora' | 'manual'
    data        TEXT NOT NULL,                    -- character JSON minus server fields
    created     INTEGER NOT NULL,
    updated     INTEGER NOT NULL,
    deleted     INTEGER
);
CREATE INDEX IF NOT EXISTS characters_owner ON characters (owner_id);
CREATE INDEX IF NOT EXISTS characters_campaign ON characters (campaign_id);

CREATE TABLE IF NOT EXISTS notes (
    id           TEXT PRIMARY KEY,
    owner_id     TEXT NOT NULL,
    campaign_id  TEXT,
    character_id TEXT,
    title        TEXT NOT NULL DEFAULT '',
    folder       TEXT NOT NULL DEFAULT '',
    body         TEXT NOT NULL DEFAULT '',
    tags         TEXT NOT NULL DEFAULT '[]',      -- JSON array of strings
    shared       INTEGER NOT NULL DEFAULT 0,
    created      INTEGER NOT NULL,
    updated      INTEGER NOT NULL,
    deleted      INTEGER
);
CREATE INDEX IF NOT EXISTS notes_owner ON notes (owner_id);
CREATE INDEX IF NOT EXISTS notes_campaign ON notes (campaign_id);

CREATE TABLE IF NOT EXISTS login_attempts (
    key          TEXT PRIMARY KEY,                -- lower-cased username
    count        INTEGER NOT NULL,
    locked_until INTEGER
);
CREATE TABLE IF NOT EXISTS aurora_elements (     -- descriptions parsed from Aurora Builder content files
    id      TEXT PRIMARY KEY,                     -- Aurora element id, e.g. ID_PHB_SPELL_ACID_SPLASH
    name    TEXT NOT NULL,
    type    TEXT NOT NULL,                        -- Racial Trait, Class Feature, Spell, Feat, ...
    source  TEXT,
    sheet   TEXT,                                 -- JSON [{level, text}] short sheet descriptions
    desc    TEXT,                                 -- full description as markdown
    usage   TEXT,                                 -- e.g. "1/Long Rest"
    action  TEXT,                                 -- Action / Bonus Action / Reaction
    meta    TEXT,                                 -- JSON of <setters> (spell level, school, range, ...)
    updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS aurora_elements_name ON aurora_elements (type, name COLLATE NOCASE);
"""


def now_ms() -> int:
    """Current time in Unix milliseconds."""
    return time.time_ns() // 1_000_000


def new_id() -> str:
    return uuid.uuid4().hex


class Database:
    """Thin wrapper around a single SQLite connection; every helper returns dicts."""

    def __init__(self, path: str | Path):
        self.path = str(path)
        self._lock = threading.RLock()
        self._depth = 0
        # The app may create the connection in one thread and use it from another (TestClient,
        # uvicorn's loop), so cross-thread use is allowed; the lock serialises access.
        self.conn = sqlite3.connect(self.path, check_same_thread=False, isolation_level=None, timeout=10)
        self.conn.row_factory = sqlite3.Row
        with self._lock:
            self.conn.execute("PRAGMA journal_mode=WAL")
            self.conn.execute("PRAGMA synchronous=NORMAL")
            self.conn.execute("PRAGMA busy_timeout=10000")
            self.conn.executescript(SCHEMA)

    def close(self) -> None:
        with self._lock:
            self.conn.close()

    # ------------------------------------------------------------------ generic helpers
    def query(self, sql: str, params: Sequence[Any] | dict = ()) -> list[dict]:
        with self._lock:
            return [dict(r) for r in self.conn.execute(sql, params).fetchall()]

    def one(self, sql: str, params: Sequence[Any] | dict = ()) -> dict | None:
        with self._lock:
            row = self.conn.execute(sql, params).fetchone()
            return dict(row) if row is not None else None

    def value(self, sql: str, params: Sequence[Any] | dict = ()) -> Any:
        with self._lock:
            row = self.conn.execute(sql, params).fetchone()
            return row[0] if row is not None else None

    def execute(self, sql: str, params: Sequence[Any] | dict = ()) -> int:
        """Run one statement; returns the number of rows changed."""
        with self._lock:
            return self.conn.execute(sql, params).rowcount

    @contextmanager
    def tx(self) -> Iterator["Database"]:
        """Group statements into one transaction (nested calls join the outer one)."""
        with self._lock:
            if self._depth:
                self._depth += 1
                try:
                    yield self
                finally:
                    self._depth -= 1
                return
            self.conn.execute("BEGIN IMMEDIATE")
            self._depth = 1
            try:
                yield self
            except BaseException:
                self._depth = 0
                self.conn.execute("ROLLBACK")
                raise
            self._depth = 0
            self.conn.execute("COMMIT")

    # ------------------------------------------------------------------ domain lookups
    def user_by_id(self, user_id: str) -> dict | None:
        return self.one("SELECT * FROM users WHERE id = ?", (user_id,))

    def user_by_name(self, username: str) -> dict | None:
        # The column is COLLATE NOCASE, so this comparison is case-insensitive and indexed.
        return self.one("SELECT * FROM users WHERE username = ?", (username,))

    def campaign(self, campaign_id: str) -> dict | None:
        return self.one(
            "SELECT c.*, u.username AS dm_name FROM campaigns c JOIN users u ON u.id = c.dm_id WHERE c.id = ?",
            (campaign_id,),
        )

    def campaign_role(self, user_id: str, campaign_id: str | None) -> str | None:
        """'dm', 'member' or None for this user in this campaign."""
        if not campaign_id:
            return None
        dm_id = self.value("SELECT dm_id FROM campaigns WHERE id = ?", (campaign_id,))
        if dm_id is None:
            return None
        if dm_id == user_id:
            return "dm"
        member = self.value(
            "SELECT 1 FROM campaign_members WHERE campaign_id = ? AND user_id = ?", (campaign_id, user_id)
        )
        return "member" if member else None

    def campaign_ids(self, user_id: str) -> tuple[set[str], set[str]]:
        """(campaigns this user DMs, campaigns this user is a member of)."""
        dm = {r["id"] for r in self.query("SELECT id FROM campaigns WHERE dm_id = ?", (user_id,))}
        member = {
            r["campaign_id"]
            for r in self.query("SELECT campaign_id FROM campaign_members WHERE user_id = ?", (user_id,))
        }
        return dm, member

    def campaign_members(self, campaign_id: str) -> list[dict]:
        return self.query(
            "SELECT u.id, u.username FROM campaign_members m JOIN users u ON u.id = m.user_id "
            "WHERE m.campaign_id = ? ORDER BY m.joined, u.username COLLATE NOCASE",
            (campaign_id,),
        )
