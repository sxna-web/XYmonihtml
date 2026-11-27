# 星跃管理平台 V2.5｜网页后端通知优先与邮箱双渠道权限设计

- 批次：第四十四批
- 版本：V2.5-DEV-B1-NOTIFY-WEB-44
- 日期：2026-11-27
- 状态：**需求已纳入；架构/影响分析已完成；实现待进入下一批；不可部署**
- 仓库：sxna-web/XYmonihtml / main
- 关联：第三十八批通知中心设计、第三十九批通知 API 权限契约、第四十一批通知 Migration 草案、第四十三批本地迁移验证器、工具可靠性与会话连续性总方案
- 本批边界：只更新设计/审计文档；不修改 Worker/HTML/D1/Secrets，不连接 Cloudflare，不部署。

## 1. 本批目标与用户最新决定

用户要求优先实现网页后端通知，并为重要通知预留邮箱通道。确认的目标：

1. **第一优先：网页后端通知**。业务事件由 Worker 服务端识别，持久化进入通知中心；前端首页、顶栏铃铛、通知中心、业务页面摘要共享同一套通知 API 和数据源。
2. **VIP 管理员**：开通一个个人网页通知收件箱和一个重要通知邮箱地址。网页收件箱保存完整站内通知；邮箱仅发送符合重要级别/类别策略的提醒。
3. **超级管理员**：开通一个自己的网页通知收件箱和一个业务通知邮箱；同时可在超管专用审计视图中查询所有用户的网页通知记录及邮箱投递记录。
4. **普通用户**：本人账号、本人卡密、本人授权/设备和本人节点使用相关的通知进入本人网页收件箱；不得读取其他用户记录。普通用户邮箱通知不在本批默认开放范围，后续由用户明确决定。
5. **节点/流量异常**：按节点/分组/订阅/设备的真实 owner、管理授权、资源关系计算收件人，不按页面当前选择或客户端传入的 user_id 发通知。
6. **用户卡密异常**：根据卡密所属管理员、卡密使用者、异常类型与处理权限，分别决定通知管理员、用户或超管；不能把卡密明文写入通知/邮件。
7. 邮箱是重要提醒通道，不替代网页收件箱；邮件失败不能导致站内通知丢失。
8. 超管查看所有用户通知内容、邮箱收件地址/投递状态等操作必须受独立超管权限控制并写审计；邮箱地址在普通列表和日志中默认脱敏。

## 2. 收件人和可见范围矩阵

| 身份 | 本人网页通知 | 本人邮箱绑定 | 邮箱提醒 | 查看所有用户通知 | 查看投递记录 |
|---|---|---|---|---|---|
| L0 未注册 | 仅本人可见的基础安全/任务通知（需稳定匿名身份） | 本批不开放 | 本批不开放 | 否 | 否 |
| L1 注册普通用户 | 本人记录 | 本批不开放 | 本批不开放 | 否 | 否 |
| L2 普通 VIP 用户（非管理员） | 本人记录 | 本批不开放 | 本批不开放 | 否 | 否 |
| 有效 VIP 管理员 | 本人网页收件箱 | 一个邮箱，验证后启用 | 重要类别/严重级别 | 否，只能看本人及授权租户范围内业务摘要 | 只能看本人邮件投递状态 |
| VIP 已过期管理员 | 历史通知只读及必要状态提醒，按既有到期权限边界 | 保留已验证地址；暂停需有效 VIP 的管理配置变更 | 关键账号/安全提醒按策略，不因 VIP 到期删除记录 | 否 | 本人记录 |
| 超级管理员 | 本人网页收件箱 | 一个业务通知邮箱，验证后启用 | 超管业务/安全重要通知 | **是，跨用户审计视图** | **是，包含 inbox/email 渠道记录** |

说明：
- “超管可查看所有用户记录”是审计读取能力，不代表超管邮箱自动收到每个用户的全部邮件正文。
- 超管邮箱默认接收系统级、全局安全、节点/流量重大异常、卡密/授权重大异常、投递故障摘要等业务通知；是否额外订阅所有用户的逐条事件，应作为单独可配置策略，避免海量邮件和不必要的个人信息扩散。
- VIP 管理员可查看范围由 tenant_admin_id、资源 owner、分享关系和 capability 决定；不得因为是 VIP 管理员就读取其他管理员数据。
- 超级管理员的全局读取必须使用专用路由/页面和审计，不得复用普通用户收件箱接口伪装成全局查询。

## 3. 通知类别和触发事件

### 3.1 第一阶段网页通知必须覆盖

- 卡密：激活失败、重复使用、异常失活、宽限期开始/即将结束、管理员到期导致失活、异常恢复、超管撤销/封禁。
- 节点/分组：节点不可用、节点订阅解析失败、节点数量异常变化、分组被删除/改型、授权分组同步失败、24 小时清理任务失败。
- 流量：短时间流量突增、异常消耗、超出配置阈值、计量数据中断/异常回退、设备/账号流量与历史基线显著偏离。
- APP：设备绑定异常、授权失败、APP 卡密异常、entitlement 状态异常、同步/清理异常。
- 账号与安全：异常登录、会话风险、账号停用/恢复、敏感操作、越权尝试。
- 系统运行：Worker/API 故障、D1 查询/写入失败、转换任务失败、通知处理积压、迁移失败、备份/恢复失败、版本兼容异常。

### 3.2 重要通知级别

- info：一般状态和完成结果。
- warning：需要关注，可能影响业务。
- critical：已确认的重大异常/安全风险，必须进入站内通知；对启用邮箱的 VIP 管理员和超管按类别策略发送邮件。
- success：重要恢复或处理完成结果。

Critical 不受普通免打扰设置屏蔽。邮件是否发送仍需满足收件邮箱已验证、事件类别在强制策略中、去重和频率限制；若邮箱未验证/投递失败，网页通知仍必须可见。

### 3.3 异常判断不能凭空生成

- 节点离线需有可信探测/同步结果及时间窗。
- 流量异常需有真实计量来源、时间窗口、阈值或基线算法；没有流量数据源时只能提示“数据缺失/未接入”，不能生成虚假超额通知。
- 节点归属必须从服务端数据关系计算。
- 卡密异常必须来自真实激活/状态变更/审计事件，不得从前端错误提示推断。
- 每个事件记录 source_event_id、event_key、generation、occurred_at、resource_type/resource_id（仅非敏感内部 ID）及经过白名单过滤的 payload。

## 4. 网页通知优先架构

推荐链路：

业务 API/定时检测
→ 服务端业务事件
→ notification_events（outbox / 幂等）
→ 收件人策略计算（user / VIP admin / superadmin）
→ user_notifications（每个收件人的网页收件箱）
→ 通知列表/未读数/状态操作 API
→ 首页、铃铛、通知中心和上下文提醒

邮箱阶段后续接入：

user_notifications
→ notification_deliveries（每渠道、每次尝试）
→ 邮件队列/发送 Worker
→ 外部邮件服务
→ webhook 或轮询确认（若供应商支持）
→ 投递状态和脱敏错误码

硬规则：
- 业务事件写入与业务状态提交应尽可能在同一 D1 batch/事务边界；如果无法原子提交，使用可恢复 outbox 和补偿扫描。
- 事件处理采用 lease + fencing token，避免过期 worker 重复完成。
- event_key + generation 幂等；恢复后再次发生异常必须生成新 generation。
- fan-out 每个 recipient 只生成一条站内通知；重试不能重复创建通知。
- 网页通知落库成功与邮箱投递状态分开；邮箱失败不能回滚业务事件或删除站内通知。
- 前端不得自行构造 recipient_id、tenant_admin_id、severity 或收件邮箱。

## 5. 建议数据模型修订（先设计，不执行 D1）

第四十一批 SQL 草案需要调整，原因是现有第四十三批本地迁移表使用 recipient_type/recipient_id，而第三十九/四十一批契约有 recipient_user_id 等不同字段；必须统一后再冻结 migration。

### 5.1 notification_events

建议保留并统一：
- id
- event_key
- generation
- event_type
- category
- severity
- source_event_id
- resource_type
- resource_id
- occurred_at
- payload_json（严格白名单，不存卡密/Token/完整 URL）
- status / attempt_count
- processing_execution_id / lease_expires_at / fencing_token
- created_at / updated_at

### 5.2 user_notifications

建议统一为用户身份收件箱模型：
- id / event_id
- recipient_user_id（统一的用户/管理员主体 ID）
- recipient_kind（user / vip_admin / superadmin；由服务端生成）
- tenant_admin_id（适用时）
- category / severity / title / summary
- resource_type / resource_id
- action_route / action_label（站内路由 allowlist）
- status（unread/read/acknowledged/resolved/archived）
- created_at / read_at / acknowledged_at / resolved_at / archived_at
- remind_at / snoozed_until
- UNIQUE(event_id, recipient_user_id)

超级管理员全局查询从 user_notifications 及 delivery 记录中按权限查询，不为每个用户复制一份“超管收件箱通知”，避免重复和统计混乱。超管自己的通知仍按 recipient_user_id 单独入箱。

### 5.3 notification_preferences

建议按主体 ID 保存：
- recipient_user_id
- category_settings_json
- quiet_hours_enabled / quiet_start / quiet_end / timezone
- digest_mode
- in_app_enabled（关键通知强制启用）
- email_enabled
- email_important_only（VIP 默认 true）
- email_address_ref（关联安全凭证记录，不在偏好 JSON 中存明文邮箱）
- updated_at

### 5.4 notification_email_bindings（建议新增独立表）

- id
- owner_user_id
- owner_kind（vip_admin / superadmin）
- email_ciphertext（必须使用 Worker Secret 管理的加密密钥，禁止明文）
- email_masked
- email_hash（用于唯一性/查重时需评估隐私影响）
- verification_token_hash
- verification_expires_at
- verified_at
- status（pending / verified / disabled / bounced）
- created_at / updated_at
- 一个主体最多一个 active binding；更换地址必须重新验证。
- 邮箱解绑/更换需重新认证或二次确认并审计。
- 不允许把邮箱地址写入普通日志、URL、错误堆栈或 Git。

### 5.5 notification_deliveries

建议一张通用渠道投递表：
- id
- notification_id（指向 user_notifications）
- channel（inbox / email）
- destination_ref（邮箱绑定 ID，不保存明文地址）
- destination_masked
- status（queued / sending / sent / delivered / failed / suppressed）
- attempt_no
- provider_message_id（需清理供应商返回中的敏感信息）
- error_code（稳定错误码）
- next_attempt_at / attempted_at / sent_at / delivered_at
- created_at / updated_at
- UNIQUE(notification_id, channel, attempt_no)

网页收件箱记录本身是 user_notifications；inbox delivery 可作为投递统计记录，但不能把“邮件已送达”与“网页通知已读”混为一谈。若保留 inbox delivery，状态只表示已持久化，不代表用户已读。

### 5.6 超管全局通知审计查询

新增专用只读 API，查询：
- 所有用户网页通知内容（按用户、管理员、类别、严重级别、资源、时间、状态筛选）。
- 对应邮箱投递记录（queued/sent/delivered/failed/suppressed、时间、脱敏邮箱、稳定错误码）。
- 不返回邮件正文全文、验证码、卡密明文、Token、完整订阅 URL。
- 每次全局查询记录 actor_id、过滤条件摘要、时间、结果条数、request_id；不得记录敏感搜索内容。
- 批量导出需另设 capability、二次确认、审计和速率限制。

## 6. API 设计范围（网页第一阶段）

普通用户/管理员：
- GET /api/notifications
- GET /api/notifications/unread-count
- GET /api/notifications/:id
- POST /api/notifications/:id/read
- POST /api/notifications/read-all
- POST /api/notifications/:id/acknowledge
- POST /api/notifications/:id/snooze
- POST /api/notifications/:id/archive
- GET /api/notifications/preferences
- PATCH /api/notifications/preferences

邮箱设置 API（第二阶段，仅已启用角色）：
- POST /api/notifications/email-binding/start
- POST /api/notifications/email-binding/verify
- DELETE /api/notifications/email-binding
- GET /api/notifications/email-binding/status

超管专用：
- GET /api/super/notifications/audit
- GET /api/super/notifications/deliveries
- GET /api/super/notifications/summary

所有 API 必须：
- 从有效 session 获取 actor/effective identity；拒绝 legacy ADMIN_TOKEN。
- 普通收件箱 SQL 强制 recipient_user_id = session effective user ID。
- 超管全局接口要求本人超管 session，不接受协助会话/伪造 isSuper。
- 资源跳转二次检查业务 capability。
- 分页稳定、筛选白名单、限流、Cache-Control: no-store。
- 不因通知 API 不可用阻塞核心业务 API。

## 7. 前端与全局页面接入

- 顶栏铃铛展示当前登录者未读数；不是事件总数。
- 首页工作台显示最高优先级的 3–5 条待处理通知。
- 通知中心为唯一 canonical route：notifications。
- VIP 管理员工作台显示本人租户范围内的节点、流量、卡密、设备、授权、同步通知。
- 超管工作台显示全局系统告警和待处理事项；单独提供全局通知审计页面。
- 业务详情页只展示当前资源关联通知摘要，不再复制整套通知列表。
- 手机端通知中心全屏/近全屏；桌面端列表+详情；所有操作保留筛选与滚动位置。
- 站内通知与“最近使用”严格分开。
- 没有真实 API 时明确显示未连接/演示状态，不能用静态假数据冒充通知。

## 8. 邮箱服务与安全前置条件

本批不指定供应商，也不假设已有可用邮件服务。第二阶段接入前必须：
1. 确认供应商/服务 API、发件域名和 SPF/DKIM/DMARC。
2. 使用 Worker Secret 保存 API Key；不得写入 HTML、仓库、日志或 D1 明文。
3. 先验证邮箱地址归属；验证 token 只存 hash、短时有效、单次使用。
4. 处理退信、投诉、限流、超时、重试和重复邮件；使用 idempotency key。
5. 对重要邮件限频和合并摘要；避免同一节点短时抖动连续轰炸。
6. 用户更换邮箱需重新验证；邮箱未验证不得发送。
7. 邮件正文仅含必要摘要和安全站内链接；不要包含卡密明文、订阅凭证、设备秘密或敏感节点订阅 URL。
8. 超管可审计投递记录，但默认不读取邮件服务商完整原始邮件正文。

## 9. 本批对第四十三批迁移验证器的独立复核发现

### 9.1 已确认问题

1. `runner.run_apply_local()` 预先创建 `schema_migrations` 后，对 `CORE-MIG-001` 特殊分支只写入 checksum 记录，没有执行 CORE SQL。当前 CORE SQL 只是 IF NOT EXISTS 创建账本表，因此实际效果看似相同，但迁移记录与实际执行路径不一致，不能把它当作完整 migration runner 的正确行为。
2. `schema_diff.compare_snapshots()` 只按 object 名称集合报告新增/删除；对于同名 index/view/trigger SQL 定义变化，没有单独报告 changed_objects。fingerprint 会变化，但差异详情不足以定位。
3. 本地测试报告的 20 项通过只证明当前测试覆盖范围内的 SQLite 行为，不证明 Cloudflare D1 语法、事务、锁或并发语义。
4. 现有 `NTF-002.sql` 使用 recipient_type/recipient_id，而旧通知 API 契约使用 recipient_user_id；通知表模型需要统一后再冻结新 migration，禁止直接把当前 SQL 当作最终业务 schema。

### 9.2 本批未做的修复

- 本批没有修改第四十三批 runner、schema_diff 或 migrations；没有新增测试或运行测试。
- 下一批可在隔离 SQLite 范围修复 CORE migration 执行路径、对象定义差异比较和测试盲点，再由独立测试报告确认。
- 不得因为上述修复而把本地 SQLite 工具宣称为 D1 迁移执行器。

## 10. 分阶段实施顺序

### 阶段 A：网页后端通知（最高优先）

1. 冻结统一通知数据模型和 migration ID/checksum。
2. 核对实际 Worker 基线、路由、session 认证、D1 binding/schema；生产未知时只在隔离环境实现和测试。
3. 实现通知 outbox、事件幂等、收件人 fan-out、租约恢复。
4. 实现普通收件箱 API、未读数、已读/确认/稍后提醒/归档、偏好。
5. 实现超管全局通知审计 API，覆盖所有用户的网页通知和渠道投递记录。
6. 实现前端通知中心、铃铛、首页摘要和业务上下文摘要。
7. 先接入可确认的卡密、节点/分组、同步、账号安全、系统运行事件。
8. 流量异常必须等待真实流量计量来源与阈值规则核实后再接入，不得虚构。
9. 完成跨用户、跨管理员、超管、协助会话、legacy token、并发/重试、手机/桌面测试。

### 阶段 B：邮箱绑定和重要提醒

1. 为有效 VIP 管理员和超管开通各自一个邮箱绑定。
2. 完成邮箱验证、更换/解绑、加密存储、审计。
3. 配置 VIP 重要通知与超管业务通知类别。
4. 接入邮件供应商、投递队列、重试/退信/限频。
5. 超管审计界面展示所有用户的 email/inbox 投递记录。
6. 完成邮件重复发送、失败恢复、退信、邮箱更换、敏感信息泄漏测试。

### 阶段 C：运行指标与通知治理

- 节点探测/流量指标可靠性、异常阈值、基线学习、静默窗口。
- 通知规则配置、合并/抑制、告警恢复、事件生命周期与 SLA。
- 可选摘要邮件和更细的角色通知偏好。

## 11. 验收清单

### 网页通知
- [ ] 同一事件按 event_key/generation 幂等。
- [ ] 每个授权接收人仅有一条对应站内通知。
- [ ] A 用户无法读取 B 用户通知。
- [ ] VIP 管理员只能读取自己有权管理的租户/资源通知。
- [ ] 超管本人可查看全局用户网页通知与邮件投递状态，所有查询有审计。
- [ ] 已读、确认、解决、归档语义分开。
- [ ] 业务恢复事件能解决旧告警；再次异常能生成新一代事件。
- [ ] 通知 API 故障不影响核心业务操作。
- [ ] 卡密、Token、订阅 URL、邮件地址等敏感数据不出现在日志/通知摘要。
- [ ] 手机和桌面入口使用同一 API/状态源。

### 邮箱
- [ ] VIP 管理员一个已验证邮箱，超管一个已验证业务邮箱。
- [ ] 未验证邮箱不会收到业务邮件。
- [ ] 重要通知按策略发信；普通网页通知不默认全部邮件轰炸。
- [ ] 邮件失败不影响网页通知记录。
- [ ] 邮件重复投递受 idempotency 和 attempt 控制。
- [ ] 超管可查所有用户 email/inbox 投递状态，但不泄漏邮件正文秘密。
- [ ] 更换/解绑邮箱需重新验证并审计。

### 流量与节点
- [ ] 节点异常来源真实、时间窗可追溯。
- [ ] 流量异常来源真实计量，阈值可解释。
- [ ] 没有流量数据时明确标记未接入，不产生假告警。
- [ ] 节点和流量通知只发给真实 owner/授权接收人。

## 12. 本批交付状态与下一步

- 需求状态：已确认纳入项目。
- 权限和渠道架构：已形成设计。
- 迁移工具复核：已发现 CORE migration 特殊处理与 schema diff 细节不足；未修改。
- Worker/HTML/D1：未修改。
- 测试：本批为静态代码/文档复核，未运行代码测试。
- 邮件供应商：未指定；邮箱绑定/发送尚未实现。
- 生产部署：未操作。
- 下一批建议：先完成第四十三批本地迁移工具的独立复核修正与测试，然后冻结统一通知 schema 和 API 实施清单；在确认实际 Worker/D1 基线前，不进入生产迁移。
