# 星跃 V2.5 D1 字段映射与正式修复优先级（只读核查版，2026-11-27）

> 状态：源码字段盘点 / 数据库核查准备，不是正式 D1 schema 导出，不是迁移脚本。
> 仓库：`sxna-web/XYmonihtml`，分支：`main`
> Worker 基线：`原始StarJump_V1点0_Final-zip-26-11-25-14:56/Worker.js`
> Worker blob SHA：`5da7aa3582558d9da2c2a0ad25a63c5e95e9fe63`
> 只读：未访问生产 D1、未执行 SQL、未修改 Worker/Secrets/Cron、未部署。

## 1. 最重要的数据库结论

当前可见的 Worker 含有 `MIGRATE_STATEMENTS`，但它只是代码中某个历史版本的建表/补列清单，**不能证明生产 D1 当前就具有这些结构**，也不能证明这些定义覆盖了所有业务表。

本次源码中：
- 明确找到 20 余个业务表的 SQL 引用；
- `MIGRATE_STATEMENTS` 仅列出其中一部分表的 CREATE TABLE 定义；
- 还有 `app_users`、`user_sessions`、`subscription_sources`、`source_ownership`、`node_records`、`node_sync_logs`、`admin_audit_events` 等表被 Worker 使用，但本次迁移数组没有提供它们完整的建表定义；
- Worker 迁移路由会尝试 CREATE、ALTER、CREATE INDEX，且部分错误被忽略；它不是只读 schema 检查。

**严禁为了“补齐表结构”而调用 `POST /api/super/migrate`。** 必须先从用户确认的正式 D1 绑定执行只读 `sqlite_master`、`PRAGMA table_info`、`PRAGMA index_list` 核查，并将结果脱敏保存。当前尚未取得正式 D1 的这些结果。

此前出现过的 `starjump-staging` 是测试库线索，不得视为生产 D1；用户曾明确表示不再使用的 `starjump-db` 不纳入当前目标。

## 2. 字段证据等级

| 等级 | 含义 | 本文处理方式 |
|---|---|---|
| A：Worker 明确 DDL | Worker 的 `MIGRATE_STATEMENTS` 有 CREATE TABLE 字段定义 | 可作为“源码内迁移定义”记录，不等于生产现状 |
| B：Worker SQL 使用 | SELECT/INSERT/UPDATE 明确引用字段，但本次未找到建表 DDL | 记录为源码依赖字段，必须 PRAGMA 核实 |
| C：业务需求字段 | V2.5 需求需要，但当前代码/DDL 未见可靠证据 | 标为待设计，不得直接 ALTER |
| D：生产实库 | 真实正式 D1 的 sqlite_master/PRAGMA 输出 | 当前缺失，需后续只读核验 |

## 3. 身份、用户、VIP 数据映射

### 3.1 `app_users`（等级/账号/角色基础表）

**证据等级：B（Worker SQL 使用，当前迁移数组未提供完整 CREATE TABLE）**

Worker 明确使用的字段：
- `id`：用户主键；
- `username`：登录名，注册时查询重复；
- `display_name`：显示名称；
- `password_hash`：密码哈希；
- `role`：角色，包含 `super_admin` 等；
- `status`：账号状态；
- `failed_login_count`、`locked_until`：登录失败锁定；
- `last_login_at`、`created_at`、`updated_at`：时间字段。

关联关系：
- `user_sessions.user_id -> app_users.id`
- `admin_vip_activations.user_id -> app_users.id`
- 多个管理员业务表通过 `admin_user_id -> app_users.id` 形成归属关系。

核查重点：
- username 是否有 UNIQUE 约束；
- role/status 的合法枚举与默认值；
- 是否存在已删除/停用用户的历史数据保留策略；
- 是否存在同一用户多身份绑定等额外字段。

### 3.2 `user_sessions`（登录会话及协助会话）

**证据等级：B**

Worker 明确使用字段：
- `id`、`user_id`、`token_hash`、`expires_at`、`revoked_at`；
- `last_seen_at`、`user_agent`；
- 协助会话使用 `acting_as_user_id`、`scope_id`；
- 登录/会话路径还会使用会话创建时间字段（需以 PRAGMA 核实）。

核查重点：
- `token_hash` 是否 UNIQUE；
- expires_at、revoked_at 是否有索引；
- 协助会话 scope 是否通过独立表 `admin_user_scopes` 管理；
- 撤销会话是否有索引，避免用户退出/改密时全表扫描。

安全要求：D1 只保存 Token 哈希；绝不能导出或记录明文 Session Token。

### 3.3 `admin_vip_cards`（后台管理员 VIP 卡池）

**证据等级：A（源码迁移定义）**

源码 DDL 字段：
- `id` TEXT PRIMARY KEY
- `code` TEXT NOT NULL UNIQUE
- `days` INTEGER NOT NULL
- `status` TEXT NOT NULL DEFAULT 'unused'
- `note` TEXT NOT NULL DEFAULT ''
- `created_by` TEXT NOT NULL
- `created_at` TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
- `used_by` TEXT
- `used_at` TEXT

索引：`status, created_at`。

### 3.4 `admin_vip_activations`（管理员 VIP 激活历史）

**证据等级：A**

源码 DDL 字段：
- `id`、`user_id`、`card_id`、`days`；
- `kind`（默认 formal，代码中区分 trial/formal）；
- `starts_at`、`ends_at`、`created_at`。

索引：`user_id, ends_at`。

重要缺口：
- 当前 `vipStatus()` 聚合 MAX(ends_at)，不能可靠表达当前有效授权的类型；
- 需要通过真实记录核查 trial/formal 值域、是否有重叠激活、是否允许同一用户多条有效授权；
- 不能把 `is_formal` 历史存在标记当成当前正式 VIP 生效证明。

## 4. APP 卡密、分组、授权字段映射

### 4.1 `app_cards`（APP 用户卡密）

**证据等级：A**

源码 DDL 字段：
- `id`、`code`、`admin_user_id`、`days`；
- `status`（默认 normal）；
- `inactive_reason`、`inactive_at`、`restored_at`；
- `manual_disabled`；
- `expires_at`、`activated_at`、`used_at`、`created_at`。

索引：`admin_user_id, status`；`code`。

现有代码状态/原因使用：
- 自动失活原因当前使用 `admin_vip_expired`；
- 人工停用使用 `manual`；
- 用户删除路径使用 `user_deleted`；
- 自动恢复仅筛选 VIP 到期原因、未人工停用、未激活/未使用、卡密自身未过期的记录。

与已确认规则的差异：
- 需求例子倾向 `owner_vip_expired`，现有代码为 `admin_vip_expired`；这是值域命名差异，修复前必须兼容旧数据，不能直接替换。
- trial/formal 来源没有单独记录在 APP 卡密行；体验期到期宽限语义尚未确认。
- 到期后正式 VIP 允许删除历史数据，体验 VIP 到期只读；现有 DELETE 没有相应身份历史判断。

### 4.2 `app_card_events`（APP 卡密事件）

**证据等级：A**

源码 DDL：
- `id` INTEGER PRIMARY KEY AUTOINCREMENT
- `card_id`、`admin_user_id`、`action`
- `detail`、`device_id`、`created_at`

索引：`card_id, created_at`。

需核查是否有外键、事件 detail 是否可能包含卡密明文，以及事件写入是否与卡密状态更新原子执行。

### 4.3 `app_groups`

**证据等级：A**

字段：
- `id`、`admin_user_id`、`name`、`mode`；
- `sort`、`enabled`、`created_at`。

索引：`admin_user_id, sort`。

### 4.4 `app_group_sources` / `app_group_members`

**证据等级：A**

- `app_group_sources(group_id, source_id)`，联合主键；
- `app_group_members(group_id, device_id)`，联合主键。

当前 DDL 未显示外键约束或级联行为。不能推定删除 app_groups 会自动清理关联；Worker 当前显式分多条语句删除，存在非原子风险。

### 4.5 `app_links` / `admin_app_perms`

**证据等级：A**

`app_links`：
- `id`、`admin_user_id`、`title`、`url`；
- `sort`、`enabled`、`created_at`。
- 索引：`admin_user_id, sort`。

`admin_app_perms`：
- `admin_user_id` PRIMARY KEY；
- `links_enabled`、`max_links`、`free_group_enabled`、`updated_at`。
- 迁移路由另有一次 `ADD COLUMN free_group_enabled` 尝试，说明历史 schema 可能有版本差异。

注意：`links_enabled` 是功能开关，不是 VIP 授权字段。

### 4.6 `app_entitlements`

**证据等级：A**

字段：
- `id`、`admin_user_id`、`device_id`、`card_id`；
- `starts_at`、`expires_at`、`purge_at`；
- `status`、`created_at`。

索引：`device_id, status`；`admin_user_id, status`；`expires_at`。

注意：
- 当前设备查询存在只取最新 entitlement 的逻辑，多个有效授权可能被遮蔽；
- 需要明确多管理员授权合并规则；
- Token 签名密钥必须 fail closed，不能使用源码固定默认值。

### 4.7 `app_free_grants` / `admin_share_codes`

**证据等级：A**

`app_free_grants`：
- `device_id`、`admin_user_id`、`granted_at`；
- 联合主键 `device_id, admin_user_id`。

`admin_share_codes`：
- `admin_user_id` PRIMARY KEY；
- `code` UNIQUE；
- `created_at`。

需要核查 share code 的失败次数、限流和封禁信息是否存在独立表/字段；当前静态 DDL 没有显示这些字段。

## 5. 转换归档字段映射

### 5.1 `convert_links`

**证据等级：A（但有后续补列）**

源码初始 DDL：
- `id` PRIMARY KEY
- `payload`、`targets`、`group_name`
- `owner_user_id`
- `ip_hash`、`hits`
- `created_at`、`last_used_at`、`expires_at`、`revoked_at)

后续迁移尝试补列：
- `owner_key` TEXT

索引：
- `expires_at`
- `ip_hash, created_at`
- `group_name`
- 后续尝试 `owner_key, group_name`

代码实际还使用：
- payload 加密保存 formats/meta/sources；
- owner_user_id / owner_key 做用户或访客归属；
- ip_hash 用于 IP 频率限制；
- targets、group_name、hits、last_used_at、expires_at、revoked_at。

需求与当前代码差距：
- 未见 `idempotency_key`、请求摘要、任务状态；
- 未见明确 `save_mode/local_only` 持久字段；
- 未见 payload 版本、key_id；
- 未见编辑快照/版本表、回收站字段/表；
- 未见独立来源 fingerprint/批次关联字段；
- 当前超管列表筛选维度不足。

上述均为 C 级待设计项，先检查真实 D1 和现有数据量，再决定扩列或新表；不能直接追加字段。

## 6. 来源、节点与同步表

以下表在 Worker 中有明确 SQL 引用，但当前 `MIGRATE_STATEMENTS` 未给出完整建表 DDL，全部列为 B 级，必须以正式 D1 PRAGMA 核实。

### 6.1 `subscription_sources`

Worker 依赖字段至少包括：
- `id`、`name`、`url`、`tier`、`enabled`、`priority`、`remark`；
- `created_at`、`updated_at`；
- 多个路由还依赖来源状态、更新时间和所有权关联。

敏感：url 可能含长期订阅凭证，任何 schema 导出/审计材料必须遮罩或不导出实际值。

### 6.2 `source_ownership`

Worker 依赖 `source_id`、`user_id` 等归属字段。需核查唯一约束、来源转移历史是否保留、旧管理员关联撤销是否有独立事件记录。

### 6.3 `node_records`

Worker 依赖字段至少包括：
- `id`、`source_id`、`fingerprint`、`uri`；
- `enabled`、`updated_at`；
- 节点名称、协议、主机、端口及解析元数据（以 PRAGMA 为准）。

敏感：`uri` 可能含账号/密码/密钥，禁止将真实节点 URI 导出到 GitHub。

### 6.4 `node_lifecycle`

**证据等级：A**

源码 DDL：
- `node_id` PRIMARY KEY、`source_id`；
- `fail_streak`、`first_check_at`、`last_check_at`；
- `observation_started_at`、`stale_at`；
- `state`、`updated_at`。

索引：`state`、`source_id`。

### 6.5 `node_sync_logs` / 同步任务表

Worker 使用 `node_sync_logs`，并在迁移路由尝试补充：
- `trigger_kind` TEXT NOT NULL DEFAULT 'manual'
- `duration_ms` INTEGER NOT NULL DEFAULT 0
- `missing_nodes` INTEGER NOT NULL DEFAULT 0

其他同步表还包括：
- `subscription_sync_state`
- `sync_task_manifests`
- `sync_task_stage`
- `sync_tasks)

其完整字段与索引尚未在当前迁移数组中定义，必须独立核查。此前用户曾提供过某个库的 `node_sync_logs` 表信息，但该信息不能替代当前正式 D1 的最新 schema。

## 7. 审计、限流和其他业务表

### 7.1 `admin_audit_events`

**证据等级：B**

Worker 写入/读取字段至少包括：
- `id`、`actor_user_id`、`effective_user_id`；
- `action`、`target_type`、`target_id`；
- `request_id`、`detail`、`result`；
- 时间字段需 PRAGMA 核实。

要求：审计不能只保存自由文本；重要字段应结构化，detail 不得写完整订阅 URL、卡密或 Token。

### 7.2 `admin_audit`

Worker 还使用旧式 `admin_audit(action, detail)`。需核实是否与 `admin_audit_events` 并存、用途是否重叠、未来是否保留兼容。不得未经数据盘点删除旧表。

### 7.3 `rate_limits`

**证据等级：A**

字段：`bucket` PRIMARY KEY、`count`、`updated_at`。
当前全局限流 D1 异常会 fail-open，需修复错误策略；表缺失不应默认为允许请求。

### 7.4 其他 Worker 引用表

当前源码还引用：
- `source_quota`
- `source_approvals`
- `node_group_members`
- `node_overrides`
- `node_user_metadata`
- `node_identity_aliases`
- `admin_user_scopes`
- `download_links`
- `releases`
- `announcements)

其中部分在迁移数组有 A 级 DDL（例如 download_links、releases、announcements），其余需要 D1 PRAGMA。不能因为某表不在 REQUIRED_TABLES 列表就判断业务不再使用。

## 8. 需求字段差距清单（只列设计缺口，不代表必须新增列）

| 业务能力 | 当前源码可见数据 | 待核实/待设计 |
|---|---|---|
| 体验/正式 VIP 状态 | activation.kind、starts_at、ends_at | 当前有效授权类型、多授权优先级、历史状态计算 |
| VIP 管理门禁 | app_users.role/status + activation | 统一动作级授权函数；不能仅靠历史 is_formal |
| APP 卡密宽限 | inactive_reason、inactive_at、restored_at、manual_disabled | trial/formal 来源、owner 到期基准、失效原因兼容 |
| APP 分组撤销/24h 清理 | group/source/member 关系、node_lifecycle | group generation、撤销 tombstone、cleanup task、device ack |
| APP 多管理员 entitlement | app_entitlements | 同设备多有效授权完整返回、管理员选择/合并规则 |
| 设备认证 | device_id、entitlement token | 不可伪造设备凭证、轮换/撤销、绑定事件 |
| 转换幂等 | convert_links.id | idempotency_key、request hash、状态、唯一约束 |
| 转换 local_only | 当前未见明确持久字段 | save_mode、用户云同步可见范围 |
| 转换历史编辑 | 当前只有 payload/group_name | 不可变版本快照、版本号、编辑审计 |
| 转换回收站 | revoked_at 仅撤销短链 | deleted_at、purge_after、恢复状态/审计（设计待定） |
| 密文轮换 | 当前 payload envelope 无 key_id 证据 | envelope version、key_id、迁移/回滚策略 |
| Cron 维护可观测 | 现有任务日志证据不足 | 独立任务状态、last_success/failure、耗时和错误码 |
| 敏感 reveal | audit action | 审计失败 fail closed、原因、频率限制 |
| APP 业务审计 | 通用审计部分存在 | 分组/入口/卡密业务 before-after 原子审计 |

## 9. 正式修复优先级（依赖顺序）

### P0：核实基线，禁止盲改数据库

1. 由用户明确指出当前正式 Worker 与正式 D1 的绑定名称（只需名称，不提供任何密钥）。
2. 只读获取该正式 D1 的 `sqlite_master`、每张核心表 `PRAGMA table_info`、`PRAGMA index_list`、外键信息。
3. 与本文件 A/B 字段清单逐表对比，形成 schema diff。
4. 记录 Worker 当前部署版本/commit 与仓库源文件是否一致；不要用仓库旧文件代表生产部署。
5. 不调用 `/api/super/migrate`，不执行任何 ALTER/CREATE/DELETE。

### P1：服务端权限和身份安全（不先做前端）

1. 修复 VIP 状态解析：区分有效体验、体验到期、有效正式、正式到期、普通注册、超管。
2. 实现动作级授权并封堵 APP 分组、APP 入口、APP 卡密管理写接口。
3. 转换高级 filters 必须有效体验/正式 VIP；L0 无 filters 基础转换仍可用。
4. Session Pepper、APP Token Secret、转换加密密钥缺失时 fail closed；移除固定字符串回退。
5. 修复超管敏感 URL reveal：审计失败不得返回明文。
6. 修复协助会话密码修改 actor/effective 身份混淆。

### P1：生命周期、撤销和维护可靠性

1. Cron 维护与来源同步解耦，0 个来源也必须执行维护任务。
2. 维护失败必须有独立日志和告警，不得 catch 后静默。
3. APP 分组 generation/tombstone、APK 增量同步、设备本地清理、cleanup acknowledgement 形成闭环。
4. 修复 stale 节点过滤、来源重新分配/启用后的旧授权隔离。
5. APP 分组删除及其关联清理/生命周期事件/审计必须原子化。

### P1：转换可靠性与凭证保护

1. 匿名 guest identity 不得回退共享 `g:anonymous`。
2. 转换归档幂等：一次用户动作一个 key，重试复用，主动重复用新 key。
3. 限流 D1 故障不得 fail-open；原子计数和 Retry-After。
4. payload 加密 envelope 版本化，独立密钥轮换兼容旧记录。
5. 转换成功归档、local_only、失败重试和用户云端可见性明确分离。

### P2：管理体验和历史能力

1. 超管转换历史多条件筛选。
2. 转换内容编辑版本快照、回收站、恢复和永久清理。
3. APP 管理业务审计覆盖创建/编辑/删除/来源关联/设备成员/入口删除。
4. 购卡入口到期切换与恢复状态可观测。
5. 数据备份/恢复演练、运行监控、隐私留存和清理策略。

## 10. D1 只读核查 SQL 模板（仅供确认正式库后使用）

以下语句全部是只读查询；执行前仍须确认选中的数据库确实是当前正式 D1。不要把 staging 查询结果冒充生产结果。

### 10.1 列出所有业务表、索引和触发器

```sql
SELECT type, name, tbl_name, sql
FROM sqlite_master
WHERE type IN ('table', 'index', 'trigger')
  AND name NOT LIKE 'sqlite_%'
ORDER BY type, tbl_name, name;
```

### 10.2 查看单张表字段（逐表执行）

```sql
PRAGMA table_info(app_users);
PRAGMA table_info(user_sessions);
PRAGMA table_info(admin_vip_cards);
PRAGMA table_info(admin_vip_activations);
PRAGMA table_info(app_cards);
PRAGMA table_info(app_card_events);
PRAGMA table_info(app_groups);
PRAGMA table_info(app_group_sources);
PRAGMA table_info(app_group_members);
PRAGMA table_info(app_links);
PRAGMA table_info(app_entitlements);
PRAGMA table_info(convert_links);
PRAGMA table_info(subscription_sources);
PRAGMA table_info(source_ownership);
PRAGMA table_info(node_records);
PRAGMA table_info(node_lifecycle);
PRAGMA table_info(node_sync_logs);
PRAGMA table_info(admin_audit_events);
```

### 10.3 查看索引和外键

```sql
PRAGMA index_list(app_cards);
PRAGMA index_list(app_entitlements);
PRAGMA index_list(convert_links);
PRAGMA foreign_key_list(app_groups);
PRAGMA foreign_key_list(app_group_sources);
PRAGMA foreign_key_list(app_group_members);
```

### 10.4 只读核实关键表行数（不读取敏感内容）

```sql
SELECT 'app_users' AS table_name, COUNT(*) AS row_count FROM app_users
UNION ALL SELECT 'admin_vip_cards', COUNT(*) FROM admin_vip_cards
UNION ALL SELECT 'admin_vip_activations', COUNT(*) FROM admin_vip_activations
UNION ALL SELECT 'app_cards', COUNT(*) FROM app_cards
UNION ALL SELECT 'app_entitlements', COUNT(*) FROM app_entitlements
UNION ALL SELECT 'app_groups', COUNT(*) FROM app_groups
UNION ALL SELECT 'convert_links', COUNT(*) FROM convert_links;
```

禁止导出真实卡密 code、订阅 URL、节点 URI、密码哈希、Session token_hash、Token、Secret 或完整用户隐私数据。

## 11. APK 与 Worker/D1 的边界

以下能力不能只靠 Worker/D1 完成，必须等 APK ZIP 解包后核查：
- Token 安全存储、设备身份凭证；
- 多管理员 entitlement 的本地选择与并存；
- 节点缓存版本、撤销墓碑应用顺序；
- 24 小时清理的本地执行与重启恢复；
- cleanup acknowledgement 上传；
- 设备换绑/退出/撤销时本地缓存清理；
- 后台任务受 Android 系统限制时的最迟清理承诺。

当前 6.00.47/6.00.48 ZIP 尚未解包审计，不得声称这些能力已实现。

## 12. 待用户提供/确认的唯一关键事项

**当前正式 D1 的绑定名称是什么？** 只需提供 Cloudflare Worker Settings 中 D1 database binding 对应的数据库名称；不要提供 API Token、密码、Secret 或其他凭证。

如果用户暂时不在电脑旁，继续可以先完善字段设计和 API 契约，但不能把 schema diff 标记为完成，也不能编写针对生产现状的 ALTER 迁移。

## 13. 本轮结论

- 已建立 Worker 源码 DDL 与 SQL 字段依赖映射。
- 已区分源码定义、代码依赖、需求待设计、生产实库待核实四种证据等级。
- 已列出 P0 核实门槛与 P1/P2 修复顺序。
- 尚未获得正式 D1 实际 schema，因此不生成迁移 SQL、不执行迁移。
