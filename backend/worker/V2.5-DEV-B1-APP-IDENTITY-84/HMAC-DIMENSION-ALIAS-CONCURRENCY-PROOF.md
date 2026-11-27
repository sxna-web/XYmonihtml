# HMAC dimension alias registry — Batch 84 concurrency proof and manifest separation

- Batch: V2.5-DEV-B1-APP-IDENTITY-84
- Date: 2026-11-28
- Status: OFFLINE_REFERENCE_CHECKS_PASS_17_OF_17 / REPOSITORY_SUITE_NOT_RUN / ACTIONS_NOT_VERIFIED / D1_NOT_TESTED / NOT_DEPLOYABLE

## 1. Scope and evidence

This batch extends Batch 82's HMAC alias counterexamples and Batch 83's candidate dimension_id model. It is a reference model and contract boundary only. It does not implement HMAC, SQL, D1, a Worker route, a production key, or a retention policy.

Local checks executed in this session:
- 8 concurrency/alias/backfill reference scenarios: passed.
- 9 manifest boundary/reference checks: passed.
- Total 17/17 reference checks passed.
- The checked-in 20-case + 9-case unittest suite has been authored but was not executed from the repository runtime. GitHub Actions status was not obtained. Do not mark CI green.

## 2. Main invariant: one logical dimension, multiple version aliases

A key-version fingerprint is not a logical identity. The proposed mapping is:

- Logical dimension: opaque random dimension_id.
- Alias key: (key_version, dimension_type, fingerprint).
- Alias value: dimension_id.
- Logical event: immutable event_id + action + dimension_type + dimension_id + event time + policy window + decision.
- Event alias: (event_id, key_version, dimension_type) -> fingerprint.

A fingerprint alias must resolve to at most one dimension_id. A logical event's dimension_id must not change when the active HMAC key changes. Rate counting is the distinct union of event_id values across every active key-version alias; never sum per-key buckets and never take the maximum bucket.

### 2.1 Overlap admission rule

During K1/K2 overlap, every new or refreshed dimension resolution must derive all aliases for the exact configured active-version set from the same validated input and attach them in one atomic operation.

- K1-only or K2-only first-seen resolution is rejected.
- A server instance with stale active-version configuration must fail closed rather than write a partial alias set.
- Resolve all supplied aliases before mutation. If they point to multiple dimension_id values, reject as integrity conflict.
- Enforce uniqueness on (key_version, dimension_type, fingerprint).
- A conflicting event_id tuple or conflicting event alias rejects the whole operation; no alias may be left partially attached.
- Exact retry with the same event_id/logical tuple/aliases is idempotent.

This prevents two concurrent full-vector first-seen calls from creating two logical IDs in the reference model. It does not prove a real database can provide the same atomicity.

### 2.2 Fundamental limit: old fingerprint cannot be re-keyed

HMAC is not reversible. If historical storage contains only K1 fingerprint and the original dimension value is no longer available from a trusted source, the system cannot calculate the K2 fingerprint from K1.

Therefore:
- Do not claim backfill completeness merely because a new alias table exists.
- A legacy event can be bridged only if the same normalized dimension value can be re-derived transiently from an authorized source, then K1 and K2 aliases are checked and attached to its existing dimension_id.
- Never persist raw IP/device/admin identifiers just to make key rotation easier.
- If the raw source is unavailable, preserve K1 verification/lookup capability and block K1 retirement; do not guess a K2 alias or merge by timestamp/count.
- Any source used for re-derivation needs separate privacy, access, retention and threat review.

## 3. Concurrency and migration state machine

1. **Prepare overlap:** configure the exact accepted key-version set on every writer/reader; version-set mismatch blocks admission.
2. **Dual derive:** each new dimension request derives aliases for all accepted versions from the same ephemeral canonical input.
3. **Atomic resolve:** uniqueness resolves all aliases to one dimension_id; conflicts abort without partial writes.
4. **Snapshot:** record an immutable backfill high-water checkpoint H for the legacy event set.
5. **Backfill:** re-derive aliases only where a trusted normalized source exists; preserve each event's existing dimension_id.
6. **Catch-up:** include every event admitted after H, including delayed retries that still use K1; repeat until the high-water/catch-up barrier is stable.
7. **Coverage proof:** for every event/dimension in every still-relevant limiter window and retry/idempotency horizon, verify K2 alias exists and points to the same dimension_id. Reconcile counts and event IDs, not only aggregate totals.
8. **Retirement gate:** K1 may be retired only after alias coverage, old-version writer shutdown, retry horizon, active-window horizon, cleanup horizon, rollback horizon and reconciliation are all proven closed.
9. **Rollback:** if K1 is needed again, restore its key/config only through an explicit reviewed overlap procedure; never silently accept a retired version or write partial aliases.
10. **Cleanup:** event/alias cleanup is coordinated with active windows, retry horizon, backfill, and key-retirement policy. Dimension aliases may be shared by many events and cannot be deleted merely because one event expires.

If any step is incomplete or has outcome-unknown status, retain both key versions and fail closed for any operation requiring missing aliases.

## 4. Adversarial model coverage

The checked-in model/test suite covers:
- concurrent full K1+K2 first-seen resolution;
- K1-only and K2-only overlap rejection;
- aliases already mapped to different dimension IDs;
- alias reassignment conflict;
- event_id exact retry and tuple conflict with no partial alias writes;
- event alias conflict;
- K1 legacy history bridge to K2;
- backfill conflict where K2 alias already belongs to another dimension;
- partial backfill and missing alias coverage;
- high-water snapshot with events arriving after the checkpoint;
- late old-version retry after the first backfill pass;
- retry/rollback/cleanup horizon gates;
- distinct event_id union deduplication;
- cleanup during an active window;
- key retirement and explicit rollback incompatibility.

The in-memory RLock serializes model calls. It is not a substitute for D1 UNIQUE constraints, transactional batch behavior, isolation testing, or query-plan evidence.

## 5. Three independent statement manifest contracts

Files:
- identity_adapter-statement-manifest.json
- limiter_adapter-statement-manifest.json
- disposable_harness-statement-manifest.json
- statement-manifest.schema.json
- manifest_validator.py

Separation rules:
- Identity adapter owns challenge, nonce, binding, share-code, operation receipt and approved audit operations.
- Limiter adapter owns dimension registry/aliases, event admission, event union reads, backfill, coverage and limiter cleanup.
- Disposable harness owns run ledger, synthetic fixtures and exact run-scoped cleanup only.
- Harness cleanup must never be imported as a production identity/limiter method.
- No statement is frozen yet. SQL text, SQL hash, placeholders, bind arrays and real bind values are intentionally absent.
- A future statement record needs a stable statement_id, owning interface/method, purpose, exact SQL hash after approval, tokenizer version, ordered placeholder contract, trusted value source/storage class/nullability/sensitivity, result index/cardinality, expected changes/RETURNING vector, evidence case IDs and assertion dependencies.
- The JSON Schema limits placeholders and binds to empty arrays while sql_state is NOT_FROZEN. Static validator rejects executable SQL fields and sensitive bind material.

Open blockers preserved:
- U80-01..08 user decisions;
- nonce representation and uniqueness scope;
- share-code digest storage encoding;
- audit actor/outcome/reason/payload policy;
- share-code rotation side effects;
- actual D1 schema/runtime and disposable DB authorization.

## 6. Non-actions and deployment status

No D1 connected, no SQL executed, no migration/DDL created, no secrets read, no production key selected, no Worker/API/HTML/APK/Room/Cloudflare configuration changed, and no deployment occurred. This batch is not deployable.
