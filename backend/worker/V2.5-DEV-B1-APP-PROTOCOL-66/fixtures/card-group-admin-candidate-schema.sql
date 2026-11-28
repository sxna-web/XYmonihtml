-- ISOLATED CANDIDATE FIXTURE ONLY. Not a production migration; never run against D1.
PRAGMA foreign_keys = OFF; -- Candidate schema deliberately has no FK constraints.

CREATE TABLE IF NOT EXISTS app_cards (
  id TEXT PRIMARY KEY,
  admin_user_id TEXT NOT NULL,
  status TEXT NOT NULL,
  manual_disabled INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT
);

CREATE TABLE IF NOT EXISTS app_groups (
  id TEXT PRIMARY KEY,
  admin_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  mode TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS admin_vip_activations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('trial','formal')),
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_card_group_mappings (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL,
  admin_user_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','removed')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  removed_at TEXT,
  UNIQUE(card_id, group_id),
  CHECK (
    (status = 'active' AND removed_at IS NULL) OR
    (status = 'removed' AND removed_at IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS ix_card_group_mappings_admin_card_status
  ON app_card_group_mappings(admin_user_id, card_id, status);
CREATE INDEX IF NOT EXISTS ix_card_group_mappings_group_status
  ON app_card_group_mappings(group_id, status);

CREATE TABLE IF NOT EXISTS app_card_group_admin_requests (
  admin_user_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL CHECK(length(payload_sha256)=64),
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(admin_user_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS admin_audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id TEXT NOT NULL,
  effective_user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  result TEXT NOT NULL,
  reason TEXT NOT NULL,
  detail TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS app_card_group_mapping_owner_insert
BEFORE INSERT ON app_card_group_mappings
WHEN NOT EXISTS (
  SELECT 1 FROM app_cards c JOIN app_groups g
    ON g.id = NEW.group_id AND g.admin_user_id = NEW.admin_user_id
   AND g.mode = 'card'
  WHERE c.id = NEW.card_id AND c.admin_user_id = NEW.admin_user_id
)
BEGIN
  SELECT RAISE(ABORT, 'CARD_GROUP_OWNER_OR_MODE_MISMATCH');
END;

CREATE TRIGGER IF NOT EXISTS app_card_group_mapping_owner_update
BEFORE UPDATE OF card_id, admin_user_id, group_id ON app_card_group_mappings
WHEN NOT EXISTS (
  SELECT 1 FROM app_cards c JOIN app_groups g
    ON g.id = NEW.group_id AND g.admin_user_id = NEW.admin_user_id
   AND g.mode = 'card'
  WHERE c.id = NEW.card_id AND c.admin_user_id = NEW.admin_user_id
)
BEGIN
  SELECT RAISE(ABORT, 'CARD_GROUP_OWNER_OR_MODE_MISMATCH');
END;

CREATE INDEX IF NOT EXISTS ix_card_group_admin_requests_created
  ON app_card_group_admin_requests(created_at);

CREATE TRIGGER IF NOT EXISTS app_card_group_mapping_card_delete_guard
BEFORE DELETE ON app_cards
WHEN EXISTS (SELECT 1 FROM app_card_group_mappings m WHERE m.card_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'CARD_HAS_GROUP_MAPPING_HISTORY');
END;

CREATE TRIGGER IF NOT EXISTS app_card_group_mapping_group_delete_guard
BEFORE DELETE ON app_groups
WHEN EXISTS (SELECT 1 FROM app_card_group_mappings m WHERE m.group_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'GROUP_HAS_CARD_MAPPING_HISTORY');
END;

CREATE TRIGGER IF NOT EXISTS app_cards_owner_transfer_guard
BEFORE UPDATE OF admin_user_id ON app_cards
WHEN OLD.admin_user_id <> NEW.admin_user_id
 AND EXISTS (SELECT 1 FROM app_card_group_mappings m WHERE m.card_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'CARD_HAS_GROUP_MAPPING_HISTORY');
END;

CREATE TRIGGER IF NOT EXISTS app_groups_owner_transfer_guard
BEFORE UPDATE OF admin_user_id ON app_groups
WHEN OLD.admin_user_id <> NEW.admin_user_id
 AND EXISTS (SELECT 1 FROM app_card_group_mappings m WHERE m.group_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'GROUP_HAS_CARD_MAPPING_HISTORY');
END;

CREATE TRIGGER IF NOT EXISTS app_groups_card_mode_guard
BEFORE UPDATE OF mode ON app_groups
WHEN OLD.mode = 'card' AND NEW.mode <> 'card'
 AND EXISTS (
   SELECT 1 FROM app_card_group_mappings m
   WHERE m.group_id = OLD.id AND m.status = 'active'
 )
BEGIN
  SELECT RAISE(ABORT, 'GROUP_HAS_ACTIVE_CARD_MAPPING');
END;
