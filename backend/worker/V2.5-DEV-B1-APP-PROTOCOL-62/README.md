# APP v2 backfill dry-run report — Batch 62

- Version: V2.5-DEV-B1-APP-PROTOCOL-62
- Date: 2026-11-27
- Status: isolated redacted report helper and tests; no D1 access; not integrated; not deployable.

## What this adds

- Wraps batch 61's normalized legacy-row planner in a deterministic dry-run report.
- Reports scanned rows, valid active candidates, duplicate rows collapsed, planned slots, conflict categories and per-card capacity.
- Conflict output contains reason codes and sequence numbers only; it does not expose device keys or entitlement identifiers.
- Every report explicitly states schema UNVERIFIED, sqlExecuted=false, migrationCreated=false and approvalRequired=true.
- Over-capacity legacy devices remain grandfathered and new reservations are blocked.

## Environment audit

The current repository tree contains no Wrangler configuration or verified isolated D1 binding/database identifier. The existing Worker source and historical D1 notes do not prove an isolated database is available. Production and the named staging database are not substitutes for an explicitly approved isolated test target.

The Library still has 6.00.47 source only; no readable 6.00.48 ZIP copy was found. Keep APP_PENDING.

## Run

```sh
node --test backend/worker/V2.5-DEV-B1-APP-PROTOCOL-62/backfill-report.test.mjs
```

No SQL, migration, D1 connection, Worker/HTML/APK/Secrets edit or deployment occurred.
