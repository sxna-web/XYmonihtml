# APP v2 Worker integration boundary — Batch 63

- Version: V2.5-DEV-B1-APP-PROTOCOL-63
- Date: 2026-11-27
- Status: source audit and integration matrix; 6 isolated tests; no production Worker wiring; not deployable.

## Evidence baseline

- Original Worker: `原始StarJump_V1点0_Final-zip-26-11-25-14:56/Worker.js`, blob `5da7aa3582558d9da2c2a0ad25a63c5e95e9fe63`.
- HTML 1.4.61: `星跃模拟后台 1.4.61.html`, blob `d046f71caa5af96b0c0978013771cb0a8f101739`.
- Existing read-only HTML-to-Worker mapping: `docs/audits/StarJump_V2.5_HTML1.4.61_Worker_D1功能映射_2026-11-27.md`.
- Feature baseline, API permission spec and D1 protection spec read before this audit.

## Critical integration findings

1. Legacy `/api/app/status` reads by device_id without token verification and picks latest entitlement.
2. Legacy `/api/app/nodes`, `groups`, `links` select latest active entitlement by device_id; multiple simultaneous entitlements cannot be represented correctly.
3. `/api/app/nodes` returns all enabled/approved sources owned by selected admin, not the exact card group allowlist.
4. Legacy `/api/app/groups` uses old public/assigned/free modes; no card_id -> group mapping is present in observed DDL or handler.
5. When no active entitlement exists, legacy `/api/app/groups` can return free-group node data using device_id + app_free_grants without an entitlement token.
6. Legacy `/api/app/free` returns free-tier nodes based on public admin ID/share code; it is not a bind-only discovery route.
7. Legacy `/api/app/links` reads all enabled links for the selected latest entitlement's admin.
8. Token HMAC key has a fixed fallback `starjump-app` if `SESSION_PEPPER` is missing. Must be changed to fail closed before production v2 auth.
9. `/api/user/app-cards` create and `/api/user/app-groups` mutations show no active VIP gate in their route bodies; outer router only checks a user session/general scope. Existing behavior conflicts with confirmed VIP-only mutation requirements.
10. `/api/user/app-groups` supports legacy public/assigned/free only. Card-group assignment table/API is missing.
11. Super-admin group mutations execute multiple independent statements and do not emit generation/tombstone cleanup in the inspected path.
12. Direct super-admin entitlement rebind updates device_id; it is not a slot release workflow.
13. HTML 1.4.61 is documented as a local simulation (localStorage/IndexedDB), and no APP-specific Worker calls were found by the existing mapping audit. It is not evidence of a live frontend-to-Worker integration.

## Authentication contract mismatch in existing isolated scaffold

- Batch 52 resolver expects an explicit entitlementId + deviceId + entitlement HMAC token, then verifies it against the exact DB row.
- Legacy token is HMAC-SHA256(entitlementId|deviceId), but its signing key currently has a hard-coded fallback.
- Batch 58 `app-v2-handler.mjs` currently calls a `resolveSession` dependency on the same Bearer token before invoking entitlement resolution. That treats an entitlement token as if it were a user session token and is not a valid adapter contract.
- Therefore batch 58 handler is a scaffold only and must not be wired as-is.
- Recommended v2 read request: explicit entitlement ID in path, opaque device ID in a dedicated header, entitlement token in Authorization Bearer; adapter calls exact resolver directly, not user-session resolver. Verify token using a secret-only key with no fallback. This remains a proposed protocol until 6.00.48 is audited and client support is implemented.
- Device ID is still a client-supplied identifier, not hardware attestation; the HMAC only binds the entitlement to that supplied identifier.

## Minimal integration plan (not implemented)

### Stage 0 — prerequisite freeze
- Audit 6.00.48 binary source and license/third-party constraints.
- Confirm card expiry/revoke slot release and device-unbind approver policy.
- Obtain an explicitly isolated D1 environment or approved disposable D1; never substitute production/staging.
- Verify actual D1 schema, migrations, indexes and Worker bindings read-only.

### Stage 1 — secure adapters, feature-flagged
- Build an adapter around batch 52 exact resolver; never infer "latest" entitlement.
- Build a DB adapter around batch 59 loader that returns owner-joined card mappings, enabled groups, free grant and free permission.
- Use batch 60 composition per entitlement; preserve card serial suffix rules and admin-scoped free de-duplication.
- Build slot adapter only after schema approval and real isolated D1 concurrency test.
- Add a v2 router namespace; do not change legacy response contracts in the same patch.
- Gate v2 routes with a server-side feature flag default OFF; fail closed if required secret, schema capability, or adapters are unavailable.

### Stage 2 — client contract and compatibility
- Client must persist one entitlement ID/token per card and an independent identity/free binding.
- Client sends explicit entitlement context for each read; never use one latest entitlement for all cards.
- Add Room tables and explicit non-destructive migrations; remove destructive Room fallback only after migration tests.
- Add generation/cursor/lease/tombstone/ack processing and enforce lease expiry before displaying/using cached nodes.
- Keep old routes only for a defined migration window; legacy free-node data route must be removed from new clients. Do not silently route legacy requests to the newest entitlement.

### Stage 3 — controlled cutover
- Enable v2 only for an audited client build and isolated D1.
- Verify exact entitlement, cross-admin isolation, same-admin multi-card composition, free group de-duplication, serial suffixes, slot concurrency, expiry, revocation, tombstone cleanup and offline lease expiry.
- Compare old/new response contract and preserve non-APP platform functions.
- Production deployment requires a separate explicit user approval and rollback package.

## Feature flags proposed

- `APP_V2_READS_ENABLED`: default false; gates new v2 read routes.
- `APP_V2_CARD_GROUPS_ENABLED`: default false; requires verified card-group schema and API.
- `APP_V2_DEVICE_SLOTS_ENABLED`: default false; requires approved migration and D1 concurrency test.
- `APP_V2_SYNC_ACK_ENABLED`: default false; requires client ACK support.
- Missing/invalid flag or prerequisite must keep v2 disabled, not fall back to unsafe v2 reads.

## Rollback

- New v2 namespace is additive; turn feature flags OFF and revert only the v2 router/adapter commit.
- Do not remove or rewrite legacy routes as part of the initial additive release.
- Any database migration must be separately approved and backward-compatible; rollback is not assumed to mean DROP TABLE.
- Never roll back by deleting user entitlements, device bindings or audit records.

## Test

```sh
node --test backend/worker/V2.5-DEV-B1-APP-PROTOCOL-63/integration-boundary.test.mjs
```

No Worker/HTML/D1/APK/Secrets changes, no D1 connection, no SQL, no migration and no deployment.
