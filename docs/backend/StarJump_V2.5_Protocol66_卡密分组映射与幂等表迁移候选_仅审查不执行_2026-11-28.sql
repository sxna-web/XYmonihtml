-- 星跃管理平台 V2.5 / Protocol66
-- 状态：仅供审查的候选 DDL。严禁直接复制到 Cloudflare D1 执行。
-- 目标库基准：starjump-staging / 18f422d4-7a4e-4a39-bca7-eada3a493454
-- 依据：docs/backend/StarJump_V2.5_starjump-staging_D1结构基准快照_2026-11-28.md
-- 该快照确认下列两张表不存在；但不是生产 schema 证明。
-- 前置：必须先取得用户对指定 Staging 数据库迁移的明确授权，并完成最新 schema 只读复核、备份/恢复点和 DDL 评审。
-- 本文件不包含任何 DROP、数据回填、现有表重建或 Secrets/binding 操作。
-- 不使用外键：真实基准未证明相关 FK，所有权通过触发器和原子业务谓词保护。

CREATE TABLE app_card_group_mappings (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL,
  admin_user_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'removed')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  removed_at TEXT,
  UNIQUE (card_id, group_id),
  CHECK (
    (status = 'active' AND removed_at IS NULL) OR
    (status = 'removed' AND removed_at IS NOT NULL)
  )
);

CREATE INDEX ix_card_group_mappings_admin_card_status
  ON app_card_group_mappings(admin_user_id, card_id, status);

CREATE INDEX ix_card_group_mappings_group_status
  ON app_card_group_mappings(group_id, status);

CREATE TABLE app_card_group_admin_requests (
  admin_user_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL
    CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  payload_sha256 TEXT NOT NULL
    CHECK (length(payload_sha256) = 64 AND payload_sha256 NOT GLOB '*[^a-f0-9]*'),
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (admin_user_id, idempotency_key)
);

CREATE INDEX ix_card_group_admin_requests_created
  ON app_card_group_admin_requests(created_at);

-- Mapping insert/update must bind the card and card-mode group to the same owner.
CREATE TRIGGER app_card_group_mapping_owner_insert
BEFORE INSERT ON app_card_group_mappings
WHEN NOT EXISTS (
  SELECT 1
    FROM app_cards c
    JOIN app_groups g
      ON g.id = NEW.group_id
     AND g.admin_user_id = NEW.admin_user_id
     AND g.mode = 'card'
   WHERE c.id = NEW.card_id
     AND c.admin_user_id = NEW.admin_user_id
)
BEGIN
  SELECT RAISE(ABORT, 'CARD_GROUP_OWNER_OR_MODE_MISMATCH');
END;

CREATE TRIGGER app_card_group_mapping_owner_update
BEFORE UPDATE OF card_id, admin_user_id, group_id ON app_card_group_mappings
WHEN NOT EXISTS (
  SELECT 1
    FROM app_cards c
    JOIN app_groups g
      ON g.id = NEW.group_id
     AND g.admin_user_id = NEW.admin_user_id
     AND g.mode = 'card'
   WHERE c.id = NEW.card_id
     AND c.admin_user_id = NEW.admin_user_id
)
BEGIN
  SELECT RAISE(ABORT, 'CARD_GROUP_OWNER_OR_MODE_MISMATCH');
END;

-- Mapping rows are history. Business changes use status='removed', never DELETE.
CREATE TRIGGER app_card_group_mapping_no_hard_delete
BEFORE DELETE ON app_card_group_mappings
BEGIN
  SELECT RAISE(ABORT, 'CARD_GROUP_MAPPING_HISTORY_IMMUTABLE');
END;

-- Do not physically remove or transfer resources after a mapping has ever referred to them.
CREATE TRIGGER app_card_group_mapping_card_delete_guard
BEFORE DELETE ON app_cards
WHEN EXISTS (
  SELECT 1 FROM app_card_group_mappings m WHERE m.card_id = OLD.id
)
BEGIN
  SELECT RAISE(ABORT, 'CARD_HAS_GROUP_MAPPING_HISTORY');
END;

CREATE TRIGGER app_card_group_mapping_group_delete_guard
BEFORE DELETE ON app_groups
WHEN EXISTS (
  SELECT 1 FROM app_card_group_mappings m WHERE m.group_id = OLD.id
)
BEGIN
  SELECT RAISE(ABORT, 'GROUP_HAS_CARD_MAPPING_HISTORY');
END;

CREATE TRIGGER app_cards_owner_transfer_guard
BEFORE UPDATE OF admin_user_id ON app_cards
WHEN OLD.admin_user_id <> NEW.admin_user_id
 AND EXISTS (
   SELECT 1 FROM app_card_group_mappings m WHERE m.card_id = OLD.id
 )
BEGIN
  SELECT RAISE(ABORT, 'CARD_HAS_GROUP_MAPPING_HISTORY');
END;

CREATE TRIGGER app_groups_owner_transfer_guard
BEFORE UPDATE OF admin_user_id ON app_groups
WHEN OLD.admin_user_id <> NEW.admin_user_id
 AND EXISTS (
   SELECT 1 FROM app_card_group_mappings m WHERE m.group_id = OLD.id
 )
BEGIN
  SELECT RAISE(ABORT, 'GROUP_HAS_CARD_MAPPING_HISTORY');
END;

CREATE TRIGGER app_groups_card_mode_guard
BEFORE UPDATE OF mode ON app_groups
WHEN OLD.mode = 'card' AND NEW.mode <> 'card'
 AND EXISTS (
   SELECT 1
     FROM app_card_group_mappings m
    WHERE m.group_id = OLD.id
      AND m.status = 'active'
 )
BEGIN
  SELECT RAISE(ABORT, 'GROUP_HAS_ACTIVE_CARD_MAPPING');
END;

-- 迁移前只读核对（人工执行前先检查对象是否已出现/名称冲突）：
-- SELECT type, name, tbl_name, sql FROM sqlite_master
-- WHERE name IN (
--   'app_card_group_mappings',
--   'app_card_group_admin_requests',
--   'ix_card_group_mappings_admin_card_status',
--   'ix_card_group_mappings_group_status',
--   'ix_card_group_admin_requests_created',
--   'app_card_group_mapping_owner_insert',
--   'app_card_group_mapping_owner_update',
--   'app_card_group_mapping_no_hard_delete',
--   'app_card_group_mapping_card_delete_guard',
--   'app_card_group_mapping_group_delete_guard',
--   'app_cards_owner_transfer_guard',
--   'app_groups_owner_transfer_guard',
--   'app_groups_card_mode_guard'
-- )
-- ORDER BY type, name;
--
-- 迁移后验收必须检查：2 张表、3 个索引、8 个触发器；PRAGMA table_info/index_list；
-- 使用隔离 SQLite fixture 验证跨管理员映射、free/public group 拒绝、软删除恢复、
-- 幂等键冲突、审计失败整体回滚、资源删除/转移保护。之后才可申请真实 D1 Staging 受控验证。
--
-- 回滚原则：
-- 1) 仅在尚未启用功能、尚无任何映射/幂等记录时，才可另行审批 DROP 这些新对象；
-- 2) 一旦产生业务数据，代码回滚只回滚 Worker/HTML，不 DROP 表、不清理映射/幂等/审计数据；
-- 3) 本文件本身不是迁移工具、不是执行授权，也不能替代迁移 manifest/checksum/postcondition。
