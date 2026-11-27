# APP v2 Identity — SQL portability and atomic assertion static review (Batch 77)

- Version: `V2.5-DEV-B1-APP-IDENTITY-77`
- Date: 2026-11-27
- Status: static review + offline validator only; `D1_NOT_TESTED / APP_PENDING / NOT_DEPLOYABLE`.

## 1. Scope

Reviewed Batch 74 `ATOMIC-OPERATION-REDESIGN.md` and its SQLite fixture, Batch 75 `OPERATION-RECEIPT-AND-LIMITER.md` and fixture, Batch 76 admission plan/matrix/validator, repository protection rules and current feature baseline.

No D1 connection, credential read, SQL execution, migration, Worker/HTML/APK/Room/Secret/config change or deployment occurred. This is not a production schema proposal or an approved migration.

## 2. Static findings — blockers before any adapter implementation

### F77-01 — CHECK accepts NULL unless NOT NULL is also enforced

SQLite CHECK constraints reject zero/false, but a CHECK expression evaluating to NULL does not fail. The candidate must retain both:
- `audit_assert INTEGER NOT NULL`
- `CHECK (audit_assert = 1)`

The expression should be a total `CASE WHEN ... THEN 1 ELSE 0 END`, never a nullable scalar expression. Validate CHECK behavior on the exact disposable D1 runtime before relying on it.

### F77-02 — conditional INSERT-SELECT can silently insert zero rows

A required audit written with `INSERT ... SELECT ... WHERE ...` can affect zero rows without SQL error. A later JavaScript `meta.changes` check cannot roll back earlier committed statements. The receipt must be an unconditional INSERT whose CHECK-protected assertion evaluates to 0 when any required predicate is false. The receipt must be the final mutating statement in the same D1 batch. Any read-after-batch is diagnostic only, not the atomic guard.

### F77-03 — event-key conflict must be verified, not ignored

`ON CONFLICT(event_key) DO NOTHING` is not sufficient by itself. The final assertion must find exactly one row matching the full envelope: event key, event type, owner, target, operation ID, schema version, actor/subject fields where applicable, outcome, and canonical payload identity. Same key + different envelope must make the assertion false and roll back. Do not classify every unique error as an idempotent replay.

### F77-04 — payload canonicalization is not frozen

Batch 74 fixture uses delimiter concatenation; Batch 75 uses manually assembled strings. Delimiter-based concatenation is ambiguous when fields contain delimiters, Unicode normalization differences, or NULL/empty distinctions. Before implementation, freeze a versioned canonical encoding:
- fixed field order and explicit type tags;
- length-prefix or an established canonical binary/JSON encoding;
- explicit distinction among absent, NULL, empty string, integer and text;
- UTF-8 policy and Unicode normalization policy;
- canonicalization version stored with the request/audit envelope;
- cryptographic digest over canonical bytes, while retaining enough immutable fields to verify the exact operation contract.

Never trust a client-supplied hash as authorization evidence. Server computes it after validation.

### F77-05 — NULL semantics must be explicit

SQL equality with NULL yields UNKNOWN, not TRUE. That is fail-closed for a positive EXISTS predicate, but can accidentally turn optional-vs-required values into indistinguishable cases. Required receipt/audit fields should be NOT NULL. For fields where NULL is a valid state, use explicit paired predicates (e.g. `col IS NULL` when expected NULL, otherwise `col = ?`) or a proven null-safe comparison supported by the target runtime. Bind NULL intentionally; never pass JavaScript `undefined`.

### F77-06 — receipt uniqueness and owner scope need one coherent key

Batch 75 fixture declares global `operation_id PRIMARY KEY` but performs owner-scoped lookup. A cross-owner collision then appears absent to the caller but fails the global insert. That is fail-closed, but permits avoidable cross-owner collision/DoS and leaves the intended uniqueness scope unclear. Prefer a composite uniqueness contract `UNIQUE(owner_id, operation_id)` if operation IDs are owner-scoped; if globally unique, generate them server-side with sufficient entropy and document that contract. In either design, every receipt read and assertion is owner-scoped and never returns another owner's receipt.

The deterministic audit event key must have an equally explicit uniqueness scope. Include owner identity in its namespace or use a globally unique server-generated event ID plus a separately checked owner scope.

### F77-07 — existing-binding create path conflicts with mandatory audit receipt shape

Batch 74 allows returning an identical pre-existing active binding without emitting `binding.created`; its receipt audit key is nullable. Batch 75's fixture makes `audit_event_key NOT NULL` and only tests a newly created binding (the pre-existing path is explicitly outside that fixture). These contracts do not yet agree. Before implementation, choose a documented operation result type:
- `created`: requires exact `binding.created` audit;
- `existing`: either no receipt is written for this operation, or a distinct non-creation resolution event is required and audited.

Do not fabricate a `binding.created` event for a row created by another operation. Do not weaken audit requirements silently.

### F77-08 — create/revoke/rotation final assertions need operation-specific exactness

- Create: exact challenge consumed by this operation; exact active binding ID/owner/device/key thumbprint/generation/creator; and exact creation audit only for the created path.
- Revoke: exact binding owner/ID, expected old active status and generation, resulting revoked status and generation = old + 1, exact operation ID and audit payload. A zero-row CAS must not be followed by an apparently successful receipt.
- Rotation: exact owner + code-record ID + active status + expected old version, resulting new version = old + 1, and exact rotation audit including old/new version and operation ID. Effects on existing bindings/sessions/challenges/free grants remain unconfirmed and must not be invented.

Every assertion must be derived from server-validated immutable inputs, not caller-supplied owner/target values.

### F77-09 — final receipt insertion itself is a uniqueness and atomicity boundary

A duplicate operation receipt must not be treated as successful merely because the insert is ignored. Do not use `INSERT OR REPLACE`, broad `DO NOTHING`, or catch-all unique-error-to-replay conversion. On a receipt conflict, resolve in a separate owner-scoped read after the batch outcome is known; compare operation type + canonical request hash + result identity/version + audit event key. If unavailable or ambiguous, return outcome-unknown and retry with the same IDs.

## 3. SQL shape guidance — illustrative only, not runnable migration

The intended pattern is conceptually:

1. prepared conditional state mutation(s), with explicit owner/state/version predicates;
2. prepared audit append with deterministic unique event key; exact duplicate may be ignored only if final assertion independently proves the full envelope matches;
3. unconditional final receipt INSERT whose assertion is a total 0/1 expression;
4. `NOT NULL` plus `CHECK(assertion = 1)` on the assertion column.

A conceptual assertion expression is:

```sql
CASE WHEN
  EXISTS (SELECT 1 FROM synthetic_state
          WHERE owner_id = ? AND resource_id = ?
            AND state = ? AND generation = ?)
  AND EXISTS (SELECT 1 FROM synthetic_audit
              WHERE event_key = ? AND owner_id = ?
                AND event_type = ? AND target_id = ?
                AND operation_id = ? AND payload_hash = ?)
THEN 1 ELSE 0 END
```

This fragment is not a complete statement, not a production schema, and not proof of Cloudflare D1 compatibility. Each placeholder must be mapped in a reviewed positional binding table. Never interpolate values into SQL.

## 4. Prepared binding and batch ordering review

- Maintain one reviewed binding table per statement: ordinal, semantic name, SQL type, required/nullable, source (server-derived or constant), and redaction class.
- Count placeholders mechanically and compare with bind arguments.
- Bind values in exact textual placeholder order; do not reuse a binding array across different statement shapes.
- Reject `undefined` before calling `bind()`; represent optional absence explicitly.
- Keep the final assertion receipt as the last mutating statement. Any statement after it that can fail and is required for correctness invalidates the design.
- D1 batch order is sequential. Do not assume JavaScript branches or result inspection can occur between statements in one batch.
- A successful zero-row UPDATE/INSERT-SELECT is not an SQL error. Explicitly assert required effects in the final statement.

## 5. Limiter static review additions

- Multi-dimensional admission must be one database-atomic decision; do not split count-check and event insert across requests.
- Required network/device/admin/action dimensions must be server-derived and non-empty; optional dimensions need an explicit applicability marker, not ambiguous empty text.
- Shared NAT tests must report network, device and admin dimensions separately; do not infer production thresholds.
- Clock tests must use injected fixed server timestamps and test both forward/backward skew. Do not use client time as authority.
- Cleanup predicate remains strict `retain_until < trusted_now`; audit and operation receipts are never transient cleanup targets.
- Cleanup/admission race must prove that a row needed for active-window/idempotency semantics cannot be deleted.
- HMAC rotation must use a documented overlap strategy (e.g. dual lookup of active K1/K2 bucket identities) so one logical client cannot split its active window. No production key, overlap duration or retirement date is selected here.

## 6. Required disposition

The current SQLite fixtures are useful logical tests but do not validate D1 CHECK semantics, D1 batch rollback, SQL dialect/runtime details, multi-request application behavior, Worker integration or production schema. The F77 findings above must be resolved in a later implementation review and then verified against a user-approved dedicated disposable D1.

Status: `STATIC_REVIEW_COMPLETE / D1_NOT_TESTED / APP_PENDING / NOT_DEPLOYABLE`.
