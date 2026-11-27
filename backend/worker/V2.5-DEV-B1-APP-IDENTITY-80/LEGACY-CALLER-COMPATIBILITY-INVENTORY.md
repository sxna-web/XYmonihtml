# Legacy APP share-code and route compatibility inventory（Batch 80）

- Status: repository-source inventory only; not a complete deployed caller inventory.
- Source baseline references: original Worker blob `5da7aa3582558d9da2c2a0ad25a63c5e95e9fe63`; DEV Worker review source `a4689380215e95c1c9f605fc974cc553b3e7037f`.
- Important: the original Worker is the user's historical two-file baseline, not proof of the current Cloudflare deployment.

## 1. Legacy route references found

| Route / route family | Evidence in Worker source | Compatibility risk |
|---|---|---|
| `GET /api/app/resolve` | explicit dispatch branch | APP discovery/binding entry; cannot repurpose as authenticated node-data read without client migration |
| `GET /api/app/groups` | explicit dispatch branch | Legacy group reader; existing response contract may be consumed by old APK |
| `GET /api/app/free` | explicit dispatch branch | Legacy free-group path; must not be treated as proof of identity binding |
| `GET /api/app/links` | explicit dispatch branch | Legacy link behavior and URL semantics need caller audit |
| `/api/app/redeem` | explicit dispatch branch | Card redemption/activation path; no change without lifecycle and APK compatibility audit |
| `GET /api/app/status` | explicit route in Worker | Existing status clients may depend on old request parameters/response fields |
| `GET /api/app/nodes` | explicit route in Worker | Existing node fetch path; do not silently redirect to v2 |
| `/api/user/share-code` | explicit user share-code route | Admin-side share-code display/management caller |
| `/api/super/admins/:id/share-code` | explicit super-admin route family | Super-admin management compatibility |
| `admin_share_codes` lookups | schema bootstrap + several code resolution functions | Existing code storage has no observed version/revocation fields in the inspected legacy DDL |

## 2. APP v2 isolated reference

Batch 64 `app-v2-read-handler.mjs` defines an injected-dependency read handler for:
`GET /api/app/v2/entitlements/:entitlementId/(groups|nodes|links|status)`.

It requires:
- `x-app-device-id`;
- `Authorization: Bearer <entitlement token>`;
- explicit entitlement ID + device ID match;
- server-side group scope restricted to the entitlement's administrator and allowed group IDs.

This is an isolated module with injected data access. The repository evidence does not show it registered into the historical Worker or called by an audited APK. It is not proof of a deployed v2 endpoint.

## 3. Caller inventory gaps

- APK source ZIP is not available as an inspectable source tree in this batch; no client call-site inventory can be claimed complete.
- No complete list of external scripts, automation, third-party clients or manually shared links was established.
- Current Cloudflare deployment may differ from both historical Worker blobs; no production read was performed.
- The existing share-code table and route semantics must be compared against actual live schema only after approved read-only environment identification.

## 4. Compatibility guardrails

1. Do not delete, rename or change semantics of any legacy route in the adapter design phase.
2. Additive v2 route remains separately namespaced and feature-flagged OFF until client/server compatibility evidence and approval.
3. Do not assume an old APP client supports Bearer header, entitlement IDs, device-key thumbprints, nonce/challenge protocol or multiple concurrent entitlements.
4. Do not migrate or rotate legacy share-code records until old-client behavior, admin UI callers, super-admin callers and rollback are understood.
5. Rotation must not implicitly invalidate bindings, sessions, challenges or free grants before the user decides U80-05/U80-06.
6. Do not treat `app_free_grants(device_id, admin_user_id)` as an identity binding table.
7. A public admin identity/share code may discover an administrator but cannot by itself authorize node reads.

## 5. Next compatibility evidence

- Inspect actual APK source and identify every route, method, header, query parameter, request body and response field.
- Search HTML/admin source for `/api/user/share-code` and super-admin share-code routes.
- Capture current production Worker version and route registration only with explicit, safe read-only authorization.
- Create golden legacy response fixtures and v2 compatibility tests before any route wiring.
- Keep legacy API regression tests passing while v2 is introduced in parallel.
