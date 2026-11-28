"""Sanitized, environment-labelled D1/SQLite schema manifest comparison.

Consumes schema metadata exported by schema_diff.schema_snapshot(). It never
opens a database and never reads business rows. SQL definitions are represented
only by SHA-256 digests so default literals or embedded constants are not echoed.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

FORMAT_VERSION = 1
TARGET_TABLES = (
    "app_cards",
    "app_groups",
    "admin_vip_activations",
    "admin_user_scopes",
    "admin_audit_events",
    "app_card_group_mappings",
    "app_card_group_admin_requests",
)


class ManifestError(ValueError):
    pass


def _digest(value: Any) -> str:
    if value is None:
        value = ""
    if not isinstance(value, str):
        value = str(value)
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _require_list(value: Any, label: str) -> list:
    if not isinstance(value, list):
        raise ManifestError(f"{label} must be a list")
    return value


def manifest_from_snapshot(snapshot: dict, environment: str) -> dict:
    """Create a minimal safe manifest from schema_snapshot() output."""
    if environment not in {"staging", "production", "local-fixture"}:
        raise ManifestError("environment must be staging, production, or local-fixture")
    if not isinstance(snapshot, dict) or not isinstance(snapshot.get("tables"), dict):
        raise ManifestError("snapshot.tables is required")
    objects = _require_list(snapshot.get("objects", []), "snapshot.objects")
    object_map: dict[tuple[str, str], dict] = {}
    for row in objects:
        if not isinstance(row, list) or len(row) < 4:
            raise ManifestError("each object row must contain type, name, table name, SQL")
        obj_type, name, table_name, sql = row[:4]
        if not all(isinstance(x, str) for x in (obj_type, name, table_name)):
            raise ManifestError("object identity fields must be strings")
        if obj_type in {"table", "index", "trigger", "view"}:
            object_map[(obj_type, name)] = {
                "type": obj_type,
                "name": name,
                "table": table_name,
                "sql_sha256": _digest(sql),
            }

    tables: dict[str, dict] = {}
    for table_name in TARGET_TABLES:
        raw = snapshot["tables"].get(table_name)
        if raw is None:
            tables[table_name] = {"status": "ABSENT"}
            continue
        if not isinstance(raw, dict):
            raise ManifestError(f"table metadata for {table_name} must be an object")

        columns = []
        for row in _require_list(raw.get("columns"), f"{table_name}.columns"):
            if not isinstance(row, list) or len(row) < 6:
                raise ManifestError(f"{table_name}: malformed table_info row")
            cid, name, declared_type, notnull, default_value, pk = row[:6]
            if not isinstance(name, str):
                raise ManifestError(f"{table_name}: column name must be a string")
            columns.append({
                "cid": cid, "name": name, "type": declared_type,
                "notnull": notnull, "pk": pk,
                "default_present": default_value is not None,
                "default_sha256": _digest(default_value) if default_value is not None else None,
            })

        index_details = raw.get("index_details", [])
        if not isinstance(index_details, list):
            raise ManifestError(f"{table_name}.index_details must be a list")
        indexes = []
        for item in index_details:
            if not isinstance(item, dict) or not isinstance(item.get("name"), str):
                raise ManifestError(f"{table_name}: malformed index detail")
            list_row = item.get("list_row", [])
            if not isinstance(list_row, list) or len(list_row) < 3:
                raise ManifestError(f"{table_name}: malformed index_list row")
            key_columns = []
            for col in _require_list(item.get("columns", []), f"{table_name}.index.columns"):
                if not isinstance(col, list) or len(col) < 3:
                    raise ManifestError(f"{table_name}: malformed index_info row")
                key_columns.append({"seqno": col[0], "cid": col[1], "name": col[2]})
            indexes.append({
                "name": item["name"],
                "unique": list_row[2],
                "origin": list_row[3] if len(list_row) > 3 else None,
                "partial": list_row[4] if len(list_row) > 4 else None,
                "columns": key_columns,
                "sql_sha256": _digest(item.get("sql", "")),
            })

        foreign_keys = []
        for row in _require_list(raw.get("foreign_keys"), f"{table_name}.foreign_keys"):
            if not isinstance(row, list) or len(row) < 8:
                raise ManifestError(f"{table_name}: malformed foreign_key_list row")
            foreign_keys.append({
                "id": row[0], "seq": row[1], "table": row[2],
                "from": row[3], "to": row[4], "on_update": row[5],
                "on_delete": row[6], "match": row[7],
            })

        related_objects = sorted(
            (obj for obj in object_map.values()
             if obj["table"] == table_name or
             (obj["type"] == "table" and obj["name"] == table_name)),
            key=lambda obj: (obj["type"], obj["name"]),
        )
        tables[table_name] = {
            "status": "PRESENT",
            "columns": columns,
            "indexes": sorted(indexes, key=lambda x: x["name"]),
            "foreign_keys": sorted(foreign_keys, key=lambda x: (x["id"], x["seq"])),
            "objects": related_objects,
        }

    manifest = {
        "format_version": FORMAT_VERSION,
        "environment": environment,
        "scope": list(TARGET_TABLES),
        "tables": tables,
    }
    canonical = json.dumps(manifest, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    manifest["manifest_sha256"] = _digest(canonical)
    return manifest


def compare_manifests(left: dict, right: dict) -> dict:
    """Compare two manifests without assuming either environment is authoritative."""
    for label, manifest in (("left", left), ("right", right)):
        if not isinstance(manifest, dict) or manifest.get("format_version") != FORMAT_VERSION:
            raise ManifestError(f"{label} manifest format_version is unsupported")
        if not isinstance(manifest.get("tables"), dict):
            raise ManifestError(f"{label} manifest tables is required")
    if set(left["tables"]) != set(right["tables"]):
        raise ManifestError("manifest scopes differ; normalize both to the same table scope")

    table_results = {}
    for name in sorted(left["tables"]):
        before, after = left["tables"][name], right["tables"][name]
        if before == after:
            table_results[name] = {"status": "MATCH", "differences": []}
            continue
        if before.get("status") == "ABSENT" or after.get("status") == "ABSENT":
            table_results[name] = {
                "status": "PRESENCE_MISMATCH",
                "differences": ["presence"],
            }
            continue
        differences = [
            key for key in ("columns", "indexes", "foreign_keys", "objects")
            if before.get(key) != after.get(key)
        ]
        table_results[name] = {
            "status": "MISMATCH",
            "differences": differences,
        }
    statuses = [item["status"] for item in table_results.values()]
    return {
        "left_environment": left.get("environment"),
        "right_environment": right.get("environment"),
        "comparison": "MATCH" if all(x == "MATCH" for x in statuses) else "MISMATCH",
        "table_results": table_results,
        "note": "Structural comparison only; not a semantic compatibility or migration approval.",
    }


def _read_json(path: str) -> dict:
    try:
        value = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ManifestError(f"cannot read JSON input: {exc}") from exc
    if not isinstance(value, dict):
        raise ManifestError("JSON root must be an object")
    return value


def main() -> int:
    parser = argparse.ArgumentParser(description="Compare sanitized schema manifests; no database access.")
    sub = parser.add_subparsers(dest="command", required=True)
    build = sub.add_parser("build", help="build a safe manifest from schema_snapshot JSON")
    build.add_argument("--input", required=True)
    build.add_argument("--environment", required=True, choices=("staging", "production", "local-fixture"))
    build.add_argument("--output", required=True)
    compare = sub.add_parser("compare", help="compare two manifests")
    compare.add_argument("--left", required=True)
    compare.add_argument("--right", required=True)
    compare.add_argument("--output", required=True)
    args = parser.parse_args()
    try:
        if args.command == "build":
            result = manifest_from_snapshot(_read_json(args.input), args.environment)
        else:
            result = compare_manifests(_read_json(args.left), _read_json(args.right))
        Path(args.output).write_text(
            json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        return 0
    except ManifestError as exc:
        parser.error(str(exc))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
