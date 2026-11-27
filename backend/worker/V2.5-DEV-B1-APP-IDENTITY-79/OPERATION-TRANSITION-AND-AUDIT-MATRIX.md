# APP v2 Identity — full operation transition and audit matrix (Batch 79)

- Version: `V2.5-DEV-B1-APP-IDENTITY-79`
- Date: 2026-11-27
- Status: design + offline reference checks only; `D1_NOT_TESTED / APP_PENDING / NOT_DEPLOYABLE`.
- Scope: create-created, create-existing, binding revoke, share-code rotation, canonical audit-envelope coverage, bind-manifest validation, limiter HMAC overlap/cleanup evidence.

## 1. Shared operation envelope and receipt rules

All operation identity is derived from authenticated server context. Never accept caller-supplied owner/actor identity as authoritative.

| Field | Required source / rule | Canonical fingerprint | Audit envelope |
|---|---|---:|---:|
| canonicalization_version | fixed protocol constant | yes | yes |
| operation_id | immutable operation ID generated/validated by server contract | yes | yes |
| operation_type | closed enum | yes | yes |
| actor_type / actor_id | authenticated actor context | yes | yes |
| owner_admin_id | resolved owner scope, distinct from actor | yes | yes |
| target_type / target_id | server-resolved resource | yes | yes |
| outcome | closed result enum | operation-specific intent only; actual result is receipt | yes |
| reason_code | closed reason enum; required/optional policy remains per operation | include only if defined by operation contract | yes |
| schema_version | audit envelope schema version | yes | yes |
| event_id / event_key / event_type | server-generated immutable audit identity | not part of request identity unless explicitly frozen | yes |
| occurred_at | trusted server time; immutable per committed attempt | no | yes |
| correlation_id | server-generated/validated tracing ID | no unless protocol freezes it | yes |
| payload | allow-listed, redacted, canonical event facts | operation-specific | yes |

**Coverage finding:** Batch 72's envelope includes the actor/owner/target/outcome/reason/schema dimensions, but Batch 78's generic `canonical_v1(fields)` accepts any caller-provided ordered field list. It does not itself freeze a required per-operation field manifest or prove the audit envelope is complete. Batch 79 adds explicit coverage requirements and marks operation-specific reason codes, actor mapping, and payload allow-lists as implementation freeze items. Do not silently invent values or add secrets.

The fingerprint is for immutable request identity. The audit envelope is a separate immutable record of the committed outcome. Do not hash volatile `occurred_at`, `event_id`, or `correlation_id` into a retry fingerprint unless the operation contract explicitly makes them stable across retries.

Receipt unique scope remains `(owner_id, operation_id)`; audit event unique scope remains `(owner_id, event_key)`. Reads and assertions must use authenticated owner scope. A foreign-owner receipt is indistinguishable from absent.

## 2. State transition matrix

### 2.1 Binding create — result = created

| Dimension | Required contract |
|---|---|
| Preconditions | Authenticated actor; server-resolved owner; valid unexpired pending challenge; challenge owner/device/code-version/key-thumbprint match; no conflicting active or revoked binding for owner+device; no conflicting prior receipt |
| CAS / uniqueness | Consume challenge only from pending and only when all bound fields and expiry match; unique owner+device binding identity; immutable operation/binding IDs |
| Atomic success state | Challenge consumed by this operation; exactly one new active binding; created_by identifies this operation; generation initialized per frozen schema contract; exactly one matching `binding.created` event; one owner-scoped receipt with result_kind=created |
| Audit exact-match | event owner, event key, event type, schema version, actor, owner_admin_id, target type/id, operation_id, outcome, reason policy, and canonical allow-listed payload match the committed binding and operation |
| Must not happen | Do not emit created for a losing contender; do not overwrite key thumbprint; do not reactivate revoked binding; do not consume challenge in a separate committed call |
| Failure classes | unauthenticated/forbidden; challenge absent/expired/mismatch/replayed; active binding conflict; revoked binding conflict; receipt exact replay; receipt payload/type conflict; event-key payload conflict; storage/constraint failure; outcome-unknown |
| Retry | Same owner + operation_id + exact canonical request returns prior receipt; no second consume/insert/event. Same ID with changed type/fingerprint is integrity conflict |
| Timeout recovery | Reuse exact operation/challenge/binding/event IDs and payload; owner-scoped receipt read, then exact binding/audit verification. If unresolved, remain outcome-unknown; never mint new IDs to "retry" |
| Rollback | Any failed required assertion/audit/receipt must abort the same verified atomic unit. This is still an unproven D1 requirement |

### 2.2 Binding create — result = existing

| Dimension | Required contract |
|---|---|
| Preconditions | Same authenticated challenge checks; an already-active binding exists for the same owner+device and exact device-key thumbprint; it predates this operation |
| CAS / uniqueness | Challenge consumption remains conditional and operation-scoped; existing binding is read/verified without changing its identity fields |
| Atomic success state | Challenge consumed; existing binding remains active; original binding ID, created_by, created_at and generation remain unchanged; one receipt result_kind=existing; one `binding.existing_resolved` audit event for this resolution |
| Audit exact-match | event key scoped to this resolution operation; event owner/actor/target/operation/outcome and canonical payload identify resolution without claiming a new binding |
| Must not happen | No `binding.created` for this operation; no rewrite of created_by/generation; no duplicate binding; no key substitution |
| Failure classes | challenge invalid/replayed; no existing binding; thumbprint mismatch; binding revoked; receipt conflict; event conflict; storage failure; outcome-unknown |
| Retry | Exact receipt replay returns the same existing binding; must not consume challenge again or append a second resolution event |
| Timeout recovery | Resolve owner-scoped receipt and verify unchanged binding plus exact resolution event; no created-event inference |
| Rollback | Challenge consumption, resolution audit and receipt must share a verified atomic boundary |

**Open freeze items:** whether existing-resolution audit is mandatory for every challenge resolution; exact `reason_code`; whether actor is the end-user or a delegated service actor in each route. Batch 78's event proposal is not yet a user-approved production policy.

### 2.3 Binding revoke

| Dimension | Required contract |
|---|---|
| Preconditions | Authenticated actor; owner-scoped active binding; expected generation supplied/resolved from trusted current state; authorization permits revocation |
| CAS | `owner + binding_id + active_status + expected_generation`; one winner only; resulting generation exactly old+1 |
| Atomic success state | Binding revoked; generation incremented once; revocation metadata set from trusted server context; exact revoke audit; owner-scoped receipt containing resulting generation |
| Audit exact-match | event owner, actor, target binding, operation ID, old/new generation, prior/new status, outcome and reason code match the committed row |
| Must not happen | No revoke across owner boundary; no stale-generation success; no duplicate generation increment on retry; no silent reactivation |
| Failure classes | forbidden; binding absent/foreign (non-disclosing); already revoked; stale CAS; receipt replay/conflict; audit mismatch; storage failure; outcome-unknown |
| Retry | Same operation ID/fingerprint returns prior receipt; a new operation with stale generation conflicts |
| Timeout recovery | Reuse exact operation/event IDs; owner-scoped receipt + binding generation/status + audit verification |
| Rollback | Missing/mismatched audit or receipt assertion must roll back the status/generation update in the same verified atomic unit |

### 2.4 Share-code rotation

| Dimension | Required contract |
|---|---|
| Preconditions | Authenticated owner; exact code-record identity; active code record; expected version; actor authorized to rotate |
| CAS | `owner + code_record_id + active_status + expected_version`; new version exactly old+1 |
| Atomic success state | Code version increments once; new code material is handled only in protected runtime and never logged/stored in audit; exact rotation audit; owner-scoped receipt |
| Audit exact-match | event owner, actor, target code-record identity, operation ID, old/new version, outcome and reason code match; never include raw share code or digest |
| Must not happen | No stale-version success; no cross-owner rotation; no raw code/digest in event/log; no implicit binding/session/challenge/free-grant revocation policy |
| Failure classes | forbidden; record absent/foreign (non-disclosing); inactive; stale CAS; receipt replay/conflict; audit mismatch; storage failure; outcome-unknown |
| Retry | Exact receipt replay returns committed version/result without rotating again; changed payload under same operation ID is integrity conflict |
| Timeout recovery | Reuse exact immutable operation/event/record IDs; owner-scoped receipt + exact version + audit verification; do not generate another code until resolution |
| Rollback | Missing/mismatched audit or receipt assertion must roll back version CAS in the same verified atomic unit |

**Business policy remains unresolved:** effect of rotation on existing bindings, sessions, pending challenges and free-group grants. No default preserve/revoke/rebind behavior is selected in this batch. The actual raw-code generation/storage/return contract also requires separate secret-handling review.

## 3. Canonical request fingerprint vs audit envelope

Canonicalization v1 supplies a typed, length-prefixed byte encoding, but does not define which fields each operation must include. Before adapter implementation, freeze an ordered allow-list per operation:

- Common: `canonicalization_version`, `operation_type`, authenticated `actor_type`, authenticated `actor_id`, authenticated `owner_admin_id`, `target_type`, server-resolved `target_id`.
- Create: immutable challenge reference, device-key thumbprint, requested outcome class; never raw private key/proof/nonce/token.
- Revoke: binding ID and expected generation.
- Rotation: code-record ID and expected version; never raw share code or code digest.
- Include optional fields only with an explicit missing/NULL/empty policy. No arbitrary object/array/float/undefined.

Audit event envelope coverage is checked separately against the Batch 72 schema: `event_id,event_key,event_type,schema_version,occurred_at,actor_type,actor_id,owner_admin_id,target_type,target_id,operation_id,outcome,reason_code,payload,correlation_id`. `reason_code` may be nullable only if its per-event contract says so; do not fill a guessed generic value.

**Freeze blockers before adapter code:** exact actor mapping; exact per-operation outcome/reason enums; required-vs-nullable reason policy; event payload allow-lists; immutable event timestamp behavior under retries; target identifiers allowed in audit; canonical ordered field list and fingerprint versioning. Keep `schema_version` distinct from `canonicalization_version`.

## 4. Prepared bind manifest — required shape

Every prepared statement needs one manifest row per positional placeholder:

| Field | Meaning |
|---|---|
| statement_id | stable source-level identifier |
| sql_sha256 | hash of exact SQL UTF-8 bytes |
| ordinal | 1-based placeholder order |
| semantic_name | unique descriptive bind name |
| source | authenticated_context / validated_request / server_constant / derived_server_value |
| storage_class | text / integer / real / blob / null |
| nullable | boolean |
| missing_policy | reject / bind_null / explicit_optional_shape |
| sensitivity | public / internal / sensitive / secret |
| expected_value | never stored in the manifest |

Example (illustrative only; no real table or production SQL):
- SQL: `UPDATE synthetic_binding SET status = ?, generation = ? WHERE owner_id = ? AND binding_id = ? AND status = ? AND generation = ?`
- Ordinals: 1 status (server_constant, text, non-null); 2 next_generation (derived_server_value, integer, non-null); 3 owner_id (authenticated_context, text, non-null); 4 binding_id (validated_request, text, non-null); 5 expected_status (server_constant, text, non-null); 6 expected_generation (validated_request, integer, non-null).
- Exact bind count = 6; ordinals exactly 1..6; no missing/undefined; SQL hash matches the exact bytes.

Static scanner rules:
1. Count bare positional `?` only in normal SQL lexical state.
2. Ignore question marks in single/double/backtick quoted regions, bracket identifiers, line comments and block comments; honor doubled quote escapes.
3. Reject named placeholders (`:name`, `@name`, `$name`) and numbered placeholders (`?NNN`) to keep one positional contract.
4. Reject unterminated quoted/comment states and malformed manifest order.
5. Require unique semantic names, exact ordinals/count, approved source/storage/sensitivity enums, explicit nullable/missing policy, and bind storage class/nullability compatibility.
6. SQL string hash is computed over exact UTF-8 bytes; do not normalize SQL before hashing.
7. This is a static linter only. It does not prove D1 PreparedStatement behavior or SQL syntax correctness.

## 5. HMAC key overlap, admission and cleanup

### Safe state machine

| State | Read/decision rule | Write rule | Exit evidence |
|---|---|---|---|
| STABLE_OLD | old key buckets authoritative | write old | baseline counts and key version |
| PREPARE_NEW | old authoritative; new key derivation tested offline | still write old | deterministic bucket test vectors, no secret values |
| DUAL_WRITE_OVERLAP | evaluate one logical history across accepted versions | write each admission event to every accepted version in one atomic decision | cross-version event coverage and duplicate-event dedupe proof |
| NEW_PRIMARY_WITH_OLD_RETENTION | new authoritative; old retained only for compatibility/verification as explicitly designed | write new; retain sufficient historical coverage | old-write cutoff and coverage proof |
| RETIRE_OLD | no active request depends on old bucket | stop old reads/writes only after safe horizon | horizon elapsed + no unresolved retry/event IDs + rollback window closed |

**Critical correction to simplistic per-bucket checks:** checking each key-version bucket independently and rejecting only when *one bucket* reaches the limit can undercount a split history (e.g. old bucket=3, new bucket=3, limit=5). During overlap, the decision must evaluate the union of logical events across all accepted key versions, deduplicated by immutable `event_id`, or prove a migration/dual-write invariant that makes one bucket a complete authoritative history. Do not sum blindly if the same event is dual-written, because that double-counts. A per-version maximum is not a safe substitute.

Admission requirements:
- All applicable dimensions and all accepted key versions participate in one serialized/atomic decision.
- The event ID + complete action/dimension/fingerprint tuple is idempotent; same ID/different tuple is integrity conflict.
- Required dimension missing or HMAC key unavailable => fail closed.
- Do not leak raw IP/device/admin identifiers; HMAC key is separate from APP identity/session/entitlement keys.
- Define how deduplicated union queries remain bounded and indexed before implementation; no production threshold or retention duration is chosen.

Cleanup requirements:
- Cleanup must not race admission into undercount. Use a proven serialized atomic boundary or retain enough immutable event history so a concurrent cleanup cannot remove an event still in an active window.
- Delete only limiter events whose retention deadline is strictly earlier than trusted server time and outside every active window/retry horizon.
- Preserve event_id dedupe evidence through the retry/idempotency horizon.
- Never clean audit events or operation receipts as limiter garbage.
- Record cleanup watermark, run ID, selected opaque IDs, before/after counts and proof that active-window coverage remains complete.

## 6. Evidence matrix before any adapter implementation

| Area | Offline evidence in Batch 79 | Still required |
|---|---|---|
| State transition tables | static matrix consistency checks | implementation review and disposable D1 |
| Receipt owner scope | reference tests | D1 unique/read isolation proof |
| Audit envelope | required-field coverage test | freeze enums/nullability/payload allow-list |
| Canonical fingerprint | field-manifest checks | freeze exact ordered fields per operation |
| Bind manifest | lexical/ordinal/type negative tests | actual D1 prepare/bind probes |
| Atomic rollback | none in this batch | user-approved disposable D1 batch tests |
| Concurrent create/revoke/rotate | logical CAS requirements | multi-request D1 harness evidence |
| Timeout recovery | deterministic retry contract | dropped-response after-commit test on disposable D1 |
| HMAC overlap | split-history counterexample | dedupe/union query plan and concurrent admission test |
| Cleanup | retention/active-window rules | cleanup-vs-admission race and residual-row evidence |
| APP compatibility | no APK changes | source audit, protocol version compatibility and device proof tests |

## 7. Safety and rollback

No D1 access, credentials, SQL execution, migration, Worker/HTML/APK/Room/Secrets/Cloudflare configuration change or deployment occurred. All new files are versioned DEV-only specifications and offline tests. Rollback is limited to reverting this batch's docs/tests/workflow; no application data is touched.

Status: `DESIGN_MATRIX_COMPLETE / OFFLINE_TESTS_PENDING / D1_NOT_TESTED / APP_PENDING / NOT_DEPLOYABLE`.
