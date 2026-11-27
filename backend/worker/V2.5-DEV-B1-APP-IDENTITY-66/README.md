# APP v2 identity discovery and binding resolver — Batch 66

- Version: `V2.5-DEV-B1-APP-IDENTITY-66`
- Date: 2026-11-27
- Status: isolated DEV design and mock tests; not wired to Worker; D1_NOT_TESTED; APP_PENDING; not deployable.

## Source audit findings (read-only original Worker)

Baseline: `原始StarJump_V1点0_Final-zip-26-11-25-14:56/Worker.js`, Blob SHA `5da7aa3582558d9da2c2a0ad25a63c5e95e9fe63`.

- `GET /api/app/resolve?code=...` publicly resolves `admin_share_codes.code` to `admin_user_id` and username, plus `admin_app_perms.free_group_enabled`. No device binding, challenge, signed credential, or rate-limit is visible in this handler.
- `GET /api/app/free?admin=...|code=...` resolves a client-supplied admin ID or share code, checks `free_group_enabled`, then directly returns free-tier node records. It is a data-read route, not merely a discovery/bind route.
- `admin_share_codes` DDL in this Worker contains `admin_user_id`, `code`, `created_at` only. No code version, active/revoked state, expiry or rotation history was found in that DDL.
- `app_free_grants` contains `device_id`, `admin_user_id`, `granted_at`; APP card redeem inserts one row. This is a device/admin free grant, not proof of a separately established identity-ID binding.
- `admin_app_perms` stores `free_group_enabled`; this route's current code checks that flag but does not visibly check the admin's current VIP status/account status.
- `/api/app/resolve` and `/api/app/free` are registered as public GET routes. The global handler first attempts session resolution, but those routes do not require a successful session before dispatch.

These are facts about the repository's original Worker snapshot only, not proof of Cloudflare's deployed Worker or current D1 schema.

## New isolated design

### 1. Public discovery

Discovery accepts a share code and rate-limit key, checks:
- code exists and is the current active version;
- admin account is active;
- admin is currently an eligible active VIP admin;
- APP free group is enabled.

It returns only a minimal display name and `freeGroupAvailable`; it does not return admin_user_id, groups, nodes, or an identity credential. Missing, revoked, disabled, expired, and ineligible codes share the same generic response.

### 2. Device proof and idempotent binding

Binding requires a one-time server challenge bound to:
- device ID;
- admin ID resolved server-side from the share code;
- share-code version;
- device public-key thumbprint.

The injected `verifyAndConsumeChallenge` must atomically verify challenge expiry, single-use state, proof signature, device key and code version. The injected `getOrCreateBinding` must enforce a unique (admin_user_id, device_id) binding and be transactionally idempotent. A repeat bind for the same admin/device returns the existing binding; another admin remains a separate binding.

The current Worker has no such challenge/binding table or device-key protocol. These adapters are contracts only; do not infer that the existing client can produce a device proof. Android Keystore key generation, challenge acquisition, request signing, key backup/restore behavior and APK compatibility remain unverified until the 6.00.48 source is audited.

### 3. Independent identity credential

`identity-token.mjs` uses a dedicated `APP_IDENTITY_SECRET` HMAC key, separate from `APP_ENTITLEMENT_SECRET` and user Session secrets. Token claims bind:
- binding ID;
- server-resolved admin user ID;
- device ID;
- issue/expiry times.

The token is not an entitlement ID and does not reuse entitlement HMAC input semantics. Maximum credential TTL is 23 hours. Every read revalidates the binding row and current admin/VIP/free-group eligibility. Revoked binding, wrong device, wrong admin, expired token, disabled free group, or database failure fails closed.

### 4. Share-code rotation/revocation semantics (proposed)

- A rotated/revoked code is rejected for new discovery/binding.
- Existing device bindings are not silently erased by code rotation alone; they remain subject to binding revocation, admin eligibility, and free-group enablement checks.
- Explicit binding revocation blocks the credential immediately on the next server validation.
- Turning off `free_group_enabled` or losing active VIP/account eligibility blocks both new binds and existing identity reads.
- This is an isolated technical proposal; the production data model and admin UI for code rotation/binding revocation require review and approval before implementation.

### 5. Free-group read and card entitlement composition

Identity credentials resolve only to `kind: IDENTITY` context. The group loader receives the admin ID from the verified binding record, never from the request. It must return enabled `mode='free'` groups owned by that exact admin only.

Multiple identity credentials for the same admin are collapsed before loading groups. Different admins remain isolated. `mergeIdentityFreeGroupsWithCardComposition` combines identity free groups with Batch 65 card composition using the composite key (admin_user_id, group_id), so an admin's same free group appears once across identity and card credentials, while card-specific groups remain untouched.

The old direct `/api/app/free` node response must not be used as the new flow. The future v2 read handler should call this verified identity resolver and then an owner-safe free-group/node loader.

## Injected adapters not implemented here

- `lookupShareCode(code)`: must resolve only the current active code version.
- `checkAdminEligibility(adminUserId)`: must derive account/VIP/free-group state from trusted server data.
- `consumeRateLimit(action,key)`: must use durable server-side rate limiting, not Worker instance memory.
- `verifyAndConsumeChallenge(...)`: must atomically verify and consume the one-time bind challenge.
- `verifyDeviceRequestProof(...)`: must verify each protected read's signature using the enrolled device key and consume a fresh request nonce atomically.
- `getOrCreateBinding(...)`: must atomically enforce unique admin/device binding.
- `loadBinding(bindingId)`: must return authoritative binding status and scope.
- `loadFreeGroups(adminUserId)`: parameterized, owner-safe read.

No D1 schema is assumed. The current observed `admin_share_codes` schema cannot supply code version/revocation metadata, and no identity binding/challenge schema was found. No SQL or migration is included.

## Tests

```bash
node --test backend/worker/V2.5-DEV-B1-APP-IDENTITY-66/identity-binding-service.test.mjs
```

The tests use mock adapters and Node.js WebCrypto. They do not prove D1, Cloudflare Workers runtime, Android key storage, device attestation, or production integration.

## Prohibited in this batch

- No Worker route registration or legacy route modification.
- No HTML/APK/Room changes.
- No D1 SQL, schema, migration or binding changes.
- No Cloudflare secret changes or deployment.
- No real share code, card code, token, user data or production credential in files/logs.
