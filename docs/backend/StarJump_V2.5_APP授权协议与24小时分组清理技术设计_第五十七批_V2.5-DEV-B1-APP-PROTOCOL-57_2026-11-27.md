# 星跃管理平台 V2.5｜APP 授权协议与 24 小时分组清理技术设计

- 批次：第五十七批
- 版本：`V2.5-DEV-B1-APP-PROTOCOL-57`
- 日期：2026-11-27
- 状态：**技术设计完成；业务规则按用户本轮回复冻结；未实施、未测试、不可部署**
- 依据：第五十一至第五十六批报告、6.00.47 APP 源码只读核查、仓库 Worker 版本源码及用户本轮确认。
- 本批边界：只形成协议、数据模型草案、状态机、客户端接入点、测试与回滚设计；不修改 Worker/HTML/APK，不创建正式 migration，不连接生产 D1/Secrets，不部署。

## 1. 本轮新增冻结规则

用户对设备数、空分组、分组变更和剩余技术边界作出明确决定：

1. **单卡密设备数**：默认一张卡密最多绑定 1 台设备。有效 VIP 管理员可自行设置上限，范围 1–5 台；超过 5 台只能由超管权限调整。超管调整必须记录操作者、目标管理员、卡密/策略范围、原值、新值、原因和时间。
2. **空分组卡密**：允许卡密不配置 card 专属分组，也允许在空分组状态下激活。空分组不等于授予管理员全部分组。用户可通过管理员身份 ID 获取符合条件的免费分组；通过卡密激活时取得该卡密显式配置的 card 分组，并可同时取得该管理员符合条件的 free 分组。
3. **激活后配置变更**：卡密分组变更同步作用于该卡密所有仍有效的已激活设备；移除/停用/改型的组立即停止服务端继续下发，并触发本地清理流程。
4. **其余技术边界**：按安全优先方案设计，精确 entitlement、管理员隔离、最小授权、失败关闭、可审计、向后兼容；不得用旧 public/assigned 语义扩大 card 授权。

以上是需求冻结，不代表代码已经实现。

## 2. 证据边界与当前差距

### 2.1 已有证据

- 第四十九批 Worker 内嵌 DDL 显示：`app_cards` 有卡密与管理员归属；`app_entitlements` 有 card_id/admin_user_id/device_id；`app_groups` 有管理员归属和 mode；`app_group_sources` 连接组与来源；`app_free_grants` 以 device_id + admin_user_id 记录免费资格。
- 该源码没有 card_id → group_id 的持久关联表，也没有可靠的授权 generation/tombstone/lease/ack 闭环。
- 旧 `/api/app/status`、`groups`、`nodes` 存在 token、latest-only 或授权范围不足问题；不能继续作为新协议的安全基础。
- 6.00.47 源码有 Room 本地分组和 GroupUpdater 刷新生命周期，但未发现当前 Worker entitlement API、card group 协议、generation、lease 或 ack 接入。
- 生产 D1 schema、生产 Worker 版本及 6.00.48 APK 源码仍未核实。6.00.47 只能作为客户端架构接入参考。

### 2.2 设计约束

所有表字段、SQL 均为设计草案，须在隔离环境核对真实 D1 schema 后形成 migration。不能把第四十九批 Worker 内嵌 DDL 当成生产 schema 事实。

## 3. 授权对象与隔离模型

### 3.1 三种不同授权入口

| 入口 | 授权主体 | 可取得内容 | 不创建的对象 |
|---|---|---|---|
| 管理员身份 ID | APP 用户 + 管理员 | 该管理员当前启用且允许分享的 free 分组 | 不创建 card entitlement，不取得 card 组 |
| APP 卡密 | 卡密 + 设备 | 该卡密显式配置的全部有效 card 分组 + 符合条件的管理员 free 分组 | 不取得该管理员其他 card/public/assigned 组 |
| 同一 APP 用户绑定其他管理员 | 另一独立管理员身份/卡密 | 另一管理员自己的 free/card 授权范围 | 不与原管理员授权合并 |

同一 APP 用户可关联多个管理员；同一 APP 用户与同一管理员只保留一条身份绑定关系。不同管理员必须使用独立授权上下文、缓存命名空间、同步游标和清理记录。

### 3.2 单卡密多设备策略

- 默认 `max_devices=1`。
- 有效 VIP 管理员可将其名下卡密策略调整为 1–5；超管可通过独立超管权限将上限提高到 5 以上。
- 卡密实际可用设备数按该卡密下**仍有效、未撤销的唯一 device_id**计数；重复请求同一设备幂等，不重复占额。
- 新设备并发激活必须在数据库事务/原子条件更新中完成“计数 + 占位/创建 entitlement”，不能先查后写造成竞态超额。
- 达到上限时返回稳定错误码 `CARD_DEVICE_LIMIT_REACHED`，不泄露其他设备标识。
- 设备解绑/迁移必须由受控服务端流程执行并审计；客户端不能通过换 device_id 绕过上限。
- 具体设备指纹/重装恢复策略需结合 APK 实际设备标识实现核对，不在本批虚构客户端已有能力。

### 3.3 空分组卡密

允许零个 card 分组。激活成功只建立该卡密 entitlement；可见内容为：
- card 分组：空集合；
- free 分组：若该设备/用户已符合该管理员免费资格且免费组启用，则返回 free 分组；否则空集合。

不得回退到管理员全部来源、public 组或 assigned 组。空分组不能被解释为“默认授权全部”。

## 4. 建议数据关系（非正式 DDL）

建议后续隔离 migration 采用独立关系表，避免把多个分组 ID 塞入卡密文本字段：

### 4.1 卡密与分组关系

`app_card_groups`（建议字段）：
- `card_id`：卡密主键；
- `group_id`：APP card 类型分组主键；
- `created_at`、`created_by`：审计元数据；
- 唯一约束：`(card_id, group_id)`。

写入时必须同时验证 card.admin_user_id = group.admin_user_id = 当前有效管理员身份，且 group 仍启用、类型为 card。删除关联优先采用可审计撤销/版本事件，不在未评估引用关系前物理删除。

### 4.2 设备上限策略

可采用卡密级 `max_devices` 字段或独立策略表；推荐独立策略记录，以保留调整历史：
- `card_id`、`max_devices`、`updated_by`、`updated_at`、`reason`；
- 服务端强制默认值 1；
- 管理员可写范围 1–5；
- 超过 5 的值仅超管可写，且需记录权限来源与审计事件。

真实表名/字段及约束必须在隔离 D1 schema 复核后决定，不在本批创建 migration。

### 4.3 授权版本与清理状态

建议增加可追溯的授权版本/事件模型，至少表达：
- 管理员/卡密/设备/授权实例；
- group_id 与单调递增 generation；
- 事件类型：grant、update、revoke、delete、type_changed、disabled；
- 事件发生时间、原因、操作者；
- 客户端已应用 generation、ack 状态与时间；
- lease 到期时间。

不建议只在 `app_groups` 上增加一个简单 version 字段就宣称满足清理需求：必须能表达单个授权实例的变更、离线设备待清理状态及重复 ack 幂等。

## 5. Worker API v2 契约草案

建议新增明确版本前缀 `/api/app/v2`，旧 API 暂时保留但不再作为新客户端授权依据。所有请求使用 HTTPS、Authorization Header 中的短期访问凭证；Token 不再放 URL query、路径、日志或分析参数。

### 5.1 APP 绑定与授权实例

- `POST /api/app/v2/identity-bindings`
  - 输入：管理员身份 ID、设备注册上下文、客户端请求 nonce。
  - 输出：管理员绑定状态、free 授权实例标识/同步入口；不得返回 card 组。
  - 管理员 ID/分享码只负责解析与绑定，不直接作为节点数据读取凭证。

- `POST /api/app/v2/cards/redeem`
  - 输入：卡密、设备注册上下文、幂等键。
  - 服务端核验卡密状态、期限、管理员、设备上限、VIP/宽限规则；原子创建或复用 entitlement。
  - 输出：该卡密对应的 entitlement_id、短期会话凭证、max_devices、授权摘要。
  - 空 card group 合法；不会扩大授权范围。

- `GET /api/app/v2/entitlements`
  - 返回当前设备可用的授权实例列表；每条包含 entitlement_id、admin_user_id 的非敏感展示信息、card_id 的内部引用、授权类型、状态和过期时间。
  - 多管理员授权逐条返回，禁止 latest-only。

### 5.2 授权读取与增量同步

- `GET /api/app/v2/entitlements/{entitlement_id}/groups`
  - 必须通过精确 entitlement resolver 验证会话、entitlement_id、device_id、状态、有效期和 Token。
  - card entitlement：card 映射的有效 card 组 + 独立符合条件的 free 组。
  - identity/free entitlement：只返回该管理员 free 组。
  - 返回 group_id、group_type、generation、enabled、lease_expires_at、节点清单/引用及 cursor。
  - 不返回其他管理员、其他卡密或未授权组。

- `GET /api/app/v2/entitlements/{entitlement_id}/changes?cursor=...`
  - 返回该 entitlement 自 cursor 后的授权变化、撤销 tombstone、当前 generation 和服务端时间。
  - cursor 仅在 entitlement 范围内有效，不跨管理员复用。

- `POST /api/app/v2/entitlements/{entitlement_id}/ack`
  - 输入：group_id、generation、event_id、结果（applied/removed/failed）、客户端时间、幂等键。
  - 服务端再次验证 entitlement 与设备绑定；ack 仅确认该设备/授权实例已处理该事件。
  - 重复 ack 幂等；旧 generation ack 不得覆盖新 generation；ack 不可恢复已撤销权限。

- `GET /api/app/v2/entitlements/{entitlement_id}/nodes`
  - 仅作为兼容/分批同步接口；查询范围必须由同一 resolver 计算出的 allowed_group_ids 限定。
  - 不允许按 admin_user_id 直接返回管理员全部来源。

### 5.3 管理端卡密配置与设备策略

保留第五十五批建议的管理端子资源：
- `GET /api/user/app-cards/:cardId/groups`
- `PUT /api/user/app-cards/:cardId/groups`
- `GET /api/user/app-cards/:cardId/device-policy`
- `PUT /api/user/app-cards/:cardId/device-policy`

所有写请求必须：
1. 由服务端 Session 确认 effective admin；
2. 检查有效正式/体验 VIP 对应的具体写权限；
3. 验证卡密归属、分组归属、分组类型/启用状态；
4. 对同一管理员内 card_id/group_id 关系逐项验证；
5. 事务写入关系与授权变更事件；
6. 记录 before/after、操作者、原因，不记录卡密明文或 Token。

管理员设备上限接口只能设置 1–5；超管扩展接口必须独立路由/权限，不接受普通管理员通过参数伪造超管权限。

## 6. 精确 entitlement resolver 调用图

所有 APP 数据读取必须经过同一安全边界，不允许每个 handler 自己“按 device_id 取最新一条”。

```text
HTTP Request
  -> Validate method / body / size / rate limit
  -> Extract Authorization credential (never query token)
  -> Resolve authenticated device session
  -> Require explicit entitlement_id
  -> entitlementResolver(entitlement_id, device_id, token/session)
       -> exact parameterized D1 lookup
       -> verify entitlement status + expires_at
       -> verify device binding
       -> load admin_user_id and card_id from DB only
       -> verify card belongs to same admin (when card entitlement)
       -> reject revoked / malformed / unavailable state (fail closed)
  -> Build entitlement-scoped allowed groups
       -> identity entitlement: enabled free groups only
       -> card entitlement: mapped enabled card groups + eligible free groups
       -> never add public/assigned implicitly
  -> Query nodes via allowed group IDs
       -> re-check group.admin_user_id
       -> re-check group mode/enabled
       -> re-check source ownership/status/approval
       -> return only authorized nodes
  -> emit audit/security event (without credentials)
```

第五十二批 resolver 与第五十三批 read policy helper 可作为纯函数/策略基础，但仍需接入实际 Worker handler 并补齐 D1 查询、Token/会话适配；当前状态仍为 NOT_INTEGRATED。

## 7. card/free group 查询 SQL 草案

以下仅表达约束关系，字段名需在隔离 D1 核实后适配，不能直接对生产执行。

### 7.1 card 专属组

```sql
SELECT g.id, g.name, g.mode, g.enabled
FROM app_card_groups AS cg
JOIN app_cards AS c
  ON c.id = cg.card_id
JOIN app_groups AS g
  ON g.id = cg.group_id
WHERE cg.card_id = ?
  AND c.admin_user_id = ?
  AND g.admin_user_id = c.admin_user_id
  AND g.mode = 'card'
  AND g.enabled = 1;
```

### 7.2 free 组

```sql
SELECT g.id, g.name, g.mode, g.enabled
FROM app_groups AS g
JOIN admin_app_perms AS p
  ON p.admin_user_id = g.admin_user_id
WHERE g.admin_user_id = ?
  AND g.mode = 'free'
  AND g.enabled = 1
  AND p.free_group_enabled = 1
  AND EXISTS (
    SELECT 1
    FROM app_free_grants AS fg
    WHERE fg.admin_user_id = g.admin_user_id
      AND fg.device_id = ?
  );
```

说明：
- 管理员身份 ID 绑定需使用经服务端确认的绑定关系/设备上下文，不能仅凭客户端传入 device_id 查询 free grant。
- 卡密入口可在卡密 entitlement 核验后，按免费资格规则读取 free 组。
- 如果未来 free grant 改为 APP 用户身份维度，必须先完成数据模型迁移与旧 grant 兼容方案；本批不假设已存在 user_id 字段。

### 7.3 节点范围查询原则

节点 SQL 必须由允许的 group_id 集合驱动，并在 SQL 中重复验证：
- group_id 属于当前 entitlement；
- group 与 entitlement 的 admin_user_id 一致；
- group 当前 enabled 且类型仍合法；
- source 仍归属该管理员、已批准、已启用；
- 节点属于该 source 且自身可用。

不能仅先查 group，再用不受限的 admin_user_id 查询全部来源节点。

## 8. generation / tombstone / lease / ack 状态机

### 8.1 核心状态

每个 entitlement × group 授权关系独立维护 generation：
- `ACTIVE(g)`：当前授权有效，客户端可同步。
- `CHANGE_PENDING(g+1)`：管理员修改分组/来源或授权关系，服务端发布新 generation。
- `REVOKED(g+1)`：删除、改型、停用、取消卡密关联或管理员撤销；服务端立即停止返回该组节点并产生 tombstone。
- `CLIENT_APPLIED(g+1)`：客户端已应用新授权或完成本地删除。
- `ACKED(g+1)`：服务端验证并记录客户端 ack。
- `LEASE_EXPIRED`：客户端未在租约期限内完成有效同步；必须停止使用该授权缓存并清除到期授权内容。

generation 必须单调递增；同名重建组使用新的稳定 group_id，不能复用旧组身份。

### 8.2 在线清理

1. 管理员变更/删除/改型/停用组，服务端事务写变更记录并递增 generation。
2. 从这一事务提交时起，所有读取 API 立即排除该组，不等待客户端 ack。
3. APP 拉取 changes，收到 tombstone。
4. APP 先停止将该组节点用于连接/选择，再删除该组本地节点与引用。
5. APP 写入本地已应用 generation，向 ack 接口提交 removed。
6. 服务端验证并幂等记录 ack；其他 group 和其他 entitlement 不受影响。

### 8.3 离线 24 小时保证

服务端无法向完全离线设备即时推送，因此使用短期授权租约：
- 每次成功同步由服务端签发明确的 `lease_expires_at`，最长不超过签发时间后 24 小时。
- 客户端缓存必须绑定 entitlement_id + group_id + generation + lease，不得跨管理员/卡密复用。
- 到期后客户端必须 fail closed：停止使用对应组节点并清除本地授权节点/缓存，即使用户未重新打开同步页面也不能继续使用。
- 为覆盖设备时钟回拨/重启，客户端实现需同时记录服务端时间锚点、系统时间异常、Android elapsedRealtime/boot session 信息；若无法可靠证明租约仍有效，按过期处理。
- 推荐首版租约期限短于 24 小时（例如 23 小时）留出时钟与调度误差余量；最终值须在设备测试中验证。
- 不能把后台定时任务必定执行作为唯一保障；APP 每次启动、恢复前台、连接前均检查租约；运行期间设置到期截止保护。
- 完全离线时最多在最后一次服务端签发租约有效期内继续使用。服务端删除/改型后，在线设备立即清理；离线设备最迟在该租约截止时停止使用并清理。

### 8.4 tombstone 保留与清除

- tombstone 至少保留到所有仍有效设备 ack，或达到经配置的最长保留周期并完成后续清理策略。
- 不能因一个设备 ack 就删除其他设备尚未处理的 tombstone。
- 已过期/撤销 entitlement 不再续租；其本地缓存同样受 lease 限制。
- 服务端清理事件和客户端 ack 必须可审计、幂等；不能因重复同步重复删除其他组。

## 9. 6.00.47 客户端最小接入点（设计，不改 APK）

### 9.1 网络层

- 新增独立 API v2 client；使用 Authorization Header、TLS、超时、重试退避和幂等键。
- 本地授权列表以 entitlement_id 为键；每个管理员/卡密有独立 token/session 与 cursor。
- 禁止以“最新 entitlement”覆盖同设备其他授权。
- 错误码分层：未授权、授权过期、设备上限、授权撤销、generation 冲突、租约过期、服务端暂不可用。
- 服务端暂不可用时不能把缓存授权无限延期；到期 fail closed。

### 9.2 Room 数据映射

建议新增或扩展 Room 实体：
- EntitlementEntity：entitlementId、adminId、cardId、deviceId、status、expiresAt、cursor。
- AuthorizedGroupEntity：entitlementId、groupId、groupType、generation、leaseExpiresAt、state。
- AuthorizedNodeEntity：entitlementId、groupId、generation、nodeId、payload。
- SyncEvent/AckEntity：eventId、entitlementId、groupId、generation、ackState、retry metadata。

复合索引至少包含 entitlementId + groupId；节点不能只按 group name 或 adminId 存储，避免多授权冲突。Room migration 必须可回滚/向前兼容，不在本批实施。

### 9.3 GroupUpdater / GroupManager 生命周期

- GroupUpdater 前置：验证 entitlement 和 lease，再拉取增量变更。
- 应用变更：对单个 entitlement/group 事务更新节点和 generation。
- 收到 tombstone：停止该组连接候选 → 删除该组节点 → 更新本地 generation → enqueue ack。
- ack 失败：保留待重试事件，但本地删除不回滚、不重新显示授权组。
- lease 到期：无须等待网络，立即标记授权失效并清理对应组。
- GroupManager 用户主动删除本地组与远程授权撤销分开建模，避免本地删除被同步任务错误恢复。
- 本地订阅刷新成功不代表授权有效；每次节点更新都必须重新检查授权范围和租约。

6.00.47 具体类/方法签名需在正式 APK 工程分支中复核；本节只给接入边界，不声称源码已有上述类或字段。

## 10. 测试矩阵

| 编号 | 场景 | 预期 |
|---|---|---|
| P57-01 | 卡密默认设备数 | 第二台设备激活被拒绝 |
| P57-02 | VIP 管理员设置 2–5 台 | 上限内可激活，超限稳定拒绝 |
| P57-03 | 管理员设置 6 台 | 服务端拒绝，提示需超管权限 |
| P57-04 | 超管将上限提高到 6+ | 允许且审计完整 |
| P57-05 | 两台设备并发抢最后一个名额 | 仅一台成功，不超额 |
| P57-06 | 同设备重复核销 | 幂等，不重复占额/建 entitlement |
| P57-07 | 空分组卡密激活 | 可激活，card groups 返回空，不返回其他组 |
| P57-08 | 身份 ID 绑定 | 只返回管理员 free 组 |
| P57-09 | 卡密激活且 free grant 有效 | 返回 card 专属组 + free 组 |
| P57-10 | 卡密 A/B 同管理员 | 只返回各自映射的 card 组 |
| P57-11 | 管理员 A/B 同设备 | entitlement、节点、cursor、ack 完全隔离 |
| P57-12 | 激活后新增/移除卡密组 | 所有该卡密有效设备同步更新 |
| P57-13 | 组删除/改型/停用 | 服务端立即停止下发并产生 tombstone |
| P57-14 | 在线客户端收到 tombstone | 停用并删除对应组，其他组保留 |
| P57-15 | 客户端离线 23h/24h/超过 24h | 租约有效期间遵守授权；到期停止使用并清理 |
| P57-16 | 客户端时钟回拨/重启 | 不能延长租约；不确定时 fail closed |
| P57-17 | 重复/乱序 ack | 幂等，旧 generation 不覆盖新状态 |
| P57-18 | 伪造 admin_id/card_id/device_id | 服务端忽略客户端归属声明并拒绝错配 |
| P57-19 | D1 查询异常/字段缺失 | fail closed，不返回节点 |
| P57-20 | 旧客户端访问旧 API | 不扩大旧权限；旧字段兼容策略明确，不能获得 v2 新授权范围 |
| P57-21 | 来源转移/撤销/禁用 | 节点查询二次验证 owner/status，立即停止下发 |
| P57-22 | 卡密过期/撤销/VIP 到期 | 分别遵循卡密、entitlement、VIP 生命周期，不互相误触发 |

测试分层：纯函数单测 → Worker.fetch + mock D1 → 隔离 D1 集成 → Android Room/网络单测 → 真机在线/离线与时钟测试。任何一层通过不代表其他层通过。

## 11. 兼容、迁移与回滚

### 11.1 兼容策略

- 旧 API 路径和字段先保留，不直接删除。
- 新客户端显式使用 `/api/app/v2`；旧客户端不自动获得更宽授权。
- 对无法携带 entitlement_id 的旧客户端，不通过“取最新授权”或放宽 Token 校验来迁就。
- 管理端旧卡密列表响应保持兼容；新增分组配置使用独立子资源。
- 老数据没有 card-group mapping 时按空集合处理，不推断为管理员全部分组。
- 老 free_grants 仅按可验证的 device_id + admin_id 迁移/兼容，不伪造 user 绑定。

### 11.2 回滚

- Worker 回滚至上一稳定版本时，新增表/事件记录保留，不自动 DROP。
- API v2 可通过服务端 feature flag 停止新客户端请求，但不得重新开放已撤销组的节点。
- HTML 回滚前确认旧 API 仍可供旧页面使用。
- APK 若已发布新协议，必须保留兼容 Worker 版本或通过服务端版本门禁阻止不兼容降级。
- migration 回滚只允许另行批准、备份并演练；优先向前修复，不自动删除授权历史。
- 发生授权范围异常时优先关闭受影响 entitlement 的节点读取，不关闭其他管理员授权，不全量清空节点。

## 12. 本批影响与执行状态

- Worker：无修改；API v2 为设计契约。
- HTML：无修改；管理端接口为设计契约。
- D1：无连接、无 SQL、无 migration；表/字段均为草案。
- APK：无修改、无 Gradle 构建、无安装测试；状态继续为 **APP_PENDING**。
- Secrets/Cloudflare：未读取、未修改、未部署。
- 代码测试：未运行；本批是协议设计交付，不报告测试通过。
- 生产安全：未执行任何生产操作。

## 13. 尚需在实施前核验的技术项

1. 生产 D1 实际 schema、索引、约束、迁移历史和 binding。
2. 当前线上 Worker 真实版本及两个部署文件的线上一致性。
3. 6.00.48 ZIP 的可读取源码与第三方授权/限制；6.00.47 仅作结构参考。
4. Android device_id 的稳定生成、重装恢复、设备迁移及防伪能力。
5. Cloudflare D1 事务/并发条件写入能力与 Worker runtime 适配。
6. 客户端后台/进程被杀/系统省电限制下，24h lease 到期保护的可靠性；必要时以连接前强制检查作为最终闸门。
7. 旧 APP 版本的实际 API 调用方与发布升级路径。

## 14. 第五十八批唯一接手卡

**第五十八批：APP v2 授权协议静态实现准备与隔离测试骨架（不接生产、不部署）。**

1. 重读 AGENTS、功能基线、API 规范、数据库保护规范、总方案、进度和本报告。
2. 只读核对当前 main 中第五十二/五十三批 helper 的实际文件与测试，确认可复用边界。
3. 以本报告契约为准，设计隔离 Worker v2 handler 模块与 mock D1 fixtures；不得接入原始生产 Worker。
4. 先实现/测试纯函数：设备上限策略、card/free group allowlist、generation 单调性、tombstone/ack 幂等、lease 截止判断。
5. 对 SQL 查询做静态契约测试，要求所有节点读取都必须绑定 allowed_group_ids 和 owner 检查。
6. 在 APK 6.00.48 未解包前，客户端继续标记 APP_PENDING，不改 APK。
7. 不创建正式 migration、不连接生产 D1、不修改 Secrets、不部署。
8. 完成后更新进度、总方案和第五十九批接手卡；所有测试必须实际运行并记录证据。
