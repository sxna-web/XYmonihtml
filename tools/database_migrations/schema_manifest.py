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
    objects = _require_list(snapshot.get("objects"), "snapshot.objects")
    object_map: dict[tuple[str, str], dict] = {}
    for row in objects:
        if not isinstance(row, list) or len(row) < 4:
            raise ManifestError("each object row must contain type, name, table name, SQL")
        obj_type, name, table_name, sql = row[:4]
        if not all(isinstance(x, str) for x in (obj_type, name, table_name)):
            raise ManifestError("object identity fields must be strings")
        if sql is not None and not isinstance(sql, str):
            raise ManifestError("object SQL must be text or null")
        if obj_type in {"table", "index", "trigger", "view"}:
            identity = (obj_type, name)
            if identity in object_map:
                raise ManifestError(f"duplicate schema object identity: {obj_type}/{name}")
            object_map[identity] = {
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

        if "index_details" not in raw:
            raise ManifestError(f"{table_name}.index_details is required; refusing partial manifest")
        index_details = raw["index_details"]
        if not isinstance(index_details, list):
            raise ManifestError(f"{table_name}.index_details must be a list")
        indexes = []
        for item in index_details:
            if not isinstance(item, dict) or not isinstance(item.get("name"), str):
                raise ManifestError(f"{table_name}: malformed index detail")
            if "list_row" not in item or "columns" not in item or "sql" not in item:
                raise ManifestError(f"{table_name}: index metadata is incomplete")
            list_row = item["list_row"]
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



def manifest_from_worker_diagnostic(payload: dict, environment: str) -> dict:
    """Build a safe manifest from /api/super/schema-status app_structure JSON.

    Worker diagnostics intentionally omit raw SQL/default literals. This path
    preserves their supplied hashes and compares only the metadata actually
    observed; it never upgrades partial observations into a verified manifest.
    """
    if environment not in {"staging", "production"}:
        raise ManifestError("environment must be staging or production")
    if not isinstance(payload, dict):
        raise ManifestError("diagnostic payload must be an object")
    structure = payload.get("data", {}).get("app_structure") if isinstance(payload.get("data"), dict) else None
    if structure is None and isinstance(payload.get("app_structure"), dict):
        structure = payload["app_structure"]
    if not isinstance(structure, dict):
        raise ManifestError("data.app_structure is required")
    if structure.get("verification") != "OBSERVED_SCHEMA_ONLY":
        raise ManifestError("APP schema diagnostic is not complete; refusing manifest")
    if structure.get("objects_verification") != "OBSERVED":
        raise ManifestError("schema object metadata is incomplete")
    raw_tables = structure.get("tables")
    raw_objects = structure.get("objects")
    if not isinstance(raw_tables, list) or not isinstance(raw_objects, list):
        raise ManifestError("diagnostic tables and objects must be lists")
    by_name = {}
    for item in raw_tables:
        if not isinstance(item, dict) or not isinstance(item.get("name"), str):
            raise ManifestError("malformed diagnostic table entry")
        if item["name"] in by_name:
            raise ManifestError("duplicate diagnostic table entry")
        by_name[item["name"]] = item

    object_rows = []
    for obj in raw_objects:
        if not isinstance(obj, dict) or not all(isinstance(obj.get(k), str) for k in ("type", "name", "table")):
            raise ManifestError("malformed diagnostic schema object")
        object_rows.append(obj)

    tables = {}
    for name in TARGET_TABLES:
        raw = by_name.get(name)
        if raw is None or raw.get("present") is False or raw.get("verification") == "MISSING":
            tables[name] = {"status": "ABSENT"}
            continue
        if raw.get("present") is not True or raw.get("verification") != "OBSERVED_SCHEMA_ONLY":
            raise ManifestError(f"{name}: diagnostic metadata is partial or unverified")
        columns_raw = _require_list(raw.get("columns"), f"{name}.columns")
        columns = []
        for col in columns_raw:
            if not isinstance(col, dict) or not isinstance(col.get("name"), str):
                raise ManifestError(f"{name}: malformed column metadata")
            digest = col.get("default_sha256")
            if digest is not None and (not isinstance(digest, str) or len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest)):
                raise ManifestError(f"{name}: invalid default digest")
            columns.append({
                "name": col["name"],
                "type": col.get("type", ""),
                "not_null": col.get("not_null"),
                "primary_key_order": col.get("primary_key_order"),
                "default_present": col.get("default_present"),
                "default_sha256": digest,
            })
        indexes_raw = _require_list(raw.get("indexes"), f"{name}.indexes")
        indexes = []
        for idx in indexes_raw:
            if not isinstance(idx, dict) or idx.get("verification") != "OBSERVED" or not isinstance(idx.get("name"), str):
                raise ManifestError(f"{name}: index metadata is partial")
            cols = _require_list(idx.get("columns"), f"{name}.index.columns")
            indexes.append({
                "name": idx["name"], "unique": idx.get("unique"),
                "origin": idx.get("origin"), "partial": idx.get("partial"),
                "columns": [{"sequence": c.get("sequence"), "name": c.get("name")} for c in cols if isinstance(c, dict)],
                "definition_digest_available": False,
            })
            if len(indexes[-1]["columns"]) != len(cols):
                raise ManifestError(f"{name}: malformed index column")
        fks_raw = _require_list(raw.get("foreign_keys"), f"{name}.foreign_keys")
        foreign_keys = []
        for fk in fks_raw:
            if not isinstance(fk, dict):
                raise ManifestError(f"{name}: malformed foreign key")
            foreign_keys.append({k: fk.get(src) for k, src in (
                ("id", "id"), ("sequence", "sequence"), ("table", "table"),
                ("from", "from"), ("to", "to"), ("on_update", "on_update"),
                ("on_delete", "on_delete"), ("match", "match"),
            )})
        related = sorted(
            ({"type": obj["type"], "name": obj["name"], "table": obj["table"],
              "definition_digest_available": False}
             for obj in object_rows if obj["table"] == name),
            key=lambda x: (x["type"], x["name"]),
        )
        tables[name] = {
            "status": "PRESENT", "columns": columns,
            "indexes": sorted(indexes, key=lambda x: x["name"]),
            "foreign_keys": sorted(foreign_keys, key=lambda x: (x["id"], x["sequence"])),
            "objects": related,
        }
    manifest = {
        "format_version": FORMAT_VERSION,
        "environment": environment,
        "source": "worker_schema_status_read_only",
        "scope": list(TARGET_TABLES),
        "tables": tables,
        "comparison_limitations": [
            "Worker diagnostic omits raw index/trigger/view SQL; definition-level comparison is unavailable.",
            "Only metadata returned by the endpoint is compared; this is not semantic compatibility approval.",
        ],
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
    diagnostic = sub.add_parser("build-diagnostic", help="build a safe manifest from Worker schema-status JSON")
    diagnostic.add_argument("--input", required=True)
    diagnostic.add_argument("--environment", required=True, choices=("staging", "production"))
    diagnostic.add_argument("--output", required=True)
    compare = sub.add_parser("compare", help="compare two manifests")
    compare.add_argument("--left", required=True)
    compare.add_argument("--right", required=True)
    compare.add_argument("--output", required=True)
    args = parser.parse_args()
    try:
        if args.command == "build":
            result = manifest_from_snapshot(_read_json(args.input), args.environment)
        elif args.command == "build-diagnostic":
            result = manifest_from_worker_diagnostic(_read_json(args.input), args.environment)
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
