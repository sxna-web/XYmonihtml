# StarJump local migration verifier (Batch 45)

**Status: LOCAL-ONLY / NOT A PRODUCTION MIGRATION RUNNER / NOT DEPLOYABLE.**

This tool uses Python's standard-library sqlite3 only. It does not call Cloudflare, Wrangler, D1, network APIs, secrets, or production bindings. It is deliberately restricted to a database file inside a dedicated temporary directory named `starjump-migration-test-*` under the OS temporary directory. Symlinks in the database path, including parent directories, remote/URI paths, relative paths, and production-like filenames are rejected.

## Commands

```bash
python tools/database_migrations/runner.py plan
python tools/database_migrations/runner.py apply-local --db /tmp/starjump-migration-test-demo/fixture.sqlite
python tools/database_migrations/runner.py check --db /tmp/starjump-migration-test-demo/fixture.sqlite
python -m unittest discover -s tools/database_migrations/tests -v
```

Create the dedicated temporary directory before `apply-local`; the command creates the database file inside it. `plan` does not open a database. `check` opens an existing database read-only. `apply-local` is intended only for disposable test fixtures.

## Batch 45 corrections

- `CORE-MIG-001` now runs through the same atomic migration path as subsequent migrations. The runner no longer pre-creates the ledger and then merely records the CORE checksum without executing its SQL.
- The ledger is checked inside the `BEGIN IMMEDIATE` transaction before applying; checksum drift stops execution. The ledger insert is committed atomically with each migration's SQL.
- Path validation rejects symlinked parent directories as well as a symlinked database file.
- `schema_diff.compare_snapshots()` now reports `changed_objects` for same-name object definition changes, including index, view, trigger and table SQL; `changed_tables` continues to report table PRAGMA differences.
- Tests cover actual CORE bootstrap execution and same-name index/view/trigger definition changes.

## Frozen local lease fields

`notification_events` includes:
- `processing_execution_id TEXT`: identity of the current claimant;
- `lease_expires_at TEXT`: UTC ISO-8601 expiry instant;
- `fencing_token INTEGER NOT NULL DEFAULT 0 CHECK (fencing_token >= 0)`: monotonically incremented on each successful claim/reclaim.

Claim, renew, reclaim, and completion must use conditional atomic UPDATE statements and verify affected-row counts. Completion must compare execution ID and fencing token so a stale worker cannot commit after a lease has been reclaimed. The test suite exercises this compare-and-set behavior in local SQLite only. This code is not a production claim/lease API implementation.

## Migration checksum

SHA-256 is calculated from the final SQL file bytes after normalizing CRLF/CR to LF; no whitespace trimming or SQL rewriting is performed. A changed migration must use a new migration ID; checksum drift stops execution.

## Compatibility boundary

SQLite test success does not establish Cloudflare D1 compatibility, transaction semantics, concurrency guarantees, SQL feature availability, or production schema compatibility. Before any D1 implementation, separately verify supported SQL syntax and transactional behavior against the actual D1 environment and schema, after explicit user approval. No D1 access or migration is included in this batch.
