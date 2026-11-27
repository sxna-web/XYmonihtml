# APP v2 Identity — disposable D1 evidence map（Batch 80）

- Version: `V2.5-DEV-B1-APP-IDENTITY-80`
- Status: `SPEC_ONLY / NO_D1_EXECUTION`
- Source matrix: Batch 76 `d1_validation_matrix.json` (D1-001..D1-026)
- Admission contract: Batch 77
- Atomic assertion review: Batch 77
- Operation contract: Batches 78-79

## 1. Admission gates — fail closed

No connection or SQL is permitted unless **all** conditions are separately evidenced:
1. User explicitly identifies a dedicated disposable D1 by exact name and database ID.
2. User identifies exact non-production Worker/service and binding.
3. Binding-to-database ID match is independently verified; a successful SQL query is not identity proof.
4. Dedicated isolation/no production traffic or data is verified.
5. Separate explicit approvals: read-only schema snapshot, disposable writes/rollback, and cleanup for the specific run.
6. A fresh immutable run ID and synthetic ID ledger are created before writes.
7. Baseline schema, indexes, foreign keys, migration ledger and before-counts are captured.
8. Any mismatch, unknown result, unexpected object or production-like data stops the harness before further writes.

No default database, account, binding, credential discovery or fallback target. `starjump-db` is not a candidate. `starjump-staging` is not an automatically approved disposable environment.

## 2. Batch 76 case mapping (existing D1-001..D1-026)

| Case | Operation / capability | Required proof beyond SQL success |
|---|---|---|
| D1-001 | environment and binding identity | independently matched DB ID/binding, redacted fingerprint, approvals |
| D1-002 | CHECK true | result metadata + scoped read-back |
| D1-003 | CHECK false / batch rollback | failing final assertion; prior synthetic writes absent |
| D1-004 | exact audit EXISTS predicate | matching audit passes; missing/mismatched owner/actor/target/op/outcome/payload fails |
| D1-005 | prepared bind storage classes | exact text/integer/NULL/Unicode/quote round-trip; undefined rejected before bind |
| D1-006 | D1 batch order/result vector | one result per statement in order; capture success/changes/read/write/RETURNING |
| D1-007 | batch error rollback | earlier synthetic write absent after later constraint failure |
| D1-008 | zero changes semantics | distinguish successful zero-row mutation from SQL error; receipt must not falsely succeed |
| D1-009 | RETURNING vs meta.changes | actual D1 runtime result shape for each statement class |
| D1-010 | unique conflict classification | expected unique conflict is narrow; unrelated SQL error remains storage failure |
| D1-011 | owner-scoped receipt | owner A sees own receipt; owner B and absent owner are indistinguishable |
| D1-012 | create-created competition | separate concurrent requests; one binding + one created event; losers resolve same winner without duplicate created event |
| D1-013 | create key conflict | competing thumbprints; exactly one winner; no key overwrite or false created audit |
| D1-014 | revoke generation CAS | same expected generation race; one generation increment and exact audit |
| D1-015 | share-code rotation CAS | same expected version race; one version increment and exact audit; no blind retry |
| D1-016 | timeout after commit | dropped response then same operation replay; exact receipt and no duplicate mutation/event |
| D1-017 | limiter multi-dimension concurrency | all required dimensions in one admission decision; observed count never exceeds test limit |
| D1-018 | limiter duplicate event ID | same tuple idempotent; changed tuple integrity conflict |
| D1-019 | limiter dimension presence | missing required dimension fails closed; optional absence explicit |
| D1-020 | shared NAT | isolate network bucket effect from device/admin buckets; no production thresholds inferred |
| D1-021 | clock movement | boundary behavior under explicitly approved synthetic skew envelope |
| D1-022 | window / Retry-After | left boundary, now boundary, precision and multi-dimension max release |
| D1-023 | cleanup race | cleanup interleaved with admission/retry; no live/retry-needed event removed |
| D1-024 | query plan / cost | EXPLAIN QUERY PLAN, rows read/written, duration, index use; no invented cost threshold |
| D1-025 | HMAC key rotation | overlap cannot split one logical dimension and bypass active window |
| D1-026 | cleanup idempotency/scope | strict retention boundary, repeated cleanup idempotent, audit/receipt preserved |

## 3. Additional required cases (D1-027..D1-034)

These are extensions, not claims that Batch 76 already tested them.

| Case | Required scenario | Expected result / proof |
|---|---|---|
| D1-027 | create-existing resolution | identical pre-existing active binding returned; original ID/created_by/created_at/generation unchanged; no created event; separate resolution event only if U80-01 is approved |
| D1-028 | receipt type/fingerprint conflict | same owner+operation ID with changed operation type or canonical fingerprint is integrity conflict; no second mutation |
| D1-029 | audit exact-match matrix | for create-created, create-existing, revoke and rotation, mutate each owner/actor/target/op/outcome/reason/payload field independently; mismatch must fail final assertion and roll back |
| D1-030 | revoke owner boundary | same binding ID under another owner cannot read or mutate; external error does not reveal whether foreign row exists |
| D1-031 | rotation side-effect policy | only after U80-05/06 decision; test chosen effect on old bindings, sessions, pending challenges and free grants, including replay |
| D1-032 | HMAC cross-version union/dedupe | same event in K1 and K2 counts once; distinct events across versions count together; same event ID with different tuple fails closed |
| D1-033 | limiter cleanup vs union history | cleanup cannot remove an event needed by active window or idempotency horizon; union count remains complete across key versions |
| D1-034 | index migration coverage | every active key version and dimension has complete query coverage before/after migration; EXPLAIN and synthetic counts prove no gap during cutover |

## 4. Per-case result vector (required)

Capture without secrets:
- run_id, case_id, environment fingerprint, approval reference;
- statement_id and exact SQL SHA-256;
- placeholder ordinal/semantic name/storage class/source/nullability (never bind values);
- batch result index, success, meta.changes, rows_read, rows_written, returned row count;
- expected vs actual state vector;
- owner-scoped receipt count and exact match boolean;
- audit event count and exact match boolean;
- failure classification and rollback read-back;
- generated synthetic ID ledger, cleanup IDs, before/after counts, residual count;
- runtime version, UTC timestamp and redacted diagnostic code.

No raw credentials, card codes, tokens, nonces, private keys, device proofs, subscription URLs, user rows or real identifiers.

## 5. Schema capability matrix (logical only; no DDL approved)

| Capability | Needed by | Must be proven |
|---|---|---|
| owner-scoped uniqueness | receipt, audit, binding | unique constraint/index exact columns and collation |
| active-state + generation/version CAS | binding revoke, code rotation | conditional write has one winner under concurrent requests |
| challenge one-time consume | create-created/existing | expiry + state + owner + device + code version + thumbprint predicate |
| immutable audit event identity | all four operations | unique owner/event key and exact payload replay comparison |
| receipt final assertion | all state-changing operations | required row exists and matches committed state in same atomic unit |
| CHECK assertion behavior | receipt/audit guard | NOT NULL + CHECK true/false and batch rollback verified in D1 |
| synthetic run namespace | all disposable writes | every read/write/cleanup is scoped to this run |
| limiter event_id dedupe | HMAC overlap | unique immutable event identity, tuple conflict detection and cross-version coverage |
| indexed dimension/time query | limiter | index query plan and bounded read/write cost evidence |

Actual schema object names are unknown. This matrix must not be translated into migration DDL until the approved schema snapshot and migration impact review exist.

## 6. Rollback and stop conditions

- The test runner must have no implicit credentials or network path in ordinary CI.
- A timeout after mutation is outcome-unknown; reuse exact IDs and do not mint replacement operations.
- Cleanup is a separately approved phase, driven only by the generated-ID ledger and exact run namespace.
- Any unexpected schema, result count/order, foreign row, missing assertion, residual artifact or binding mismatch stops the run.
- Audit and operation receipts are not limiter cleanup targets.
- No D1 evidence can be inferred from SQLite, mocks, static SQL or this mapping document.
