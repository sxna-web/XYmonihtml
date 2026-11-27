# APP v2 Identity SQL semantics — Batch 69

- Version: `V2.5-DEV-B1-APP-IDENTITY-69`
- Date: 2026-11-27
- Status: local disposable SQLite semantic fixture only; D1 untested; no migration; no Worker integration; not deployable.

## Scope
This fixture models the logical constraints from Batch 68 using a disposable SQLite database under a `starjump-migration-test-*` temporary directory. It exercises the eight logical store operations: challenge insert/consume, nonce replay prevention, binding insert/idempotency/revocation, share-code CAS/read, and transient cleanup. It also checks transaction rollback behavior as a local analogue only.

## Run
```bash
python -m unittest discover -s backend/worker/V2.5-DEV-B1-APP-IDENTITY-69 -p '*_test.py' -v
```

## Critical boundary
Passing SQLite tests does **not** prove Cloudflare D1 compatibility, D1 `batch()` rollback, `RETURNING`, `meta.changes`, production schema, deployed binding names, multi-isolate concurrency, or Android proof/signature compatibility. The fixture schema is synthetic test-only data and is not a migration. Do not apply it to any D1.

## D1 verification gates
Before any D1 adapter work:
1. Explicitly identify a dedicated non-production D1 database ID and binding name, with user approval for read/write testing.
2. Read-only capture `PRAGMA table_info`, `index_list`, `index_info`, `foreign_key_list`, `sqlite_master`, and migration ledger from that isolated database.
3. Record D1/SQLite engine compatibility and supported SQL features; test parameter binding and each conditional statement.
4. Verify `RETURNING` result shape and affected-row metadata for success/no-op/conflict; never infer from mock behavior.
5. Verify `D1Database.batch()` sequential execution and rollback on a forced statement failure, using disposable rows/tables only.
6. Run competing challenge consume, duplicate nonce, binding insert and share-code CAS requests from separate requests/isolates; assert exactly one winner.
7. Verify owner-scoped revoke/read and that revoked bindings cannot be resurrected.
8. Verify cleanup is bounded and cannot delete binding/audit records.
9. Inspect the existing rate-limit schema and decide whether a dedicated durable identity rate-limit model is required; old `rate_limits(bucket,count,updated_at)` is not presumed sufficient.
10. Save schema snapshots and test evidence; delete only the isolated fixture database after evidence capture, never production data.

## Not performed
No Cloudflare account/D1 connection, no staging or production access, no SQL migration, no Worker route, no HTML/APK/Room/Secret changes, no deployment.
