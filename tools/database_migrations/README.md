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

## Schema snapshot coverage (local SQLite only)

The read-only snapshot now records:
- table columns via `PRAGMA table_info` and extended/generated-column metadata via `table_xinfo`;
- index list metadata, ordered key columns via `index_info`, extended key/auxiliary columns via `index_xinfo`, and the stored index SQL definition;
- foreign-key rows and full sqlite_master object definitions for tables, indexes, views, and triggers.

This improves local structural diff evidence but is not a complete semantic equivalence proof. It does not read Cloudflare D1, does not imply production compatibility, and does not automatically repair drift. The local test suite is run in RC1 CI only as a regression check for this isolated verifier.

## RC1 CI regression integration (2026-11-28)

The isolated verifier test suite is now part of the RC1 convergence workflow:
- Command: `python -m unittest discover -s tools/database_migrations/tests -v`
- Current suite: 25 tests, including index key order/uniqueness and extended/generated-column snapshot coverage.
- The CI step uses disposable local SQLite fixtures only. It does not invoke D1, Wrangler, Cloudflare APIs, production bindings, or secrets.
- Latest push and PR workflow checks passed: [push run](https://github.com/sxna-web/XYmonihtml/actions/runs/46097127196), [PR run](https://github.com/sxna-web/XYmonihtml/actions/runs/46097121612).

## Compatibility boundary

SQLite test success does not establish Cloudflare D1 compatibility, transaction semantics, concurrency guarantees, SQL feature availability, or production schema compatibility. Before any D1 implementation, separately verify supported SQL syntax and transactional behavior against the actual D1 environment and schema, after explicit user approval. No D1 access or migration is included in this batch.


## Sanitized schema manifest comparison (Batch 78)

- Module: `schema_manifest.py`; tests: `tests/test_schema_manifest.py`.
- This utility consumes JSON exported from the existing `schema_diff.schema_snapshot()` function. It never opens a database, connects to Cloudflare, invokes Wrangler, or reads business rows.
- Build a manifest: `python tools/database_migrations/schema_manifest.py build --input snapshot.json --environment staging --output staging.manifest.json` (use `production` only for a separately captured production schema-only snapshot).
- Compare: `python tools/database_migrations/schema_manifest.py compare --left staging.manifest.json --right production.manifest.json --output comparison.json`.
- Scope is fixed to the seven APP/VIP tables in Batch 77. Missing tables are explicitly marked `ABSENT`; table presence mismatch is not treated as a safe-to-create recommendation.
- Column defaults and sqlite_master/index/trigger SQL are represented by SHA-256 digests, not echoed. Column names/types/NOT NULL/PK, index uniqueness/origin/partial/key columns, foreign-key actions, and object identities are compared.
- Output is a structural comparison only. A MATCH is not proof of semantic compatibility, data integrity, migration safety, D1 transaction semantics, or production readiness. Keep staging and production source snapshots and manifests separately labelled; do not overwrite an approved baseline without review.
- New regression tests: 16. The latest full suite reports 62 tests passed. The whole unittest suite is run by the existing RC1 convergence workflow against local in-memory fixtures only.


## Staging schema-only intake from the Worker diagnostic (Batch 93)

This path consumes the authenticated `GET /api/super/schema-status` response from an already-existing staging Worker that is confirmed to use the staging D1 binding. It does not create or switch bindings and does not call Wrangler or Cloudflare APIs from this local utility.

1. Sign in as the direct super-admin account to the staging environment only.
2. Request `GET /api/super/schema-status` and save the complete JSON response as `staging-schema-status.json`. Do not use a production Worker URL for this staging capture.
3. Confirm `data.app_structure.verification` is `OBSERVED_SCHEMA_ONLY` and `objects_verification` is `OBSERVED`. If either is partial, stop; do not build a manifest.
4. Build the sanitized manifest:

```bash
python tools/database_migrations/schema_manifest.py build-diagnostic --input staging-schema-status.json --environment staging --output staging.app-schema.manifest.json
```

5. Keep the original response and generated manifest together with capture date, Worker version/commit, and an operator note that the endpoint was the staging environment. Do not put credentials, cookies, authorization headers, or session tokens in the files or commit them to Git.
6. Compare two independently captured manifests only when both environments are explicitly approved for read-only inspection:

```bash
python tools/database_migrations/schema_manifest.py compare --left staging.app-schema.manifest.json --right approved-baseline.app-schema.manifest.json --output schema-comparison.json
```

### What this intake contains / omits

- Includes table presence, column names/types/nullability/PK order, default-presence plus SHA-256 of default expressions, index identity/uniqueness/origin/partial flag/key columns, FK actions, and trigger/view names.
- The Worker diagnostic never returns raw default expressions after Batch 93; it returns only `default_present` and `default_sha256`.
- It does not return business rows, card codes, tokens, request payload JSON, or raw trigger/view/index SQL.
- Since raw index/trigger/view SQL is intentionally omitted, definition-level SQL digest comparison is unavailable in this intake path. A manifest match therefore means only that the exposed structural metadata matches; it is not semantic equivalence or migration approval.
- A missing table is recorded as `ABSENT`, never as an instruction to create it. A partial diagnostic is rejected.
- This procedure is documentation for a future authorized staging capture. No staging or production database was accessed as part of Batch 93.
