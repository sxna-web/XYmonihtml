# APP v2 Identity — D1 statement contract independent security review (Batch 71)

- Version: `V2.5-DEV-B1-APP-IDENTITY-71`
- Date: 2026-11-27
- Status: **static review and design correction only; no D1 connection; no SQL execution; no migration; no Worker integration; not deployable**
- Baseline: Batch 70 statement contract, Batch 68 adapter contract, original Worker source blob `5da7aa3582558d9da2c2a0ad25a63c5e95e9fe63`

## 1. Review scope and evidence boundary

Reviewed the repository's root `AGENTS.md`, V2.5 functional baseline, API authorization specification, database change-protection specification, project continuity plan, development progress log, Batch 68/69/70 artifacts, and the original Worker source.

The original Worker is a repository source baseline, not proof of the deployed Cloudflare Worker or live D1 schema. Its visible DDL and callers are used only to identify compatibility risks. No Cloudflare account, D1 database, production or staging environment was accessed.

## 2. Eight-method static review

| Method | Review result | Required correction / gate |
|---|---|---|
| `insertChallenge` | One parameterized INSERT with immutable server-derived challenge context is appropriate. | Classify only the expected `challenge_id` primary-key conflict as a domain conflict. Do not turn every constraint/SQL error into “duplicate”. Enforce bounded challenge lifetime and server-generated issue/expiry times. |
| `consumeChallengeAtomic` | One conditional UPDATE is the correct single-use boundary. | Keep pending status, strict `expires_at > now`, device, authenticated admin, code version and verified key thumbprint in the same WHERE clause. Zero rows must remain one non-disclosing rejection class. Use verified D1 affected-row/RETURNING behavior; do not infer it from SQLite. |
| `consumeNonceAtomic` | Unique `(binding_id, nonce)` plus insert-if-absent is the correct replay guard. | Verify signature/canonical request, binding, device key and timestamp before consuming. Duplicate must reject. Store `retain_until`, not the signed timestamp. Do not shorten existing rows if the configured skew increases. |
| `upsertBindingAtomic` | Insert-if-absent followed by owner/device-scoped winner SELECT in one D1 batch is structurally sound, subject to real D1 concurrency verification. | Keep the unique `(admin_user_id, device_id)` constraint. Compare owner/device/status/key/version after the batch. Never overwrite key material or revive revoked rows. Add the conditional audit statement described in §3 to the same batch. |
| `revokeBindingAtomic` | Owner-scoped conditional UPDATE followed by owner-scoped read is appropriate. | A zero-row follow-up must query by both binding ID and authenticated owner. Keep revoked rows and audit history. Any “already revoked” idempotent result must be policy-defined and must not reveal another owner's row. |
| `rotateShareCodeAtomic` | Version compare-and-swap is appropriate for a separately approved v2 schema. | Zero rows means conflict/inactive; do not auto-read and retry with a new version. Do not change legacy code behavior or silently revoke existing bindings. Digest collision is a distinct safe conflict. |
| `getCurrentShareCode` | Owner-scoped minimal metadata read is appropriate. | Enforce one active row by verified schema constraint or detect invariant violation. Never expose `code_digest` or raw secret to APP. |
| `expireTransientRecords` | Bounded cleanup is appropriate; binding/revocation/audit data must be outside cleanup scope. | Batch candidates by stable row identity. Do not use delimiter-concatenated `binding_id || ':' || nonce` as a composite key. Prefer a nonce surrogate primary key or a verified row-value predicate. Cleanup only after the replay-retention deadline. |

### Cross-cutting SQL/result requirements

- Every user-controlled value remains a bound parameter. SQL identifiers must come only from reviewed fixed code/schema.
- Treat expected uniqueness conflicts, zero-row conditional writes, schema errors, overloads, timeouts and unknown write outcomes as separate internal classes.
- Do not use `results.length` as a generic affected-row count.
- Verify `success`, statement result ordering, `meta.changes` and/or `RETURNING` shape against the exact approved D1 runtime before implementation.
- A timeout after a write is outcome-unknown. Resolve with the same immutable operation identifiers and owner-scoped reads; do not generate a new challenge, nonce or binding identity blindly.
- Fail closed for APP identity security checks. Redact SQL, stack, code, digest, nonce, token and device proof from public errors and routine logs.

## 3. Binding creation audit: atomic and idempotent proposal

Batch 70 correctly identifies that JavaScript cannot branch between statements inside `D1.batch()`. The current two-statement insert + winner-read contract does not, by itself, guarantee an atomic creation audit.

### Recommended logical batch

Prepare all statements before calling `batch()`:

1. `INSERT ... ON CONFLICT(admin_user_id, device_id) DO NOTHING` using a newly generated `binding_id` and immutable creation timestamp.
2. Owner/device-scoped winner SELECT.
3. Conditional audit INSERT-SELECT, using the *attempt's* binding ID, owner, device, key thumbprint and exact creation timestamp. Give the audit event a deterministic unique key such as `binding.created:<binding_id>`; use `ON CONFLICT(event_key) DO NOTHING`.

The third statement must select only the row created by this logical attempt. If the insert lost to an older winner, that older row has a different binding ID and the audit statement inserts nothing. If the same logical batch is retried after an ambiguous timeout, the same binding ID/event key is reused and the unique event key prevents a duplicate audit. If the audit statement fails, the batch should fail as a unit so the binding insert is not committed without its creation audit.

Illustrative shape only (table/column names are unverified design names; syntax and runtime behavior require isolated D1 tests):

```sql
INSERT INTO identity_binding_audit (
  event_key, binding_id, admin_user_id, actor_type, action, occurred_at
)
SELECT ?, b.binding_id, b.admin_user_id, 'app_device', 'binding.created', ?
FROM identity_bindings AS b
WHERE b.binding_id = ?
  AND b.admin_user_id = ?
  AND b.device_id = ?
  AND b.device_key_thumbprint = ?
  AND b.created_at = ?
ON CONFLICT(event_key) DO NOTHING;
```

Requirements:
- The audit table needs a unique, non-null `event_key` (or equivalent unique idempotency key).
- Reuse the same `binding_id`, event key and immutable creation timestamp on retries of one logical operation.
- Do not reuse an operation ID for a distinct bind attempt.
- Do not append “binding.created” merely because a matching owner/device winner exists; the attempted binding ID must match.
- Verify D1 batch rollback when the audit statement is forced to fail using only disposable rows.
- Revoke, share-code rotation and other sensitive transitions need their own deterministic event keys and reviewed atomicity contracts; this proposal does not claim those audit paths are implemented.

This is a design recommendation, not a migration or a claim about current schema.

## 4. Nonce retention boundary matrix

Assumption to be frozen and tested: a signed request timestamp (T) is accepted exactly when `abs(T - server_now) <= S`, using the same precision and trusted server clock on every request. Thus the request can be accepted from server time (T-S) through (T+S), inclusive.

For a nonce first accepted at server time (t_0), the conservative bound is:

```text
retain_until >= t0 + 2 * MAX_CLOCK_SKEW + SAFETY_MARGIN
```

| First accepted timestamp position | First server receipt | Last server time same timestamp can pass | Required interpretation |
|---|---|---|---|
| Maximum future edge | `t0 = T - S` | `T + S = t0 + 2S` | Worst case; keep nonce beyond this point plus margin. |
| Zero skew | `t0 = T` | `T + S = t0 + S` | Formula retains longer than strictly needed; conservative. |
| Maximum past edge | `t0 = T + S` | `T + S = t0` | Timestamp is valid only at the receipt boundary; formula remains conservative. |
| Just inside future edge | `t0 = T - S + ε` | `t0 + 2S - ε` | Still approaches the worst case as ε approaches zero. |
| Exact expiry boundary | Cleanup runs when `retain_until <= now` | Signature window has already ended because margin is positive | Safe only if margin exceeds clock/precision/queue uncertainty. |
| Duplicate before cleanup | Existing nonce row remains, even if nominal expiry has passed | Duplicate unique key still exists | Reject; expiry alone does not make an uncleaned nonce reusable. |
| Duplicate after cleanup | Row has been deleted | Original signed timestamp must already be outside acceptance window | Signature timestamp check rejects before a new nonce insert can authorize it. |

### Numeric illustration (not a project configuration)

If `S = 300 seconds` and `SAFETY_MARGIN = 30 seconds`, minimum retention is 630 seconds after first receipt. The values are examples only; no production skew or margin has been selected.

### Additional protocol safeguards

- The skew value, timestamp unit/precision and margin must be server configuration, never client input.
- If skew is increased, existing rows may have been retained for too short a period. Either freeze skew for the protocol version, retain against the maximum supported skew, or version the signing protocol and do not widen acceptance for old signatures.
- Do not mix seconds and milliseconds, round timestamps differently in verification and cleanup, or use client wall-clock time as cleanup time.
- Nonce uniqueness is scoped to binding; binding revocation/status and device-key proof are checked on every protected request.
- Cleanup is bounded and independent of request authorization. Never treat a delayed cleanup as permission to accept an expired signature.

## 5. Legacy share-code compatibility review

The original Worker source contains legacy `admin_share_codes` DDL with `admin_user_id` primary key, raw `code` unique and `created_at`; no observed version, digest or revocation fields. Observed legacy callers include:
- `ensureShareCode` and user/super-admin share-code display routes;
- APP resolve by query-string code, returning administrator metadata;
- legacy free-group lookup accepting administrator ID or code;
- download lookup accepting administrator ID or code.

The source also shows the old code being stored and returned in raw form. This is a compatibility/security finding about the repository baseline only, not proof of the live Worker.

Required approach:
1. Do not rename, reinterpret, overwrite or drop legacy `code` as part of the v2 design.
2. Do not assume a v2 digest/version table already exists.
3. Introduce a separately versioned v2 contract/table or additive migration only after a full caller inventory, verified live schema snapshot, compatibility plan and explicit approval.
4. Keep discovery separate from authentication: a legacy share code may identify a candidate administrator, but it must not alone grant node/group access or create a trusted binding.
5. Keep existing legacy route behavior unchanged during design. Any later deprecation requires a versioned migration window, client compatibility evidence and user approval.
6. Rotation semantics remain unconfirmed: do not silently revoke existing bindings, preserve them, or invalidate them without an explicit policy decision. The current DEV proposal is not a frozen business rule.
7. Never place raw codes in logs, analytics, error details or audit payloads. Query-string legacy behavior requires careful access-log/redaction review before route migration.

## 6. Durable rate-limit assessment

The original Worker source baseline shows:
- `rate_limits(bucket TEXT PRIMARY KEY, count INTEGER, updated_at TEXT)`;
- global conversion minute/hour buckets incremented with `INSERT ... ON CONFLICT DO UPDATE count=count+1`, then read in a separate SELECT;
- a catch-all failure path that returns `ok: true` (fail-open);
- time-bucket strings in the key; no observed APP identity-specific subject/action dimensions or bounded cleanup in the reviewed excerpts.

This is not sufficient evidence for APP identity protection. The old table may be reusable only after live schema/caller inspection and a new, explicit contract. The old fail-open helper must not be reused for identity discovery, challenge issuance, failed proof, nonce consumption, binding attempts or share-code rotation.

### Required identity limiter model

- Server-derived pseudonymous subject dimensions: network/IP, device, administrator and action; never trust client-supplied bucket names.
- Explicit fixed/sliding-window or token-bucket semantics, with stable window start/end and retention.
- Atomic decision and increment in one conditional database statement/transaction. A separate increment followed by SELECT can race at the threshold.
- A candidate single-statement shape is conditional UPSERT with a limit predicate and verified `RETURNING`; this is only a design candidate until target D1 runtime behavior is tested.
- Deterministic `Retry-After`, bounded cleanup, safe handling of clock changes, and privacy-safe metrics.
- Fail closed for identity security actions if the durable limiter is unavailable; distinguish operational outage from user quota rejection.
- Test competing requests from separate Worker requests/isolates to prove no more than the configured allowance is admitted.

No real D1 rate-limit schema or concurrency evidence was available in this batch.

## 7. Risk register and required next evidence

| Risk | Severity | Current disposition |
|---|---|---|
| Binding creation audit can be missing or duplicated if written outside an idempotent atomic unit | High | Conditional audit statement + unique event key proposed; D1 test pending |
| Nonce cleanup too early can reopen replay window | Critical | Retention matrix and skew-change safeguard documented; protocol constants and D1 test pending |
| Legacy share-code migration can break old routes or turn discovery into authentication | Critical | Preserve legacy contract; route inventory and approved migration strategy required |
| Existing rate_limits helper fails open and is not APP identity scoped | Critical | Do not reuse for identity; durable atomic limiter required |
| D1 result metadata/batch rollback/concurrent winner behavior unverified | High | Requires approved isolated D1 and separate-request tests |
| Table/column names in APP v2 contracts are not verified against live schema | Critical | No migration or adapter implementation until schema evidence exists |

Required before any D1 implementation:
- explicitly identified dedicated non-production D1 database ID and binding, independently confirmed as isolated;
- user's explicit approval for read-only inspection and separate disposable writes;
- schema and migration-ledger snapshot;
- D1 verification of all eight methods, audit uniqueness/rollback, nonce boundary/cleanup, batch winner selection, timeout retry and durable limiter races;
- redacted evidence tied to exact Worker/runtime version.

## 8. Batch outcome

- Static review completed for all eight methods.
- Binding creation audit idempotency design added as a proposed third batch statement.
- Nonce time-boundary matrix completed; skew changes identified as a replay-retention hazard.
- Legacy share-code route/schema compatibility reviewed against original Worker source.
- Durable rate-limit gap confirmed from visible source; no assumption that the old table is adequate.
- No executable tests were added in this batch; this is a static design review.
- No D1 connection, SQL execution, migration, Worker/HTML/APK/Room/Secret change, Cloudflare configuration change or deployment occurred.

Status: `D1_NOT_TESTED` / `APP_PENDING` / `NOT_DEPLOYABLE`.

## 9. Next batch handoff — Batch 72

**APP v2 D1 audit/idempotency contract and rate-limit protocol freeze review (design-only; no D1).**

1. Re-read AGENTS, functional/API/database protection baselines, continuity plan, progress and Batch 68–71 reports.
2. Turn the proposed binding audit event into a complete event schema contract: event keys, actor/owner/target, immutable payload, retention, duplicate and timeout behavior.
3. Define idempotent audit contracts for binding revoke and share-code rotation without changing the unconfirmed rotation policy.
4. Freeze a candidate identity rate-limit algorithm (dimensions, windows, limits as configurable policy, atomic decision, Retry-After, cleanup and fail-closed behavior); do not invent final numeric limits.
5. Recheck nonce protocol versioning, timestamp precision and skew-change behavior against the APP signature contract; do not claim Android compatibility.
6. Keep legacy share-code route migration as a staged compatibility plan; no route or schema changes.
7. No D1 connection, SQL, migration, Worker/HTML/APK/Room/Secrets changes or deployment.
8. Update progress, continuity plan and the Batch 73 handoff.
