# 星跃管理平台 V2.5｜超管账号、协助会话与审计边界核查

> 批次：第十八批  
> 版本标识：V2.5-DEV-B1-REVIEW-18  
> 日期：2026-11-27  
> 状态：DEV 静态源码审计；未修改业务代码  
> 核查分支：repair/v2.5-batch1-auth-vip-app  
> 核查文件：releases/v2.5-batch1/Worker.js、releases/v2.5-batch1/index.html  
> 已阅读：AGENTS.md、V2.5 功能基线、动作级权限门禁矩阵 V1  
> 兼容性：本批只形成审计与修复计划，不修改 Worker、HTML、D1、Secrets、Cron 或生产部署

## 1. 本批结论

候选 Worker 已具备独立超管角色、Bearer Session、超管 API 门禁、限时协助授权（read/operate/manage）、协助会话到期与撤销检查、超管访问拒绝审计等基础安全结构。协助会话不能访问 `/api/super/*` 和旧 `/api/admin/*`，这是正确的纵深防御方向。

但本批发现一个重要的生命周期缺口：超管停用/锁定目标用户时，只撤销以该用户为 `user_id` 的会话；协助会话的 `user_id` 是超管本人、目标用户保存在 `acting_as_user_id`。同时 `resolveSession()` 每次请求只检查会话所有者（超管）的账号状态，没有再次检查被协助用户是否仍为 active。因此目标用户被停用后，既有协助会话在授权未撤销且未过期时仍可能继续访问用户态 API。

另一个重要边界是：超管停用/锁定管理员账号会撤销该账号的网页 Session，但 APP 卡密核销、已有 APP entitlement、APP 节点和分组读取路径没有统一检查管理员账号 status。账号被停用后，APP 侧授权是否应继续有效尚未被业务规则明确规定；这不能直接等同于管理员 VIP 到期规则，必须区分“VIP 到期”“账号停用/锁定”“超管撤销授权”。

## 2. 已核实的安全机制

### 2.1 登录 Session 与角色识别

- `resolveSession()` 要求 Authorization: Bearer。
- 旧 `ADMIN_TOKEN` 被识别为 legacy 超管上下文，仅用于旧 `/api/admin/*` 和 bootstrap；不能直接访问多用户 `/api/super/*` 管理接口。
- 普通 Session 从 `user_sessions` 查询，并校验 token hash、撤销时间、账号存在、账号 status=active、Session 到期时间。
- `isSuper` 从 Session 所属用户的 role 判断，不由客户端提交的 role 字段决定。
- 用户密码修改会撤销其他 Session，保留当前 Session；超管重置密码会撤销目标用户 Session。
- 超管停用/锁定用户会撤销该用户名下的 Session。
- 没有在本批检查范围内发现普通用户可直接通过请求字段将自己提升为超管的路径。

### 2.2 超管 API 隔离

- `/api/super/*` 统一要求有效超管 Session；legacy ADMIN_TOKEN 不可直接调用多数超管管理接口。
- `superRoute()` 再次检查 `ctx.isSuper`。
- 当 `actorId !== effectiveId` 时，协助会话不能访问总后台；仅允许结束自己的协助会话。
- `/api/admin/*` 旧后台只接受 legacy ADMIN_TOKEN 或超管本人 Session；协助会话被拒绝。
- 用户态 API 要求 Session；legacy ADMIN_TOKEN 被拒绝。
- 用户态协助会话按 HTTP 方法粗分 scope：GET=read，DELETE=manage，其余写操作=operate；写操作通过 `userBatch()` 将授权有效性断言放入同一批 D1 操作。

### 2.3 协助授权与会话

- scope 支持 read / operate / manage。
- 授权默认 24 小时；可设 1–720 小时；永久授权必须显式传 permanent=true 且填写 reason。
- 同一管理员、目标用户、scope 已存在有效授权时拒绝重复创建。
- 撤销 scope 时会撤销引用该 scope_id 的协助 Session。
- 启动协助时要求目标用户存在且 status=active，并要求存在未撤销、未过期授权。
- 协助 Session 默认时长由配置决定，限制在 5–240 分钟。
- 协助开始与结束均写入 `admin_audit_events`。
- 超管界面将协助 Token 保存在页面 JS 内存中；页面刷新后该变量丢失。

### 2.4 用户账号管理

- 超管可创建 user 或 super_admin。
- 超管可修改用户状态 active/disabled/locked、role 和 display_name。
- 超管可重置密码；重置后撤销目标账号 Session。
- 降级或停用最后一个有效超管有批内断言保护，防止并发造成超管锁死。
- 本批检查的 `superRoute()` 中未发现物理删除用户的 DELETE 路由；当前提供的是状态停用/锁定，而不是删除账号。

### 2.5 审计机制

- `auditStmt()` 记录 actor_user_id、effective_user_id、action、target_type、target_id、request_id、before_json、after_json、result、reason、detail。
- 多数敏感业务写操作将业务 SQL 与审计 INSERT 放在同一个 D1 batch 中。
- `auditDenied()` 对拒绝事件尝试写入 denied 记录；审计写入失败时仅输出不含敏感值的 console.error，不能保证拒绝事件持久化。
- 超管审计查询按 actor_user_id 可筛选，当前接口查询 `admin_audit_events` 并返回 SELECT * 全字段。
- 旧后台另有 `admin_audit` 表和查询接口，两套审计表并存，需统一检索与保留策略。

## 3. 重要风险与差异

### P1-18-01｜目标用户停用后，既有协助 Session 未被同步撤销

**源码证据：**
- 超管修改目标用户 status 非 active 时，执行的是 `UPDATE user_sessions ... WHERE user_id = targetId`。
- 协助 Session 创建时，`user_sessions.user_id = 超管 actorId`，`acting_as_user_id = targetId`。
- `resolveSession()` 查询 Session 所属用户并检查其 status，但没有查询/检查 `acting_as_user_id` 对应目标用户的 status。
- 每次请求只重新校验 scope 记录是否仍有效，没有检查目标账号是否仍 active。

**影响：** 超管停用或锁定目标用户后，既有协助 Session 可能继续以该用户 effectiveId 访问用户态 API，直到 scope 撤销或 Session 自身到期。这与“停用账号应立即阻断其访问”的常见安全预期不一致。

**建议修复：**
1. 在同一批停用/锁定用户的操作中，撤销 `acting_as_user_id = targetId` 的所有协助 Session。
2. `resolveSession()` 每次解析协助 Session 时，同时确认目标用户仍存在且 status=active。
3. 在用户态写批次的 scopeGuard 之外，增加目标账号状态断言，避免请求期间目标账号被停用的竞态。
4. 账号恢复后不得自动恢复旧协助 Session；需要重新授权/新建协助会话。
5. 为该场景增加并发测试：协助请求与停用操作同时发生时，停用完成后任何新请求均应被拒绝。

### P1-18-02｜管理员账号停用/锁定未统一影响 APP 授权路径

**源码证据：**
- `/api/app/redeem` 根据 app_cards 查询卡密并核销，没有在核销前统一验证对应 admin_user 的 status。
- `/api/app/status` 根据 entitlement、device_id 和 Token 验证授权，没有统一校验 entitlement 对应管理员账号状态。
- APP nodes/groups/links 路径主要按 entitlement 和 device_id 读取；免费分组路径按 admin ID/share code 与权限配置查询。
- 本批未发现上述 APP 读取入口统一调用“管理员账号 active 状态”门禁。

**影响：** 超管将管理员账号设为 disabled/locked 后，网页登录 Session 被撤销，但 APP 用户可能仍能继续核销该管理员未激活卡密，已有 entitlement 也可能继续读取节点/分组/入口。

**规则边界：** 用户已确认“管理员 VIP 到期不自动使已激活 APP 卡密失效”。这不等于“管理员账号被超管停用/锁定后 APP 授权也必须继续有效”。两者是不同事件。

**建议修复前先冻结规则：**
- disabled/locked 是否禁止新 APP 卡密核销？
- 是否立即停止已有 entitlement 的节点/分组更新？
- 是否保留本地 24 小时清理宽限？
- 免费 grant 和公开分享入口是否立即停止？
- 恢复账号后哪些授权可恢复，哪些必须重新核验？

在规则确认前不应直接把 status 检查塞进所有 APP 路径，以免错误破坏已确认的 APP 卡密生命周期。

### P1-18-03｜协助 Session 缺少可见的会话管理与立即撤销入口

- 启动协助时，API 返回一次性 Bearer Token 和有效分钟数。
- 前端把完整 Token 文本显示在状态区域，虽然只保存在内存，但屏幕截图、录屏或旁观者可能看到完整凭证。
- 页面刷新后 JS 内存变量丢失，当前界面无法继续用该 Token 结束协助。
- 后端支持超管本人通过 session_id 结束协助，但界面没有展示活跃协助会话列表、到期时间、目标用户和“立即结束”按钮。
- 目前可依赖 scope 撤销或 Session 到期，但操作不够直观。

建议：前端不显示完整 Token，只显示创建成功、目标用户、scope、到期时间和短 ID；新增超管协助会话列表与立即撤销按钮；页面刷新后仍能从服务端加载会话状态。Token 不得写 localStorage、URL、普通日志或审计 detail。

### P1-18-04｜超管创建接口允许直接创建新的 super_admin

- `POST /api/super/users` 接受 role=user 或 super_admin。
- HTML 用户创建表单直接提供“超级管理员”选项。
- 创建超管会写普通审计，但没有看到独立的二次认证、强制理由或双人审批流程。

这并不表示普通用户可提权：该操作本身仍要求超管身份。但它属于最高权限变更，建议独立成“授予超管身份”动作，要求重新验证超管密码/强认证、填写理由、明确确认，并记录授权人、接收人和前后角色；是否要求双人审批由产品安全策略确认。

### P2-18-05｜审计查询返回全部 before/after 原始 JSON，缺少统一字段脱敏层

- 超管审计查询使用 `SELECT *` 返回审计表所有字段。
- `auditStmt()` 对 before/after/detail 只做 JSON 序列化与长度截断，没有统一敏感字段递归脱敏。
- 具体调用点虽有部分主动遮罩 URL，但无法证明所有调用点都不会把卡密、Token、完整订阅 URL 或其他敏感字段写入审计。

建议：在 audit 写入层集中执行字段级脱敏/白名单，不依赖每个业务调用点记得遮罩；查询 API 只返回界面需要的字段，敏感原文必须走单独的受控 reveal 流程并记录审计。

### P2-18-06｜拒绝事件审计不是强制持久化

`auditDenied()` 写审计失败时只 console.error，主请求仍返回拒绝结果。这有助于避免审计故障改变 401/403，但安全事件可能无法持久化。

建议：对登录失败、越权尝试、协助访问拒绝、账号状态变更等关键安全事件，采用独立可靠队列/重试或监控告警；不能把“console.error 有输出”当成审计闭环。

### P2-18-07｜新旧两套审计表并存

- 新审计：`admin_audit_events`，含 actor/effective/request_id/before/after/result 等结构化字段。
- 旧审计：`admin_audit`，仍被 legacy 管理操作与同步摘要使用。
- 当前超管审计 UI 主要读取 `admin_audit_events`，旧表记录未见统一时间线查询。

建议：建立统一审计检索层，清晰区分历史旧记录与结构化新记录；迁移前只读盘点，不直接删除旧表或改写历史。

### P2-18-08｜scope 粒度按 HTTP 方法推断，未细分动作语义

当前 GET=read、DELETE=manage、其他写操作=operate。这样无法区分：
- 导出/复制/查看敏感凭证；
- 修改普通配置与执行敏感操作；
- POST 形式的撤销、重置、批量清理；
- PUT/PATCH 中可能存在的删除/授权动作。

建议：对每个路由声明显式动作权限，而不是只根据 HTTP method 推断。高风险动作（导出、分享、凭证 reveal、批量删除、权限修改）应独立 scope，默认不授予。

### P2-18-09｜协助授权可被授予给超管目标账号

启动协助检查目标账号存在且 active，但本批未发现明确拒绝目标角色为 super_admin。前端下拉列表过滤了超管，但 API 本身仍应验证。

建议：后端禁止对 super_admin 目标创建普通协助授权；如果未来确实需要超管间应急协助，应设计独立、强审计、双重确认流程，不能依赖前端过滤。

## 4. 账号状态、VIP 状态与 APP 授权必须分离

正式修复应明确以下状态不是同一个概念：

| 状态变化 | 已确认/待确认边界 |
|---|---|
| VIP 自然到期 | 已确认：管理员管理权限失效；已激活 APP 卡密不因管理员 VIP 到期自动失效 |
| 账号 disabled | 超管主动停用账号；对 APP 新核销、已有授权、免费 grant 的影响待确认 |
| 账号 locked | 超管/安全策略锁定账号；是否立即冻结 APP 侧授权待确认 |
| scope revoked | 应立即阻断协助 Session；候选实现已有 scope_id 校验与 Session 撤销 |
| 协助 Session expired | 应立即阻断协助请求；候选实现有到期检查 |
| 超管 role 降级 | 应立即阻断其超管 API；需要同时检查其仍存续的协助 Session 和授权 |

不能用一个 `active` 或 `vip_active` 布尔字段代替上述多条独立生命周期。

## 5. 修复实施顺序（本批不实施）

1. 先补协助 Session 的目标用户状态检查与停用时批量撤销；这是可按现有安全意图实施的最小修复。
2. 补协助 Session 管理界面：列表、立即结束、到期显示；不显示完整 Token。
3. 将 super_admin 授予从普通创建表单拆分，增加强确认/重新认证/理由审计。
4. 为审计写入层设计统一敏感字段脱敏和最小字段查询。
5. 统一新旧审计检索，但先保留旧数据。
6. 将 scope 从 HTTP 方法粗粒度逐步升级为动作级策略；先列出路由矩阵和兼容测试。
7. 由用户确认 disabled/locked 对 APP 新核销、已有 entitlement、免费 grant、分享入口和 24 小时本地清理的具体规则。
8. 只读核实真实 D1 中 user_sessions、admin_user_scopes、app_users、app_entitlements、app_cards 的实际字段、索引和外键，再设计迁移；未经批准不执行生产 SQL。

## 6. 必须补充的测试矩阵

| 场景 | 预期 |
|---|---|
| 普通用户访问 /api/super/* | 403，记录拒绝事件 |
| legacy ADMIN_TOKEN 访问多用户超管 API | 403 |
| 协助 read scope 发起 GET | 允许范围内只读 |
| 协助 read scope 发起 POST/PUT/DELETE | 拒绝 |
| 协助 operate scope 发起普通写操作 | 按显式动作矩阵允许 |
| 协助 operate scope 执行删除 | 拒绝 |
| 协助 manage scope 执行获准删除 | 允许并审计 |
| scope 被撤销后复用旧 Token | 立即拒绝 |
| scope 到期后复用旧 Token | 立即拒绝 |
| 目标用户被 disabled/locked 后复用旧协助 Token | **必须立即拒绝** |
| 目标用户被停用与协助写请求并发 | 不得在停用完成后写入 |
| 超管结束协助会话 | 只撤销协助 Session，不撤销本人登录 Session |
| 页面刷新后查看活跃协助会话 | 可列出并立即结束 |
| 创建/授予 super_admin | 强认证、理由和审计齐全 |
| 最后一个有效超管降级/停用 | 原子拒绝 |
| 超管停用管理员账号 | 网页 Session 立即失效 |
| 管理员账号停用后 APP 核销 | 按用户确认的新规则执行 |
| 管理员账号停用后已有 APP entitlement | 按用户确认的新规则执行 |
| VIP 自然到期但 APP 卡密已激活 | 保持既定规则，不自动失效 |
| 审计内容含 URL/卡密/Token | 入库和 API 返回均脱敏 |
| 审计写入失败 | 关键安全事件触发可靠告警/补偿 |
| 新旧审计表混合检索 | 时间、操作者、目标和动作可区分 |

## 7. 本批边界与结论

- 已完成：阅读 AGENTS.md、功能基线、动作级权限矩阵；静态检查 Worker 的 Session 解析、超管路由、协助授权/启动/结束、用户状态变更、审计查询及 APP entitlement 入口；检查 HTML 用户管理、协助控制与审计 UI。
- 未完成：真实 D1 schema/数据读取、API 集成测试、并发测试、Cloudflare 线上部署核验。
- 未修改：Worker、HTML、D1、Secrets、Cron、生产部署。
- 发布等级：仅 DEV 静态审计，不是 RC，不可部署。

**结论：** 超管与协助访问已有基本隔离，但“目标账号停用后协助会话仍可能有效”是本批优先修复项；管理员账号停用对 APP 授权的影响没有统一门禁，需要先确认产品规则。审计需要补统一脱敏、拒绝事件可靠留存和新旧审计表统一检索。当前不建议把候选 Batch 1 作为正式部署包。
