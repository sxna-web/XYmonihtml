# Legacy share-code caller source review — Batch 81

- Scope: historical repository Worker and HTML source only.
- Worker source SHA: `5da7aa3582558d9da2c2a0ad25a63c5e95e9fe63`.
- HTML source SHA: `ab98aecd4c8546eda197bbb4d5a9f5ec0db82613`.
- These are the user's historical two-file development baseline, not proof of the current Cloudflare deployment.

## 1. Worker caller / route inventory

| Route or helper | Observed behavior | Compatibility constraint |
|---|---|---|
| `GET /api/app/resolve` | share code resolves administrator identity/name and free-group-enabled flag | discovery only; must not become node-read authorization |
| `GET /api/app/groups` | legacy APP group reader dispatch | preserve response/request contract until APK callsites are audited |
| `GET /api/app/free` | resolves admin by admin ID or legacy share code and returns free groups | legacy public access semantics require separate security migration plan |
| `GET /api/app/links` | legacy APP links route | preserve current query and response contract until caller audit |
| `POST /api/app/redeem` | reads card code/device ID, activates entitlement, creates free grant | card activation and entitlement semantics must not be conflated with identity binding |
| `GET /api/app/status` | reads device_id and returns latest entitlement status; no token argument observed in route body | existing clients may depend on response; security remediation must be additive/compatibility-tested |
| `GET /api/app/nodes` | reads device_id + token query and selects latest active entitlement | multi-entitlement client behavior not established; do not silently redirect to v2 |
| `GET /api/user/share-code` | authenticated user HTML panel reads own code and bind URL | keep admin panel behavior and output fields until versioned UI contract exists |
| `GET /api/super/admins/:id/share-code` | super-admin UI loads selected admin's code and bind URL | retain super-admin permission boundary and output shape |

Observed legacy schema bootstrap includes `admin_share_codes(admin_user_id PRIMARY KEY, code UNIQUE, created_at)` and `app_free_grants(device_id, admin_user_id, granted_at)`. No version/revocation columns were observed in this source DDL. This is not a live schema assertion.

## 2. HTML callsites found

- `loadUserPanel()` calls `/api/user/share-code`, displays `data.code`, copies it, and renders QR from `data.bind_url`.
- `loadShareCode()` calls `/api/super/admins/{admin}/share-code`, displays `data.code`, and stores `data.bind_url` in the UI.
- These are management UI callers, not APP APK callers. No source evidence says the APP consumes the same endpoint.

## 3. APP v2 module boundary

Batch 64 `app-v2-read-handler.mjs` and token adapter are isolated modules with injected dependencies. Repository evidence does not show the handler registered in the historical Worker dispatcher or prove an APK calls its v2 paths. Keep feature flag OFF until integration and client capability evidence exist.

## 4. Unresolved caller evidence

- APK ZIP/source tree remains unavailable for source-level inspection in this batch; no complete method/path/header/query/body/response inventory can be claimed.
- External clients, deep links, automation, cached QR codes and manually shared codes are not fully inventoried.
- Current deployed Cloudflare Worker and live D1 schema were not read.
- Rotation effects on old bindings, sessions, pending challenges and free grants remain blocked by U80-05/U80-06.

## 5. Compatibility gates

1. Obtain an inspectable APK source tree and search every HTTP client, deep-link handler and storage path.
2. Produce golden fixtures for legacy request/response payloads.
3. Add v2 in a separate namespace and keep legacy route behavior unchanged during staged adoption.
4. Prove management UI share-code endpoints and super-admin scope still work.
5. Do not rotate/revoke legacy codes or migrate old records until caller inventory and rollback are approved.
