"""Read-only SQLite schema fingerprinting for isolated local fixtures only."""
from __future__ import annotations
import hashlib
import json
import sqlite3

def schema_snapshot(conn: sqlite3.Connection) -> dict:
    objects = conn.execute("""
        SELECT type, name, tbl_name, COALESCE(sql, '') AS sql
        FROM sqlite_master
        WHERE type IN ('table','index','trigger','view')
          AND name NOT LIKE 'sqlite_%'
        ORDER BY type, tbl_name, name
    """).fetchall()
    tables = {}
    for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"):
        name = row[0]
        qname = '"' + name.replace('"', '""') + '"'
        tables[name] = {
            "columns": [list(r) for r in conn.execute(f"PRAGMA table_info({qname})")],
            "indexes": [list(r) for r in conn.execute(f"PRAGMA index_list({qname})")],
            "foreign_keys": [list(r) for r in conn.execute(f"PRAGMA foreign_key_list({qname})")],
        }
    return {"objects": [list(r) for r in objects], "tables": tables}

def fingerprint(conn: sqlite3.Connection) -> str:
    payload = json.dumps(schema_snapshot(conn), sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()

def compare_snapshots(before: dict, after: dict) -> dict:
    before_names = {(o[0], o[1]) for o in before.get("objects", [])}
    after_names = {(o[0], o[1]) for o in after.get("objects", [])}
    return {
        "added_objects": sorted([list(x) for x in after_names - before_names]),
        "removed_objects": sorted([list(x) for x in before_names - after_names]),
        "changed_tables": sorted(name for name in set(before.get("tables", {})) & set(after.get("tables", {}))
                                  if before["tables"][name] != after["tables"][name]),
    }
