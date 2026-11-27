# V2.5 Worker authorization integration — Batch 48

**Status: VERSIONED WORKER COPY + ADAPTER CODED; runtime tests and independent review pending; NOT DEPLOYABLE.**

Base Worker:
- `原始StarJump_V1点0_Final-zip-26-11-25-14:56/Worker.js`
- Blob SHA: `5da7aa3582558d9da2c2a0ad25a63c5e95e9fe63`

This revision imports the isolated authorization model from batch 47 and applies an adapter gate before APP management write handlers:
- APP groups: POST/create, PUT/update, DELETE/history delete, sources POST/associate and members POST/associate. The similarly shaped members DELETE route is in the super-admin handler, not this user route.
- APP links: POST/create and DELETE/history delete.
- APP cards: POST/generate, DELETE/disable and /disable POST/disable.
- GET routes are not VIP-gated by this adapter; existing session and assist-scope checks remain in force.

The adapter derives actor/effective identity only from the server-resolved `resolveSession()` context. It reads all `admin_vip_activations` rows for the effective user. VIP query errors fail closed. Formal-expiry deletes return a cutoff that the Worker applies in the final owner-constrained DELETE predicate.

Repository DDL inspected (not production schema evidence):
- `admin_vip_activations(user_id, kind, starts_at, ends_at)`
- `app_groups(id, admin_user_id, created_at)`
- `app_links(id, admin_user_id, created_at)`

Important limits:
- These columns are evidenced by the original Worker migration statements only. The live Cloudflare D1 schema remains unverified.
- No D1 schema changes or migrations are included.
- No Worker runtime/Cloudflare compatibility test has been executed.
- The adapter tests exercise the pre-handler authorization boundary and assert denied decisions do not call mock writes; they are not end-to-end handler tests. Fourth-ninth-batch follow-up adds actual Worker handler tests in a separate immutable revision directory.
- Physical APP group deletion and its 24-hour client cleanup/acknowledgement lifecycle remain a separate unresolved issue.
- No HTML, Secrets, production D1, Cloudflare settings, or deployment were changed.

Run:
```bash
node --test backend/worker/V2.5-DEV-B1-CORE-AUTH-48/worker-auth-adapter.test.mjs
```
