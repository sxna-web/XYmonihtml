-- Local verifier ledger bootstrap. This is not approved for production D1.
CREATE TABLE IF NOT EXISTS schema_migrations (
    migration_id TEXT PRIMARY KEY,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
