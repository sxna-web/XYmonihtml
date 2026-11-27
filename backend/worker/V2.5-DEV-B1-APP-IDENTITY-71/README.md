# APP v2 Identity — Batch 71

- Version: `V2.5-DEV-B1-APP-IDENTITY-71`
- Date: 2026-11-27
- Status: static security review / design-only; D1 untested; not deployable.

## Files
- `D1-SECURITY-REVIEW.md`: eight-method review, binding audit idempotency, nonce boundary matrix, legacy share-code compatibility and durable rate-limit assessment.
- `README.md`: scope and status.

## Critical conclusions
- Batch 70's two-statement binding insert/winner-read contract needs a third conditional audit INSERT-SELECT with a unique deterministic event key if creation audit must be atomic and retry-safe.
- Nonce retention uses `first_seen + 2 * MAX_CLOCK_SKEW + SAFETY_MARGIN` under the symmetric inclusive timestamp rule. Widening clock skew later can invalidate the old retention guarantee.
- Legacy `admin_share_codes` stores raw code in the original Worker baseline and is used by several legacy routes. Keep it unchanged until a full compatibility migration is approved.
- The observed `rate_limits` table/helper is global, separately reads the count after increment, and fails open on errors. It is not an APP identity limiter.

## Not performed
No D1 connection, SQL execution, migration, Worker route, HTML/APK/Room/Secret change, Cloudflare configuration change, or deployment. No executable tests were added in this static-review batch.
