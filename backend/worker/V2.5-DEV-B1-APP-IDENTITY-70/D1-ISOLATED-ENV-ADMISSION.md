# APP v2 Identity — isolated D1 admission and schema snapshot protocol (Batch 70)

- Version: `V2.5-DEV-B1-APP-IDENTITY-70`
- Date: 2026-11-27
- Status: checklist/template only. No Cloudflare account connection, no D1 query, no write, no migration, no deployment.

## A. Environment admission — all gates required

An environment is **not approved** merely because it is called staging, preview, test, or development.

| Gate | Required evidence | Current status |
|---|---|---|
| Dedicated D1 database | Exact database ID and database name confirmed by user | NOT PROVIDED |
| Dedicated binding | Exact Worker binding name and target database ID match | NOT PROVIDED |
| Environment isolation | No production routes/credentials/data; no shared database with production | NOT VERIFIED |
| Access authorization | User explicitly approves read-only inspection and separately approves disposable writes | NOT GRANTED |
| Worker target | Non-production Worker/service and environment explicitly identified | NOT PROVIDED |
| Schema baseline | Read-only snapshot and migration ledger captured before writes | NOT CAPTURED |
| Backup/recovery | Disposable fixture reset/recreate procedure documented | NOT VERIFIED |
| Cleanup | Only batch-created synthetic records can be deleted | NOT VERIFIED |

**Stop rule:** if any gate is missing or contradictory, do not connect. Do not guess binding names, database IDs, account selection, or environment. Do not use production or `starjump-staging` as a substitute for an explicitly approved isolated target.

## B. User authorization record template

Complete only when the user intentionally approves a future isolated test:

- Environment label:
- Cloudflare D1 database name:
- D1 database ID (store securely; do not put in public Git):
- Worker/service name:
- Binding name:
- Confirmed binding points to the same isolated database:
- Read-only schema inspection approved: yes/no
- Disposable write/rollback tests approved: yes/no
- Test window and expiry:
- Allowed operations:
- Prohibited operations:
- Person responsible for cleanup:
- Approval timestamp:

No secrets, API tokens, account credentials or production database identifiers should be placed in this repository document.

## C. Read-only schema snapshot checklist

After admission and explicit read-only authorization only, collect and preserve redacted outputs for:
1. `SELECT name, type, sql FROM sqlite_master ORDER BY type, name`.
2. For each relevant table: `PRAGMA table_info(table_name)`.
3. `PRAGMA index_list(table_name)`, then `PRAGMA index_info(index_name)`.
4. `PRAGMA foreign_key_list(table_name)`.
5. `PRAGMA user_version` and the actual migration ledger table, if present.
6. Relevant table row counts only; do not export user/card/token/subscription data.
7. D1 binding/database identity confirmation from the intended Worker configuration and Cloudflare dashboard.

Identifiers in PRAGMA statements cannot be parameter-bound. Use only table/index names enumerated from the schema snapshot and quote identifiers safely; never accept client-provided identifiers.

## D. Disposable D1 test data protocol

Only after the isolated database and write approval are confirmed:
- Use a clearly reserved synthetic namespace/prefix and generated fake IDs.
- Create only explicitly approved test records/tables; do not alter existing business records.
- Capture before/after schema and row counts.
- Force a controlled statement failure inside a D1 batch and verify rollback using only disposable rows.
- Test one-winner races with separate requests/isolates, not a single sequential loop.
- Verify result shape, `meta.changes`, RETURNING behavior, unique conflicts and error classification.
- Verify timeout-after-write recovery without duplicate state.
- Delete only test records whose generated IDs were captured by the test run.
- Re-run counts and verify no test artifacts remain; preserve redacted logs.
- Do not delete a test table if it contains anything outside the batch's own synthetic namespace.

## E. Snapshot record template

| Field | Value |
|---|---|
| Snapshot ID | |
| Date/time UTC | |
| D1 database fingerprint | |
| Worker/service + version | |
| Binding name | |
| D1/runtime version evidence | |
| Schema object count | |
| Migration ledger latest entry | |
| Identity-related tables found | |
| Rate-limit schema found | |
| Read-only query evidence path | |
| Reviewer | |
| Redaction check | |

## F. Exit criteria

The isolated D1 phase is complete only when all eight adapter methods have verified statement behavior, result classification, unique conflict handling, rollback behavior where applicable, retry behavior, multi-request race results, cleanup boundaries, and durable rate-limit evidence. SQLite CI success alone cannot satisfy any D1-specific gate.
