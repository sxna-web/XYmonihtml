"""Local SQLite migration verifier. Explicitly NOT a Cloudflare D1 runner.

Only apply-local is supported, and only for files inside a dedicated temporary
folder named starjump-migration-test-*. No network, Wrangler, secrets, or D1 APIs.
"""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import sqlite3
import sys
import tempfile

HERE = Path(__file__).resolve().parent
MIGRATIONS = HERE / "migrations"

class SafetyError(RuntimeError):
    pass

def _is_within(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False

def validate_local_test_path(raw: str) -> Path:
    if "://" in raw or raw.startswith(("file:", "http:", "https:")):
        raise SafetyError("remote/URI database paths are forbidden")
    candidate = Path(raw).expanduser()
    if not candidate.is_absolute():
        raise SafetyError("database path must be absolute")
    current = Path(candidate.anchor)
    for part in candidate.parts[1:]:
        current = current / part
        if current.exists() and current.is_symlink():
            raise SafetyError("symlink database paths are forbidden")
    resolved = candidate.resolve(strict=False)
    temp_root = Path(tempfile.gettempdir()).resolve()
    if not _is_within(resolved, temp_root):
        raise SafetyError("database must be under the system temporary directory")
    if not any(p.name.startswith("starjump-migration-test-") for p in [resolved.parent, *resolved.parents]):
        raise SafetyError("database must be inside starjump-migration-test-* folder")
    if resolved.name in {"production.db", "prod.db", "starjump.db", "starjump-d1.db"}:
        raise SafetyError("production-like database filename is forbidden")
    return resolved

def migration_files() -> list[Path]:
    return sorted(MIGRATIONS.glob("*.sql"), key=lambda p: p.name)

def load_migrations() -> list[dict]:
    from checksum import sha256_file
    result = []
    for path in migration_files():
        result.append({
            "migration_id": path.stem,
            "path": str(path.relative_to(HERE)),
            "checksum": sha256_file(path),
            "sql": path.read_text(encoding="utf-8"),
        })
    return result

def _statements(sql: str):
    buf = ""
    for line in sql.splitlines(keepends=True):
        buf += line
        if sqlite3.complete_statement(buf):
            statement = buf.strip()
            if statement:
                yield statement
            buf = ""
    if buf.strip():
        raise ValueError("incomplete SQL statement at end of migration")

def apply_one(conn: sqlite3.Connection, migration: dict) -> str:
    existing = conn.execute(
        "SELECT checksum FROM schema_migrations WHERE migration_id=?",
        (migration["migration_id"],),
    ).fetchone()
    if existing:
        if existing[0] != migration["checksum"]:
            raise SafetyError(f"checksum drift: {migration['migration_id']}")
        return "already-applied"
    conn.execute("BEGIN IMMEDIATE")
    try:
        for statement in _statements(migration["sql"]):
            conn.execute(statement)
        conn.execute(
            "INSERT INTO schema_migrations(migration_id, checksum) VALUES (?, ?)",
            (migration["migration_id"], migration["checksum"]),
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    return "applied"

def run_apply_local(raw_path: str) -> dict:
    db_path = validate_local_test_path(raw_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    db_path = validate_local_test_path(str(db_path))
    conn = sqlite3.connect(str(db_path), timeout=5)
    try:
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute(
            "CREATE TABLE IF NOT EXISTS schema_migrations ("
            "migration_id TEXT PRIMARY KEY, checksum TEXT NOT NULL, "
            "applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
        )
        conn.commit()
        results = []
        for migration in load_migrations():
            if migration["migration_id"] == "CORE-MIG-001":
                checksum = migration["checksum"]
                row = conn.execute(
                    "SELECT checksum FROM schema_migrations WHERE migration_id=?",
                    (migration["migration_id"],),
                ).fetchone()
                if row and row[0] != checksum:
                    raise SafetyError("checksum drift: CORE-MIG-001")
                if not row:
                    conn.execute(
                        "INSERT INTO schema_migrations(migration_id, checksum) VALUES (?, ?)",
                        (migration["migration_id"], checksum),
                    )
                    conn.commit()
                results.append({
                    "id": migration["migration_id"],
                    "status": "applied" if not row else "already-applied",
                })
            else:
                results.append({
                    "id": migration["migration_id"],
                    "status": apply_one(conn, migration),
                })
        return {
            "database": str(db_path),
            "mode": "LOCAL_TEMP_SQLITE_ONLY",
            "migrations": results,
        }
    finally:
        conn.close()

def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Local-only migration verifier; not a D1 tool"
    )
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("plan", help="show migration IDs and checksums without opening a database")
    check = sub.add_parser("check", help="read-only schema fingerprint of an isolated temporary SQLite DB")
    check.add_argument("--db", required=True)
    apply = sub.add_parser("apply-local", help="apply only to an isolated temporary SQLite DB")
    apply.add_argument("--db", required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "plan":
            print(json.dumps([
                {k: m[k] for k in ("migration_id", "path", "checksum")}
                for m in load_migrations()
            ], indent=2))
        elif args.command == "check":
            path = validate_local_test_path(args.db)
            if not path.is_file():
                raise SafetyError("check requires an existing temporary database file")
            from schema_diff import schema_snapshot, fingerprint
            conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
            try:
                print(json.dumps({
                    "fingerprint": fingerprint(conn),
                    "schema": schema_snapshot(conn),
                }, indent=2))
            finally:
                conn.close()
        else:
            print(json.dumps(run_apply_local(args.db), indent=2))
        return 0
    except (SafetyError, sqlite3.Error, ValueError, OSError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

if __name__ == "__main__":
    raise SystemExit(main())
