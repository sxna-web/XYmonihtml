# 星跃管理平台 V2.5：通知数据库 Migration 逐字段 SQL 草案与只读结构检查

- 批次：第四十一批
- 版本标识：V2.5-DEV-B1-NTF-MIGRATION-41
- 日期：2026-11-27
- 状态：SQL 草案 / Migration 契约 / 只读检查设计；未执行 SQL、未修改 Worker/HTML、未连接生产 D1，不可部署
- 关联：第三十二批迁移执行器风险审计、第三十三批迁移执行器设计、第三十九批通知数据表与 API 契约、第四十批双产品协同规范
- 适用基线：原始 Worker 与现有通知契约仅用于设计参考；不能据此推断 Cloudflare 线上 Worker、D1 binding 或 schema 当前状态
- 重要约束：不得使用已弃用的 starjump-db；starjump-staging 仅是 staging，不得当生产；生产 binding/schema 未核实前禁止任何写入或迁移

## 1. 本批结论与实施边界

通知持久化采用四张业务表：
1. notification_events：事件 outbox 与事件处理状态。
2. user_notifications：每位收件人的通知收件箱与状态。
3. notification_preferences：用户通知偏好。
4. notification_deliveries：渠道投递尝试记录。

并增加统一迁移账本 schema_migrations 与互斥锁 migration_locks。账本/锁表属于迁移基础设施，不属于通知业务表。

本批提供可审查 SQL 草案、结构指纹规则、Worker API SQL 谓词契约、错误码和隔离测试矩阵。所有 SQL 均为待审查文本，不可直接粘贴到生产 D1 执行。后续必须先由独立实现阶段生成 migration 文件、计算真实 SHA-256、在全新隔离 D1 和已有结构模拟库测试，再进入部署候选。

## 2. 命名、时间与数据约定

- 表名和字段名统一 snake_case。
- 主键 ID 使用服务端生成的不可预测 TEXT ID；不得使用客户端提交的 ID 作为授权依据。
- 时间统一存 UTC ISO-8601 字符串，建议 YYYY-MM-DDTHH:MM:SS.sssZ；SQLite CURRENT_TIMESTAMP 默认值仅作为兼容兜底，正式 Worker 写入应显式传 UTC 时间。
- 布尔字段使用 INTEGER，CHECK 值仅允许 0/1。
- JSON 字段存 TEXT，写入前必须 JSON.stringify 并做字段白名单、长度限制和敏感值扫描；SQLite JSON 函数不能作为唯一校验层。
- 所有状态枚举必须有 CHECK；新增枚举值需要新 migration，不允许静默写入未知状态。
- 不保存密码、Bearer token、Cookie、完整卡密、完整订阅 URL、设备秘密标识或私人消息正文。
- 租户归属字段必须由服务端业务资源查询推导，不能相信请求 body 的 tenant_admin_id / recipient_user_id。
- D1 SQLite 外键只有在连接配置与执行环境实际启用时才可靠；业务授权不能依赖外键代替。

## 3. Migration 账本 SQL 草案

### 3.1 schema_migrations

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  migration_id TEXT PRIMARY KEY,
  checksum_sha256 TEXT NOT NULL CHECK (length(checksum_sha256) = 64),
  depends_on_json TEXT NOT NULL DEFAULT '[]',
  description TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('applied', 'failed', 'rolled_back')),
  execution_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  applied_at TEXT,
  finished_at TEXT,
  schema_fingerprint_before TEXT,
  schema_fingerprint_after TEXT,
  runner_version TEXT NOT NULL,
  error_code TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_schema_migrations_status
  ON schema_migrations(status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_schema_migrations_execution
  ON schema_migrations(execution_id);
```

规则：
- migration_id 唯一且不可复用；checksum 使用实际 migration 文件的 UTF-8 原始字节 SHA-256，换行符规范化策略必须固定并写入构建工具。
- depends_on_json 只记录依赖 ID；执行前必须逐项确认依赖状态为 applied。
- 同一 migration_id 已 applied 且 checksum 相同：返回 already_applied，不重复执行。
- 同一 migration_id 已存在但 checksum 不同：CHECKSUM_MISMATCH，立即停止，禁止覆盖账本。
- 部分失败不得写成 applied；记录 failed 与 execution_id。若 D1 batch 已原子回滚，则记录失败在独立安全路径；若失败记录也无法写入，Worker 返回 EXECUTION_STATE_UNKNOWN 并要求只读复核。
- 不允许通过删除账本行来“重试”。修复应新增 migration 或明确 rollback migration。
- schema_fingerprint_before/after 是结构摘要，不是安全签名；不得作为授权凭据。

### 3.2 migration_locks

```sql
CREATE TABLE IF NOT EXISTS migration_locks (
  lock_name TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL,
  owner_actor_id TEXT NOT NULL,
  fencing_token INTEGER NOT NULL CHECK (fencing_token > 0),
  acquired_at TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL
);
```

- 只允许一个 schema migration 执行器持有 lock_name='schema'。
- 锁获取/续租/释放必须使用原子条件更新，并检查 changes()；仅 SELECT 后再 UPDATE 不足以防竞态。
- 每次成功获取锁 fencing_token 单调递增；执行中每个阶段必须校验 execution_id 与 fencing_token。
- 过期租约不代表旧执行器自动失去写能力；所有写阶段仍须带 fencing 条件。
- D1 不支持跨请求长事务，迁移应拆成可验证的小阶段；单个 migration 不能依赖 Worker 内存状态。

## 4. 通知业务表 SQL 草案

### 4.1 notification_events

```sql
CREATE TABLE IF NOT EXISTS notification_events (
  id TEXT PRIMARY KEY,
  event_key TEXT NOT NULL,
  event_type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
  tenant_admin_id TEXT,
  actor_user_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at TEXT,
  processing_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (processing_status IN ('pending', 'processing', 'processed', 'failed', 'dead_letter')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TEXT,
  last_error_code TEXT,
  UNIQUE(event_key, generation)
);
CREATE INDEX IF NOT EXISTS idx_notification_events_queue
  ON notification_events(processing_status, next_attempt_at, created_at);
CREATE INDEX IF NOT EXISTS idx_notification_events_aggregate
  ON notification_events(aggregate_type, aggregate_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_notification_events_tenant
  ON notification_events(tenant_admin_id, created_at);
```

说明：
- UNIQUE(event_key, generation) 是最终幂等保障；同一事件的新失败周期必须递增 generation。
- payload_json 只允许事件类型对应的白名单字段；不能把整条业务对象序列化入库。
- processing_status=processing 必须配合租约/执行记录，不能因 Worker 中断而永久卡住；后续实现应增加 processing_execution_id 与 lease_expires_at，或使用独立事件执行表。若在本批冻结 SQL 时选择增加字段，必须同步更新 checksum 和结构验收。
- last_error_code 只存稳定错误码，不存异常堆栈或原始请求体。

### 4.2 user_notifications

```sql
CREATE TABLE IF NOT EXISTS user_notifications (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES notification_events(id) ON DELETE RESTRICT,
  recipient_user_id TEXT NOT NULL,
  tenant_admin_id TEXT,
  category TEXT NOT NULL
    CHECK (category IN ('vip','app','card','device','node','sync','task','security','system','release')),
  severity TEXT NOT NULL
    CHECK (severity IN ('info','success','warning','critical')),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  summary TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 1000),
  action_route TEXT,
  action_label TEXT,
  resource_type TEXT,
  resource_id TEXT,
  status TEXT NOT NULL DEFAULT 'unread'
    CHECK (status IN ('unread','read','acknowledged','resolved','archived')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  read_at TEXT,
  acknowledged_at TEXT,
  resolved_at TEXT,
  archived_at TEXT,
  remind_at TEXT,
  snoozed_until TEXT,
  last_reminded_at TEXT,
  dedupe_key TEXT,
  UNIQUE(event_id, recipient_user_id)
);
CREATE INDEX IF NOT EXISTS idx_user_notifications_inbox
  ON user_notifications(recipient_user_id, status, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_user_notifications_reminders
  ON user_notifications(status, remind_at, severity);
CREATE INDEX IF NOT EXISTS idx_user_notifications_tenant
  ON user_notifications(tenant_admin_id, category, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_notifications_resource
  ON user_notifications(resource_type, resource_id, created_at DESC);
```

说明：
- event_id 使用 RESTRICT，避免通知清理误删来源事件；用户操作只能归档。
- recipient_user_id 必须从服务端会话与业务接收人规则推导。
- action_route 仅允许站内路由 allowlist；禁止任意 URL、javascript: 或外部跳转。
- resolved 只能由真实业务恢复事件或具备对应 capability 的服务端动作设置。
- 状态变化时必须写入对应时间戳；同一状态重复请求幂等，不得重置首次 read_at/acknowledged_at。
- 归档不代表删除；归档后仍保留审计和事件关联。
- 组合索引顺序需用隔离数据 EXPLAIN QUERY PLAN 验证，不可仅凭字段数量认定有效。

### 4.3 notification_preferences

```sql
CREATE TABLE IF NOT EXISTS notification_preferences (
  user_id TEXT PRIMARY KEY,
  category_settings_json TEXT NOT NULL DEFAULT '{}',
  vip_reminder_days_json TEXT NOT NULL DEFAULT '[7,3,1]',
  quiet_hours_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (quiet_hours_enabled IN (0,1)),
  quiet_start TEXT,
  quiet_end TEXT,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  digest_mode TEXT NOT NULL DEFAULT 'realtime'
    CHECK (digest_mode IN ('realtime','daily')),
  browser_push_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (browser_push_enabled IN (0,1)),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (quiet_hours_enabled = 0)
    OR (
      quiet_hours_enabled = 1
      AND quiet_start GLOB '[0-2][0-9]:[0-5][0-9]'
      AND quiet_end GLOB '[0-2][0-9]:[0-5][0-9]'
      AND substr(quiet_start,1,2) BETWEEN '00' AND '23'
      AND substr(quiet_end,1,2) BETWEEN '00' AND '23'
    )
  )
);
```

说明：
- SQLite CHECK 只能验证时间字符串形状，IANA timezone 必须由 Worker 使用可信时区库/运行时能力验证。
- quiet_hours_enabled=0 时保留或清空 quiet_start/end 由产品实现统一决定；建议保留用户配置，关闭时不生效。
- VIP 提醒档位只允许 30/14/7/3/1 的子集，且数组必须去重、升序/降序规范化；数据库 JSON 字段不替代 Worker 校验。
- critical 通知不得通过偏好关闭；普通通知免打扰只影响展示/投递时机，不阻止事件入库。
- browser_push_enabled 仅表示用户设置意图，不代表浏览器授权或推送已送达。

### 4.4 notification_deliveries

```sql
CREATE TABLE IF NOT EXISTS notification_deliveries (
  id TEXT PRIMARY KEY,
  notification_id TEXT NOT NULL REFERENCES user_notifications(id) ON DELETE RESTRICT,
  channel TEXT NOT NULL CHECK (channel IN ('inbox','web_push','email')),
  status TEXT NOT NULL CHECK (status IN ('pending','sent','failed','skipped')),
  attempt_no INTEGER NOT NULL DEFAULT 1 CHECK (attempt_no > 0),
  provider_message_id TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  attempted_at TEXT,
  delivered_at TEXT,
  UNIQUE(notification_id, channel, attempt_no)
);
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_queue
  ON notification_deliveries(status, created_at);
CREATE INDEX IF NOT EXISTS idx_notification_deliveries_notification
  ON notification_deliveries(notification_id, channel, attempt_no);
```

说明：
- 当前首期只启用 inbox；只有真正接入并验证外部渠道后，才可写 web_push/email sent。
- inbox 记录只代表站内通知成功写入，不代表用户已读。
- 外部渠道重试产生新的 attempt_no，不得重复创建 user_notifications。
- provider_message_id 需确认不会包含访问凭据；敏感返回值不得保存。

## 5. 迁移拆分与依赖

| Migration ID | 内容 | 依赖 | 失败处理 |
|---|---|---|---|
| CORE-MIG-001 | schema_migrations 与 migration_locks | 无 | 基础设施失败即停止所有后续迁移 |
| NTF-001 | 四张通知表、CHECK、外键、索引 | CORE-MIG-001 | 原子失败后只读复核，修复用新 migration |
| NTF-002 | 事件处理租约/死信字段或辅助表（冻结前二选一） | NTF-001 | 不允许手工改表后继续 |
| NTF-003 | 通知 API 所需查询索引与审计扩展（如确有需要） | NTF-001 | 仅新增迁移，不覆盖旧 checksum |
| NTF-004 | 事件触发器接入与历史动态通知兼容层 | NTF-001, NTF-003 | 按事件类型逐项启用，失败可关闭新事件生产 |
| NTF-005 | 通知 UI API 切换与旧模拟通知下线 | NTF-004 | feature flag 回退 UI，不删除已持久化数据 |

说明：本表是建议拆分。NTF-002 的处理租约方案必须在实际实现前冻结，不能让 processing 状态缺少恢复机制。每个 migration 的 checksum 必须由最终 SQL 文件自动计算并写入发布清单；本设计文档不伪造 checksum 值。

## 6. 只读 schema 检查契约

检查端点建议：GET /api/super/schema-status?scope=notifications
- 必须为超级管理员本人有效 session：ctx.isSuper=true、ctx.legacy=false、ctx.actorId===ctx.effectiveId。
- 协助会话、legacy ADMIN_TOKEN、普通管理员、访客均拒绝。
- GET 只执行 sqlite_master、PRAGMA table_info、PRAGMA index_list、PRAGMA index_info、PRAGMA foreign_key_list 查询。
- 不允许调用 migrate、CREATE、ALTER、DROP、INSERT、UPDATE、DELETE、REINDEX、VACUUM。
- 返回 Cache-Control: no-store；不输出用户数据、卡密、Token、完整 URL。

只读检查步骤：
1. 查询 sqlite_master 中目标表、索引、触发器的定义。
2. 对每张目标表执行 PRAGMA table_info(table_name)，核对 cid/name/type/notnull/dflt_value/pk。
3. 执行 PRAGMA index_list(table_name)，再对每个索引执行 PRAGMA index_info(index_name)，核对唯一性、列顺序。
4. 执行 PRAGMA foreign_key_list(table_name)，核对引用表、列和 on_delete。
5. 读取 schema_migrations 中对应 migration_id、checksum、status、依赖和执行时间。
6. 生成规范化结构对象，按表名/列序/索引/约束排序后计算 fingerprint；字段值缺失或不确定时返回 unknown，不得假装兼容。
7. 将 actual 与 expected 逐项比较，输出 missing_table、missing_column、type_mismatch、nullability_mismatch、default_mismatch、missing_index、index_mismatch、foreign_key_mismatch、checksum_mismatch、dependency_missing。
8. 只读检查结果不得自动修复，不得在 GET 请求中“顺便补表”。

建议响应：
- status: compatible | missing | drift | unknown
- checked_at
- database_binding_label：只输出安全配置别名，不输出真实敏感 binding/凭据
- migrations[]：migration_id、expected_checksum、applied_checksum、status、dependency_status
- tables[]：table、exists、columns、indexes、foreign_keys、differences
- fingerprint：expected/actual
- warnings[]：例如外键 enforcement 未确认、检查范围不完整

## 7. Worker API 实现契约与 SQL owner predicate

### 7.1 身份上下文

每个路由进入后统一要求：
- 有效 Bearer session；ctx 从服务端 resolveSession 得到。
- 普通收件箱要求 ctx.effectiveId 非空，ctx.legacy !== true。
- 不信任 body/query 的 recipient_user_id、user_id、tenant_admin_id、isSuper。
- actorId 与 effectiveId 不同时视为协助会话：默认不允许写通知状态、偏好或读取跨用户收件箱；即使将来开放只读协助视图，也必须使用单独路由、显式 read scope、目标用户审计和字段脱敏。
- 超管全局系统通知使用独立命名空间和路由，不混入被协助用户上下文。
- VIP 到期不改变 APP entitlement；通知跳转目标仍须重新检查对应业务 capability。

### 7.2 列表与未读数

查询必须固定带：
`WHERE recipient_user_id = ?`
绑定值只能来自 ctx.effectiveId。
可选租户筛选必须从服务端授权范围构造，不接受客户端任意 tenant_admin_id。
分页使用稳定游标 (created_at, id)，排序方向固定；游标签名或服务端验证，拒绝篡改、跨用户复用、超范围 limit。
建议错误码：
- AUTH_REQUIRED 401
- LEGACY_CREDENTIAL_FORBIDDEN 403
- IMPERSONATION_SCOPE_FORBIDDEN 403
- INVALID_FILTER 400
- INVALID_CURSOR 400
- NOTIFICATION_NOT_FOUND 404（不泄露其他用户记录是否存在）
- SCHEMA_NOT_READY 503

### 7.3 单条状态操作

所有 SQL 更新均同时包含通知 ID 与收件人：
`WHERE id = ? AND recipient_user_id = ?`
不得先用 id 单独 SELECT 再写入。
read：只允许 unread → read；read_at 仅首次设置。
acknowledge：只允许 read/unread → acknowledged；acknowledged_at 首次设置。
snooze：仅允许未解决、未归档通知；remind_at 必须在当前时间之后且不超过业务允许上限，服务端使用 UTC 校验；不改变 status 为 resolved。
archive：设置 archived/archived_at；不能物理删除。
resolve：调用对应业务服务，重新读取真实业务状态并检查 capability；不能由前端自由指定 resolved。
read-all：必须带 recipient_user_id 条件和合法筛选白名单；不能跨用户批量更新。
偏好：SELECT/UPSERT 的 user_id 只能绑定 ctx.effectiveId；只允许字段白名单更新。

### 7.4 事件 outbox 与 fan-out

- 业务动作成功与 outbox 插入应尽可能放在同一 D1 batch 中。
- 事件接收人由服务端按 event_type、资源 owner、授权关系与 recipient policy 计算。
- INSERT 使用 UNIQUE(event_key,generation) 冲突处理；不能先 SELECT 再 INSERT 作为唯一幂等机制。
- fan-out 采用有限批次，单个接收人失败不得丢失其他接收人；每条收件箱记录 UNIQUE(event_id,recipient_user_id)。
- 事件处理器要有 execution lease、attempts、next_attempt_at 和 dead-letter 恢复路径。
- 恢复事件应将原通知 resolved 或产生关联恢复通知；不能永久去重掉下一次新的失败 generation。
- APP 通知接收人必须按 APP entitlement、管理员 owner 和具体资源权限计算；不能把 APP 用户通知直接发给后台所有管理员。

## 8. 统一通知中心与全局界面联动

本批数据模型对应同一个通知中心，不允许首页、顶栏、APP 管理、节点管理分别建立互不一致的通知数据源。

- canonical route：notifications。
- 顶栏铃铛：显示当前登录用户未读数量；不得把总事件数当未读数。
- 首页工作台：显示 3–5 条最高优先级未处理事项，可按角色配置；点击进入通知中心同一条通知。
- APP 管理工作台：可展示 APP 分类通知摘要和快捷跳转，但数据仍来自同一收件箱 API，并按 APP 管理权限过滤。
- 节点、卡密、用户等页面：仅在当前资源相关时展示上下文提醒；不复制完整通知列表。
- 最近使用与通知提醒是不同概念：最近使用来自访问历史；通知来自真实事件，不能混用。
- 手机：通知中心全屏/近全屏，筛选可折叠，重要操作靠近底部安全区域，触控目标不小于 44px。
- 桌面：列表+详情布局，右侧详情可按需打开；不重复占用全局右侧快捷面板。
- 所有页面允许按业务特点调整布局；快捷入口、最近使用、摘要区按需配置，不要求每页复制相同模板。
- 网络离线显示最近已加载内容并标明可能过期；不得将缓存伪装成实时。
- 通知跳转后返回保留筛选、滚动位置与通知 ID。
- 重要安全通知不受普通免打扰影响；已读不等于解决。

## 9. 业务规则与通知事件边界

- VIP 到期提醒：按 7/3/1 天等偏好生成提醒；不改变 VIP 实际到期逻辑。
- APP 卡密：体验管理员与正式 VIP 管理员创建的未激活 APP 卡密均有 3 天宽限，满 3 天才失活；提醒时间不能改变失活时间。
- 卡密恢复：只恢复 inactive_reason='admin_vip_expired' 的卡密；不得恢复人工停用、超管撤销、封禁或作废。
- APP entitlement 与后台 VIP 分离：VIP 到期不自动让已激活 APP entitlement 失效。
- APP 设备、授权、分组同步、版本发布提醒按各自 owner 和授权范围发送。
- 系统迁移失败、结构冲突等 Critical 通知仅进入超级管理员本人安全通知区，不能通过协助会话暴露。

## 10. 诊断开关与日志字段

诊断开关默认关闭。启用时只输出：
- request_id、execution_id、migration_id、event_id。
- migration checksum 前后比对结果（可展示完整 SHA-256；不得混入秘密）。
- migration lock 的 fencing_token、租约是否有效。
- 表/字段/索引/约束检查数量与差异类型。
- event_type、event_key 的不可逆摘要、处理状态、attempts、生成/去重/跳过计数。
- recipient 数量统计，不输出完整接收人清单。
- duration_ms、稳定 error_code。

禁止输出：
- Token、Cookie、密码、卡密、完整订阅 URL。
- payload 原文、私信正文、设备秘密标识。
- SQL bind 参数中的敏感业务数据。
- 完整异常堆栈回传客户端。

## 11. 隔离 D1 测试矩阵

| 编号 | 测试场景 | 预期 |
|---|---|---|
| T01 | 空白 D1 首次执行 CORE-MIG-001 | 账本/锁表结构正确，重复执行安全 |
| T02 | NTF-001 首次执行 | 四张表、索引、CHECK、FK 与预期一致 |
| T03 | 同 migration_id、同 checksum 重跑 | already_applied，无重复 DDL |
| T04 | 同 migration_id、不同 checksum | CHECKSUM_MISMATCH，停止 |
| T05 | 依赖 migration 缺失 | DEPENDENCY_MISSING，停止 |
| T06 | 两个执行器并发申请锁 | 只有一个取得有效 fencing token |
| T07 | 旧执行器租约过期后继续写 | fencing 校验拒绝旧执行器 |
| T08 | DDL 中途失败 | 不标记 applied；只读检查可识别状态 |
| T09 | 表存在但缺列 | status=drift，不误报 compatible |
| T10 | 列类型/notnull/default 不一致 | 精确报告差异，不自动修复 |
| T11 | 索引缺失/列顺序错误/唯一性不同 | index_mismatch |
| T12 | FK 目标或 ON DELETE 不同 | foreign_key_mismatch |
| T13 | 两个并发相同事件写入 | 唯一约束只保留一条事件 |
| T14 | 同一事件 fan-out 重试 | 每个收件人仅一条通知 |
| T15 | 同一对象恢复后再次失败 | generation 增加，产生新事件 |
| T16 | 用户 A 读取用户 B 通知 ID | 404，不泄露存在性 |
| T17 | read-all 请求篡改 user_id | 忽略客户端身份字段，仅更新本人 |
| T18 | 协助会话写偏好/已读 | 403 |
| T19 | ADMIN_TOKEN 访问通知 API | 403 |
| T20 | VIP 到期但 APP entitlement 有效 | APP entitlement 不被通知流程改变 |
| T21 | 普通通知免打扰 | 事件仍入库，投递按偏好延迟 |
| T22 | Critical 通知免打扰 | 仍按安全策略可见 |
| T23 | snooze 时间过去/过远/非法格式 | 400，状态不变 |
| T24 | 已读后再次 read | 幂等，不覆盖首次 read_at |
| T25 | 通知归档 | 只改状态，不删除事件和审计 |
| T26 | 外部推送尚未接入 | 不产生 web_push/email sent 假记录 |
| T27 | 游标跨用户复用或篡改 | INVALID_CURSOR |
| T28 | 大量事件 fan-out | 分批处理，不超时、不丢收件人 |
| T29 | 诊断开关开启 | 日志脱敏，不输出秘密 |
| T30 | 手机/桌面 UI 通知入口 | 同一 API、同一权限与状态源 |

## 12. 发布与回滚门禁

正式进入可部署候选前必须全部满足：
1. 实际 Cloudflare Worker/D1 binding 名称由用户确认或通过只读部署配置核实；不能猜测，更不能沿用已弃用 binding。
2. 生产 schema 先只读盘点；保存结构快照和迁移前 fingerprint。
3. 每个 migration 文件冻结后由自动化工具计算 SHA-256，并写入 manifest；本设计文档不填虚构 checksum。
4. 在隔离 D1 执行全新安装、重复执行、结构漂移、并发锁、失败恢复和回滚演练。
5. 所有 API 做跨用户、跨租户、协助会话、legacy token 权限测试。
6. Worker 与 HTML 版本兼容清单完成；通知 feature flag 可单独关闭，不删除通知数据。
7. 备份与恢复演练通过；明确哪些 migration 可逆、哪些只能前滚修复。
8. 生产执行必须由用户明确授权；“继续”只授权继续开发，不授权生产数据库变更。
9. 完成后交付与用户现有 Cloudflare 两文件流程匹配的完整 Worker/HTML 更新包、版本说明、部署顺序、回滚包和一键数据库初始化/升级入口。
10. 本批不触碰 Cloudflare、D1、Secrets 或部署。

## 13. 本批实际完成状态

- 已完成：第四十一批设计文档。
- 未完成：migration SQL 文件实现、自动 checksum 生成、只读检查代码、Worker API、事件处理器、HTML 通知中心接入。
- 未执行：任何 D1 SQL、任何 Worker/HTML 修改、任何 Cloudflare 部署。
- 当前状态：V2.5-DEV-B1-NTF-MIGRATION-41 / DESIGN ONLY / NOT DEPLOYABLE。
- 下一批建议：在隔离 SQLite/D1 兼容测试环境实现 CORE-MIG-001 与 NTF-001 的可重复迁移脚本及 schema diff 测试；先解决事件处理租约字段冻结问题，再扩展通知 API。不得直接连接生产库。
