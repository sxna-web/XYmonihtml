# 星跃管理平台 V2.5 — starjump-staging D1 结构基准快照

- 基准日期：2026-11-28（用户在 Cloudflare D1 Console 执行查询并提供结果）
- 数据库名称：`starjump-staging`
- 数据库 ID：`18f422d4-7a4e-4a39-bca7-eada3a493454`
- Cloudflare Worker：`starjump-api-staging`
- D1 Binding：`DB`
- 用户确认：当前 V2.5 版本只使用 `starjump-staging`；`starjump-test-db`、`starjump-db` 本轮不使用，不要求用户重复打开或查询，也不得删除。
- 查询：只读 `sqlite_master` 元数据查询；不是业务数据导出，不包含表内用户数据。
- 证据边界：这是用户提供的 Staging 数据库结构结果，不是正式生产库结构证明，也不是 Cloudflare Worker 运行时/真实数据兼容验收。
- 操作边界：本次没有执行 DDL/DML、迁移、备份恢复、binding 修改、Secrets 操作或部署。

## 后续 AI / 开发者强制接手规则

1. 开始任何数据库、迁移、SQL、APP 卡密/分组或 Worker D1 相关任务前，先读取本文件及 `docs/星跃管理平台V2.5_开发进度与测试验收记录.md` 的最新数据库变更记录。
2. 本文件是 `starjump-staging` 在 2026-11-28 的历史基准，不可静默覆盖。后续结构变化必须新增带日期/批次的新快照或追加变更记录，并更新进度总账、PR 交接说明。
3. 若任务涉及当前结构，优先使用本快照，不得要求用户重复执行相同的 `sqlite_master` 查询。只有明确需要确认“基准之后是否发生变化”且仓库中没有更新证据时，才提出一次最小化只读复核。
4. 用户已明确本版本只使用 `starjump-staging`。不要擅自切换到 `starjump-db` 或 `starjump-test-db`，也不要将这些数据库删除、清空、迁移或重新绑定。
5. 数据库名带 `staging`，因此不得把它描述为已确认的正式生产数据库。生产环境的 Worker、D1 binding 和数据归属仍需独立确认。
6. 不得根据本快照臆造缺失字段、外键、约束或生产 schema；本快照仅包含 sqlite_master 返回的对象定义。
7. 未获用户明确授权，不得对 Cloudflare D1 执行任何写入、DDL/DML、迁移、删除、恢复或 binding 修改。不得索取/输出 Secrets。
8. 在修改 schema 前先比较代码 SQL 与本快照；设计向前兼容、可验证、可回滚迁移，并单独列出备份/恢复点。不得将候选 fixture schema 当成真实库。
9. 交接给后续 AI 时，必须明确指出本文件路径，并要求先读取；不得只依赖聊天记录或要求用户重新贴结果。

## 原始查询

```sql
SELECT type, name, tbl_name, sql
FROM sqlite_master
WHERE type IN ('table', 'index', 'view', 'trigger')
ORDER BY type, name;
```

## 查询结果

### 索引（含 SQLite 自动索引）

```text
index idx_node_records_enabled | node_records | CREATE INDEX idx_node_records_enabled ON node_records(enabled)
index idx_node_records_protocol | node_records | CREATE INDEX idx_node_records_protocol ON node_records(protocol)
index idx_node_records_source | node_records | CREATE INDEX idx_node_records_source ON node_records(source_id)
index idx_node_records_tier | node_records | CREATE INDEX idx_node_records_tier ON node_records(tier)
index idx_node_sync_logs_created | node_sync_logs | CREATE INDEX idx_node_sync_logs_created ON node_sync_logs(created_at)
index idx_node_sync_logs_source | node_sync_logs | CREATE INDEX idx_node_sync_logs_source ON node_sync_logs(source_id)
index ix_admin_scopes_target | admin_user_scopes | CREATE INDEX ix_admin_scopes_target ON admin_user_scopes(target_user_id)
index ix_admin_share_codes_code | admin_share_codes | CREATE INDEX ix_admin_share_codes_code ON admin_share_codes(code)
index ix_alias_fingerprint | node_identity_aliases | CREATE INDEX ix_alias_fingerprint ON node_identity_aliases(source_id, fingerprint)
index ix_app_cards_admin | app_cards | CREATE INDEX ix_app_cards_admin ON app_cards(admin_user_id, status)
index ix_app_cards_code | app_cards | CREATE INDEX ix_app_cards_code ON app_cards(code)
index ix_app_ent_admin | app_entitlements | CREATE INDEX ix_app_ent_admin ON app_entitlements(admin_user_id, status)
index ix_app_ent_device | app_entitlements | CREATE INDEX ix_app_ent_device ON app_entitlements(device_id, status)
index ix_app_ent_expires | app_entitlements | CREATE INDEX ix_app_ent_expires ON app_entitlements(expires_at)
index ix_app_groups_admin | app_groups | CREATE INDEX ix_app_groups_admin ON app_groups(admin_user_id, sort)
index ix_app_links_admin | app_links | CREATE INDEX ix_app_links_admin ON app_links(admin_user_id, sort)
index ix_app_users_role | app_users | CREATE INDEX ix_app_users_role ON app_users(role, status)
index ix_audit_events_actor | admin_audit_events | CREATE INDEX ix_audit_events_actor ON admin_audit_events(actor_user_id, id)
index ix_audit_events_created | admin_audit_events | CREATE INDEX ix_audit_events_created ON admin_audit_events(created_at)
index ix_audit_events_target | admin_audit_events | CREATE INDEX ix_audit_events_target ON admin_audit_events(target_type, target_id)
index ix_card_events_card | app_card_events | CREATE INDEX ix_card_events_card ON app_card_events(card_id, created_at)
index ix_convert_links_expires | convert_links | CREATE INDEX ix_convert_links_expires ON convert_links(expires_at)
index ix_convert_links_group | convert_links | CREATE INDEX ix_convert_links_group ON convert_links(group_name)
index ix_convert_links_ip | convert_links | CREATE INDEX ix_convert_links_ip ON convert_links(ip_hash, created_at)
index ix_convert_links_owner | convert_links | CREATE INDEX ix_convert_links_owner ON convert_links(owner_key, group_name)
index ix_download_links_scope | download_links | CREATE INDEX ix_download_links_scope ON download_links(scope, admin_user_id, sort)
index ix_group_members_node | node_group_members | CREATE INDEX ix_group_members_node ON node_group_members(user_id, node_kind, node_id)
index ix_manual_nodes_user | user_manual_nodes | CREATE INDEX ix_manual_nodes_user ON user_manual_nodes(user_id, updated_at)
index ix_node_groups_user | node_groups | CREATE INDEX ix_node_groups_user ON node_groups(user_id, sort_order)
index ix_node_lifecycle_source | node_lifecycle | CREATE INDEX ix_node_lifecycle_source ON node_lifecycle(source_id)
index ix_node_lifecycle_state | node_lifecycle | CREATE INDEX ix_node_lifecycle_state ON node_lifecycle(state)
index ix_node_meta_lookup | node_user_metadata | CREATE INDEX ix_node_meta_lookup ON node_user_metadata(user_id, node_kind)
index ix_node_overrides_node | node_overrides | CREATE INDEX ix_node_overrides_node ON node_overrides(node_id)
index ix_source_approvals_status | source_approvals | CREATE INDEX ix_source_approvals_status ON source_approvals(status, created_at)
index ix_source_ownership_user | source_ownership | CREATE INDEX ix_source_ownership_user ON source_ownership(user_id)
index ix_source_quota_expires | source_quota | CREATE INDEX ix_source_quota_expires ON source_quota(expires_at)
index ix_sync_tasks_source | sync_tasks | CREATE INDEX ix_sync_tasks_source ON sync_tasks(source_id, created_at)
index ix_sync_tasks_status | sync_tasks | CREATE INDEX ix_sync_tasks_status ON sync_tasks(status)
index ix_user_sessions_acting | user_sessions | CREATE INDEX ix_user_sessions_acting ON user_sessions(acting_as_user_id)
index ix_user_sessions_user | user_sessions | CREATE INDEX ix_user_sessions_user ON user_sessions(user_id, expires_at)
index ix_vip_activations_user | admin_vip_activations | CREATE INDEX ix_vip_activations_user ON admin_vip_activations(user_id, ends_at)
index ix_vip_cards_status | admin_vip_cards | CREATE INDEX ix_vip_cards_status ON admin_vip_cards(status, created_at)
index sqlite_autoindex_activation_cards_1 | activation_cards | <null>
index sqlite_autoindex_activation_cards_2 | activation_cards | <null>
index sqlite_autoindex_admin_app_perms_1 | admin_app_perms | <null>
index sqlite_autoindex_admin_share_codes_1 | admin_share_codes | <null>
index sqlite_autoindex_admin_share_codes_2 | admin_share_codes | <null>
index sqlite_autoindex_admin_user_scopes_1 | admin_user_scopes | <null>
index sqlite_autoindex_admin_vip_activations_1 | admin_vip_activations | <null>
index sqlite_autoindex_admin_vip_cards_1 | admin_vip_cards | <null>
index sqlite_autoindex_admin_vip_cards_2 | admin_vip_cards | <null>
index sqlite_autoindex_announcements_1 | announcements | <null>
index sqlite_autoindex_app_cards_1 | app_cards | <null>
index sqlite_autoindex_app_cards_2 | app_cards | <null>
index sqlite_autoindex_app_devices_1 | app_devices | <null>
index sqlite_autoindex_app_entitlements_1 | app_entitlements | <null>
index sqlite_autoindex_app_free_grants_1 | app_free_grants | <null>
index sqlite_autoindex_app_group_members_1 | app_group_members | <null>
index sqlite_autoindex_app_group_sources_1 | app_group_sources | <null>
index sqlite_autoindex_app_groups_1 | app_groups | <null>
index sqlite_autoindex_app_links_1 | app_links | <null>
index sqlite_autoindex_app_settings_1 | app_settings | <null>
index sqlite_autoindex_app_users_1 | app_users | <null>
index sqlite_autoindex_convert_links_1 | convert_links | <null>
index sqlite_autoindex_download_links_1 | download_links | <null>
index sqlite_autoindex_node_group_members_1 | node_group_members | <null>
index sqlite_autoindex_node_groups_1 | node_groups | <null>
index sqlite_autoindex_node_identity_aliases_1 | node_identity_aliases | <null>
index sqlite_autoindex_node_lifecycle_1 | node_lifecycle | <null>
index sqlite_autoindex_node_overrides_1 | node_overrides | <null>
index sqlite_autoindex_node_records_1 | node_records | <null>
index sqlite_autoindex_node_records_2 | node_records | <null>
index sqlite_autoindex_node_user_metadata_1 | node_user_metadata | <null>
index sqlite_autoindex_rate_limits_1 | rate_limits | <null>
index sqlite_autoindex_releases_1 | releases | <null>
index sqlite_autoindex_schema_migrations_1 | schema_migrations | <null>
index sqlite_autoindex_source_approvals_1 | source_approvals | <null>
index sqlite_autoindex_source_ownership_1 | source_ownership | <null>
index sqlite_autoindex_source_quota_1 | source_quota | <null>
index sqlite_autoindex_subscription_sources_1 | subscription_sources | <null>
index sqlite_autoindex_subscription_sync_state_1 | subscription_sync_state | <null>
index sqlite_autoindex_sync_task_manifests_1 | sync_task_manifests | <null>
index sqlite_autoindex_sync_task_stage_1 | sync_task_stage | <null>
index sqlite_autoindex_sync_tasks_1 | sync_tasks | <null>
index sqlite_autoindex_user_manual_nodes_1 | user_manual_nodes | <null>
index sqlite_autoindex_user_sessions_1 | user_sessions | <null>
index ux_admin_scopes_active | admin_user_scopes | CREATE UNIQUE INDEX ux_admin_scopes_active ON admin_user_scopes(admin_user_id, target_user_id, scope) WHERE revoked_at IS NULL
index ux_app_users_username | app_users | CREATE UNIQUE INDEX ux_app_users_username ON app_users(username)
index ux_user_sessions_token | user_sessions | CREATE UNIQUE INDEX ux_user_sessions_token ON user_sessions(token_hash)
```

### 表对象

```sql
CREATE TABLE _cf_KV ( key TEXT PRIMARY KEY, value BLOB ) WITHOUT ROWID;
CREATE TABLE activation_cards ( id TEXT PRIMARY KEY, code_hash TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'unused', device_id TEXT, expires_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP );
CREATE TABLE admin_app_perms ( admin_user_id TEXT PRIMARY KEY, links_enabled INTEGER NOT NULL DEFAULT 1, max_links INTEGER NOT NULL DEFAULT 1, free_group_enabled INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE admin_audit ( id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, detail TEXT DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP );
CREATE TABLE admin_audit_events ( id INTEGER PRIMARY KEY AUTOINCREMENT, actor_user_id TEXT, effective_user_id TEXT, action TEXT NOT NULL, target_type TEXT NOT NULL DEFAULT '', target_id TEXT NOT NULL DEFAULT '', request_id TEXT NOT NULL DEFAULT '', before_json TEXT NOT NULL DEFAULT '', after_json TEXT NOT NULL DEFAULT '', result TEXT NOT NULL DEFAULT 'ok', reason TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP );
CREATE TABLE admin_share_codes ( admin_user_id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE admin_user_scopes ( id TEXT PRIMARY KEY, admin_user_id TEXT NOT NULL, target_user_id TEXT NOT NULL, scope TEXT NOT NULL, granted_by TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', granted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, expires_at TEXT, revoked_at TEXT );
CREATE TABLE admin_vip_activations ( id TEXT PRIMARY KEY, user_id TEXT NOT NULL, card_id TEXT, days INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'formal', starts_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, ends_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE admin_vip_cards ( id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, days INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'unused', note TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, used_by TEXT, used_at TEXT);
CREATE TABLE announcements ( id TEXT PRIMARY KEY, scope TEXT NOT NULL DEFAULT 'web', title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', level TEXT NOT NULL DEFAULT 'info', active INTEGER NOT NULL DEFAULT 1, starts_at TEXT, ends_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE app_card_events ( id INTEGER PRIMARY KEY AUTOINCREMENT, card_id TEXT NOT NULL, admin_user_id TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', device_id TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE app_cards ( id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, admin_user_id TEXT NOT NULL, days INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'normal', inactive_reason TEXT NOT NULL DEFAULT '', inactive_at TEXT, restored_at TEXT, manual_disabled INTEGER NOT NULL DEFAULT 0, expires_at TEXT, activated_at TEXT, used_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE app_devices ( device_id TEXT PRIMARY KEY, tier TEXT NOT NULL DEFAULT 'free', activated_at TEXT, expires_at TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP );
CREATE TABLE app_entitlements ( id TEXT PRIMARY KEY, admin_user_id TEXT NOT NULL, device_id TEXT NOT NULL, card_id TEXT NOT NULL, starts_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, expires_at TEXT NOT NULL, purge_at TEXT, status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE app_free_grants (device_id TEXT NOT NULL, admin_user_id TEXT NOT NULL, granted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (device_id, admin_user_id));
CREATE TABLE app_group_members (group_id TEXT NOT NULL, device_id TEXT NOT NULL, PRIMARY KEY (group_id, device_id));
CREATE TABLE app_group_sources (group_id TEXT NOT NULL, source_id TEXT NOT NULL, PRIMARY KEY (group_id, source_id));
CREATE TABLE app_groups ( id TEXT PRIMARY KEY, admin_user_id TEXT NOT NULL, name TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'assigned', sort INTEGER NOT NULL DEFAULT 100, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE app_links ( id TEXT PRIMARY KEY, admin_user_id TEXT NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 100, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE app_settings ( key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP );
CREATE TABLE app_users ( id TEXT PRIMARY KEY, username TEXT NOT NULL, display_name TEXT NOT NULL DEFAULT '', password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', status TEXT NOT NULL DEFAULT 'active', failed_login_count INTEGER NOT NULL DEFAULT 0, locked_until TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, last_login_at TEXT );
CREATE TABLE convert_links ( id TEXT PRIMARY KEY, payload TEXT NOT NULL, targets TEXT NOT NULL DEFAULT '', group_name TEXT NOT NULL DEFAULT '默认分组', owner_user_id TEXT, ip_hash TEXT NOT NULL DEFAULT '', hits INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, last_used_at TEXT, expires_at TEXT NOT NULL, revoked_at TEXT, owner_key TEXT);
CREATE TABLE download_links ( id TEXT PRIMARY KEY, scope TEXT NOT NULL DEFAULT 'global', admin_user_id TEXT, title TEXT NOT NULL, url TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 100, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE node_group_members ( user_id TEXT NOT NULL, group_id TEXT NOT NULL, node_kind TEXT NOT NULL, node_id TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (user_id, group_id, node_kind, node_id) );
CREATE TABLE node_groups ( id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, remark TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP );
CREATE TABLE node_identity_aliases ( source_id TEXT NOT NULL, identity_key TEXT NOT NULL, fingerprint TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (source_id, identity_key) );
CREATE TABLE node_lifecycle ( node_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, fail_streak INTEGER NOT NULL DEFAULT 0, first_check_at TEXT, last_check_at TEXT, observation_started_at TEXT, stale_at TEXT, state TEXT NOT NULL DEFAULT 'ok', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE node_overrides ( user_id TEXT NOT NULL, node_id TEXT NOT NULL, field_name TEXT NOT NULL, override_value TEXT NOT NULL, updated_by TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, reason TEXT NOT NULL DEFAULT '', PRIMARY KEY (user_id, node_id, field_name) );
CREATE TABLE node_records ( id TEXT PRIMARY KEY, source_id TEXT NOT NULL, source_name TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '', protocol TEXT NOT NULL DEFAULT '', server TEXT NOT NULL DEFAULT '', port INTEGER, uri TEXT NOT NULL DEFAULT '', fingerprint TEXT NOT NULL, tier TEXT NOT NULL DEFAULT 'free', enabled INTEGER NOT NULL DEFAULT 1, last_seen TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(source_id, fingerprint) );
CREATE TABLE node_sync_logs ( id INTEGER PRIMARY KEY AUTOINCREMENT, source_id TEXT NOT NULL, source_name TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'success', total_nodes INTEGER NOT NULL DEFAULT 0, added_nodes INTEGER NOT NULL DEFAULT 0, updated_nodes INTEGER NOT NULL DEFAULT 0, error_message TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP );
CREATE TABLE node_user_metadata ( user_id TEXT NOT NULL, node_kind TEXT NOT NULL, node_id TEXT NOT NULL, remark TEXT NOT NULL DEFAULT '', favorite INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (user_id, node_kind, node_id) );
CREATE TABLE rate_limits ( bucket TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE releases ( id TEXT PRIMARY KEY, platform TEXT NOT NULL DEFAULT 'android', version_code INTEGER NOT NULL, version_name TEXT NOT NULL, min_version_code INTEGER NOT NULL DEFAULT 0, url TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', force INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE schema_migrations ( version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP );
CREATE TABLE source_approvals ( source_id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'pending', requested_by TEXT NOT NULL, reviewed_by TEXT, reviewed_at TEXT, reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP );
CREATE TABLE source_ownership ( source_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, assigned_by TEXT NOT NULL, assigned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP );
CREATE TABLE source_quota ( source_id TEXT PRIMARY KEY, profile_title TEXT, total_bytes INTEGER, upload_bytes INTEGER, download_bytes INTEGER, used_bytes INTEGER, remaining_bytes INTEGER, expires_at TEXT, status TEXT NOT NULL DEFAULT 'unavailable', last_success_at TEXT, last_attempt_at TEXT, error_message TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP );
CREATE TABLE sqlite_sequence(name,seq);
CREATE TABLE subscription_sources ( id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, tier TEXT NOT NULL DEFAULT 'free', enabled INTEGER NOT NULL DEFAULT 1, priority INTEGER NOT NULL DEFAULT 100, remark TEXT DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP );
CREATE TABLE subscription_sync_state ( source_id TEXT PRIMARY KEY, generation INTEGER NOT NULL DEFAULT 0, lease_owner TEXT, lease_token_hash TEXT, lease_expires_at INTEGER NOT NULL DEFAULT 0, last_success_at TEXT, last_manifest_hash TEXT, last_task_id TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP );
CREATE TABLE sync_task_manifests ( task_id TEXT PRIMARY KEY, node_count INTEGER NOT NULL, stage_hash TEXT NOT NULL, canonicalization_version TEXT NOT NULL, verified_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP );
CREATE TABLE sync_task_stage ( task_id TEXT NOT NULL, seq INTEGER NOT NULL, node_key TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (task_id, seq) );
CREATE TABLE sync_tasks ( id TEXT PRIMARY KEY, source_id TEXT NOT NULL, generation INTEGER NOT NULL, lease_owner TEXT NOT NULL, lease_token_hash TEXT NOT NULL, actor_user_id TEXT, trigger_kind TEXT NOT NULL DEFAULT 'manual', status TEXT NOT NULL DEFAULT 'staging', canonicalization_version TEXT NOT NULL DEFAULT 'v1.0-1', node_count INTEGER NOT NULL DEFAULT 0, staged_count INTEGER NOT NULL DEFAULT 0, missing_count INTEGER NOT NULL DEFAULT 0, manifest_hash TEXT, error_message TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, committed_at TEXT );
CREATE TABLE user_manual_nodes ( id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', protocol TEXT NOT NULL DEFAULT '', server TEXT NOT NULL DEFAULT '', port INTEGER, uri TEXT NOT NULL DEFAULT '', tier TEXT NOT NULL DEFAULT 'free', enabled INTEGER NOT NULL DEFAULT 1, remark TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP );
CREATE TABLE user_sessions ( id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_hash TEXT NOT NULL, acting_as_user_id TEXT, scope_id TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, expires_at TEXT NOT NULL, revoked_at TEXT, last_seen_at TEXT, user_agent TEXT NOT NULL DEFAULT '' );
```

### 视图与触发器

查询结果没有返回 view 对象。触发器如下：

```sql
CREATE TRIGGER trg_audit_events_no_delete BEFORE DELETE ON admin_audit_events BEGIN SELECT RAISE(ABORT, 'admin_audit_events is append-only'); END;
CREATE TRIGGER trg_audit_events_no_update BEFORE UPDATE ON admin_audit_events BEGIN SELECT RAISE(ABORT, 'admin_audit_events is append-only'); END;
```

## 后续变更记录

| 日期 | 批次/版本 | 变更内容 | 验证方式 | 影响数据库 |
|---|---|---|---|---|
| 2026-11-28 | BASELINE-001 | 首次记录用户提供的 sqlite_master schema-only 快照 | Cloudflare D1 Console 用户执行只读查询 | starjump-staging |
