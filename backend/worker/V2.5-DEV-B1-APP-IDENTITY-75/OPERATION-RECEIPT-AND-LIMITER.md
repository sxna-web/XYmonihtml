# APP v2 Identity — operation receipt, audit assertion and limiter edge contract (Batch 75)

- Version: `V2.5-DEV-B1-APP-IDENTITY-75`
- Date: 2026-11-27
- Status: logical contract + disposable in-memory SQLite fixture only; D1_NOT_TESTED / APP_PENDING / NOT_DEPLOYABLE.

## 1. Scope and impact

This batch extends Batch 74's required operation receipt pattern to binding create, binding revoke and share-code rotation, and tests limiter idempotency/boundaries. All table names and columns in the fixture are synthetic. No existing production schema is assumed.

No D1 connection, SQL/migration execution, Worker/HTML/APK/Room/Secret/config modification or deployment is in scope.

## 2. Common operation receipt contract

One logical operation has immutable:
- operation_id;
- authenticated owner scope, derived by the server;
- closed operation_type;
- canonical request fingerprint/hash;
- result resource ID and resulting generation/version;
- deterministic audit_event_key;
- final database assertion that all required state and audit facts match.

The receipt is the final commit marker. Candidate assertion is a NOT NULL integer with CHECK(value = 1), populated from exact EXISTS predicates. A false assertion must raise a constraint error inside the same verified atomic unit; checking changes after commit is too late.

Owner-scoped resolution:
1. Query receipt by operation_id and authenticated owner in the same logical scope.
2. Same owner + same operation type + same canonical request returns the prior result without repeating mutation/audit.
3. Same operation_id with a different request/type is an integrity conflict.
4. A receipt belonging to another owner is indistinguishable from absent to the caller; never reveal its result.
5. Ambiguous write timeout is outcome-unknown. Retry reuses every original operation/event/resource ID and immutable payload, then resolves using owner-scoped reads.

The receipt table and CHECK assertion are candidate design only. D1 support for CHECK, scalar EXISTS, batch rollback, result metadata and prepared binding must be validated against a user-approved disposable D1 before implementation.

## 3. Operation-specific atomic contracts

### 3.1 Binding create

Within one atomic unit:
1. resolve prior owner-scoped receipt;
2. conditionally insert a binding using stable binding_id/operation_id and unique owner+device;
3. append binding.created only for the exact row newly created by this operation;
4. final receipt assertion checks exact active binding + exact event key/type/owner/target/operation/payload.

Same event key + same full canonical envelope is an exact replay; same key with any differing field is integrity conflict and must roll back. A pre-existing matching binding is not evidence that this operation created it; preserve the separate existing-binding resolution semantics from Batch 74.

### 3.2 Binding revoke

Use compare-and-swap over binding ID, authenticated owner, active status and expected generation. Exactly one transition increments generation. Append one immutable revoke event whose envelope matches owner, target, operation ID, prior/new state and resulting generation. Final receipt assertion must verify both the resulting revoked row and exact audit event. Missing or mismatched audit must roll back the status/generation change.

A retry with the same operation ID/request resolves the receipt and does not increment again. A distinct operation with stale generation conflicts. Revoked bindings are never silently reactivated.

### 3.3 Share-code rotation

Use compare-and-swap over authenticated owner, code-record identity, active status and expected version. Append a rotation event matching owner, target record, operation ID, old version and new version. Final receipt assertion checks exact new version and exact event. Missing/mismatched audit rolls back the version increment.

This batch does not decide whether rotation revokes, preserves or requires rebinding existing identity bindings, sessions, challenges or free-group grants. That business policy remains unconfirmed. Legacy fields/routes remain untouched.

## 4. Durable limiter event contract

Each limiter admission carries a server-generated event_id, action enum, pseudonymous dimension buckets, trusted server timestamp, retention deadline and request fingerprint. Dimensions are server-derived; missing required dimensions fail closed before admission. Optional dimensions must be explicitly marked non-applicable by the action contract, not represented by ambiguous empty strings.

- Same event_id + same complete action/dimension/fingerprint tuple: exact replay of the original admission; do not count twice.
- Same event_id + different tuple: integrity conflict; never silently accept.
- Admission checks all applicable dimensions and inserts one event atomically; no split increment-then-check sequence.
- The rate event ledger is append-only during its retention window; cleanup is bounded and only removes rows strictly older than retain_until.
- Limiter storage failure is fail-closed for identity-security actions. Do not convert storage failure into a rate denial or a fail-open admission.
- Keep HMAC bucket key separate from APP identity, entitlement and session secrets. Do not store raw IP/device/admin identifiers.

### Sliding-window and Retry-After

For a half-open window `[now-window, now)`, events exactly at the left boundary count; events at `now` do not. For integer-second timestamps and an inclusive left edge, the earliest next admissible second after a full dimension is the expiry of the oldest event plus one second. If multiple dimensions are full, calculate each dimension's release point and return the latest one (maximum), because all dimensions must be under limit.

This is a logical arithmetic contract only. Exact timestamp precision, skew, D1 SQL boundary behavior, query plan and cross-isolate serialization remain unverified.

### Cleanup

Do not delete audit events or operation receipts as transient data. Limiter cleanup may delete only rate events whose retain_until is strictly earlier than trusted now; exact-boundary rows remain until the next cleanup tick. Retention must exceed the longest active window plus approved retry/idempotency allowance. Final retention duration is not set in this batch.

## 5. Local SQLite fixture

File: `test_identity_operations_and_limiter.py`

24 tests cover:
- create success, missing/mismatched audit rollback;
- revoke success, missing/mismatched audit rollback, idempotent receipt replay and stale generation;
- rotation success, missing/mismatched audit rollback and replay;
- event key exact replay vs payload conflict;
- owner-scoped operation receipt and operation ID payload conflict;
- duplicate limiter event_id same/different payload;
- required dimension validation;
- multi-dimensional Retry-After max release point;
- half-open window boundary;
- cleanup exact retention boundary, active-window protection and idempotency.

Run:

```bash
python -m unittest discover -s backend/worker/V2.5-DEV-B1-APP-IDENTITY-75 -p 'test_*.py' -v
```

The fixture uses an in-memory synthetic SQLite schema. It is not a D1 migration, does not model multiple Worker isolates, and does not prove D1 CHECK enforcement, D1 batch rollback, D1 concurrency or production schema compatibility.

## 6. Explicit non-goals / unresolved

- No production DDL/schema is asserted.
- No D1 connection or SQL execution.
- No Worker/API integration, APK compatibility or Android Keystore proof.
- No final limiter thresholds, retention duration or HMAC key rotation policy.
- No share-code rotation policy for existing bindings/sessions/challenges/free grants.
- No audit retention or cleanup policy.
- Not deployable.
