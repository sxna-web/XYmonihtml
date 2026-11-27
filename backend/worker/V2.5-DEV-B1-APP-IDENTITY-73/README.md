# APP v2 Identity — Batch 73

- Version: `V2.5-DEV-B1-APP-IDENTITY-73`
- Date: 2026-11-27
- Status: adversarial design review and isolated D1 test specification only; not deployable.

## Contents
- `ADVERSARIAL-REVIEW-AND-ISOLATED-TESTS.md`: atomic audit gaps, timeout behavior, challenge-to-binding atomicity, rate-limit adversarial cases, exact isolated D1 test matrix, nonce rollout gates and legacy share-code caller inventory.

## Key conclusions
- D1 batch rollback applies when a statement errors. A conditional statement that affects zero rows is not an error; post-batch JavaScript cannot undo a committed batch.
- Mandatory audit writes need a verified in-batch database assertion/constraint. `ON CONFLICT DO NOTHING` alone cannot distinguish exact retry from payload conflict.
- Challenge consume and binding create must be one atomic logical operation to avoid burning a challenge when binding creation fails.
- D1 write timeout is outcome-unknown; Promise.race does not cancel a write. Reuse immutable operation identifiers and resolve owner-scoped state before retry.
- Durable limiter concurrency, duplicate event IDs, missing dimensions, NAT effects, Retry-After, clock movement and cleanup race all require isolated D1 tests.
- Legacy callers include Worker routes `/api/user/share-code`, `/api/super/admins/:id/share-code`, `/api/app/resolve`, `/api/app/free`, `/api/app/download`, and original HTML display calls. APK/external callers remain unaudited.

## Not performed
No D1 connection, SQL, migration, Worker/HTML/APK/Room/Secret/config change, executable test or deployment.
