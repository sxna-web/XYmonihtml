# APP v2 Identity — audit event and durable rate-limit protocol (Batch 72)

- Version: V2.5-DEV-B1-APP-IDENTITY-72
- Date: 2026-11-27
- Status: design only; no D1 connection, SQL, migration, Worker integration or deployment.
- Basis: AGENTS.md, V2.5 functional/API/database protection baselines, Batch 57 APP protocol design and Batches 68–71.

## 1. Scope and non-goals

This batch defines a proposed immutable audit-event contract for binding creation/revocation and share-code rotation, a candidate durable rate-limit protocol, and signature timestamp/nonce versioning requirements.

It does not create schema or decide unconfirmed business policy:
- Whether share-code rotation revokes, preserves or requires rebinding existing identity bindings remains unconfirmed.
- Audit retention, final rate-limit thresholds, clock-skew values, timestamp precision and safety margin remain configuration/policy decisions.
- No claim is made that the Android client implements the signature protocol. APK 6.00.48 remains unaudited.
- No D1 schema, binding, Worker runtime or production state is inferred from repository documents.

## 2. Audit event envelope

### 2.1 Required logical fields

This is a logical contract, not production DDL. Names and types require reconciliation with verified schema.

| Field | Meaning | Rule |
|---|---|---|
| event_id | Unique immutable event identity | Server-generated; stable for retries of one logical operation |
| event_key | Deterministic idempotency key | Unique; namespace + target + operation/version; never raw credentials |
| event_type | Closed event taxonomy | e.g. app.identity.binding.created |
| schema_version | Audit payload schema version | Server-controlled |
| occurred_at | Trusted server UTC timestamp | One canonical precision per schema version |
| actor_type / actor_id | Authenticated actor | Derived from server context, not request body |
| owner_admin_id | Resource owner | Resolved from trusted database state |
| target_type / target_id | Target resource | Internal identifiers only |
| operation_id | Logical write-operation id | Stable across retries; distinct for a new operation |
| outcome | committed / rejected / conflict / system_error | Never mark an uncommitted mutation committed |
| reason_code | Normalized safe reason | No free-form secrets, raw body or stack |
| payload | Immutable allowlisted metadata | Versioned, bounded and secret-free |
| correlation_id | Request trace reference | Random/pseudonymous, not a credential |

Actor and owner are separate. A super-admin action may have an actor different from the resource owner. Never infer owner from actor or accept either from client-supplied IDs.

### 2.2 Event taxonomy and payload allowlist

| Event | Allowed metadata | Prohibited |
|---|---|---|
| binding.created | binding_id, device_key_thumbprint, binding_generation, creation_method | key bytes, device proof, raw device identifier, token |
| binding.revoked | binding_id, prior_status, resulting_status, revoke_reason_code, binding_generation | proof, free-form content, other owner's data |
| share_code.rotation_committed | owner_admin_id, code_record_id, old_version, new_version, rotation_operation_id | raw code, code_digest, generated secret, URL containing code |

A key thumbprint remains a pseudonymous identifier and must be access-controlled. Omit it if not necessary.

### 2.3 Append-only and integrity

- Audit events are append-only. Corrections are new compensating events referencing the prior event; routine maintenance must not update/delete committed events.
- Enforce uniqueness of event_id and event_key, or an equivalent unique idempotency key.
- Same event_key with a different canonical payload is an integrity conflict, never silent success.
- Owner-scoped reads filter by owner in SQL, not after a global read.
- Privileged audit reads are themselves audited.
- Retention/legal-hold policy is not set here. Do not implement audit cleanup until the owner approves it.
- Never include raw share code, code_digest, token, nonce, private key, device proof, subscription URL or raw device identifier in audit or ordinary logs.

## 3. Idempotency by operation

### 3.1 Binding creation

Continue Batch 71's three-statement logical batch:
1. Insert-if-absent binding with stable binding_id and operation_id.
2. Read winner using authenticated owner + device scope.
3. Conditional audit INSERT-SELECT only if the row exactly matches this attempt's binding_id, owner, device, key thumbprint, generation and immutable created_at.

Suggested deterministic event key: app.identity.binding.created:<binding_id>.

Reuse binding_id, operation_id, event_id/event_key and immutable timestamp only for retries of this same logical attempt. If this attempt lost the owner/device uniqueness race, its binding_id differs from the winner and it must not append a created event. A pre-existing matching binding is not evidence this attempt created it.

### 3.2 Binding revocation

Proposed logical transaction:
1. Conditional UPDATE by binding_id + authenticated owner + expected status/generation; transition only an eligible non-revoked row and increment generation.
2. Conditional audit INSERT-SELECT from the exact resulting row, matching binding_id, owner, operation_id (or immutable revoke version), new generation and revoke timestamp.
3. Return success only after the batch result is validated.

Suggested key: app.identity.binding.revoked:<binding_id>:<new_generation>.

Rules:
- First successful revoke writes exactly one event.
- Retry after ambiguous timeout reuses operation_id and expected generation. Resolve by owner-scoped state and event lookup.
- A distinct later attempt must not create another revoked transition for an already revoked binding.
- Zero-row update is not automatically success; it can mean absent, wrong owner, stale generation, already revoked or state conflict. Public errors must not disclose another owner's row.
- Audit failure must roll back the transition if D1 atomicity is verified.
- Never resurrect a revoked binding during retry.

### 3.3 Share-code rotation

The audit records only the committed version transition:
- Suggested key: app.identity.share_code.rotated:<owner_admin_id>:<new_version>, or stable rotation operation ID if version semantics differ.
- Conditional audit INSERT-SELECT must match owner, code-record ID, old version, new version, operation ID and committed timestamp.
- Stale version CAS writes no committed event.
- Timeout retry resolves whether the exact version and event already committed; it must not generate another code/version blindly.
- Raw code and code_digest never enter audit, logs, metrics or error text.

Unresolved business policy: whether rotation affects existing bindings, active sessions, outstanding challenges or free-group access. Do not silently choose revoke-all, preserve-all or force-rebind. Keep legacy share-code routes/fields unchanged until a separately approved migration policy exists.

## 4. Audit retention and failure policy

- No retention duration is selected. Approve retention, legal-hold, export and permanent-deletion rules before designing cleanup.
- Audit events are excluded from transient cleanup.
- Index/query design should support owner + occurred_at, target + occurred_at, event_key uniqueness and correlation_id lookup without indexing secret-bearing payload fragments.
- Payload size is bounded and event types are allowlisted. Unknown event types or oversized payloads fail closed for the mutation.
- If audit persistence fails, do not report the state change as successful. Prefer the same verified transaction/batch; otherwise use a durable outbox and do not report success until durable intent exists.
- Do not swallow audit exceptions. Emit only a redacted operational alert with correlation_id.
- Timeout means outcome unknown, not rollback. Retry only with same operation identifiers and resolve by owner-scoped state/event reads.

## 5. Candidate durable identity rate-limit protocol

### 5.1 Dimensions and pseudonymous keys

For each action, derive keys server-side using a dedicated secret separate from APP identity and entitlement signing secrets:
- network scope: keyed hash of normalized client network address, only after trusted proxy/header handling is verified;
- device scope: keyed hash of authenticated device key thumbprint or stable server-verified device reference;
- admin scope: keyed hash of resolved administrator ID;
- action scope: fixed server enum, such as identity.discover, identity.challenge.issue, identity.proof.fail, identity.nonce.consume, identity.binding.create, identity.binding.revoke and identity.share_code.rotate.

Never store raw IP, device identifiers, admin IDs, share codes or tokens in limiter rows. Use a dedicated HMAC key; do not reuse APP_IDENTITY_SECRET, APP_ENTITLEMENT_SECRET, SESSION_PEPPER or token keys. Secret rotation requires a versioned key identifier and a transition plan so active windows are not reset.

### 5.2 Candidate: atomic sliding-window event admission

Use an append-only rate event ledger and one conditional INSERT-SELECT statement per admission:
- Each event stores a server-generated request/event ID, action enum, keyed network/device/admin buckets, server timestamp and retention deadline.
- The single INSERT-SELECT admits only when counts in every applicable dimension/action window are below configured thresholds.
- The statement inserts one event or inserts nothing; no separate increment then SELECT decision.
- Unique request/event ID makes an admitted retry idempotent. Reuse of an ID with different action or bucket dimensions is an integrity conflict.
- Add indexes for (action, network_bucket, occurred_at), (action, device_bucket, occurred_at), (action, admin_bucket, occurred_at), and retain_until cleanup.
- Thresholds and window lengths are configuration, not hard-coded here. Do not copy general conversion quota values as APP identity thresholds.

Illustrative logical shape only; this is not executable SQL or a migration:

    INSERT INTO identity_rate_events (...)
    SELECT ...
    WHERE network-window count < configured network limit
      AND device-window count < configured device limit
      AND admin-window count < configured admin limit
    ON CONFLICT(event_id) DO NOTHING
    RETURNING event_id;

This is a candidate only. Exact window-boundary inclusivity, null/non-applicable dimensions, D1 RETURNING, query plan, write serialization across isolates and duplicate retry classification require disposable isolated D1 tests. Do not infer D1 behavior from SQLite fixtures.

### 5.3 Admission, denial and Retry-After

- A newly returned inserted event_id means admitted, after duplicate handling is verified.
- No returned row means rate denied or another non-insert condition; do not guess. Use a bounded follow-up read with the same pseudonymous keys to classify and calculate earliest relevant window expiry.
- Return stable public code RATE_LIMITED and integer Retry-After. Do not reveal thresholds, raw bucket keys or which other user/device filled a shared network bucket.
- Compute Retry-After from the oldest event that must expire for all exceeded dimensions, using trusted server time and conservative ceiling. If classification fails, return a safe temporary service error or safe retry hint according to policy; never claim admitted.
- Ordinary conversion quota behavior remains separate. Identity limiting must not permanently ban L0 basic conversion.

### 5.4 Atomicity and failure policy

The single-statement design avoids partial consumption across dimensions because checks and insert are one statement. Concurrency correctness still depends on actual D1/SQLite write serialization and must be tested using separate Worker requests/isolates.

If D1 cannot provide required serialization or query cost is unacceptable, do not split decisions into independent increments. Return to design review for a verified transaction/outbox or purpose-built limiter. Never use in-memory counters as the durable security boundary.

For identity discovery, challenge/proof, binding and rotation:
- limiter storage unavailable means fail closed with a generic temporary service error, not a quota denial and not fail-open;
- record a redacted operational metric; never log raw identity inputs;
- cleanup is bounded and only removes events past retain_until;
- retain events at least as long as the longest active window plus safety margin and operational retry allowance;
- cleanup failure may increase storage/cost but must not relax limits;
- use supported action enums and explicit request/query caps.

### 5.5 Values intentionally left open

Require product/security approval and load testing for:
- per-action thresholds and window lengths;
- network-scope applicability and shared-network handling;
- required dimensions before vs after device proof;
- Retry-After behavior when several dimensions are full;
- retention/privacy notice;
- emergency bypass and super-admin support procedure.

No final numeric values are frozen in this batch.

## 6. Signature protocol, timestamp precision and nonce versioning

### 6.1 Evidence boundary

Batch 57 describes signed-request nonce and device-proof intent, but repository evidence does not establish a complete canonical signing format, algorithm, Android implementation, timestamp unit, key rotation model or protocol version accepted by a shipped APK. No client/server compatibility claim is made.

### 6.2 Required versioned envelope

Before implementation, freeze:
- protocol_version;
- signature algorithm and key type;
- canonical method, path, query/body digest and content-type;
- exact UTF-8 canonicalization, newline and field ordering;
- timestamp integer unit and precision;
- nonce byte length/encoding and per-binding uniqueness scope;
- device key thumbprint format;
- server acceptance window and boundary inclusivity;
- challenge binding, expiry and one-time consumption;
- key rotation/revocation behavior;
- verification order and uniform external errors.

Do not log raw signatures, nonce values, device public keys or tokens.

### 6.3 Version-specific nonce retention

For each protocol version v, define immutable acceptance skew S_v, timestamp precision P_v and safety margin M_v. Under symmetric inclusive acceptance abs(T - server_now) <= S_v:

    retain_until >= first_seen + 2 * S_v + M_v

- Store protocol_version and retain_until with nonce, or use version-scoped nonce uniqueness.
- Cleanup uses server-side integer timestamps at the exact stored precision.
- Never reinterpret old-version timestamps using new precision or wider skew.
- Increasing skew for an existing version is prohibited unless all retained rows are safely extended before the wider acceptance becomes active. Safer default: publish a new protocol version with a separate acceptance policy.
- During dual-version rollout, verify each request only under its declared supported version; do not try multiple canonicalization variants until one passes.
- Consume nonce only after cryptographic verification and binding/device/status checks, but before protected side effect. Where replay safety requires it, nonce consumption and side effect must be in one verified atomic unit.
- If nonce insertion outcome is unknown after timeout, retry with same nonce and operation ID; duplicate means already consumed/rejected unless original result can be recovered safely through an idempotency record.

Batch 71's 2S formula assumes symmetric inclusive acceptance. If actual windows are asymmetric, derive retention from actual earliest/latest accepted server times.

## 7. Legacy share-code staged compatibility

| Stage | Allowed | Must not do |
|---|---|---|
| A — inventory | Enumerate Worker routes, HTML callers, APK callers and external integrations | No schema/route mutation |
| B — isolated v2 design | Define separate v2 discovery/binding credential flow | Do not treat legacy raw code as authentication |
| C — additive rollout plan | Prepare dual-read/dual-write or v2-only plan after verified schema and migration review | No destructive rename/drop; no secret logging |
| D — isolated validation | Test old/new clients/routes against isolated data and rollback plan | No production writes |
| E — separately approved release | Add v2 route/feature flag after explicit approval | No silent old route shutdown |
| F — deprecation decision | Decide only after client adoption evidence and explicit policy approval | No automatic expiry/revocation assumptions |

Legacy admin_share_codes fields/routes remain unchanged during design. Rotation's effect on current bindings/challenges/sessions remains a product decision, not a technical default.

## 8. Isolated validation matrix

Before any implementation is D1-ready, test on a dedicated, explicitly approved non-production D1:
1. Audit event unique event_key and same-payload retry.
2. Same event_key with different payload is integrity conflict.
3. Binding creation winner/losing concurrent attempts; only winner emits created event.
4. Binding revoke exact generation transition emits one event; duplicate retry emits no second event.
5. Rotation CAS stale version emits no committed event; ambiguous timeout resolves same version/event.
6. Forced audit statement failure rolls back corresponding state mutation.
7. Audit owner-scoped reads and audit-read access.
8. Rate-limit threshold race from separate Worker requests/isolates for every dimension.
9. Sliding-window exact boundaries and Retry-After rounding.
10. Duplicate event ID with same vs different action/bucket inputs.
11. D1 RETURNING, result metadata, query plan and statement/batch rollback.
12. Cleanup only after retain_until; cleanup failure does not relax admission.
13. Nonce replay before/after cleanup at future/past skew boundaries.
14. Protocol dual rollout, timestamp unit mismatch and skew increase rejection.

SQLite fixtures/mock stores can test pure logic but do not satisfy this D1 gate.

## 9. Impact and status

- Documents only; no Worker, HTML, APK, Room, D1, Secrets, Cloudflare config, API route or migration changed.
- No D1 connection or SQL execution.
- No executable tests added or run in this design-only batch.
- Document rollback: retain prior batch artifacts; this proposal changes no runtime behavior.
- Status: D1_NOT_TESTED / APP_PENDING / NOT_DEPLOYABLE.

## 10. Batch 73 handoff

**APP v2 identity audit/rate-limit contract adversarial review and isolated test specification (design-only; no D1).**

1. Re-read AGENTS, functional/API/database protection baselines, continuity plan, progress and Batches 68–72.
2. Independently challenge audit uniqueness/retry for concurrent bind/revoke/rotation and ambiguous timeout.
3. Review sliding-window admission under concurrency, duplicate event IDs, missing dimensions, shared NAT, clock jumps, query cost and cleanup races; do not run against D1.
4. Define exact isolated D1 tests/evidence for batch/statement atomicity, RETURNING, race admission and Retry-After.
5. Review nonce protocol rollout for old/new APK compatibility; keep APP_PENDING absent client evidence.
6. Complete legacy share-code caller inventory from repository source without changing routes/schema.
7. No D1 connection, SQL, migration, Worker/HTML/APK/Room/Secrets changes or deployment.
8. Update progress, continuity plan and Batch 74 handoff.
