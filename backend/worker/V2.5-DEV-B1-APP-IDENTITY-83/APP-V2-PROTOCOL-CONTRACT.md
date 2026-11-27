# APP v2 protocol contract gap closure — Batch 83

- Batch: `V2.5-DEV-B1-APP-IDENTITY-83`
- Date: 2026-11-28
- Status: `PROTOCOL_CONTRACT_DESIGN_COMPLETE / 6_00_48_SOURCE_UNAVAILABLE / OFFLINE_TOKENIZER_TESTS_PENDING / D1_NOT_TESTED / APP_NOT_INTEGRATED / NOT_DEPLOYABLE`
- Scope: protocol and compatibility design only. No executable production SQL, D1, Worker, APK, Room, Secrets or deployment changes.

## 1. Evidence boundary and compatibility verdict

The only fully inspectable source archive currently available in Library is `StarJump-6.00.47-source.zip` (SHA-256 recorded in Batch 82). The repository contains a 6.00.48 ZIP entry, but the GitHub text/file search interface does not expose ZIP bytes and Library inventory contains no 6.00.48 archive. Therefore:

- Batch 82 source findings apply only to that exact 6.00.47 archive.
- 6.00.48 and the installed APK remain **not source-verified**.
- No protocol compatibility claim can be made for either version until exact archive bytes, SHA-256, ZIP integrity, manifest/version metadata and caller scan are available.
- No APK runtime instrumentation or packet capture was performed.

For 6.00.47, Batch 82 found no StarJump identity/card/catalog caller, no device-key proof/token persistence, and no dedicated identity deep-link callback. The app's current built-in feed/local reserved groups are not equivalent to server-authorized composed catalog.

## 2. Product rules mapped to client capability

| Requirement | Product rule | 6.00.47 evidence | Contract disposition |
|---|---|---|---|
| Multiple administrators | One APP user may bind multiple VIP administrators; one binding per same admin | No identity binding caller/storage found | New server-authoritative binding set; client must represent multiple independent admin scopes |
| Admin identity ID | Identity ID resolves that admin's free group only | No discovery/bind caller found | Discovery is not authorization; explicit challenge-bound binding required |
| Multiple cards, same admin | Each valid card contributes its configured card groups | No card activation/entitlement caller found | Each credential is independently resolved; never select only latest entitlement |
| Free group dedupe | Same admin free group appears once even when several cards are active | Not implemented/evidenced | Deduplicate by stable admin + free-group identity, not by display name |
| Different admins' free groups | Each admin's free group remains independent | Not implemented/evidenced | Scope by admin identity; no cross-admin dedupe |
| Same-name card groups | Keep each card's group separately; append that card's serial number to display name | Not implemented/evidenced | Preserve source group identity; display suffix is presentation, not authorization key |
| Empty-group card | Activation is allowed even if card currently maps to no groups | Not implemented/evidenced | Activation outcome independent from catalog item count |
| Group updates | Updates synchronize to active clients | No catalog generation/ack caller found | Monotonic generation + tombstone + acknowledgement protocol |
| 24-hour local cleanup | Deleted/retyped APP groups have local nodes cleared within 24h | No tombstone/ack client path found | Server lease hard cap remains 23h; client cleanup must be idempotent and acknowledge generation |
| Device cap | Default one device/card; valid VIP admin may configure up to five; above five requires super-admin authority | No device slot logic found | Server enforces; client display is advisory only |
| APP identity link | Dedicated StarJump challenge callback; generic subscription import links are not identity | Existing deep links are generic import routes | Add verified HTTPS App Link + challenge handle; do not repurpose import schemes |

No rule above is evidence of implementation in the inspected APK.

## 3. Five protocol domains

All endpoints below are **logical contract names**, not registered routes. Final paths, HTTP methods, field names, error codes and token format remain subject to API review. Every request is HTTPS. Owner/admin identity is resolved server-side; never trust client-supplied owner IDs, role, VIP state, card status or device count.

### D1 — Discovery and binding

Purpose: discover a public administrator identity and establish a device-bound relationship only after proof of control.

Logical operations:
1. `identity.discover`: accepts normalized public identity ID; returns only non-secret display metadata and whether binding can be initiated. It must not return nodes or grants.
2. `binding.challenge.create`: authenticated APP session + verified device public-key thumbprint + resolved admin + current share-code version; creates short-lived one-time challenge.
3. `binding.challenge.resolve`: consumes challenge exactly once, verifies proof-of-possession and current owner/admin/code version, then returns `created` or `existing`.
4. `binding.list` / `binding.revoke`: owner-scoped list/revoke; revocation uses expected generation CAS and never silently reactivates a revoked binding.

Invariants:
- One active binding per (APP user, admin, device key identity) according to the eventual approved cardinality rule; same administrator must not create duplicate logical binding rows.
- A public identity ID is discovery material, never authentication.
- Existing binding is not a new `binding.created`; original created_by/time/generation remain unchanged.
- Challenge, proof and binding must be bound to the same admin, device key, share-code version and server time window.
- U80-01..04 and U80-07..08 remain blockers for audit/event payload semantics. No default audit actor/reason mapping is invented here.

### D2 — Card activation and entitlement

Purpose: activate each card independently and expose an opaque credential reference to the APP.

Logical operations:
- `card.activate`: card secret submitted only in HTTPS request body; server validates status, expiry, owner VIP policy, device capacity and atomic activation rules.
- `entitlement.list`: returns all active credential references for the authenticated APP user, grouped by owner admin; never collapses to latest-only.
- `entitlement.deactivate`: only if product policy and device-release rules are explicitly frozen; not enabled by this design.

Invariants:
- Card activation may succeed with zero catalog groups.
- Same user may hold multiple valid cards from one admin and cards from multiple admins.
- Each card's entitlement remains separately attributable; no card serial or raw card secret is exposed to unrelated users.
- Device cap is checked server-side per exact product rule: default one; VIP admin configurable up to five; >5 requires super-admin authority. This does not define device release timing.
- Admin VIP expiry grace/restore rules must preserve the distinct inactive reason. Never reactivate manually revoked/blocked/expired cards by generic owner restoration.
- U80-05/06 block assumptions about share-code rotation effects on existing bindings, sessions, pending challenges and free grants.

### D3 — Entitlement status

Purpose: provide current status and revocation/generation state for every credential.

Logical operation: `entitlement.status` for explicit credential references in the authenticated user's scope.

Required response concepts:
- credential reference (opaque);
- owner admin reference (opaque/display-safe);
- status and reason class;
- expiry/server time;
- device slot state and configured cap;
- entitlement generation;
- next refresh hint.

Invariants:
- Never select a single latest entitlement as a proxy for all credentials.
- A status response is not a catalog authorization token by itself.
- Status and catalog requests must revalidate current server entitlement; stale client cache is not authority.
- Responses must not disclose raw card code, share code, token, digest, nonce, private key, device proof or subscription URL.
- A stale generation must cause a refresh/rejection, not silently keep revoked grants.

### D4 — Composed catalog

Purpose: compose all authorized groups without merging unrelated cards or administrators.

Logical operation: `catalog.resolve` using the authenticated APP session and explicit active entitlement references; server derives actual grants.

Composition rules:
1. Resolve each valid card independently and retain its card-group provenance.
2. For multiple cards owned by the same admin, include that admin's enabled free group once.
3. Different admins' free groups remain separate even if names match.
4. Card groups with the same display name remain separate; display name appends the source card serial number, e.g. `香港节点（序列号…）`. The serial is a display discriminator only; never use it as a secret or authorization key.
5. Empty card group sets do not invalidate card activation or unrelated grants.
6. Group identity is a stable opaque server ID plus owner/source credential provenance; display name is never a unique key.
7. A card removal/revocation removes only that card's grants; another card from the same admin remains effective.
8. Admin free-group disable/delete affects only that admin free grant; it does not erase a card's independently configured groups.

Response must include catalog generation, per-group source kind, owner scope, source credential reference (opaque), group generation, and tombstone state. It must not return a credential's raw secret.

### D5 — Group generation, tombstone and acknowledgement

Purpose: guarantee local cleanup of deleted or retyped APP groups.

Logical operations:
- `catalog.delta`: returns changes after a client generation, including upserts and tombstones.
- `catalog.ack`: records client acknowledgement for exact device + catalog generation + applied tombstone IDs.
- Optional `catalog.snapshot`: full authoritative reconciliation when generation history is unavailable.

Invariants:
- Server generation is monotonic within its declared scope; no client-generated generation.
- Deletion or type change creates a tombstone; do not physically erase the only evidence before acknowledgement/retention policy permits it.
- Client applies changes idempotently; tombstone deletes local nodes for the exact group identity, not same-name groups owned by other cards/admins.
- Client acknowledges only after local transaction commits.
- Server lease is capped at 23 hours (below the user's 24-hour cleanup requirement); offline client must clear expired authorization/local nodes rather than extend its own lease.
- Reinstall/restore or missing local generation requires a full snapshot and fresh device binding as appropriate.
- Cleanup acknowledgement is evidence of client application, not proof that every other device has applied it. Track per-device state.
- No device slot release timing or automatic expiry release behavior is defined in this batch.

## 4. Android device-key lifecycle and backup compatibility

Batch 82 found `android:allowBackup=true` and backup rules include profile/config databases. No device-bound identity credential exists in the inspected 6.00.47 source.

Proposed client design (not APK code):
1. Generate an asymmetric key pair in Android Keystore; private key non-exportable. Server stores only public key/thumbprint and binding metadata.
2. Use key attestation only if supported and separately verified; do not make attestation a hidden mandatory dependency without product decision and compatibility testing.
3. Bind proof to a fresh server challenge, HTTP method/path, body digest, challenge ID, server nonce, expiry and device key thumbprint. Freeze canonical signing format and algorithm in a separate crypto review before implementation.
4. Do not put card codes, share codes, bearer tokens, private keys or reusable proofs in deep-link query parameters, logs, clipboard, backup or ordinary Room/DataStore rows.
5. Exclude all reusable auth/session/device credential material from cloud backup and device transfer. Keystore private keys are not migrated; restore must be treated as a new device requiring fresh proof and server-side slot decision.
6. Handle uninstall, clear-data, key invalidation, OS restore, app data migration and device replacement as explicit lifecycle cases. Do not auto-free a server slot solely because local key disappeared.
7. If key is invalidated, fail closed and guide user through authorized rebind; preserve audit and device-cap policy.

### Deep-link callback

- Prefer verified HTTPS Android App Links with domain association.
- Callback carries only an opaque, short-lived, one-time challenge handle and non-secret state; no card/share secret.
- APP fetches challenge details over HTTPS and signs proof with Keystore key.
- Validate state, challenge expiry, one-time consumption, expected package/app link association and server-side binding before displaying success.
- Existing `sn://subscription` and `clash://install-config` imports remain unchanged and are never treated as identity callback.
- If verified App Links cannot be configured, do not silently fall back to trusting an arbitrary custom scheme.

## 5. Statement-manifest separation and tokenizer contract

Batch 82 determined the Batch 81 JSON is method-level only. Future executable adapter preparation requires three disjoint manifests:

| Interface | Owns | Must not contain |
|---|---|---|
| Identity adapter | challenge, nonce, binding, share-code, receipt and audit statements | limiter admission/cleanup or test-ledger cleanup |
| Limiter adapter | dimension registry/aliases, event admission, union read, backfill, cleanup and coverage checks | identity binding/challenge mutation |
| Disposable harness | run ledger, synthetic fixtures, before/after counts, exact run-scoped cleanup | production identity or limiter APIs |

Every statement record must include:
- stable statement_id and interface/method;
- exact SQL text and SHA-256 (only after approved schema/SQL design);
- tokenizer version and ordered placeholder ordinal;
- semantic bind name, trusted source, storage class, nullable/missing policy, sensitivity class;
- statement result index, expected row cardinality, changes/RETURNING expectations;
- receipt/audit/final assertion dependency;
- D1 case IDs and evidence vector.

Tokenizer v1 lexical contract:
- Recognize placeholders only outside single/double/backtick/bracket quoted spans and comments.
- Honor doubled quote escapes (`''`, `""`, ```, `]]`).
- Ignore `--` line comments and `/* ... */` block comments.
- Accept anonymous positional `?` only.
- Reject `?NNN`, `:name`, `@name`, `$name`, unterminated quote/comment, and any ambiguous tokenization.
- Require one bind value per recognized placeholder in textual order; reject undefined before driver invocation.
- Regex-only question-mark counting is prohibited.
- This batch adds only a local lexical reference checker and tests; it does not validate D1 SQL dialect/runtime behavior.

## 6. HMAC dimension consistency proof — candidate, not production freeze

Problem: K1 and K2 fingerprints for the same raw dimension differ. A key-version fingerprint cannot be part of the immutable logical event tuple as though it were equal across key versions.

Candidate model for further proof:
- Canonical event row stores immutable event fields plus an opaque `dimension_id` (logical identity), not a version-specific HMAC fingerprint.
- A separate alias registry maps `(key_version, dimension_type, fingerprint)` to the same opaque `dimension_id`.
- During overlap, the server derives aliases for every still-accepted key version before admission. If a K1 alias resolves an existing dimension_id, the K2 alias is attached to that same ID atomically; this bridges old-only history.
- A new dimension receives a random opaque dimension_id and all required current aliases in one proven atomic unit.
- Fingerprint lookup must not disclose raw identifiers; fingerprints and aliases are sensitive pseudonymous data with restricted access and retention.
- A missing alias, conflicting alias-to-dimension mapping, event_id tuple conflict, partial backfill or unknown commit outcome fails closed.
- Backfill requires immutable high-water checkpoint plus catch-up for events admitted after snapshot; key retirement waits for complete coverage and closure of window, retry, cleanup and rollback horizons.
- Query counts distinct event_id over the union of all accepted key aliases. Never sum buckets or take max bucket count.

Unresolved proof obligations:
1. Does the alias registry guarantee one logical dimension_id for every accepted key version under concurrent first-seen requests?
2. How are two independently created dimension_id values reconciled if K1 and K2 first-seen requests race before either alias is visible?
3. What exact uniqueness constraints and atomic insert/resolve ordering prevent split identity?
4. How are HMAC collisions, corrupted alias rows and key compromise handled?
5. What is the bounded lookup/write amplification and query plan under overlap?
6. How does rollback restore old-key coverage without exposing raw dimensions?
7. Which stable random dimension IDs and alias rows are retained/erased at cleanup?

Candidate A remains **not implementation-ready** until these are proven with a synthetic concurrency model, then reviewed against exact approved D1 schema in a separately authorized disposable environment. No production keys, algorithms, thresholds, retention periods, SQL or DDL are selected here.

## 7. Unresolved user decisions and stop conditions

U80-01..08 remain unresolved in the current repository evidence. This batch does not invent decisions about:
- whether existing-binding resolution emits a required audit;
- actor mapping, outcome/reason enums and nullability;
- audit payload allow-list and identifier visibility;
- share-code rotation effects on existing bindings/sessions/challenges/free grants;
- old challenge expiry/cleanup policy;
- retry timestamp/event reuse semantics;
- allowed identifiers in logs/audit.

No production adapter, route registration or client integration may proceed while its dependent decision is unresolved. APP v2 feature flag remains OFF.

## 8. Explicit non-actions

No 6.00.48 source was obtained; no APK was changed or built; no Worker/API route was registered; no D1 was connected; no SQL or migration was executed or created; no credentials or Secrets were read; no Cloudflare configuration was changed; no production deployment occurred.
