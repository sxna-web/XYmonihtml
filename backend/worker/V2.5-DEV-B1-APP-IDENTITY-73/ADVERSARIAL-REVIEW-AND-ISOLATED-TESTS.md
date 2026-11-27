# APP v2 Identity — adversarial review and isolated D1 test specification (Batch 73)

- Version: `V2.5-DEV-B1-APP-IDENTITY-73`
- Date: 2026-11-27
- Status: design/review only; no D1 connection, SQL execution, migration, Worker integration, APK change or deployment.
- Inputs: Batches 68–72, APP v2 protocol work, original Worker.js and original index.html repository baselines.
- Safety boundary: original Worker/HTML are repository baselines, not proof of the live Cloudflare deployment or live D1 schema.

## 1. Executive findings

### F73-01 — Batch success does not prove a conditional audit row was inserted (critical design gap)

Cloudflare documents that `D1Database.batch()` executes statements sequentially as a SQL transaction and rolls back the batch if a statement errors. It also returns one result per statement, with `success` and metadata. A conditional `INSERT ... SELECT ... WHERE ...` that selects zero rows is still a successful SQL statement; a zero `meta.changes` value is not itself a SQL exception. Therefore:

- A business UPDATE/INSERT can commit even when a later conditional audit INSERT silently inserts zero rows.
- Checking `meta.changes` only after `batch()` returns is too late to roll back the already committed batch.
- `ON CONFLICT(event_key) DO NOTHING` alone cannot distinguish a valid exact retry from a conflicting event payload.
- Before implementation, the design must include a database-enforced in-batch assertion/constraint or another proven atomic pattern that makes a missing/mismatched required audit event abort the same batch. A post-batch JavaScript check is not sufficient.
- The exact assertion mechanism must be tested against disposable D1; do not invent a trigger/table/constraint on the production schema.

Official references: [D1 batch API](https://developers.cloudflare.com/d1/worker-api/d1-database/) and [D1 return objects](https://developers.cloudflare.com/d1/worker-api/return-object/).

### F73-02 — Timeout is outcome-unknown, not rollback

Cloudflare's current D1 debugging documentation states that a Promise.race timeout only bounds how long the Worker waits; it does not cancel the D1 query, and a write may still commit after the local timeout wins. Consequences:

- Never retry a timed-out mutation with a newly generated binding_id, operation_id, event_id or event_key.
- Reuse the exact immutable identifiers for the same logical operation.
- Resolve by owner-scoped reads of both business state and audit event before deciding whether to retry.
- If the result remains ambiguous, return a safe temporary/unknown outcome; do not tell the client the operation definitely failed or succeeded.

Reference: [Debug D1 — timeout behavior and write retries](https://developers.cloudflare.com/d1/observability/debug-d1/).

### F73-03 — Challenge consumption and binding creation must not be separate commits

The Batch 67 state-machine interface currently models `consumeBindChallenge()` and `getOrCreateBinding()` as separate store calls. If challenge consumption commits and binding creation then fails, the proof challenge is spent while no binding is created; a normal retry is rejected as already used.

Required design correction before adapter implementation:
- Put challenge conditional consumption, binding insert-if-absent/winner resolution, and required creation audit into one verified D1 batch/atomic unit.
- The binding insert must depend on the exact challenge row being consumed by this request.
- A failed binding/audit statement must roll back challenge consumption.
- A legitimate retry after an ambiguous commit must reuse the same challenge/binding/operation/event identifiers and resolve the already-committed outcome.
- If the challenge is valid but an identical binding already exists, return the owner-scoped existing binding only if device key and status match; do not emit a second `binding.created` event.

### F73-04 — Zero-row state transitions need explicit outcome classification

- Binding revoke: a conditional UPDATE affecting zero rows is not an SQL error and does not roll back a batch. Treat it as no-op/conflict after checking owner-scoped state; do not append a revoke event.
- Share-code CAS rotation: zero rows means stale version/not eligible/not found in the caller's owner scope; it is not a committed rotation.
- Audit insert-select: zero rows after a successful business transition is not acceptable for a required audit. This is the F73-01 assertion gap.
- Never infer another owner's resource existence from public error differences.

### F73-05 — Rate-limit candidate is not yet proven under concurrent D1 requests

The single conditional INSERT-SELECT is directionally safer than separate increment/read calls, but the actual concurrency admission invariant, D1 `RETURNING`, duplicate event classification, and multi-dimension Retry-After remain untested. Local SQLite fixtures and mocks do not prove multiple Worker isolates.

### F73-06 — Legacy share-code callers remain live compatibility dependencies in the source baseline

The original Worker source contains:
- DDL: `admin_share_codes(admin_user_id PRIMARY KEY, code UNIQUE, created_at)`.
- `ensureShareCode()`: reads and lazily inserts the raw code.
- `/api/user/share-code`: current user's share-code display.
- `/api/super/admins/:id/share-code`: super-admin display route.
- `/api/app/resolve?code=...`: public code-to-admin discovery; returns admin identity/name and free-group flag.
- `/api/app/free?code=...` (or `?admin=...`): legacy free-group read path.
- `/api/app/download?code=...` (or `?admin=...`): download list lookup.
- A further admin-download lookup path resolves the same table.
- Original HTML calls `/api/user/share-code` and `/api/super/admins/:id/share-code`; no direct `/api/app/resolve`, `/api/app/free` or `/api/app/download` call was found in that HTML snapshot.

This inventory is limited to repository-visible source. APK callers, external clients, other deployed frontends and the live Worker remain unaudited. Do not rename/drop/reinterpret the old field or change old route semantics in this batch. Public code discovery is not identity authentication.

## 2. Adversarial operation matrix

| Operation | Adversarial case | Required invariant | Failure classification |
|---|---|---|---|
| Challenge + bind | Two requests consume same challenge concurrently | Exactly one logical consume/bind outcome | One winner; loser generic already-used/conflict |
| Challenge + bind | Binding insert fails after challenge consume | Same atomic unit rolls challenge consumption back | Retryable store error; challenge remains usable |
| Binding create | Two devices bind same owner/device concurrently with same key | One binding row, one creation audit | One created; other returns exact winner |
| Binding create | Same owner/device, different key thumbprint | Never overwrite/rebind key | Conflict; no audit for losing attempt |
| Binding create | Same event key, same canonical payload | Exact idempotent replay | Return prior result; no duplicate event |
| Binding create | Same event key, different payload | Integrity conflict | Must not silently succeed |
| Binding create | Timeout after commit | One binding and one audit only | Outcome-unknown then owner-scoped resolve |
| Binding revoke | Two concurrent revokes with same expected generation | One generation transition and one event | Winner succeeds; loser no-op/conflict |
| Binding revoke | Retry after ambiguous timeout | No generation increment/event duplication | Resolve exact generation + event |
| Binding revoke | Wrong owner or stale generation | No state mutation and no owner disclosure | Generic not-found/not-owned/conflict |
| Rotation | Two CAS requests use same old version | Exactly one new version | Winner committed; loser stale-version conflict |
| Rotation | Audit condition misses after CAS update | Must abort the same atomic unit | Assertion/constraint failure, no rotation commit |
| Rotation | Timeout after commit | No second code/version generation | Resolve version + operation/event |
| Audit | Duplicate event key, same payload | Idempotent no-op | Existing event accepted only after exact comparison |
| Audit | Duplicate event key, different payload | Never accept as idempotent | Integrity conflict and alert |
| Audit | Audit persistence unavailable | Business mutation must not be reported committed | Whole atomic unit fails |
| Limiter | N concurrent distinct requests at limit L | Admitted count never exceeds L for each required dimension | Exactly L admitted |
| Limiter | Same event_id retried | Does not consume another slot | Return original decision after exact match |
| Limiter | Same event_id, different action/buckets | No overwrite or false admission | Integrity conflict |
| Limiter | Missing required dimension | Cannot bypass that dimension via NULL | Reject safely / service unavailable |
| Limiter | Shared NAT with many distinct users | No identity data leakage; network threshold effect measurable | Generic rate response; policy tuning required |
| Limiter | Clock moves forward/backward | Window and cleanup remain conservative | No premature deletion/admission |
| Limiter | Cleanup races with admission | Live-window events are never removed | Cleanup only past safe retain_until |
| Limiter | D1 unavailable | Security-sensitive operation fails closed | Generic 503, never fail-open |
| Nonce | Old protocol request during staged rollout | Existing supported clients are not silently broken | Version-specific verification |
| Nonce | Skew widened in-place | Old nonce retention cannot become insufficient | Prohibit; introduce a new protocol version |

## 3. Required atomic shapes — design constraints, not executable SQL

### 3.1 Challenge-to-binding transaction

One prepared batch must be constructed before execution; no JavaScript branch may occur between statements inside the batch.

1. Conditional challenge consume scoped by challenge_id + owner/admin + device + code_version + device-key thumbprint + pending status + expiry.
2. Binding insert-if-absent that is selectable only from the exact challenge row consumed by this operation; stable binding_id and operation_id are generated once for this logical operation.
3. Resolve the owner/device winner and compare owner, device, key thumbprint, status and generation.
4. Append `binding.created` only when the attempted binding_id is the actual newly inserted row.
5. Enforce the required audit outcome inside the same atomic unit. A zero-row audit INSERT is not enough; use a verified database-enforced assertion/constraint pattern or redesign the atomic statement. Do not rely on post-batch JS inspection to roll back.
6. Verify the full batch result vector and owner-scoped final state before returning.

If the operation finds an identical pre-existing binding, it must not claim this request created it. A revoked binding must never be silently reactivated.

### 3.2 Binding revocation

- Conditional UPDATE by binding_id + authenticated owner + expected status + expected generation + operation_id.
- Increment generation exactly once and record immutable revoke timestamp.
- Audit must match exact resulting row, operation_id and new generation.
- If update changes zero rows, classify by owner-scoped read; do not append an event.
- If update changes one row but audit is absent/mismatched, the batch must fail before commit through a verified assertion.
- A repeated revoke cannot increment generation again or resurrect the binding.

### 3.3 Share-code rotation

- Compare-and-swap on authenticated owner + expected current version.
- New version is deterministic expectedVersion + 1 only after successful CAS.
- Audit event matches owner, record ID, old/new versions, operation_id and committed timestamp.
- Zero-row CAS is a conflict/no-op, not success.
- Required audit absence/mismatch must abort the same atomic unit.
- The effect of rotation on existing bindings, sessions, challenges and free-group grants remains an unconfirmed product policy. This batch does not choose preserve/revoke/force-rebind.

### 3.4 Audit idempotency

For every event key:
- First insert: append immutable event.
- Retry with identical canonical payload: return the already-committed event as the same logical outcome; no duplicate.
- Same event key with different payload: integrity conflict; never `DO NOTHING` and report success.
- Audit event payload remains allowlisted and secret-free.
- Audit retention, legal hold, export and deletion are not set here; no audit cleanup.

## 4. Sliding-window limiter adversarial review

### 4.1 Admission dimensions

Server-derived pseudonymous dimensions are action-specific:
- network bucket: keyed HMAC of normalized client network address after trusted proxy/header handling is verified;
- device bucket: keyed HMAC of authenticated device-key thumbprint/stable verified device reference;
- admin bucket: keyed HMAC of administrator resolved from trusted server state;
- action: closed server enum.

Do not trust arbitrary `X-Forwarded-For` or client-supplied owner/device claims. Do not store raw IP, raw device ID, admin ID, share code or token in the rate ledger.

A dimension that is mandatory for an action cannot be NULL or silently omitted. A dimension that is genuinely not applicable must be explicitly declared by that action's server-side policy. NULL must never become a universal shared bucket or a bypass condition.

### 4.2 Shared NAT

Network limits can affect unrelated users behind one NAT. The isolated test must measure this explicitly. Final thresholds, network weighting, exemptions and whether a network dimension is a hard admission gate remain security/product decisions; do not invent values. Public responses must not reveal which dimension was exceeded or the bucket key.

### 4.3 Stable time and window boundary

- Store trusted server epoch timestamps at one frozen precision (recommend integer milliseconds only after the protocol/runtime contract is verified).
- Choose and freeze one half-open window convention, e.g. `[now - window, now)`; use the exact same predicate in admission, Retry-After and tests.
- Reject/handle future-dated ledger events outside an explicitly bounded tolerance; do not let a backward clock jump extend a window indefinitely or a forward jump erase live evidence.
- Keep rate-limit time semantics separate from nonce signature timestamp semantics.

### 4.4 Retry-After

For each exceeded dimension/window:
1. Count the events in the exact half-open window.
2. Let current count be C and allowed count be L.
3. Determine how many oldest events must expire to make the next request admissible: `C - L + 1`.
4. Select the expiry time of that Nth oldest event for that dimension/window.
5. The overall retry time is the maximum of those dimension-specific release times.
6. Return `Retry-After = max(1, ceil((release_time - server_now)/1000))`.

If any dimension cannot be classified reliably, do not claim admission. Return a generic temporary service error or a safe generic retry hint per approved policy. Never reveal network/device/admin thresholds.

### 4.5 Indexes and cleanup

Candidate indexes must cover each access path:
- (action, network_bucket, occurred_at)
- (action, device_bucket, occurred_at)
- (action, admin_bucket, occurred_at)
- (retain_until)

These are candidates, not approved DDL. Measure rows_read, rows_written, query duration and query plan in isolated D1. Cleanup must be bounded and indexed; only delete after the longest relevant window plus safety margin. Cleanup and admission must use the same trusted time convention. Cleanup never touches audit events, bindings or nonce rows whose signature replay window remains live.

### 4.6 Secret rotation

The limiter HMAC key is independent from APP identity, entitlement, session and signing keys. Store a key version identifier. Rotation must preserve old buckets until their longest active windows drain; rotating the secret must not reset a live user's quota or allow a burst. Do not dual-count or migrate buckets until an explicit transition algorithm is tested.

## 5. Exact isolated D1 test specification

All tests below require a disposable, isolated D1 database explicitly approved for testing. No production/staging binding may be guessed. Use synthetic IDs and secrets only.

### A. D1 batch and statement semantics

| ID | Setup / input | Operation | Expected result / evidence |
|---|---|---|---|
| D1-01 | Insert synthetic row A | Batch: write A, then execute a guaranteed SQL constraint error | Batch rejects; A is absent afterward; capture statement error and post-read |
| D1-02 | Existing row A; missing target B | Batch: conditional UPDATE B + harmless SELECT | Batch succeeds with UPDATE `meta.changes=0`; confirms zero rows is not rollback |
| D1-03 | Synthetic audit table with required constraint | Business write + required audit assertion forced false | Whole batch rejects; business write absent |
| D1-04 | Same event key and same canonical payload | Replay same batch after confirmed prior commit | One event only; same logical outcome |
| D1-05 | Same event key, different payload | Replay with one payload field changed | Integrity conflict; original event unchanged; no business mutation |
| D1-06 | Force audit statement SQL/constraint failure after business write | Execute batch | Business write rolled back; audit absent; no partial state |

### B. Challenge/binding/revoke/rotation concurrency

| ID | Synthetic input | Concurrent action | Expected result |
|---|---|---|---|
| ID-01 | One pending challenge C, same owner/device/key, 20 requests | Consume + bind concurrently | Exactly one logical challenge consumption; at most one binding; exactly one created audit |
| ID-02 | One challenge C, binding insert deliberately violates fixture constraint | Consume + bind | Batch failure; challenge remains pending; no binding/audit |
| ID-03 | Same owner/device, same key, 20 independent challenge attempts | Bind concurrently | One binding winner; other attempts return exact winner or safe conflict; no duplicate created audit |
| ID-04 | Same owner/device, key A vs key B | Bind concurrently | One immutable key winner; loser cannot overwrite; conflict recorded without secret |
| ID-05 | Same owner/device but different owners | Bind concurrently | Two separate owner-scoped bindings if policy permits; no cross-owner collision |
| ID-06 | Active binding generation 4 | Two revokes both expect generation 4 | One transition to generation 5; one revoke event |
| ID-07 | Revoked binding generation 5 | Repeat revoke and rebind | No generation 6, no resurrection, no second revoke event |
| ID-08 | Owner A binding ID submitted under owner B | Revoke | No mutation; generic not-found/not-owned; no B-visible existence leak |
| ID-09 | Share-code version 7 | Two rotations both expect 7 | Exactly one version 8 transition and one event |
| ID-10 | Force audit assertion mismatch after rotation CAS | Rotate | Entire rotation batch aborts; version remains 7 |
| ID-11 | Commit operation then simulate client timeout before response | Retry same operation identifiers | Exactly one business transition and one event; resolve committed result |
| ID-12 | Same event key with altered owner/target/generation payload | Replay | Integrity conflict; no silent success |

### C. Durable rate limiter

| ID | Synthetic input | Expected result |
|---|---|---|
| RL-01 | Limit L=3, window W=60s, four distinct request IDs at same instant, sequential | First 3 admitted; 4th denied |
| RL-02 | Same as RL-01, 40 concurrent requests from separate Worker requests/isolates | At most 3 admitted; all results and persisted rows reconcile |
| RL-03 | Same admitted event_id retried 5 times with identical action/buckets | One ledger row; same original admission outcome |
| RL-04 | Reuse event_id with changed action or bucket | Integrity conflict; no second row/admission |
| RL-05 | Required device bucket absent | No bypass; safe rejection/service error |
| RL-06 | Optional admin dimension explicitly not applicable to discovery | Other required dimensions still enforced; no NULL shared bucket |
| RL-07 | 20 synthetic users share one network bucket but have distinct device/admin buckets | Measure network gate effect and confirm generic response; do not finalize policy from fixture alone |
| RL-08 | Events exactly at now-W, just after now-W, and exactly at now | Match the frozen half-open boundary exactly |
| RL-09 | C=5, L=3; oldest three timestamps known | Retry-After points to expiry of the third-oldest event (C-L+1), not merely the oldest |
| RL-10 | Two dimensions exceeded with different release times | Retry-After uses the later release time |
| RL-11 | Forward/backward clock jumps in controlled test clock | No premature cleanup or unbounded bypass; behavior documented |
| RL-12 | Cleanup runs concurrently with admission | No event inside any active window is deleted |
| RL-13 | Cleanup batch is interrupted/fails | No partial deletion beyond verified transaction semantics; next cleanup is idempotent |
| RL-14 | Limiter D1 operation throws/unavailable | Protected action fails closed; generic 503; no success response |
| RL-15 | Rotate HMAC key while old-window events remain | Old quota evidence remains effective until drain; no fresh burst |
| RL-16 | EXPLAIN/query metrics for expected max event volume | Required indexes used; rows_read and duration within an explicitly approved budget |

### D. Nonce protocol rollout

| ID | Input | Expected result |
|---|---|---|
| NP-01 | Old protocol version with valid old canonical signature | Accepted only while old protocol is explicitly supported |
| NP-02 | New protocol version with valid new canonical signature | Accepted only after server and APK support are verified |
| NP-03 | Same nonce replayed under same binding/version | Rejected |
| NP-04 | Same nonce string under two different bindings | Follows explicitly frozen uniqueness scope; no accidental global collision |
| NP-05 | Timestamp at future skew edge, then replay through final valid instant | Nonce remains present through `first_seen + 2*S_v + M_v` |
| NP-06 | Increase skew for old version without retention migration | Release gate fails; do not deploy |
| NP-07 | Unknown protocol version / downgrade attempt | Fail closed without falling back to weaker signature rules |
| NP-08 | Old APK source/behavior unavailable | Keep APP_PENDING; no claim of compatibility |

### Evidence template

For every isolated test capture:
- D1 database identifier (synthetic disposable only), binding name and environment label;
- Worker build/commit SHA and runtime version;
- schema snapshot/checksum and fixture seed;
- exact synthetic input, concurrent request count and expected outcome;
- per-request status/code and operation/event identifiers (never credentials);
- D1 batch result vector, each statement's success/meta.changes/returned rows;
- owner-scoped post-state rows and audit-event count;
- query plan, rows_read, rows_written, duration and cleanup outcome;
- retry/timeout injection point and whether the write committed;
- test result, logs, timestamp and reviewer.

A passing SQLite fixture or mock is not a passing D1 test. A passing D1 test is not a passing APK/Android integration test.

## 6. Nonce protocol and APK compatibility gate

- No APK ZIP/source evidence was available in this batch; do not infer Android Keystore, canonical signing, timestamp units, nonce persistence or header support.
- Keep old and new protocol contracts separately versioned. Do not silently require new signatures from an old APK or widen the old version's skew.
- A rollout requires: APK source inspection; device-key generation/storage proof; exact canonicalization test vectors shared by server and Android; clock/nonce persistence tests; old/new client matrix; feature-flagged server rollout; telemetry proving supported-version adoption; explicit minimum-client policy and rollback path.
- Unknown/unsupported protocol version must fail closed for the new protected API, without silently downgrading to legacy public share-code authentication.
- Legacy endpoints remain separately isolated until callers are inventoried and migration is approved.

## 7. Legacy share-code caller inventory and compatibility plan

Repository source evidence (not live environment proof):

| Caller | Location | Behavior | Compatibility rule |
|---|---|---|---|
| DDL | Original Worker.js around lines 4051–4054 | `admin_share_codes` stores raw `code`, unique, keyed by admin | Do not mutate old table/field in this batch |
| `ensureShareCode` | Original Worker.js around lines 4636–4647 | Read existing raw code or lazily insert new code | Preserve old behavior until client migration is proven |
| User display | `/api/user/share-code`, around lines 4664–4671 | Returns code and deep-link | Preserve response contract |
| Super-admin display | `/api/super/admins/:id/share-code`, around lines 4649–4662 | Returns code and deep-link | Preserve authorization and response contract |
| APP discovery | `/api/app/resolve?code=...`, around lines 4673–4690 | Publicly resolves code to admin metadata/free flag | Discovery only; never treat as authentication |
| APP free group | `/api/app/free?code=...` or `?admin=...`, around lines 4368–4400 | Loads free-group data after code/admin resolution | Do not change without APK caller and data-scope audit |
| APP download | `/api/app/download?code=...` or `?admin=...`, around lines 4837–4848 | Resolves code/admin then returns download list | Preserve until callers are migrated |
| HTML | Original index.html around lines 2409, 2681–2694 | Calls user/super share-code display routes | Preserve UI contract |

Migration sequence:
1. Inventory APK/external consumers and actual live route use.
2. Keep legacy code as discovery only; separately authenticate v2 challenge/binding using device proof.
3. Add versioned v2 API without altering old route/schema.
4. Run old/new compatibility tests and observe supported client adoption.
5. Decide code rotation effects on existing bindings/free access only after explicit user policy confirmation.
6. Deprecate old routes only with a documented migration window and user approval.

## 8. Not performed / release status

- No D1 database was connected; no SQL or migration was executed.
- No Worker, HTML, APK, Room, Secret, Cloudflare configuration or production data was modified.
- No executable test was run in this batch.
- No live APK source was inspected.
- No production/staging deployment occurred.
- D1_NOT_TESTED / APP_PENDING / NOT_DEPLOYABLE.

## 9. Batch 74 handoff

**Next task: APP v2 identity atomic-operation redesign and executable local adversarial fixtures (still no D1 connection).**

1. Re-read AGENTS, functional/API/database protection baselines, continuity plan, progress and Batches 67–73.
2. Revise the logical state machine contract so challenge consumption + binding creation + required audit are one atomic logical operation.
3. Design explicit in-batch assertion semantics for mandatory audit writes; cover same-key/same-payload retry and same-key/different-payload conflict.
4. Extend disposable local SQLite fixtures for failure after challenge consume, audit zero-row, duplicate event payload, timeout-after-commit simulation, revoke/rotation races and limiter boundary/Retry-After.
5. Clearly label SQLite tests as local semantic tests, not D1 concurrency proof.
6. Do not connect any D1, execute SQL/migrations, alter Worker/HTML/APK/Room/Secrets or deploy.
7. Update progress, continuity plan and Batch 75 handoff.
