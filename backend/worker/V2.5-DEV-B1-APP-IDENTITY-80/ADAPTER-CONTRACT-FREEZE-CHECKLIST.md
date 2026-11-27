# APP v2 Identity — adapter contract freeze checklist（Batch 80）

- Version: `V2.5-DEV-B1-APP-IDENTITY-80`
- Date: 2026-11-27
- Status: `PRE_IMPLEMENTATION_REVIEW / BUSINESS_FREEZE_BLOCKED / D1_NOT_TESTED / NOT_DEPLOYABLE`
- Purpose: separate user-confirmed product rules, proposed technical contracts, unresolved business decisions and runtime proof requirements before any adapter implementation.

## 1. Decision labels

- **CONFIRMED_PRODUCT_RULE**：用户明确确认的产品/权限规则，可作为实现输入。
- **PROPOSED_TECHNICAL_CONTRACT**：技术方案已经形成，但未因此自动成为用户批准的业务语义。
- **USER_DECISION_REQUIRED**：会改变用户可见行为、授权范围、历史状态或兼容性的事项；未确认不得编码为硬规则。
- **RUNTIME_EVIDENCE_REQUIRED**：可先设计，但必须由获批 disposable D1 / Worker / APP 环境实测。
- **NOT_IN_SCOPE**：本批不决定、不实现。

## 2. Confirmed product rules relevant to this adapter

| Item | Status | Confirmed boundary |
|---|---|---|
| APP user can bind multiple VIP administrators | CONFIRMED_PRODUCT_RULE | One APP user may have multiple administrator relationships; each administrator's authorization remains isolated |
| Same administrator binding uniqueness | CONFIRMED_PRODUCT_RULE | One APP user retains only one relationship for the same administrator; do not merge different administrators |
| Administrator identity ID | CONFIRMED_PRODUCT_RULE | Identity ID grants only that administrator's free groups; it is discovery/binding input, not proof that a caller may read node data |
| APP card credential | CONFIRMED_PRODUCT_RULE | A card grants the card's configured groups plus the eligible free group for its administrator |
| Multi-card composition | CONFIRMED_PRODUCT_RULE | Multiple valid cards of the same administrator may contribute their configured card groups; that administrator's free group appears only once |
| Same-name card groups | CONFIRMED_PRODUCT_RULE | Do not merge distinct card groups; distinguish them with the corresponding card serial marker |
| Cross-administrator isolation | CONFIRMED_PRODUCT_RULE | Free/card grants from different administrators remain separate |
| APP device default | CONFIRMED_PRODUCT_RULE | One device by default per APP card; effective VIP administrator can adjust, maximum five; above five requires super-admin authority |
| APP-specific sharing | CONFIRMED_PRODUCT_RULE | APP free/card groups must use dedicated APP integration sharing, not ordinary web links |

These rules constrain the product layer. They do **not** by themselves define SQL table names, event actor values, reason codes, canonical payload byte fields, receipt schema, or D1 transaction behavior.

## 3. Technical proposals — not yet production-frozen

| Item | Current proposal | Freeze condition |
|---|---|---|
| Operation receipt uniqueness | `(owner_id, operation_id)` | Verify exact owner context derivation and disposable D1 unique/read isolation |
| Audit uniqueness | `(owner_id, event_key)` | Verify event-key scope and exact replay equality |
| Binding created outcome | New row inserted by this operation; exact `binding.created` | D1 batch/constraint proof and final predicate proof |
| Binding existing outcome | Pre-existing identical active binding; preserve identity fields; separate resolution event | User/policy decision whether every successful existing-resolution must be audited; then D1 proof |
| Revoke | Owner + binding + active + expected generation CAS; generation old+1 | D1 one-winner concurrency and receipt/audit atomicity |
| Share-code rotation | Owner + code record + active + expected version CAS; version old+1 | Rotation side effects require user decision; D1 CAS proof |
| Canonicalization v1 | Typed length-prefix, NFC, strict type set, SHA-256 | Freeze per-operation field order and verify cross-runtime vectors |
| Prepared bind manifest | Exact SQL SHA-256, statement ID, ordinal and bind type/source metadata | Linter + real D1 prepare/bind probes |
| Audit envelope | Batch 72 field set as candidate immutable envelope | Freeze actor/reason/payload/timestamp/identifier policy |
| Limiter overlap | Union logical events by immutable event_id across active key versions | D1 dedupe/atomicity/index-cost and concurrency proof |

## 4. User decisions required before adapter code

| ID | Decision | Why it changes behavior | Safe default until confirmed |
|---|---|---|---|
| U80-01 | For `create-existing`, is `binding.existing_resolved` mandatory for every successful challenge resolution, or only security-relevant resolutions? | Determines audit volume, event-key policy and whether a successful resolution can fail when audit is unavailable | Do not implement the existing-resolution write path as production policy |
| U80-02 | Actor mapping per route: APP end user, authenticated administrator, super-admin, or trusted service actor? | Actor identity is a security/audit fact and cannot be inferred from the operation name | Derive actor only from authenticated server context; leave event mapping unresolved |
| U80-03 | Exact per-operation `outcome` and `reason_code` enums; is reason_code nullable for any event? | Affects API error taxonomy, audit schema, replay comparison and dashboards | No generic placeholder reason; do not freeze guessed enums |
| U80-04 | Per-event payload allow-list and which opaque target IDs may be retained in audit | Controls privacy, traceability and audit exact-match | Exclude raw secrets and device proofs; do not add unreviewed payload fields |
| U80-05 | On share-code rotation, what happens to existing APP bindings, sessions, pending challenges and free-group grants? | Could disconnect existing APP users or preserve previously issued access | No implicit revoke, preserve, rebind or forced reactivation behavior |
| U80-06 | Should rotation invalidate all pending challenges from older code versions, or only reject them at challenge consumption? | Changes in-flight pairing UX and cleanup semantics | Reject stale code_version at consume; do not add broad destructive cleanup |
| U80-07 | Audit timestamp/event identity on exact retry: reuse original immutable event envelope or generate a new resolution event per new operation? | Determines idempotency and forensic interpretation | Exact same operation reuses exact event; no new event on retry |
| U80-08 | Which actor/owner/target identifiers may appear as opaque IDs in audit and operational logs? | Even opaque IDs can be linkable personal data | Keep logs redacted; do not broaden audit payload without approval |

The above list is intentionally not a form/request for immediate answers. The project can continue with schema-independent verification design. These decisions must be resolved before production adapter behavior is frozen.

## 5. Canonical request fingerprint field review

The request fingerprint is not the audit event envelope. Proposed field inventory:

| Operation | Candidate ordered fields | Server-derived vs request input | Status |
|---|---|---|---|
| create | canonicalization_version, operation_type, actor_type, actor_id, owner_admin_id, target_type, target_id, challenge_id, device_key_thumbprint, result_class | Actor/owner/target/challenge resolution from trusted server state; thumbprint is verified proof output; operation ID is request idempotency input | PROPOSED; exact order and actor mapping blocked |
| existing resolution | same identity fields + existing binding ID + resolution class | Binding ID and immutable fields loaded under owner scope | PROPOSED; audit mandatory policy U80-01 |
| revoke | common identity fields + binding_id + expected_generation | Owner/actor from auth context; expected generation from trusted read or validated precondition | PROPOSED; reason/outcome blocked |
| rotation | common identity fields + code_record_id + expected_version | Owner/actor from auth context; code record/version server resolved | PROPOSED; side effects U80-05/06 |

Rules retained from Batch 78:
- distinguish missing, SQL NULL, empty string, integer and boolean;
- reject float, arbitrary object/array and undefined;
- NFC-normalize strings and use typed length-prefix encoding;
- exact field order is part of the versioned contract;
- raw share code, digest, token, nonce, private key, device proof and subscription URL never enter the fingerprint or audit payload;
- changing field order/encoding requires a new canonicalization version.

## 6. Audit envelope freeze checklist

Candidate envelope fields: `event_id,event_key,event_type,schema_version,occurred_at,actor_type,actor_id,owner_admin_id,target_type,target_id,operation_id,outcome,reason_code,payload,correlation_id`.

Before implementation, each event type must define:
- actor mapping from authenticated server context;
- owner mapping, distinct from actor;
- target type and whether target ID is permitted;
- exact outcome enum;
- exact reason enum and nullability;
- payload allow-list and canonical payload digest/bytes;
- event timestamp behavior under retries;
- schema_version (separate from canonicalization_version);
- owner-scoped event key and exact replay equality.

No value is invented by this checklist. The Batch 72 envelope is a candidate schema, not user-approved production semantics.

## 7. APP/legacy compatibility boundary

- Existing legacy routes remain unchanged during the adapter design phase.
- APP v2 read handler currently exists as isolated injected-dependency code under `APP-PROTOCOL-64`; it is not proof of production route registration or APP client support.
- Legacy Worker route references found in the repository include `/api/app/resolve`, `/api/app/groups`, `/api/app/free`, `/api/app/links`, `/api/app/redeem`, `/api/app/status`, `/api/app/nodes`, `/api/user/share-code`, and super-admin share-code management.
- APP APK ZIP could not be source-audited in this batch; caller inventory is therefore incomplete. No legacy route or schema may be removed/renamed based on the current evidence.

## 8. Implementation entry gate

Adapter implementation may begin only after:
1. User decision blockers U80-01..08 are resolved or explicitly scoped out with safe behavior.
2. Existing actual deployment baseline and relevant schema are independently identified; repository source is not treated as live deployment proof.
3. A dedicated disposable D1, exact database ID, Worker/service and binding are user-confirmed and independently matched.
4. Separate approvals exist for read-only schema inspection, disposable writes, and cleanup.
5. Schema/migration proposal, rollback, synthetic namespace and evidence ledger are reviewed.
6. D1 cases mapped in `D1-EVIDENCE-MAP.md` pass in that approved environment.
7. APP client capability/source audit confirms protocol compatibility; otherwise v2 remains feature-flagged and legacy routes stay intact.

Until then: no D1, no SQL execution, no migration, no Worker/HTML/APK/Room/Secret/config changes and no deployment.
