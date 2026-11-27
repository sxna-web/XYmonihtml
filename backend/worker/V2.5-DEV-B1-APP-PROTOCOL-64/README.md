# APP v2 entitlement-token adapter and exact read handler — Batch 64

- Version: `V2.5-DEV-B1-APP-PROTOCOL-64`
- Date: 2026-11-27
- Status: isolated DEV implementation; not wired to the existing Worker; not deployable.
- Base: Batch 52 exact entitlement resolver; Batch 58 handler contract is superseded for auth semantics by this directory.

## Authentication contract

- `Authorization: Bearer <entitlement-token>`
- `X-App-Device-ID: <device-id>`
- Explicit path identity: `/api/app/v2/entitlements/:entitlementId/{groups|nodes|links|status}`
- The bearer value is an APP entitlement HMAC token, never a user Session token.
- HMAC input remains the observed legacy payload `entitlementId|deviceId`; output is base64url SHA-256 HMAC.
- New adapter reads only `APP_ENTITLEMENT_SECRET` (minimum 32 characters). Missing/short secret fails closed. It never falls back to `SESSION_PEPPER` or a fixed default.
- The 32-character minimum and dedicated secret name are DEV safety requirements; production secret provisioning and rotation require separate review/approval.

## Read boundary

All four resources require the exact resolver output. Client-provided admin IDs are ignored. Group scope must be explicit, unique, enabled, and owned by the resolved admin. Empty allowlist returns empty nodes without issuing a node query. Node and link loader results are checked again for owner/group scope.

Injected loaders must themselves use parameterized, owner-safe queries. This handler is a boundary guard, not a replacement for SQL-level authorization.

## Run

```bash
node --test backend/worker/V2.5-DEV-B1-APP-PROTOCOL-64/app-v2-read-handler.test.mjs
```

## Limits

- No production Worker import or route registration.
- No D1 schema assumptions beyond Batch 52 observed resolver columns.
- No migration, real D1, Cloudflare binding, secret, HTML, APK, Room migration, or deployment changes.
- 6.00.48 source and third-party licensing remain unaudited; APK_PENDING.
- D1 remains D1_NOT_TESTED.
- This tests Node mock D1/WebCrypto behavior only; not Cloudflare Workers runtime or Android compatibility.
