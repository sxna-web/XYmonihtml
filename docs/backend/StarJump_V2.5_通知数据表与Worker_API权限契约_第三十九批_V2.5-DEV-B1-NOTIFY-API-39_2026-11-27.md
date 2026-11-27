# 星跃管理平台 V2.5：通知数据表、Worker API 与提醒权限契约

- 批次：第三十九批
- 版本标识：V2.5-DEV-B1-NOTIFY-API-39
- 日期：2026-11-27
- 状态：数据库/API 契约设计；未修改 Worker/HTML；未执行 D1；不可部署
- 基线 Worker：原始StarJump_V1点0_Final-zip-26-11-25-14:56/Worker.js（blob 5da7aa3582558d9da2c2a0ad25a63c5e95e9fe63）
- 基线 HTML：星跃模拟后台 1.4.61.html（blob d046f71caa5af96b0c0978013771cb0a8f101739）
- 关联：第三十二批迁移风险审计、第三十三批迁移执行器设计、第三十六批 NAV/RBAC、第三十八批通知中心设计
- 严格边界：只提交契约文档，不创建数据库表、不执行 SQL、不修改生产环境、不改 Cloudflare 绑定/Secrets。

## 1. 本批结论

通知系统采用四类数据实体：
1. notification_events：业务事件/outbox，记录事情实际发生，负责事件幂等。
2. user_notifications：面向具体收件人的站内通知，保存已读、确认、稍后提醒、解决和归档状态。
3. notification_preferences：每个用户的类别偏好、免打扰、提前提醒配置。
4. notification_deliveries：通知投递尝试记录，为未来站内实时刷新/浏览器推送等渠道提供可观测性。

必须区分：事件发生不等于通知已生成；通知生成不等于外部推送已送达；已读不等于已确认；已确认不等于业务问题已解决；归档不等于删除业务记录或审计记录。

当前原 Worker 没有通知 API 路由和通知表，现有 HTML 的 getNotifications() 是前端动态拼装，不是持久通知服务。本批仅设计。

## 2. 原 Worker 路由和权限基线核查

静态复核原 Worker：
- resolveSession() 从 Bearer token 解析会话，返回 actorId、effectiveId、isSuper、scope、session、legacy。
- 多用户接口应从服务端 session 推导身份，不能信任 body/query 中的 user_id。
- 原 Worker 对 /api/super/* 有总管理员本人会话检查；协助会话不能访问总后台，不能把协助会话自动当作超管本人。
- 旧 ADMIN_TOKEN 是 legacy 凭据，不应被用于普通用户通知收件箱或通知偏好。
- 原 Worker 有 auditStmt()、userBatch()，但通知状态变更仍需独立审计策略。
- 原 /api/super/schema-status 只检查现有 REQUIRED_TABLES 的表名，不足以验证通知表字段、索引、约束或 migration checksum。通知表必须纳入未来 migration ledger 和结构检查。

## 3. 数据模型设计

### 3.1 事件表：notification_events

| 字段 | 类型/约束 | 说明 |
|---|---|---|
| id | TEXT PRIMARY KEY | 事件 ID |
| event_key | TEXT NOT NULL | 业务对象 + 事件代次组成的幂等键 |
| event_type | TEXT NOT NULL | 例如 app.card.activated |
| aggregate_type | TEXT NOT NULL | card/device/source/task/admin/system |
| aggregate_id | TEXT NOT NULL | 业务对象内部 ID，不直接展示 |
| generation | INTEGER NOT NULL DEFAULT 1 | 恢复后再次发生时递增 |
| tenant_admin_id | TEXT | 归属管理员，由服务端推导 |
| actor_user_id | TEXT | 触发事件的真实操作者，可空 |
| payload_json | TEXT NOT NULL DEFAULT '{}' | 严格白名单、脱敏后的事件参数 |
| occurred_at | TEXT NOT NULL | 事件实际发生时间 |
| created_at | TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP | 入库时间 |
| processed_at | TEXT | 收件人展开完成时间 |
| processing_status | TEXT NOT NULL | pending/processing/processed/failed |
| attempts | INTEGER NOT NULL DEFAULT 0 | 处理尝试数 |
| last_error_code | TEXT | 脱敏错误码，不存堆栈/凭据 |

索引/约束：
- UNIQUE(event_key, generation)，或将 generation 编入 event_key 后 UNIQUE(event_key)，最终以 migration 实现审查为准。
- INDEX(processing_status, created_at)。
- INDEX(aggregate_type, aggregate_id, occurred_at)。
- payload 不得包含完整卡密、Token、密码、订阅 URL、Cookie、设备秘密标识。
- 事件表不是用户收件箱；一个事件可产生多位合法接收人的通知。

### 3.2 收件箱表：user_notifications

| 字段 | 类型/约束 | 说明 |
|---|---|---|
| id | TEXT PRIMARY KEY | 通知 ID |
| event_id | TEXT NOT NULL | 来源事件 |
| recipient_user_id | TEXT NOT NULL | 收件人，由服务端解析 |
| tenant_admin_id | TEXT | 资源所属管理员 |
| category | TEXT NOT NULL | vip/app/card/device/node/sync/task/security/system/release |
| severity | TEXT NOT NULL | info/success/warning/critical |
| title | TEXT NOT NULL | 脱敏标题 |
| summary | TEXT NOT NULL | 脱敏摘要 |
| action_route | TEXT | 站内路由白名单 ID，不接受任意 URL |
| action_label | TEXT | 操作入口文案 |
| resource_type | TEXT | 关联资源类型 |
| resource_id | TEXT | 关联资源 ID |
| status | TEXT NOT NULL DEFAULT 'unread' | unread/read/acknowledged/resolved/archived |
| created_at | TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP | 创建时间 |
| read_at | TEXT | 已读时间 |
| acknowledged_at | TEXT | 确认时间 |
| resolved_at | TEXT | 解决时间 |
| archived_at | TEXT | 归档时间 |
| remind_at | TEXT | 下次提醒时间 |
| snoozed_until | TEXT | 稍后提醒截止 |
| last_reminded_at | TEXT | 最近一次提醒时间 |
| dedupe_key | TEXT | 单收件人去重键 |

约束：
- UNIQUE(event_id, recipient_user_id)：同一事件给同一用户只生成一条收件箱记录。
- INDEX(recipient_user_id, status, created_at DESC)。
- INDEX(recipient_user_id, remind_at, severity)。
- INDEX(tenant_admin_id, category, created_at)。
- 用户删除通知只允许归档，不物理删除事件/审计。
- status=resolved 只能由业务解决事件或拥有相应业务权限的服务端动作触发，不能由“已读”接口直接设置。

### 3.3 偏好表：notification_preferences

| 字段 | 类型/约束 | 说明 |
|---|---|---|
| user_id | TEXT PRIMARY KEY | 用户 ID |
| category_settings_json | TEXT NOT NULL DEFAULT '{}' | 类别开关/摘要选项 |
| vip_reminder_days_json | TEXT NOT NULL DEFAULT '[7,3,1]' | VIP 提前提醒档位 |
| quiet_hours_enabled | INTEGER NOT NULL DEFAULT 0 | 是否免打扰 |
| quiet_start | TEXT | HH:MM |
| quiet_end | TEXT | HH:MM |
| timezone | TEXT | IANA 时区，如 Asia/Shanghai |
| digest_mode | TEXT NOT NULL DEFAULT 'realtime' | realtime/daily |
| browser_push_enabled | INTEGER NOT NULL DEFAULT 0 | 浏览器推送授权状态 |
| updated_at | TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP | 更新时间 |

安全规则：
- 用户只能读写自己的偏好。
- 偏好关闭普通通知不能阻止业务事件生成，也不能屏蔽 critical 安全/系统风险提示。
- browser_push_enabled=1 不能替代浏览器实际授权；需要单独保存有效订阅并提供撤销能力，未来另行设计。
- 时区必须验证为有效 IANA 时区；无效值拒绝或回退为 UTC 并提示用户确认。

### 3.4 投递表：notification_deliveries

| 字段 | 类型/约束 | 说明 |
|---|---|---|
| id | TEXT PRIMARY KEY | 投递记录 ID |
| notification_id | TEXT NOT NULL | 对应收件箱通知 |
| channel | TEXT NOT NULL | inbox/web_push/email 等 |
| status | TEXT NOT NULL | pending/sent/failed/skipped |
| attempt_no | INTEGER NOT NULL DEFAULT 1 | 尝试次数 |
| provider_message_id | TEXT | 外部渠道返回 ID（如有） |
| error_code | TEXT | 脱敏错误码 |
| created_at | TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP | 创建时间 |
| attempted_at | TEXT | 尝试时间 |
| delivered_at | TEXT | 渠道确认送达时间 |

- UNIQUE(notification_id, channel, attempt_no)。
- INDEX(status, created_at)。
- 当前阶段只实现站内 inbox；没有真正接入外部渠道前，不得将 inbox 入库标记成 web_push/email sent。
- 投递失败重试不能重复生成用户通知。

## 4. 事件幂等和生命周期契约

### 4.1 事件键规则

- vip.expiry:{admin_id}:{expiry_date}:{threshold_days}
- app.card.activated:{card_id}:{activation_generation}
- app.card.grace:{card_id}:{expiry_generation}:{threshold}
- app.device.bound:{user_id}:{device_id}:{binding_generation}
- subscription.sync.failed:{source_id}:{failure_generation}
- task.failed:{task_id}:{run_generation}
- security.account.disabled:{user_id}:{status_generation}

不得只用当前状态字符串作永久去重键，否则恢复后再次失败会被永久吞掉。每次新的失败周期/激活周期/状态变更必须有 generation。

### 4.2 事件处理

1. 业务动作发生并成功提交。
2. 在同一 D1 batch/事务中写入 outbox 事件；如果事件由外部定时检查产生，先用唯一 event_key 原子插入。
3. 事件处理器根据事件类型计算接收人，不能由前端传 recipient。
4. 为每个收件人插入 user_notifications，依赖唯一约束防重复。
5. 记录 inbox 投递结果；后续外部渠道按独立 delivery 记录处理。
6. 业务恢复时生成 recovery event，关闭原提醒周期或将通知标记 resolved。
7. 所有状态变化保留必要审计，不允许普通用户改写原事件内容。

### 4.3 D1 并发与失败

- 事件插入必须使用唯一约束作为最终幂等保障，不能依赖“先 SELECT 再 INSERT”。
- D1 batch 中业务动作与 outbox 插入尽可能原子提交。
- 如果通知展开处理失败，事件保留 pending/failed，支持重试。
- 单个收件人失败不能让其他合法收件人丢失通知。
- 重试使用指数退避并设置最大尝试次数；超限进入待人工检查状态。
- 不在 Worker 请求中执行无上限批量 fan-out；必须分页/分批。
- 多租户接收人计算必须从事件资源 owner 与服务端授权关系得出。

## 5. Worker API 契约

统一前缀：/api/notifications。全部使用 Bearer session；所有返回 Cache-Control: no-store。

### 5.1 收件箱读取

| 方法与路径 | 用途 | 权限 |
|---|---|---|
| GET /api/notifications | 分页查询本人通知 | 有效登录会话 |
| GET /api/notifications/unread-count | 未读/待处理计数 | 有效登录会话 |
| GET /api/notifications/:id | 查看本人通知详情 | 通知 recipient 必须等于 effective user |
| GET /api/notifications/preferences | 读取本人偏好 | 有效登录会话 |

查询参数：
- filter=all/unread/pending/archived
- category 仅允许白名单类别
- severity=info/success/warning/critical
- limit=1..100，默认 30
- cursor 使用稳定游标（created_at + id），不使用可被篡改的任意 SQL offset
- 任何非法参数返回 400；不回退到全量查询。

返回示意（字段为契约，不代表接口已实现）：

    {
      "ok": true,
      "data": [{
        "id": "notification_id",
        "category": "app",
        "severity": "warning",
        "title": "APP 设备发生变化",
        "summary": "有一台新设备完成绑定",
        "status": "unread",
        "created_at": "2026-11-27T10:00:00Z",
        "action": {"route": "app-devices", "label": "查看设备"}
      }],
      "next_cursor": null
    }

### 5.2 通知状态操作

| 方法与路径 | 请求字段 | 规则 |
|---|---|---|
| POST /api/notifications/:id/read | 无 | unread → read；幂等 |
| POST /api/notifications/read-all | filter 可选 | 只影响当前收件人；critical 不会因此 resolved |
| POST /api/notifications/:id/acknowledge | 无 | read/unread → acknowledged；记录时间 |
| POST /api/notifications/:id/snooze | remind_at | 允许的时间范围内；只推迟提醒，不解决事件 |
| POST /api/notifications/:id/archive | 无 | 归档；不能删除事件/审计 |
| POST /api/notifications/:id/resolve | resolution_code | 仅当该类别支持用户处理，且服务端重新验证业务权限与业务状态 |

注意：
- read-all 只对本人记录执行，SQL 必须包含 recipient_user_id。
- 通知 ID 不可作为授权凭据；每个操作都要验证通知属于当前 effective user。
- resolve 不是通用自由文本接口；不同类别必须调用对应业务服务验证真实状态。
- 对同一条通知重复提交状态操作应幂等返回当前状态。

### 5.3 偏好设置

| 方法与路径 | 请求字段 | 规则 |
|---|---|---|
| PUT /api/notifications/preferences | 类别开关、提醒档位、免打扰、时区、摘要模式 | 只更新白名单字段 |
| POST /api/notifications/preferences/test | 可选 | 仅测试站内展示，不伪造外部投递成功 |

偏好写入限制：
- VIP 提醒档位仅允许 30/14/7/3/1 天中的配置子集，默认 7/3/1。
- quiet_start/end 必须同时提供且格式正确。
- daily digest 的发送时间未来另行设计。
- critical 类别开关不允许完全关闭；用户可关闭普通声音/外部推送，但安全提醒仍可见。

## 6. API 身份和权限矩阵

| 会话/角色 | 查询本人通知 | 修改本人状态/偏好 | 查看其他用户通知 | 超管全局通知 |
|---|---:|---:|---:|---:|
| 访客 | 仅访客会话明确支持时 | 仅访客偏好可选 | 否 | 否 |
| 普通注册用户 | 是 | 是 | 否 | 否 |
| 有效 VIP 管理员 | 是 | 是 | 否，除非业务授权明确允许该类资源摘要 | 否 |
| 体验 VIP 管理员 | 是 | 是 | 仅按体验权限范围 | 否 |
| VIP 已到期管理员 | 是，保留其本人通知 | 本人已读/归档等低风险操作；偏好可修改 | 否 | 否 |
| 超管本人会话 | 本人通知；另有明确超管系统通知入口 | 是 | 仅使用明确授权的管理查询接口 | 是 |
| 超管协助会话 | 仅目标用户通知的只读视图，且需明确 read scope；默认建议不提供 | 默认禁止写通知状态和偏好 | 否 | 否 |
| ADMIN_TOKEN legacy | 否 | 否 | 否 | 否 |

额外约束：
- 超管本人全局系统通知与普通收件箱隔离，避免协助会话把超管全局消息带入被协助用户上下文。
- 协助会话即使有 read scope，也不能查看其他租户或超管本人消息。
- 过期 VIP 是否允许查看本人历史通知，不改变其业务资源权限；通知跳转仍须在目标 API 二次鉴权。
- APP 通知按 APP entitlement、管理员 owner、资源归属和具体 action capability 计算接收人。
- VIP 到期与 APP entitlement 生命周期分开：VIP 到期提醒不能错误地宣布已激活 APP entitlement 自动失效。

## 7. 业务事件接入矩阵

| 事件类型 | 产生位置 | 接收对象 | 去重代次 | 默认级别 |
|---|---|---|---|---|
| admin.vip.expiring | VIP 到期计算服务 | 本人管理员 | expiry_date + threshold | warning |
| admin.vip.expired | VIP 状态更新服务 | 本人管理员 | expiry_generation | critical/warning |
| app.card.activated | 卡密激活业务成功后 | 所属管理员；是否通知 APP 用户需产品确认 | activation_generation | success |
| app.card.grace | 卡密宽限期检查 | 所属管理员 | expiry_generation + threshold | warning |
| app.card.revoked | 人工/超管撤销成功后 | 所属管理员；必要时卡密使用者 | status_generation | warning |
| app.device.bound | 设备绑定成功后 | APP 用户；有权限管理员可收摘要 | binding_generation | warning |
| app.device.limit | 设备上限判定 | APP 用户 | limit_generation | warning |
| app.permission.changed | APP 管理授权变更成功后 | 授权方与被授权方（按具体动作） | permission_generation | warning |
| node.sync.failed | 同步任务最终失败 | source owner | failure_generation | warning |
| node.sync.recovered | 同步恢复成功 | source owner | recovery_generation | success |
| task.failed | 任务结束失败 | task owner | run_generation | warning |
| admin.review.pending | 注册/申请成功后 | 有权审核的超管 | application_id | info/warning |
| system.migration.failed | 迁移执行器 | 超管本人会话 | migration_id + run_id | critical |
| system.schema.conflict | 结构校验 | 超管本人会话 | schema fingerprint | critical |
| app.release.published | APP 发布服务 | 目标 APP 用户/管理员 | release_id + audience | info/warning |

卡密 3 天宽限期规则必须沿用项目既定规则：体验管理员与正式 VIP 管理员创建的未激活 APP 卡密均有 3 天宽限；满 3 天才失活。通知提前量不得改变业务失活时间。恢复只恢复 inactive_reason='admin_vip_expired' 的卡密，不恢复人工停用、超管撤销/封禁/作废。

## 8. 通知 UI 与导航契约

- canonical route：notifications，是独立通知中心页面。
- 顶栏铃铛在桌面与手机都可触达，角标只显示未读数；超大数显示 99+。
- 首页仅显示 3-5 条最高优先级未处理提醒，点击进入同一个通知中心。
- 手机通知中心全屏/近全屏，筛选区可折叠，单手可操作。
- 桌面通知中心列表 + 详情区；快捷工具不再复制整套通知列表。
- 页面状态：loading/loaded/empty/error/offline/permission-denied。
- 网络断开时显示最近一次已加载内容并标记“可能不是最新”，不得把本地缓存说成实时状态。
- 跳转 action_route 必须是站内 route allowlist，不接受任意外链或脚本。
- 用户从通知跳转后返回，应保留筛选、滚动位置和通知 ID。

## 9. 通知诊断与审计

诊断开关应输出：
- event_id、event_type、event_key hash、处理状态、尝试次数。
- 生成通知数量、跳过数量、去重数量。
- recipient 数量（仅统计，不输出完整用户列表）。
- 投递渠道、投递状态、耗时、脱敏错误码。
- 处理开始/结束时间和 request_id。

严禁输出：
- 完整卡密、密码、Bearer token、Cookie、完整订阅 URL。
- 通知完整 payload、用户私人消息、设备敏感标识。
- 可直接用于访问资源的签名 URL。

审计事件建议：
- notification.preference.update
- notification.read
- notification.acknowledge
- notification.snooze
- notification.archive
- notification.resolve
- notification.delivery.retry

普通通知可归档；安全审计记录保持 append-only，不允许普通用户或通知清理任务删除。

## 10. 迁移与实施顺序（不执行）

### Migration NTF-001：通知基础表
- 创建 notification_events、user_notifications、notification_preferences、notification_deliveries。
- 创建唯一约束和索引。
- 检查表结构、字段类型、notnull、默认值、索引和唯一约束。
- 不能仅检查表名存在。

### Migration NTF-002：通知 API
- 收件箱分页/计数/详情。
- 已读、全部已读、确认、稍后提醒、归档。
- 偏好读取/更新。
- 每个写接口都加入 owner predicate 和审计。

### Migration NTF-003：事件处理器
- outbox 处理、幂等 fan-out、失败重试。
- 先接入任务失败、订阅同步失败和 VIP 到期等低风险事件。
- 再接入 APP 卡密、设备、授权和系统安全事件。

### Migration NTF-004：UI 接入
- 替换前端临时 getNotifications() 拼装为 API 收件箱。
- 顶栏角标读取 unread-count。
- 增加完整通知中心和偏好设置。
- 旧通知来源在新服务稳定前保留 fallback，但 UI 必须标记数据来源，不能把模拟通知混成真实通知。

### 上线前门禁
1. 在隔离 D1 测试完整 migration 与回滚。
2. 检查所有索引、约束和 migration checksum。
3. 用多用户账号验证收件箱隔离。
4. 测试并发重复事件只产生一条通知。
5. 测试事件恢复后重新失败会产生新一轮通知。
6. 测试超管协助会话和 legacy token 拒绝规则。
7. 测试免打扰与 critical 通知。
8. 测试卡密 code、Token、订阅 URL 不出现在通知和日志中。
9. 只有测试通过且生产 D1 binding/schema 核实后，才进入正式迁移计划。
10. 用户明确授权后才部署；本批不具备部署资格。

## 11. 路由收敛冻结建议

根据第三十八批对照：
- 首页 canonical route：home。旧 dashboard 与 v1-overview 暂留 alias，按角色渲染模块，不丢失访客基础转换与管理员运营概览。
- 转换 canonical route：convert。旧 v1-converter 暂留 alias 并默认进入基础模式；高级转换为同一工作区内权限控制的模式。
- 通知 canonical route：notifications。
- 以上 route alias 只有在新页面通过功能、权限、书签和设备测试后才能移除。

## 12. 本批交付状态与下一批

- 系统版本：V2.5 DEV。
- 本批标识：V2.5-DEV-B1-NOTIFY-API-39。
- 文档设计完成；没有 Worker 代码实现、HTML 改造、D1 建表或 Cloudflare 部署。
- 原 Worker 当前 DB binding 注释指向 starjump-db，用户已明确不再使用；本批不复制该 binding，也不推断生产 D1 binding。
- 生产 schema 未核实，不能执行 NTF-001。
- 第三十批 APP ZIP 源码审计工作流尚未收到运行报告；不能假设 APP 推送/后台限制已审计完成。

下一批建议：第四十批将本契约细化为逐字段 SQL migration 草案、migration checksum/依赖清单、只读 schema 检查输出结构，以及 Worker API 逐接口伪代码/错误码；仍不执行 D1，不改生产 Worker。