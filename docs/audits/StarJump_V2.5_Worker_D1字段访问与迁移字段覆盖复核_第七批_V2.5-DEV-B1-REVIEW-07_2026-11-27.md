# 星跃管理平台 V2.5 DEV：D1 字段访问与迁移字段覆盖复核（第七批）

- 版本标识：`V2.5-DEV-B1-REVIEW-07`
- 日期：2026-11-27
- 阶段：DEV 静态 SQL 字段核查
- 对象：`releases/v2.5-batch1/Worker.js`
- Worker blob：`5a2739d981e1835e692a04b903052f268fed981a`
- 前置报告：`V2.5-DEV-B1-REVIEW-05`

> 方法说明：扫描 Worker 中 SQL 模板/字符串，提取常见 FROM/JOIN/UPDATE/INTO 别名字段、INSERT 列清单和 UPDATE SET 字段，再与迁移 CREATE TABLE 列定义比对。这是静态启发式分析，不是完整 SQL 解析器；动态 SQL、无别名字段、表达式、触发器和真实 D1 schema 仍需独立验证。未执行 SQL。

## 一、字段覆盖比对结论

- 当前迁移清单包含 18 张 CREATE TABLE。
- 对 Worker 可识别的字段访问进行比对后，18 张表中发现 1 个需要特别标注的字段：`convert_links.owner_key`。
- 该字段不在 CREATE TABLE 初始定义内，但后续迁移代码确实尝试通过 `ALTER TABLE convert_links ADD COLUMN owner_key TEXT` 添加。
- 因此它不是“完全没有迁移语句”，但当前 ALTER 逻辑依赖运行时尝试，不能只凭 CREATE TABLE 定义判断结构已经齐全。
- 其余 17 张新建表，在本次可识别的字段引用与 CREATE TABLE 列定义之间未发现明确缺列；这不等于真实 D1 结构已通过核验。

## 二、18 张迁移表的声明字段清单

| 表 | CREATE TABLE 声明字段 |
|---|---|
| `convert_links` | id, payload, targets, group_name, owner_user_id, ip_hash, hits, created_at, last_used_at, expires_at, revoked_at |
| `admin_vip_cards` | id, code, days, status, note, created_by, created_at, used_by, used_at |
| `admin_vip_activations` | id, user_id, card_id, days, kind, starts_at, ends_at, created_at |
| `app_cards` | id, code, admin_user_id, days, status, created_at, used_at, activated_at, expires_at, inactive_at, inactive_reason, restored_at, manual_disabled |
| `node_lifecycle` | node_id, source_id, state, fail_streak, first_check_at, last_check_at, observation_started_at, stale_at, updated_at |
| `app_entitlements` | id, admin_user_id, device_id, card_id, starts_at, expires_at, status, created_at, purge_at |
| `rate_limits` | bucket, count, updated_at |
| `app_links` | id, admin_user_id, title, url, sort, enabled, created_at |
| `app_groups` | id, admin_user_id, name, mode, sort, enabled, created_at |
| `app_group_sources` | group_id, source_id |
| `app_group_members` | group_id, device_id |
| `app_free_grants` | device_id, admin_user_id, granted_at |
| `admin_share_codes` | admin_user_id, code, created_at |
| `download_links` | id, scope, admin_user_id, title, url, sort, enabled, created_at |
| `app_card_events` | id, card_id, admin_user_id, action, detail, device_id, created_at |
| `releases` | id, platform, version_code, version_name, min_version_code, url, notes, force, created_at |
| `announcements` | id, scope, title, body, level, starts_at, ends_at, active, created_at |
| `admin_app_perms` | admin_user_id, links_enabled, max_links, free_group_enabled |

注意：`convert_links.owner_key`、`node_sync_logs` 的若干字段和 `admin_app_perms.free_group_enabled` 还涉及 ALTER TABLE；实际是否添加成功，不能由静态源码证明。

## 三、基础表字段依赖（未由当前迁移创建）

本次扫描识别到以下表的字段访问，但没有找到它们在当前迁移清单中的 CREATE TABLE。下列字段是代码访问线索，不是完整 schema 定义：

| 基础表 | Worker 可识别的字段访问 |
|---|---|
| `app_users` | id, username, password_hash, role, status, display_name, created_at, updated_at, failed_login_count, locked_until, last_login_at |
| `user_sessions` | id, user_id, acting_as_user_id, scope_id, token_hash, expires_at, revoked_at, last_seen_at, user_agent |
| `admin_user_scopes` | id, admin_user_id, target_user_id, scope, granted_by, reason, expires_at, revoked_at |
| `subscription_sources` | id, name, url, priority, enabled, tier, remark, created_at, updated_at |
| `source_ownership` | source_id, user_id, assigned_by |
| `source_approvals` | source_id, status, requested_by, reviewed_by, reason, created_at, reviewed_at |
| `subscription_sync_state` | source_id, generation, last_task_id, last_manifest_hash, lease_owner, lease_token_hash, lease_expires_at, last_success_at, updated_at |
| `sync_tasks` | id, source_id, actor_user_id, trigger_kind, status, generation, lease_owner, lease_token_hash, node_count, staged_count, missing_count, manifest_hash, error_message, created_at, updated_at, committed_at |
| `sync_task_stage` | task_id, seq, node_key, payload |
| `sync_task_manifests` | task_id, canonicalization_version, node_count, stage_hash |
| `node_records` | id, source_id, source_name, fingerprint, name, protocol, server, port, tier, enabled, uri, last_seen, created_at, updated_at |
| `node_groups` | id, user_id, name, remark, sort_order, created_at, updated_at |
| `node_group_members` | group_id, node_id, user_id, node_kind |
| `node_overrides` | user_id, node_id, field_name, override_value, reason, updated_by, updated_at |
| `node_user_metadata` | user_id, node_id, node_kind, favorite, remark, sort_order |
| `node_identity_aliases` | fingerprint, identity_key, source_id |
| `user_manual_nodes` | id, user_id, name, protocol, server, port, tier, enabled, uri, remark, created_at, updated_at |
| `source_quota` | source_id, total_bytes, used_bytes, remaining_bytes, upload_bytes, download_bytes, status, profile_title, last_attempt_at, last_success_at, expires_at, error_message |
| `app_settings` | key, value, updated_at |
| `admin_audit` | action, detail |
| `admin_audit_events` | actor_user_id, effective_user_id, action, target_type, target_id, request_id, before_json, after_json, result, reason, detail |

重要限制：
- SQL 扫描无法推断这些基础表的完整字段、类型、默认值、索引和约束。
- `admin_audit` 与 `admin_audit_events` 是两个独立表名，不能误合并。
- `node_sync_logs` 在 Worker 中有读写字段，但没有 CREATE TABLE；仅见 ALTER TABLE 尝试。这张表必须作为高优先级基础 schema 缺口核查。
- 本清单不应直接转换成 CREATE TABLE 脚本。先以只读方式取得目标 D1 的真实 schema，再核对历史数据和兼容性。

## 四、数据库实施优先级

### P0：迁移前必须明确

1. 确认 Worker 真实绑定名与目标 D1 身份；代码使用 `env.DB`，但仓库源码不能证明 Cloudflare 实际绑定到了哪一个 D1。
2. 对 22 张基础表逐张读取 `sqlite_master`、`PRAGMA table_info`、`PRAGMA index_list`、`PRAGMA foreign_key_list`。
3. 对 `node_sync_logs` 确认是否存在；若不存在，先追溯原始系统建表来源，不得凭字段访问猜建表。
4. 对 `convert_links.owner_key`、`node_sync_logs` 三个 ALTER 字段、`admin_app_perms.free_group_enabled` 核对实际是否存在及数据兼容性。

### P1：一键升级框架

1. 只读 schema manifest 必须包含表、字段、类型、NOT NULL、默认值、主键、唯一约束、索引、外键。
2. migration ledger 保存 migration_id、checksum、依赖、执行状态、开始/结束时间、操作者和验证结果。
3. 执行前显示 dry-run 差异；执行后重新读取 schema 并按 manifest 复核。
4. 任一必要基础表缺失或结构未知时，停止自动升级并显示明确原因。
5. 只允许经审查的增量变更；不 DROP、不 TRUNCATE、不重建正式业务表。

## 五、部署与测试声明

- 本批只增加字段访问/迁移覆盖审计文档。
- 未修改 Worker、HTML、D1、Secrets 或 Cloudflare 配置。
- 未执行 SQL，未读取生产 D1，未进行线上 API 测试。
- 本报告为 DEV 静态审计，不是 schema manifest 成品或迁移脚本，不可部署。
