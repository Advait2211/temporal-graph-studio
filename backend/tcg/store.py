"""SQLite interval store (proposal §Incremental Construction).

Every node and edge row carries a validity interval [s, f) over commit indices,
with f = NULL meaning "still valid at the newest commit". The graph as of
commit τ is a filtered query, not a stored copy:  s <= τ AND (f IS NULL OR f > τ).
"""

from __future__ import annotations

import json
import os
import sqlite3
from pathlib import Path

HOME = Path(os.environ.get("TCG_HOME", Path.home() / ".cache" / "tcg-studio"))
DB_DIR = HOME / "db"
REPO_DIR = HOME / "repos"

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS commits (
  idx INTEGER PRIMARY KEY, sha TEXT, parent TEXT, author TEXT, email TEXT, ts INTEGER, msg TEXT,
  files INTEGER, ins INTEGER, del INTEGER, n_delta INTEGER, n_code_files INTEGER
);
CREATE TABLE IF NOT EXISTS nodes (
  id INTEGER PRIMARY KEY, key TEXT, root TEXT, kind TEXT, name TEXT, qual TEXT, path TEXT, lang TEXT,
  start INTEGER, end_line INTEGER, sig TEXT, doc TEXT, is_test INTEGER, s INTEGER, f INTEGER,
  community INTEGER DEFAULT -1, pagerank REAL DEFAULT 0, qmeta TEXT
);
CREATE TABLE IF NOT EXISTS edges (
  id INTEGER PRIMARY KEY, src TEXT, dst TEXT, type TEXT, weight REAL, s INTEGER, f INTEGER
);
CREATE TABLE IF NOT EXISTS changes (t INTEGER, key TEXT, root TEXT, path TEXT, level TEXT);
CREATE INDEX IF NOT EXISTS nodes_key ON nodes(key);
CREATE INDEX IF NOT EXISTS nodes_sf ON nodes(s, f);
CREATE INDEX IF NOT EXISTS edges_sf ON edges(s, f);
CREATE INDEX IF NOT EXISTS edges_src ON edges(src);
CREATE INDEX IF NOT EXISTS edges_dst ON edges(dst);
CREATE INDEX IF NOT EXISTS changes_t ON changes(t);
CREATE INDEX IF NOT EXISTS changes_root ON changes(root);
"""


def db_path(repo_id: str) -> Path:
    return DB_DIR / f"{repo_id}.sqlite"


def connect(repo_id: str, fresh: bool = False) -> sqlite3.Connection:
    DB_DIR.mkdir(parents=True, exist_ok=True)
    p = db_path(repo_id)
    if fresh and p.exists():
        p.unlink()
    conn = sqlite3.connect(p, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    if "qmeta" not in {r[1] for r in conn.execute("PRAGMA table_info(nodes)")}:  # graphs built before quantum support
        conn.execute("ALTER TABLE nodes ADD COLUMN qmeta TEXT")
    return conn


def set_meta(conn: sqlite3.Connection, key: str, value) -> None:
    conn.execute("INSERT OR REPLACE INTO meta(k, v) VALUES (?, ?)", (key, json.dumps(value, default=str)))


def get_meta(conn: sqlite3.Connection, key: str, default=None):
    row = conn.execute("SELECT v FROM meta WHERE k = ?", (key,)).fetchone()
    return json.loads(row[0]) if row else default


def list_repo_ids() -> list[str]:
    if not DB_DIR.exists():
        return []
    return sorted(p.stem for p in DB_DIR.glob("*.sqlite") if not p.stem.endswith(".tmp"))


ALIVE = "s <= :tau AND (f IS NULL OR f > :tau)"


def nodes_as_of(conn: sqlite3.Connection, tau: int) -> list[sqlite3.Row]:
    return conn.execute(f"SELECT * FROM nodes WHERE {ALIVE}", {"tau": tau}).fetchall()


def edges_as_of(conn: sqlite3.Connection, tau: int) -> list[sqlite3.Row]:
    return conn.execute(f"SELECT * FROM edges WHERE {ALIVE}", {"tau": tau}).fetchall()


def changes_upto(conn: sqlite3.Connection, tau: int, level: str = "sym") -> list[sqlite3.Row]:
    return conn.execute("SELECT t, key, root, path FROM changes WHERE t <= ? AND level = ? ORDER BY t",
                        (tau, level)).fetchall()
