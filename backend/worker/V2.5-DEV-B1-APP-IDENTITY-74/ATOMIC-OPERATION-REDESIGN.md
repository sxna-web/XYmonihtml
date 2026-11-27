# APP v2 Identity — atomic operation redesign (Batch 74)

- Version: V2.5-DEV-B1-APP-IDENTITY-74
- Date: 2026-11-27
- Status: logical contract + local SQLite fixture only; not D1-tested or deployable.

## 1. Atomic bind contract

The current Batch 67 state machine exposes challenge consumption and binding creation as separate store calls. This permits a consumed challenge to be stranded if the later binding write fails.

The revised logical operation must place these steps in one D1 batch / verified atomic unit, with no JavaScript branch or separate D1 call between them:

1. Conditional challenge consume scoped to challenge ID, authenticated owner, device, code version, device-key thumbprint, pending status and expiry.
2. Binding insert or exact existing-binding resolution scoped to owner + device. Never overwrite a different key and never reactivate a revoked binding.
3. Append binding.created only when this operation actually inserted the binding.
4. Insert a final operation receipt/commit marker with a database CHECK assertion.
5. If any required condition is absent or mismatched, the final statement must raise a SQL error so the same batch rolls back all prior writes.

## 2. Required audit assertion candidate

Cloudflare D1 batch documentation states that statements execute sequentially and a statement error aborts/rolls back the batch. A conditional write affecting zero rows is not automatically an error; checking meta.changes after batch completion cannot undo committed writes. See the official D1 batch API and result object docs.

Candidate schema shape (design only; not approved DDL):

    CREATE TABLE identity_operations (
      operation_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      request_payload_hash TEXT NOT NULL,
      result_binding_id TEXT NOT NULL,
      result_kind TEXT NOT NULL,
      audit_event_key TEXT,
      audit_assert INTEGER NOT NULL CHECK (audit_assert = 1),
      committed_at INTEGER NOT NULL
    );

The final statement is an unconditional INSERT with audit_assert calculated from scalar EXISTS checks for:
- the exact challenge consumed by this operation;
- the exact active owner/device/key binding;
- and, only when result_kind is created, the exact event key, owner, target and canonical audit payload.

If any required row is missing or mismatched, audit_assert is 0 and CHECK fails inside the batch. This is materially different from an INSERT-SELECT that simply inserts zero rows.

This is only a candidate. CHECK enforcement, scalar subqueries, prepared binding, result metadata and batch rollback must be verified in a user-approved disposable D1 before any adapter relies on it. No production table or constraint is assumed to exist.

## 3. Idempotency and conflict rules

- Same operation_id + same canonical request payload: return the committed operation receipt after owner-scoped read; do not duplicate binding/audit.
- Same operation_id + different payload: integrity conflict.
- Concurrent same operation_id: unique receipt permits one commit; loser resolves by owner-scoped receipt read and compares payload. If unresolved, outcome-unknown.
- Same event_key + same canonical payload: exact replay only after full field comparison.
- Same event_key + different payload: final CHECK fails because no exact matching audit row exists; the entire batch rolls back.
- An identical active binding that predates this operation may be returned as existing, without a second binding.created event.
- A different key or revoked binding is a conflict; never silently rebind or resurrect.
- Timeout is outcome-unknown. Reuse all original IDs and resolve owner-scoped operation receipt, binding and audit state.

## 4. Revoke and rotation

Revoke uses owner + binding ID + expected status + expected generation CAS. Only one request may increment generation. A zero-row update is conflict/no-op, not success. Required revoke audit must be asserted by the same final CHECK marker.

Share-code rotation uses owner + active status + expected version CAS. Only one transition wins. The audit assertion must match operation ID and exact old/new version.

The effect of rotation on existing bindings, sessions, challenges and free-group grants remains unconfirmed; this batch does not choose preserve/revoke/force-rebind.

## 5. Local SQLite fixture

File: test_identity_atomic_semantics.py

12 tests cover:
1. successful challenge + binding + audit;
2. binding SQL constraint failure rolls challenge back;
3. missing audit row is caught by final CHECK and rolls everything back;
4. audit SQL error rolls everything back;
5. exact operation replay;
6. same operation ID with changed payload conflict;
7. simulated response timeout after commit and retry resolution;
8. identical existing binding does not emit a second created event;
9. revoke generation CAS;
10. share-code version CAS;
11. half-open rate window and Retry-After release point;
12. same event key with different payload rolls back the second attempt.

Run:

    python -m unittest discover -s backend/worker/V2.5-DEV-B1-APP-IDENTITY-74 -p 'test_*.py' -v

The fixture is an in-memory synthetic SQLite schema. Passing it does not prove D1 compatibility, D1 multi-isolate concurrency, production schema, Android compatibility or deployed behavior.

## 6. Not performed

No D1 connection, D1 SQL, migration, Worker/HTML/APK/Room/Secret/config change, real D1 batch, multi-isolate test or deployment.

Status: local SQLite semantics only; D1_NOT_TESTED / APP_PENDING / NOT_DEPLOYABLE.

## 7. Batch 75 handoff

Extend the operation receipt + audit assertion contract to revoke and rotation. Add local tests for revoke/rotation audit missing/mismatch rollback, event key same/different payload, owner-scoped receipt reads, limiter event_id idempotency, missing dimensions, multi-dimensional Retry-After and cleanup boundaries. Still no D1 connection.
