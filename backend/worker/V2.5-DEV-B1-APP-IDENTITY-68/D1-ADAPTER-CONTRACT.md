# APP v2 Identity D1 adapter contract — Batch 68

Status: design-only; no executable migration; no production/staging D1 access.

## Evidence boundary

The legacy Worker source contains a bootstrap DDL array for `admin_share_codes` with:
- `admin_user_id TEXT PRIMARY KEY`
- `code TEXT NOT NULL UNIQUE`
- `created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP`

It contains no `code_version`, `revoked_at`, or identity binding/challenge/nonce tables in that DDL. The legacy schema also has `app_free_grants(device_id, admin_user_id, granted_at)`, which is a device/admin free grant and is not an identity binding record.

The repository's `tools/database_migrations` is explicitly local SQLite-only, constrained to disposable temp paths, and expressly not a D1 runner. Existing local migration files are CORE/notification migrations, not APP identity migrations. No tracked Wrangler config or APP v2-specific isolated D1 binding/database ID was found in the repository tree examined for this batch. This does not establish the live Cloudflare configuration.

## D1 operation mapping (logical contract; not SQL migration)

| Batch 67 store method | D1-safe implementation shape | Required uniqueness / condition | Result interpretation |
|---|---|---|---|
| `insertChallenge` | One parameterized INSERT | PRIMARY KEY(`challenge_id`) | One inserted row = created; unique conflict = conflict; all other errors fail closed |
| `consumeChallengeAtomic` | One conditional UPDATE, optionally RETURNING challenge_id | WHERE challenge_id, status='pending', expires_at > now, device/admin/code_version/key thumbprint all match | Exactly one returned/changed row = consumed; zero = expired/used/mismatch |
| `consumeNonceAtomic` | One INSERT ... ON CONFLICT(binding_id, nonce) DO NOTHING, optionally RETURNING | UNIQUE(`binding_id`, `nonce`); include device_id and expiry | One inserted row = consumed; zero = replay/conflict |
| `upsertBindingAtomic` | INSERT ... ON CONFLICT(admin_user_id, device_id) DO NOTHING, followed by owner-scoped SELECT; if both must be a single logical unit use D1.batch | UNIQUE(`admin_user_id`, `device_id`) | Existing row is returned only if active and same key thumbprint; never overwrite key or reactivate revoked row |
| `revokeBindingAtomic` | Conditional UPDATE by binding_id + admin_user_id; follow with owner-scoped read if idempotent already-revoked success is desired | Binding ID and admin owner must match | Updated/already-revoked owned row = success; absent/wrong owner = same public failure |
| `rotateShareCodeAtomic` | One conditional UPDATE | WHERE admin_user_id=?, active=1, code_version=expected; set digest, code_version=expected+1, rotated_at | Exactly one changed row = rotated; zero = CAS conflict; unique digest collision = safe conflict |
| `getCurrentShareCode` | Owner-scoped SELECT of current active version | UNIQUE(`admin_user_id`) for one current row, or one current row enforced by schema | Return only the minimum server-side record; never return stored digest to APP client |
| `expireTransientRecords` | Bounded DELETE statements, preferably grouped with D1.batch | Only pending expired challenges and expired nonce records | Idempotent counts; never delete bindings or audit history |

## Important D1 constraints

1. Use `env.DB.prepare(...).bind(...)`; never interpolate user values into SQL.
2. Prefer one conditional statement for a state transition. Use affected-row / RETURNING evidence; do not do an unprotected read-then-write.
3. D1 `batch()` is a sequential transaction batch: if a statement fails, the batch rolls back. It is not a JavaScript callback transaction and cannot pause between statements to branch on an earlier result.
4. Do not issue manual `BEGIN` / `COMMIT` across Worker awaits. Compose prepared statements before calling `batch()`.
5. For multi-statement binding creation, uniqueness is the cross-request race guard. A batch can insert-if-absent and then select the winner; after reading, the adapter must still compare status, admin owner, device and key thumbprint.
6. Avoid `INSERT OR REPLACE` for bindings or share codes: SQLite REPLACE can delete/replace the existing row and would violate revoked-row retention and audit expectations.
7. Do not assume `changes()` can safely represent every semantic outcome. For conditional writes, use `RETURNING` where supported by the verified D1 runtime or inspect the documented result metadata and then perform an owner-scoped read.
8. Store server timestamps consistently (prefer integer epoch milliseconds or a strictly normalized UTC format). Expiry comparison must be performed in the same conditional statement as consumption.
9. Cleanup must be bounded (for example, delete a limited set of expired IDs per run) and must not erase binding/revocation/audit history.
10. Database overload, timeout, unique conflict, and schema mismatch must be distinguished internally but return non-sensitive stable API errors; never leak SQL, tokens, share codes or stack traces.

## Design-only logical fields (all NEW / UNVERIFIED)

- identity_bind_challenges: challenge_id PK, device_id, admin_user_id, code_version, device_key_thumbprint, issued_at, expires_at, status, consumed_at.
- identity_request_nonces: binding_id, nonce, device_id, consumed_at, expires_at; UNIQUE(binding_id, nonce).
- identity_bindings: binding_id PK, admin_user_id, device_id, device_key_thumbprint, share_code_version, status, created_at, revoked_at, revoke_reason; UNIQUE(admin_user_id, device_id).
- admin_share_codes v2 extension or version table: admin_user_id, code_digest, code_version, active, rotated_at/revoked_at. Existing legacy `code` column may be required for old routes; do not replace or reinterpret it until every caller is inventoried and compatibility is approved.
- identity_binding_audit: append-only audit identity, actor, action, target binding/admin, reason, timestamp; never cleanup with transient nonce rows.

These are conceptual entities only. No CREATE/ALTER statements are provided.

## Open decisions / gates

- Share-code rotation preserving existing bindings is still a DEV proposal, not a frozen production policy.
- Decide whether legacy share codes remain dual-read during migration, or whether a separately versioned v2 code is introduced.
- Device-key enrollment, signature canonicalization (method + path + body digest + nonce + timestamp), and nonce verification must be specified with the Android client. 6.00.48 remains unaudited.
- Durable rate limiting is a separate required dependency; this mapping does not solve it.
- Before D1 implementation, obtain a verified non-production D1 database ID/binding, confirm its schema and migration history, and run isolated D1-specific concurrency/rollback tests with explicit authorization.
