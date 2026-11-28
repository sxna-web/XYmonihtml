# APP v2 Identity — Batch 85

- Batch: V2.5-DEV-B1-APP-IDENTITY-85
- Date: 2026-11-28
- Status: OFFLINE_REVIEW_AND_MODEL / D1_NOT_TESTED / NOT_DEPLOYABLE

## Negative review conclusions

1. Batch 84 alias identity omitted tenant and owner scope; event_id was globally keyed in the in-memory model. Batch 85 models the namespace as tenant_id + owner_id + dimension_type.
2. Batch 84 RLock only serializes threads inside one Python process. It does not prove multi-Worker or D1 concurrency. Production requires database uniqueness and an atomic write boundary for the complete active key set.
3. Active key-set drift is a real race: a writer can read K1/K2 and attempt to commit after configuration moves to K1/K2/K3. The new model requires both active versions and a config epoch; stale writers fail closed.
4. Event cleanup and dimension-alias retirement are separate. Removing an event cannot release aliases still referenced by another event; aliases remain reserved until an independently proven retirement operation.
5. No trusted canonical-input source for historical K1-only recomputation was found in reviewed Batch 84 artifacts. K1 retirement remains NOT_EXECUTABLE / BLOCKED.

## Durable backfill checkpoint contract

Required design fields: migration_id; immutable source_snapshot_id and snapshot_consistency_token; stable composite snapshot_high_water; last_committed_cursor; catch_up_watermark and catch_up_cursor; writer_epoch and active_key_set_epoch; expected key versions and coverage totals; deterministic page identity/checksum; lease epoch/fencing token; state, attempt, outcome-unknown marker and non-sensitive error class.

Cursor advancement must be atomic with successful alias writes. Replay is idempotent; an unknown commit outcome must be reconciled before cursor advancement. A stale lease holder must be fenced. A timestamp or maximum event ID alone is not a consistent snapshot proof.

## Cross-Worker production obligations

- Unique scoped alias: tenant + owner + dimension_type + key_version + fingerprint.
- Unique event: tenant + owner + event_id.
- Unique event alias: tenant + owner + event_id + key_version + dimension_type.
- All active aliases map to one opaque dimension_id.
- Config epoch and active key membership are checked in the same atomic boundary.
- No process-local mutex or read-then-write uniqueness checks.
- Retirement requires complete new-key coverage, no old writers, closed retry/cleanup/rollback horizons.

## Manifest metadata

Three independent manifests remain empty design skeletons. Future entries must declare owner, method, purpose, result/error contracts and receipt/audit/assertion dependencies. SQL text/hash/placeholders/binds remain blank. Harness statements must not invoke production identity or limiter methods.

Tests are synthetic/static only; no HMAC cryptography, D1, Worker, APP or production behavior is proven.
