# APP v2 Identity — D1 statement and result contract (Batch 70)

- Version: `V2.5-DEV-B1-APP-IDENTITY-70`
- Date: 2026-11-27
- Status: implementation specification only; no executable migration; no D1 connection; no Worker integration; not deployable.
- Prerequisite: Batch 68 logical adapter contract and Batch 69 disposable SQLite semantics fixture.

## 1. Evidence and compatibility boundary

This document specifies the future adapter behavior, not the current production schema. The legacy Worker DDL observed in Batch 68 does not contain the identity challenge, nonce, binding, or share-code version fields required below. Do not execute these SQL fragments against any database until a separately approved non-production D1 has been identified, its schema has been captured, and a migration has been reviewed and approved.

Use `env.DB.prepare(sql).bind(...values)` for all dynamic values. Do not interpolate user-controlled values. The SQL below uses anonymous `?` placeholders; parameter order is part of each contract.

Cloudflare documentation currently describes D1 `run()` / `batch()` results as typed result objects with `success`, `meta`, and (where applicable) `results`; write operations without RETURNING normally have empty `results`. `meta.changes` is useful evidence for affected rows, but the exact runtime behavior of each RETURNING statement must be verified against the approved isolated D1 before production use. Do not infer from SQLite or mock tests.

## 2. Shared result classifier

Every adapter method must normalize database outcomes into internal domain outcomes before the HTTP layer maps them to stable non-sensitive errors.

- **DB success**: `result.success === true`; still inspect `meta.changes` / `results` as specified for the statement.
- **One row changed**: exactly one affected row for single-row state transitions. A value greater than one is an invariant violation and must fail closed.
- **Zero rows changed**: a state/precondition miss, not a database outage. Perform only the explicitly specified owner-scoped read if the method needs to distinguish already-revoked, conflict, or absence.
- **Unique constraint conflict**: classify only the expected constraint as a domain conflict. Do not treat every SQL error as a duplicate.
- **Other SQL error / timeout / missing column / schema mismatch**: fail closed; emit a redacted internal diagnostic code; never return SQL, stack, tokens, code, or digests.
- **No blind retry**: retry only when the operation is known idempotent and the retry policy says so. A timeout after a write can mean outcome-unknown; resolve using the same idempotency key or owner-scoped read before retrying.

Do not use `results.length` as a generic substitute for `meta.changes`. For a statement with RETURNING, require both the verified returned-row shape and the verified affected-row behavior; if the runtime does not provide a stable combination, use a single conditional write plus a subsequent scoped read.

## 3. Eight method statement contracts

The table names and columns below are **logical design names**, not verified production identifiers.

### 3.1 insertChallenge

Logical target: `identity_bind_challenges`.

```sql
INSERT INTO identity_bind_challenges (
  challenge_id, device_id, admin_user_id, code_version,
  device_key_thumbprint, issued_at, expires_at, status
) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending');
```

Bind order: challenge ID, device ID, server-resolved admin ID, server-resolved share-code version, verified device-key thumbprint, server issue time, server expiry.

- One successful insert / one change: `created`.
- Expected primary-key collision: `challenge_id_conflict`; never overwrite.
- Any other error: fail closed.
- A challenge must be bound to the server-resolved administrator, device and enrolled key. Client-supplied admin ID is not authoritative.
- Retry: only with the same generated challenge ID and same immutable payload; otherwise create a new challenge.

### 3.2 consumeChallengeAtomic

```sql
UPDATE identity_bind_challenges
SET status = 'consumed', consumed_at = ?
WHERE challenge_id = ?
  AND status = 'pending'
  AND expires_at > ?
  AND device_id = ?
  AND admin_user_id = ?
  AND code_version = ?
  AND device_key_thumbprint = ?;
```

Bind order: server now, challenge ID, server now, device ID, admin ID, expected code version, verified key thumbprint.

- Exactly one change: `consumed`.
- Zero changes: `not_consumable` (expired, already consumed, missing, or context mismatch); do not reveal which condition to an untrusted caller.
- More than one change: invariant failure.
- The expiry comparison is strict: `expires_at > now`; equality is expired.
- Never split the condition into read-then-write.
- Retry after an uncertain timeout must not mint a second binding blindly; resolve the challenge/binding state through the same owner/device scope.

### 3.3 consumeNonceAtomic

Logical target: `identity_request_nonces`, unique key `(binding_id, nonce)`.

```sql
INSERT INTO identity_request_nonces (
  binding_id, nonce, device_id, consumed_at, expires_at
) VALUES (?, ?, ?, ?, ?)
ON CONFLICT(binding_id, nonce) DO NOTHING;
```

Bind order: binding ID, nonce, device ID, server receive time, server-computed retention deadline.

- One change: `nonce_consumed`.
- Zero changes: `replay_or_duplicate`; reject the request.
- Do not use `INSERT OR REPLACE`, and do not update an existing nonce row on conflict.
- Before insertion, verify signature, canonical request, binding status, device-key thumbprint, timestamp window and request size. The nonce row is not a substitute for signature verification.
- A nonce is scoped to the binding; it must not be globally shared between unrelated administrators/devices.

#### Nonce retention rule — security-critical

Do **not** set nonce expiry to the request's signed timestamp, and do not delete a nonce merely because a short arbitrary TTL elapsed. If the server accepts timestamps within a symmetric skew window `[-S, +S]`, a request arriving with a timestamp near the allowed future edge can remain valid for almost `2S` after first receipt.

For a request accepted at server time `now`, set the row's retention deadline to at least:

```text
retain_until = now + 2 * MAX_CLOCK_SKEW + SAFETY_MARGIN
```

The timestamp must also be checked against server time on every request. The configured skew and margin must be constants from reviewed server configuration, not client input. If the protocol later allows longer request validity, the retention horizon must be increased accordingly. A duplicate nonce encountered before cleanup remains rejected even if its row's nominal expiry passed; cleanup is a separate bounded process.

This formula assumes the server accepts a signed timestamp only when `abs(request_timestamp - now) <= MAX_CLOCK_SKEW`. If the eventual protocol uses a different acceptance rule, recalculate and test the maximum replay-valid interval before implementation.

### 3.4 upsertBindingAtomic

Logical unique key: `UNIQUE(admin_user_id, device_id)`. Never overwrite an existing key thumbprint or revive a revoked binding.

Prepare both statements before calling `batch()`:

```sql
INSERT INTO identity_bindings (
  binding_id, admin_user_id, device_id, device_key_thumbprint,
  share_code_version, status, created_at
) VALUES (?, ?, ?, ?, ?, 'active', ?)
ON CONFLICT(admin_user_id, device_id) DO NOTHING;
```

```sql
SELECT binding_id, admin_user_id, device_id, device_key_thumbprint,
       share_code_version, status, created_at, revoked_at
FROM identity_bindings
WHERE admin_user_id = ? AND device_id = ?
LIMIT 1;
```

Execute the two prepared statements in one `env.DB.batch([insert, select])`. D1 executes the batch sequentially; the second statement reads the winner after the insert attempt. JavaScript cannot branch between statements inside the batch.

After the batch returns:
- Validate both result entries report success.
- The SELECT must return exactly zero or one row; more than one violates the unique invariant.
- No row: `binding_missing` (fail closed).
- Row status not active: `binding_revoked_or_inactive`; do not reactivate.
- Owner/device mismatch: invariant failure.
- Key thumbprint mismatch: `binding_key_conflict`; never rotate/overwrite key implicitly.
- Same owner/device/key and active: `binding_existing` (idempotent success).
- Newly inserted row and active: `binding_created`.

A competing request is serialized by the unique constraint and D1 statement execution. Both requests may complete the insert attempt, but the follow-up SELECT must return the single durable winner. Only one row may ever exist for the owner/device pair.

**Audit note:** do not claim that the batch can conditionally branch to append an audit row. If creation audit must be in the same atomic unit, add a reviewed SQL-level conditional audit statement with a unique operation/event key and test its duplicate behavior. Otherwise write the audit through a separately idempotent outbox/event contract; never create duplicate audit entries on retries.

### 3.5 revokeBindingAtomic

```sql
UPDATE identity_bindings
SET status = 'revoked', revoked_at = ?, revoke_reason = ?
WHERE binding_id = ?
  AND admin_user_id = ?
  AND status = 'active';
```

Bind order: server now, normalized reason code, binding ID, authenticated owner admin ID.

- One change: `revoked_now`.
- Zero changes: perform owner-scoped SELECT by binding ID + admin ID only.
  - Owned row already revoked: `already_revoked` (idempotent result if policy permits).
  - No owned row: `not_found_or_not_owned` (same public error).
  - Owned row in another terminal state: `state_conflict`.
- Never query by binding ID alone and then decide ownership in JavaScript.
- Never delete the binding or its audit history.

### 3.6 rotateShareCodeAtomic

This method depends on a future, separately approved share-code v2 schema. The observed legacy `admin_share_codes(code)` must remain untouched until every legacy caller and compatibility path is inventoried.

```sql
UPDATE admin_share_codes_v2
SET code_digest = ?,
    code_version = code_version + 1,
    rotated_at = ?
WHERE admin_user_id = ?
  AND active = 1
  AND code_version = ?;
```

Bind order: new server-computed digest, server now, authenticated admin ID, expected current version.

- One change: `rotated`.
- Zero changes: `cas_conflict_or_inactive`; do not retry with a newly-read version automatically, because that would silently overwrite a concurrent operator's action.
- Unique digest conflict: `digest_collision`; generate a new random code/digest, then require a new explicit rotation attempt.
- Other errors: fail closed.
- Rotation must not silently revoke existing bindings; that policy remains unconfirmed and must not be inferred from this SQL contract.
- Never log or return raw code/digest.

### 3.7 getCurrentShareCode

```sql
SELECT admin_user_id, code_version, active, rotated_at
FROM admin_share_codes_v2
WHERE admin_user_id = ?
  AND active = 1
LIMIT 1;
```

- Bind only the authenticated owner admin ID.
- Zero rows: `not_found_or_inactive`.
- Exactly one row: return only the minimum management metadata needed.
- More than one row: schema invariant failure.
- Never select `code_digest` for an APP response. If a management flow needs a one-time raw code, it must be generated and displayed once at creation/rotation, not reconstructed from a digest.

### 3.8 expireTransientRecords

Use a bounded candidate selection and bounded deletes. Exact SQL syntax/RETURNING support must be checked against the approved D1 runtime. One portable shape is a subquery with a fixed server-side batch limit:

```sql
DELETE FROM identity_bind_challenges
WHERE challenge_id IN (
  SELECT challenge_id
  FROM identity_bind_challenges
  WHERE status = 'pending' AND expires_at <= ?
  ORDER BY expires_at ASC
  LIMIT ?
);
```

```sql
DELETE FROM identity_request_nonces
WHERE binding_id || ':' || nonce IN (
  SELECT binding_id || ':' || nonce
  FROM identity_request_nonces
  WHERE expires_at <= ?
  ORDER BY expires_at ASC
  LIMIT ?
);
```

The concatenated nonce key above is illustrative only and can theoretically collide if identifiers contain the delimiter. Prefer a rowid-backed table or a stable surrogate primary key for the nonce row, then delete by that key. Do not implement the concatenation expression as written.

- Bind server now and a hard-coded/config-bounded positive batch limit.
- Repeat bounded cleanup on later scheduled runs until backlog clears.
- Delete only expired pending challenges and nonce records past their safe replay-retention horizon.
- Never delete bindings, revoked bindings, or audit records.
- Cleanup must be idempotent; record counts as internal metrics only.
- Do not run unbounded full-table deletes on a request path.

## 4. Durable rate-limit dependency

The old observed `rate_limits(bucket,count,updated_at)` shape is not presumed adequate for identity discovery, challenge issue, failed proof, nonce abuse, binding attempts and share-code rotation. Before implementation, inventory the real table and all existing callers. The identity rate-limit contract must define:
- stable server-derived subject keys (hashed/pseudonymous where appropriate);
- separate dimensions for IP/network, device, admin, and action;
- fixed/sliding window or token-bucket semantics;
- atomic increment/limit decision across concurrent requests;
- retention and bounded cleanup;
- privacy-safe metrics and stable `Retry-After` behavior.

A Worker in-memory Map is not an acceptable durable rate limiter.

## 5. Failure and retry matrix

| Operation | Safe retry | Must not retry blindly |
|---|---|---|
| challenge insert | Same challenge ID + identical immutable values; otherwise resolve existing row | New challenge after ambiguous timeout without checking previous outcome |
| challenge consume | Re-read only within owner/device scope; challenge remains single-use | Mint another binding from same consumed challenge |
| nonce insert | Re-submit same binding+nonce; duplicate remains rejection | Change nonce after ambiguous result and accept same signed request |
| binding batch | Re-run same owner/device/key insert-if-absent + winner SELECT | Change key or revive revoked row to make retry succeed |
| revoke | Repeat conditional update; then owner-scoped read | Delete row or report success for another owner |
| share-code CAS | Return conflict; operator explicitly starts a new rotation using fresh expected version | Auto-read new version and retry overwrite |
| current-code read | Safe read retry | Return digest/raw secret |
| cleanup | Repeat bounded cleanup | Unbounded delete or include binding/audit |

## 6. D1 isolated runtime acceptance gates

Before this contract can be promoted to implementation:
1. Approved dedicated non-production D1 database ID and binding name are recorded outside source control; user explicitly approves read/write testing.
2. Capture schema and migration ledger read-only before any write.
3. Verify each SQL statement against that D1, including parameter order, constraint names/behavior, RETURNING result shape and `meta.changes`.
4. Verify `batch()` result array ordering and forced failure rollback using disposable test-only rows/tables.
5. Run competing requests through separate Worker requests/isolates for challenge consume, nonce insert, binding creation and share-code CAS.
6. Verify timeout-after-write resolution and duplicate retry semantics.
7. Verify bounded cleanup never deletes binding/audit rows and nonce cleanup horizon prevents still-valid replay.
8. Verify durable rate-limit concurrency behavior.
9. Save redacted evidence, schema snapshot, database identifier fingerprint and exact Worker/runtime version; never commit credentials or real user data.

## 7. Explicit non-claims

This contract does not prove:
- the real D1 schema or binding name;
- that the illustrative new table/column names exist;
- that current production supports the SQL fragments without adjustment;
- D1 RETURNING / metadata behavior for these exact statements;
- multi-isolate concurrency or rate limiting;
- Android Keystore, canonical signing or APK 6.00.48 compatibility;
- Worker route integration or production readiness.
