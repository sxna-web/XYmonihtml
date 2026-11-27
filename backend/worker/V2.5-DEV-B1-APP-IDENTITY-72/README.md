# APP v2 Identity — Batch 72

- Version: V2.5-DEV-B1-APP-IDENTITY-72
- Date: 2026-11-27
- Status: design-only; D1 not tested; not deployable.

## Contents
- AUDIT-AND-RATE-LIMIT-PROTOCOL.md: immutable audit envelope, idempotent create/revoke/rotation, candidate atomic sliding-window limiter, signature protocol versioning, nonce retention, legacy share-code rollout and isolated validation gates.

## Key conclusions
- Audit events are append-only, uniquely keyed, owner-scoped and secret-free. Retention is not guessed; no audit cleanup before policy approval.
- Binding create/revoke and share-code rotation use deterministic event keys tied to exact committed state generation/version. Timeout retries reuse immutable operation identifiers.
- Candidate rate limit checks network/device/admin/action windows and appends one event in one conditional statement. It remains pending isolated D1 concurrency/query-plan tests; no final thresholds selected.
- Nonce retention is version-specific. Under symmetric inclusive skew, retain at least first_seen + 2*S_v + M_v. Do not widen an existing protocol's skew in place.
- Legacy share-code fields/routes remain unchanged. Rotation's effect on existing bindings is unconfirmed.

## Not performed
No D1 connection, SQL, migration, Worker/HTML/APK/Room/Secret change, Cloudflare config change, executable test or deployment.
