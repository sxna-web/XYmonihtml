# APP v2 Identity D1 contract — Batch 70

This batch converts the Batch 68 adapter map and Batch 69 SQLite fixture into a detailed future D1 implementation specification.

Files:
- `D1-STATEMENT-CONTRACT.md`: eight method SQL shapes, bind order, success/conflict/expiry semantics, D1 result classification, retry boundaries, nonce retention and rate-limit dependency.
- `D1-ISOLATED-ENV-ADMISSION.md`: mandatory environment admission, read-only schema snapshot and disposable-write protocol.

Status:
- Specification only.
- No D1 connection or SQL execution.
- No migration, Worker route, HTML, APK, Room or Secret change.
- No production or staging access.
- Not deployable.

Next batch: independent review of the statement contract for SQL portability, uniqueness assumptions, nonce replay horizon, and audit idempotency; add static/mock contract tests only if they test meaningful executable behavior. D1 connection requires a user-approved dedicated non-production database and binding.
