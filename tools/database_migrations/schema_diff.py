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
        index_rows = [list(r) for r in conn.execute("PRAGMA index_list(" + qname + ")")]
        index_details = []
        for index_row in index_rows:
            index_name = str(index_row[1])
            qindex = '"' + index_name.replace('"', '""') + '"'
            index_details.append({
                "name": index_name,
                "list_row": index_row,
                "columns": [list(r) for r in conn.execute("PRAGMA index_info(" + qindex + ")")],
                "extended_columns": [list(r) for r in conn.execute("PRAGMA index_xinfo(" + qindex + ")")],
                "sql": conn.execute(
                    "SELECT COALESCE(sql, '') FROM sqlite_master WHERE type='index' AND name=?",
                    (index_name,),
                ).fetchone()[0],
            })
        tables[name] = {
            "columns": [list(r) for r in conn.execute("PRAGMA table_info(" + qname + ")")],
            "extended_columns": [list(r) for r in conn.execute("PRAGMA table_xinfo(" + qname + ")")],
            "indexes": index_rows,
            "index_details": index_details,
            "foreign_keys": [list(r) for r in conn.execute("PRAGMA foreign_key_list(" + qname + ")")],
        }
    return {"objects": [list(r) for r in objects], "tables": tables}

def fingerprint(conn: sqlite3.Connection) -> str:
    payload = json.dumps(schema_snapshot(conn), sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()

def compare_snapshots(before: dict, after: dict) -> dict:
    before_objects = {(o[0], o[1]): tuple(o) for o in before.get("objects", [])}
    after_objects = {(o[0], o[1]): tuple(o) for o in after.get("objects", [])}
    common = before_objects.keys() & after_objects.keys()
    changed = [
        {"type": key[0], "name": key[1], "before": list(before_objects[key]), "after": list(after_objects[key])}
        for key in sorted(common)
        if before_objects[key] != after_objects[key]
    ]
    return {
        "added_objects": sorted([list(x) for x in after_objects.keys() - before_objects.keys()]),
        "removed_objects": sorted([list(x) for x in before_objects.keys() - after_objects.keys()]),
        "changed_objects": changed,
        "changed_tables": sorted(name for name in set(before.get("tables", {})) & set(after.get("tables", {}))
                                  if before["tables"][name] != after["tables"][name]),
    }
