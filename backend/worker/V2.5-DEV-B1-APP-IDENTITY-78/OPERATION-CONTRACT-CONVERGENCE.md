# APP v2 Identity — operation contract convergence and canonical envelope (Batch 78)

- Version: `V2.5-DEV-B1-APP-IDENTITY-78`
- Date: 2026-11-27
- Status: proposed logical contract + offline counterexample tests; `D1_NOT_TESTED / APP_PENDING / NOT_DEPLOYABLE`.

## 1. Scope

Resolves the Batch 74/75/77 logical mismatch for new versus pre-existing binding resolution, defines owner-scoped operation/audit key uniqueness, versioned canonical encoding, prepared binding order and limiter overlap evidence. No Worker handler or D1 SQL is implemented. No D1 connection, credential access, SQL execution, migration, Worker/HTML/APK/Room/Secret/config change or deployment occurred.

## 2. Binding create operation: two explicit outcomes

### `created`
- This operation inserted the binding row.
- Exactly one `binding.created` audit event is required.
- Event key: owner-scoped `app.identity.binding.created:<binding_id>`.
- Event envelope identifies operation ID, owner, target binding, key thumbprint, generation and canonical payload.
- Receipt stores `result_kind=created` and the created-event key.

### `existing`
- An identical active binding existed before this operation; it was not created by this operation.
- Never emit `binding.created`; never alter `created_by` or generation.
- Challenge consumption is still a state transition, so record a distinct `binding.existing_resolved` audit event. This records resolution, not creation.
- Event key: owner-scoped `app.identity.binding.existing_resolved:<operation_id>`.
- Receipt stores `result_kind=existing` and this resolution-event key.
- A different key thumbprint, revoked binding, owner mismatch or conflicting device binding is a conflict; never reactivate, replace or silently rebind.

Both successful outcomes require an exact owner-scoped receipt and matching audit envelope. This is a recommended future contract, not a deployed behavior change.

## 3. Receipt and audit uniqueness

- Operation logical unique key: `(owner_id, operation_id)`.
- Every read, assertion and conflict resolution uses authenticated owner + operation ID.
- Same owner + same operation type + same canonical request fingerprint replays original result; changed type/fingerprint is integrity conflict.
- Another owner's same operation ID is independent and unobservable through the caller's lookup.
- Audit logical unique key: `(owner_id, event_key)`.
- Replay requires exact match of canonicalization version, event type, actor, owner, target, operation ID, outcome, reason and canonical payload digest/bytes. Any mismatch is integrity conflict.
- Keys use fixed operation namespaces and opaque server-generated IDs; caller-supplied owner/target is never trusted.

## 4. Canonical payload encoding v1

Delimiter concatenation is prohibited. The reference fixture defines deterministic typed length-prefix encoding:
- version marker is part of the bytes; field order is explicit and frozen;
- field names and values are UTF-8 with 32-bit big-endian byte lengths;
- distinct tags for missing, NULL, string, integer and boolean;
- integers use canonical base-10 ASCII, no leading plus/zeros (zero is `0`);
- strings and field names normalize to Unicode NFC before UTF-8 encoding;
- empty string is a string tag with zero payload, distinct from NULL and missing;
- booleans are `true`/`false`, distinct from integer 1/0;
- floats, arrays, objects and undefined are rejected unless a future version defines them;
- SHA-256 is computed server-side after validation; store `canonicalization_version=1` with the fingerprint.

Changing field order, normalization, tags or integer grammar requires a new version. This is an application-level proposal, not a D1 feature.

## 5. NULL / empty / absent / undefined

- Missing: explicit missing tag in the reference encoding; required DB fields reject before SQL.
- SQL NULL: explicit NULL tag and intentional `bind(null)`.
- Empty text: string tag + zero bytes.
- JavaScript `undefined`: reject before prepare/bind; never coerce to NULL or empty text.
- Optional SQL predicates use one of two reviewed statement shapes: `column IS NULL`, or `column = ?` with non-NULL value. Never expect `column = NULL` to match.

## 6. Prepared binding manifest

For each statement record immutable SQL text/hash; placeholder ordinal; semantic name; source (authenticated server context / validated request / constant); expected storage class; nullable flag; missing-value policy; sensitive-data class. Static checks count positional placeholders outside strings/comments, reject named placeholders, require ordinals exactly 1..N, exact bind count and no undefined values. Adversarial `?`, quotes and comment markers inside literals must not alter count. This local checker does not prove D1 prepared-binding behavior.

## 7. Final assertions

- Create-created: challenge consumed by this operation; exact active binding ID/owner/device/thumbprint/generation/created_by; exact `binding.created` event.
- Create-existing: challenge consumed by this operation; exact active pre-existing binding; unchanged created_by/generation; exact `binding.existing_resolved` event; no `binding.created` for this operation.
- Revoke: owner + binding ID + active + expected generation CAS; exact revoked state and generation old+1; exact event with operation ID and old/new generation.
- Rotation: owner + code record ID + active + expected version CAS; exact version old+1; exact event with operation ID and old/new version.
- Zero-row mutation, stale CAS, duplicate receipt conflict or missing/mismatched audit must not produce a successful receipt. Receipt is the final mutating statement in the same verified atomic batch.
- No policy is selected for rotation effects on existing bindings, sessions, challenges or free grants.

## 8. Limiter key overlap and cleanup evidence

Future HMAC bucket rotation uses versioned bucket identities. During overlap, each request checks every accepted key version; new key becomes write-primary only after dual-read coverage; admission must preserve one logical counter across versions in one atomic decision (for example, dual-write). Old key retirement waits until the longest configured window + retention + retry/idempotency horizon has elapsed since last old-key write, plus approved skew margin. No key, duration, threshold or retention number is selected.

Cleanup race tests must prove cleanup never deletes an event still inside any applicable active window or needed for duplicate event_id resolution; use trusted server time and strict retention boundary; prevent concurrent cleanup from causing admission undercount through a single atomic decision or proven serialized design. Audit and operation receipts are never limiter cleanup targets.

## 9. Validation status

Offline tests cover only the Python reference encoding, result contract, owner scoping, placeholder checker and HMAC overlap model. They do not prove SQLite DDL, D1 syntax, D1 batch rollback, Worker concurrency, APP behavior or production schema.

`CONTRACT_CONVERGENCE_DESIGN_COMPLETE / OFFLINE_TESTS_PENDING / D1_NOT_TESTED / APP_PENDING / NOT_DEPLOYABLE`.
