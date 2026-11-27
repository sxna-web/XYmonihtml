# APP v2 Identity D1 preflight — Batch 68

- Version: `V2.5-DEV-B1-APP-IDENTITY-68`
- Date: 2026-11-27
- Status: read-only repository/schema-source audit + D1 adapter design; no executable migration; no D1 connection; no Worker integration; not deployable.

See `D1-ADAPTER-CONTRACT.md` for the eight Batch 67 store-method mappings and the explicit evidence boundary.

## Findings
- Legacy Worker DDL is a source-code schema proposal/bootstrap, not proof of current live D1 schema.
- `admin_share_codes` legacy DDL has admin_user_id PK, plaintext code UNIQUE and created_at only; no version/revocation fields.
- `app_free_grants` is device/admin free grant, not identity binding.
- No identity challenge, nonce, or binding table was found in the examined legacy Worker DDL.
- Repository migration runner is local SQLite-only and refuses paths outside disposable temporary test directories. It is not a D1 runner.
- Existing tracked migrations are local CORE/notification model files, not APP identity migrations.
- No tracked Wrangler config or APP v2-specific isolated D1 binding/database ID was found in the current repository tree examined. This does not prove what is configured in Cloudflare dashboard or live deployment.

## Scope and rollback
Only this versioned directory and the batch report/progress docs are added. No Worker, HTML, APK, Room, D1, Secrets, Cloudflare config or production data changed. Rollback is to stop using this documentation/version directory or revert its additions; no data rollback is needed.

## Tests
This is a documentation and read-only audit batch. No executable code test is claimed. Prior batch 67 mock suite remains 14/14; that does not validate D1 behavior.

## Next gate
Do not implement D1 adapter or migration until an explicitly authorized non-production D1 binding/database ID and current schema/migration evidence are available. Then test uniqueness races, batch rollback, result metadata, SQL dialect, and overload/error handling in that isolated database.
