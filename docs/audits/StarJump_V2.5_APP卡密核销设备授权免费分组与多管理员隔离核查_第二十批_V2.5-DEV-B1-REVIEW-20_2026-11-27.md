# 星跃管理平台 V2.5｜APP 卡密核销、设备授权、免费分组与多管理员授权隔离核查

> 批次：第二十批  
> 版本标识：V2.5-DEV-B1-REVIEW-20  
> 日期：2026-11-27  
> 状态：DEV 静态源码审计；未修改业务代码  
> 核查分支：repair/v2.5-batch1-auth-vip-app  
> 核查对象：releases/v2.5-batch1/Worker.js、releases/v2.5-batch1/index.html  
> 依据：AGENTS.md、V2.5 功能基线、动作级权限门禁矩阵 V1、第十三/十四/十五/十九批报告及用户本轮确认  
> 兼容性：仅新增审计文档；不修改 Worker、HTML、D1、Secrets、Cron、APK 或生产部署

## 1. 本批已确认业务规则补充

用户本轮明确确认：

**体验 VIP 与正式 VIP 管理员创建的 APP 卡密，均采用相同的三天宽限规则。**

- 管理员 VIP 到期后，未激活且自身仍有效的 APP 卡密保留三天宽限。
- 满三天后，才允许因管理员 VIP 到期而自动失活。
- 管理员恢复有效 VIP 后，只恢复因 `admin_vip_expired` 自动失活、且未人工停用、未激活/使用、卡密自身未过期的 APP 卡密。
- 人工停用、超管撤销/作废、卡密自身过期，不得因管理员恢复 VIP 自动恢复。
- 此规则不区分管理员最后有效身份是体验 VIP 还是正式 VIP。

本规则已由用户确认，不再作为待确认事项。第十九批报告中的“体验 VIP 创建的 APP 卡密三天宽限待确认”应由本报告更正，后续实施时统一按三天处理。

## 2. 本批结论摘要

候选 Worker 具备 APP 卡密核销、设备 Token、管理员分享编号、APP 分组和授权记录等基础实现，但存在以下高风险差异：

1. **P0：APP 节点接口绕过分组范围。** `/api/app/nodes` 验证某一管理员的有效 entitlement 后，却读取该管理员全部已启用且通过审核的来源节点；没有按设备实际可见的 APP 分组、分组成员关系和 `app_group_sources` 限定。
2. **P0：公开免费分组接口不验证 APP 用户身份。** `/api/app/free` 可通过管理员 ID 或分享编号获取该管理员所有 tier='free' 节点；不验证 APP 用户身份 ID、设备授权凭证或登录状态。
3. **P1：无有效 entitlement 时的免费分组路径仅凭 device_id。** `/api/app/groups` 在没有有效授权时查询 `app_free_grants`，只要求客户端提交 device_id；device_id 是客户端可自报字符串，不构成可靠设备身份认证。
4. **P1：APP 卡密事件列表返回明文卡密。** `/api/user/app-cards/events` 查询并返回 `app_cards.code`，将历史卡密明文暴露在事件接口。
5. **P1：换绑只修改 entitlement.device_id。** 超管换绑后未同步处理 `app_free_grants`、旧设备残留授权关系及旧设备缓存清理/确认；未见换绑前置状态校验、理由必填、二次确认或独立换绑事件账本。
6. **P1：多管理员授权按单个 Token 选择一个 entitlement。** 当前 API 一次只返回与该 Token 对应管理员的数据；没有合并机制。必须保持授权隔离，不能把不同管理员数据混成一个授权；如果产品需要一个设备同时使用多个管理员授权，应由 APK 分别保存和请求各自 Token。
7. **P1：APP 卡密核销没有显式检查卡密所属管理员账号状态。** 核销查询 app_cards，但未 JOIN app_users 检查管理员 disabled/locked 状态。账号停用与 VIP 到期规则必须分开，不能依赖 VIP 卡密 Cron 代替账号状态检查。
8. **P2：APP 核销后的事件审计独立写入且失败被吞掉。** 卡密、entitlement、free grant 批次成功后，app_card_events 再单独写入并 catch 忽略，可能产生已核销但事件时间线缺失。
9. **P2：APP Token 可通过 URL query 传递。** appTokenFromRequest 接受 token 查询参数，可能进入代理、访问日志、浏览器历史或诊断日志。
10. **P2：分组节点查询没有完整校验来源归属。** groupNodeList() 仅依据 group_id 连接来源和节点，没有在该查询里再次核对分组所属管理员与 source_ownership 的关系；需防止脏关联或管理员间误关联。

以上均为静态源码核查结论，不代表线上已发生数据泄漏。未执行 API/D1/APP 真实联调。

## 3. 逐项核查

### 3.1 APP 卡密核销

路径：`POST /api/app/redeem`

当前流程：
1. 接收 code 和客户端传入 device_id。
2. 校验卡密格式与 device_id 格式。
3. 按 code 查询 app_cards。
4. 检查 manual_disabled、activated_at、used_at、status、expires_at。
5. 通过 userBatch() 对卡密未使用状态做断言，更新为 used，创建 app_entitlements，插入 app_free_grants。
6. 批次完成后单独插入 app_card_events，失败被 catch 忽略。
7. 使用 HMAC(APP_HMAC_SECRET 或 SESSION_PEPPER) 生成 entitlementId|deviceId Token。

**正向实现：**
- 卡密状态有 unused/normal 等条件检查。
- 卡密更新、entitlement 创建和 free grant 写入放在同一批次。
- 同一张卡密并发核销有状态断言与条件 UPDATE，具备防重复核销基础。
- 新卡密生成独立 entitlement，不复用旧 entitlement。
- Token 同时绑定 entitlement ID 与 device_id。

**风险：**
- 设备 ID 由客户端传入，格式校验只能验证字符串，不证明设备真实性。
- 核销时没有显式读取管理员 app_users.status 检查 disabled/locked。
- 账号停用后，如果卡密仍是 normal，理论上可能继续核销；需要服务端阻断账号停用管理员的新核销。
- 事件日志不在核销原子批次内，失败可静默。
- app_free_grants 是永久授权记录，当前按 device_id + admin_user_id 写入；若设备 ID 可被复制，免费资格也可能被冒用。
- entitlement Token 依赖 APP_HMAC_SECRET，当前仍有 SESSION_PEPPER 回退路径；正式环境密钥轮换、版本和撤销机制需要独立设计。

**修复要求：**
- 核销前读取管理员账号状态，disabled/locked/封禁账号不得创建新 entitlement；这不等于因管理员 VIP 到期撤销已激活 entitlement。
- 将核销事件写入可靠原子批次或事务性事件账本；不能吞掉关键审计失败。
- 引入 APP 安装实例密钥/设备注册凭证等可验证绑定机制；device_id 只作为标识，不作为身份凭证。
- 保持同一卡密仅核销一次；不同卡密可产生独立 entitlement。
- 三天宽限只作用于管理员未激活 APP 卡密，不得误伤已激活且仍在自身有效期内的 APP entitlement。

### 3.2 APP Token 与状态校验

当前：
- Token 为 HMAC(secret, entitlementId|deviceId)。
- /api/app/status 要求 Token，并在该设备授权记录中逐条匹配。
- /api/app/nodes、/api/app/groups、/api/app/links 读取有效 entitlement 并匹配 Token。
- appTokenFromRequest 接受 X-App-Token、Authorization Bearer 和 URL query token。
- listActiveEntitlements() 只返回 status='active' 且 expires_at 尚未到期的授权。

**正向实现：** 仅伪造 device_id 不足以通过需要 Token 的接口。

**风险：**
- URL query token 容易被日志、代理和历史记录收集。
- Token 缺少明确的 key_id/version 元数据；密钥轮换和单个 entitlement 撤销后的版本化管理不足。
- 未发现设备级 Token 列表、主动撤销、旧 Token 轮换和换绑后的客户端清理 ACK 闭环。
- 当前每个接口每次只选择一个匹配 Token 的 entitlement，不能把它理解为设备所有管理员授权自动合并。

**修复要求：**
- 正式 APK 仅使用 Authorization Bearer 或 X-App-Token；URL query token 作为兼容期逐步废止。
- 增加 Token 版本、key_id、签发时间、撤销状态或可撤销的服务端授权凭证。
- 对设备换绑/撤销生成服务端事件，APK 增量同步后回传清理 ACK。
- 每份 entitlement 独立授权、独立 Token、独立管理员范围；多个管理员授权分别呈现、分别同步和撤销。

### 3.3 APP 节点下发范围（最高优先级）

路径：`GET /api/app/nodes`

当前 SQL 的核心条件：
- `source_ownership.user_id = ent.admin_user_id`
- `subscription_sources.enabled = 1`
- `node_records.enabled = 1`
- 来源审核状态不是非 approved。

但没有：
- JOIN app_groups；
- JOIN app_group_sources；
- 检查 app_groups.enabled；
- 检查 group.mode；
- 检查 assigned 分组是否包含该 device_id；
- 限制到该设备实际获准查看的分组来源。

**影响：** 设备只要持有某管理员的一张有效卡密，就可能拿到该管理员全部启用且审核通过的来源节点，不限于管理员实际配置给该设备的 APP 分组。会绕过管理员在 APP 分享后台配置的分组边界。

**修复要求：**
- /api/app/nodes 必须与 /api/app/groups 使用同一套授权范围解析函数。
- 首先通过 Token 确认唯一 entitlement 与管理员身份。
- 查询该管理员下对该 device_id 可见且 enabled 的分组：
  - public：按产品确认的公共范围；
  - assigned：必须存在 app_group_members 对应设备；
  - free：必须存在可信的 APP 身份免费授权凭证。
- 节点必须经 app_group_sources 限定，并再次校验 source_ownership、source enabled、审核通过、node enabled。
- 任何未分配给 APP 分组的来源都不得因管理员拥有该来源而自动下发。
- 不得把个人 node_overrides 或用户备注写入 APP 分享结果。

### 3.4 免费分组身份授权

当前存在两条路径：

A. `GET /api/app/free?admin=... 或 ?code=...`
- 只验证管理员参数/分享编号与管理员 free_group_enabled 开关；
- 不要求 APP 用户身份 ID；
- 不要求 device_id；
- 不要求 Token；
- 返回该管理员所有 tier='free' 的来源节点。

B. `GET /api/app/groups?device_id=...`
- 没有有效 entitlement 时，查询 app_free_grants(device_id)；
- 只凭 device_id 找到已绑定管理员；
- 返回该管理员 free 模式分组；
- 不校验 Token 或独立 APP 用户身份凭证。

**与已确认需求不符：**
用户已确认 APP 免费分组应通过 APP 用户身份 ID 获取管理员分享的免费节点；不能仅凭管理员 ID、分享编号或客户端自报 device_id 获得授权。APP 卡密分组则通过对应管理员的 APP 用户卡密授权。

**修复要求：**
- 将免费授权主体改为可验证的 APP 用户身份 ID/安装实例身份，不允许仅用管理员 ID、分享编号或 device_id 作为授权证明。
- 分享编号只用于解析管理员/发起绑定，不直接授予节点数据。
- 免费授权需有可撤销、可审计的 grant 记录；验证 grant 绑定的 APP 用户身份、管理员、状态与撤销时间。
- app_free_grants 旧记录不得直接视为永久可信身份凭证；迁移前只读核实数据，设计兼容绑定与补救流程。
- 免费分组仅返回该管理员明确开放、已启用、mode='free' 且通过 app_group_sources 授权的来源。
- 免费授权与 APP 卡密 entitlement 必须分开；一份卡密授权到期不能自动把设备身份或其他管理员的免费 grant 混在一起。

### 3.5 多管理员授权隔离

当前 `listActiveEntitlements(deviceId)` 会返回该 device_id 的多条有效 entitlement；`matchEntitlementToken()` 使用请求 Token 找到其中一条。

这意味着：
- 每个请求由 Token 决定当前管理员；
- groups/nodes/links 按当前匹配 entitlement 的 admin_user_id 取数据；
- 没有把多个管理员授权合并为一个数据集；
- 同一设备多个管理员授权必须分别携带各自 Token 请求。

**需要保留的安全边界：**
- 管理员 A 的 Token 不得访问管理员 B 的分组、节点、入口或卡密；
- A 的授权到期/撤销不能影响 B 的授权；
- A 的免费 grant 不得给 B 使用；
- A 的分组成员列表不能跨管理员污染；
- 设备换绑 A 不得意外修改 B 的 entitlement。

若产品希望 APP 同时展示多个管理员授权，APK 应按授权实例分区展示，不应在服务端把多个管理员的节点混成一个无来源归属的数据池。

### 3.6 换绑设备

当前超管路由 `/api/super/app-entitlements/:id/rebind`：
- 读取 entitlement id 与原 device_id；
- 接收新 device_id；
- 直接 UPDATE app_entitlements.device_id；
- 写审计（失败 catch 忽略）；
- 返回新 Token。

风险：
- 未在该处理函数内检查 entitlement 是否 active、是否已过期或 purged。
- 未检查新设备身份是否已完成可信注册。
- 没有必填换绑理由/二次确认字段。
- 没有明确的旧设备本地清理 ACK。
- app_free_grants 仍绑定旧 device_id，没有同步解绑/迁移；旧设备可能继续持有免费分组 grant。
- 没有换绑事件账本记录旧 Token 版本撤销和新 Token 签发。
- 直接修改 entitlement 当前 device_id，历史归属变化不可由主表本身完整追溯。

**修复要求：**
- 换绑采用事件式流程：申请 → 风险检查 → 超管确认/理由 → 旧设备撤销事件 → 新设备绑定 → 新 Token → APK 清理 ACK。
- 仅允许对符合产品规则的 active entitlement 换绑；过期/已 purge entitlement 不得重新激活。
- app_free_grants 必须单独核对是否应转移；不得默认永久留给旧设备。
- 每次换绑保留不可覆盖的 before/after 事件。
- 同一 entitlement 并发换绑必须串行化，旧 Token 即时失效。
- 超管操作必须审计成功；审计失败应阻断高风险换绑或进入可靠审计队列。

### 3.7 APP 卡密事件与明文泄漏

`GET /api/user/app-cards/events` 返回：
- action
- detail
- device_id
- created_at
- c.code

其中 c.code 为 APP 卡密明文。事件接口只应提供必要的状态事件，不应在每条历史事件中返回卡密原文。

修复要求：
- 默认返回卡密 ID、掩码、状态、事件类型、时间和设备标识；
- 明文只允许在生成卡密的即时响应中一次性展示，之后不再从事件 API 读取；
- 旧明文卡密泄露风险需要评估是否批量作废/轮换，但不得擅自作废用户现存卡密；
- 日志、审计、导出统一脱敏。

## 4. 本批问题优先级

| 编号 | 优先级 | 问题 | 主要影响 |
|---|---|---|---|
| APP-20-01 | P0 | /api/app/nodes 未按 APP 分组授权范围过滤 | 可能越权下发管理员全部来源节点 |
| APP-20-02 | P0 | /api/app/free 仅凭管理员 ID/分享编号公开取免费节点 | 免费节点授权绕过 APP 用户身份 |
| APP-20-03 | P1 | /api/app/groups 免费路径只验证 device_id | 设备标识冒用可读取历史免费 grant |
| APP-20-04 | P1 | APP 卡密事件 API 返回明文 code | 卡密泄漏与重放风险 |
| APP-20-05 | P1 | 换绑未同步 free grant、旧设备清理与撤销账本 | 旧设备残留权限 |
| APP-20-06 | P1 | 核销未检查管理员账号 disabled/locked | 停用管理员仍可能新建 APP 授权 |
| APP-20-07 | P1 | 多管理员授权需明确分区使用，不支持自动聚合 | 客户端容易误用 Token 或混淆管理员数据 |
| APP-20-08 | P2 | app_card_events 独立写入且失败被吞 | 审计时间线缺失 |
| APP-20-09 | P2 | URL query 允许传 APP Token | Token 暴露在代理/日志/历史记录 |
| APP-20-10 | P2 | groupNodeList 未完整核对来源所有权 | 脏关联可能导致跨管理员来源被关联 |
| APP-20-11 | P2 | 换绑缺少状态/理由/并发控制 | 误换绑、重复换绑、历史追溯不足 |

## 5. 修复前置计划与数据库影响

本批只提出修复计划，不修改代码。

### 第一阶段：封堵越权下发
- 统一实现 resolveAppEntitlementScope()。
- groups、nodes、links 使用同一 entitlement + admin + device + group scope。
- 先修复 /api/app/nodes 的全来源查询。
- 对 /api/app/free 增加可信 APP 用户身份凭证校验；在兼容迁移完成前，不允许仅凭 admin/code 对外返回节点数据。

### 第二阶段：可信 APP 身份与免费授权
- 设计 APP 用户身份 ID、设备注册凭证、安装实例公钥/签名挑战。
- 免费 grant 绑定 app_user_identity_id + admin_user_id + grant_state。
- 保留 device_id 作为设备实例标识，不作为唯一授权凭证。
- 分享编号仅用于绑定管理员，不授予节点访问权。
- 旧 app_free_grants 数据先只读盘点，不直接批量删除或迁移。

### 第三阶段：卡密与换绑安全
- 核销时校验管理员账号 status。
- 卡密事件改为掩码输出。
- 核销事件与 entitlement 状态保持一致、审计失败可追踪。
- 换绑使用可追踪事件和旧设备撤销 ACK。
- 多管理员授权分别独立保存 Token 与 entitlement。

### 第四阶段：APP 生命周期规则衔接
- 管理员 VIP 到期：体验/正式一律三天宽限，只影响未激活 APP 卡密。
- 已激活 APP entitlement 按自身 expires_at 继续生效，不因管理员 VIP 到期而提前失效。
- 管理员账号 disabled/locked：阻止新的卡密核销、新授权和管理写操作；已激活 entitlement 是否立即停止下发，应作为账号安全规则独立实现，不能混同 VIP 到期。
- 卡密自身过期、人工停用、超管撤销/作废必须有独立原因，不能被管理员 VIP 恢复操作覆盖。

### D1 影响预判
可能涉及现有表：
- app_cards
- app_card_events
- app_entitlements
- app_free_grants
- app_groups
- app_group_sources
- app_group_members
- admin_share_codes
- app_users
- source_ownership
- subscription_sources
- source_approvals
- node_records

潜在新增结构（必须先核实真实 D1，不得直接建表）：
- APP 用户身份/设备注册表；
- 免费授权 grant 事件表；
- entitlement rebind/revoke 事件账本；
- Token key_id/version 或设备凭证字段；
- APP 授权清理 ACK 记录。

不允许把候选 Worker 的 MIGRATE_STATEMENTS 当作生产 D1 真实结构。执行任何迁移前必须先读取真实 D1 的表、字段、索引、约束和数据分布，生成 dry-run 与回滚方案。

## 6. 必须通过的测试矩阵

| 场景 | 预期结果 |
|---|---|
| 管理员只把来源 A 分配到设备可见分组 | APP 只能拿到来源 A |
| 管理员拥有来源 A/B，但只分享 A | APP 不得通过 /api/app/nodes 拿到 B |
| 分组 disabled | APP 不得读取该分组节点 |
| assigned 分组未包含设备 | APP 不得读取该分组 |
| 来源不属于该管理员 | APP 分组不得关联该来源 |
| 来源 disabled 或审核未通过 | APP 不得收到该来源节点 |
| 只提交管理员 ID 请求 /api/app/free | 不得返回节点 |
| 只提交分享编号请求 /api/app/free | 不得直接授予节点访问权 |
| 只伪造 device_id 请求 /api/app/groups | 不得读取免费 grant |
| 有可信 APP 身份且绑定管理员免费 grant | 只能读取该管理员开放的免费分组 |
| A 管理员 Token 请求 B 管理员资源 | 403，不得返回 B 数据 |
| 同设备有 A/B 两个授权 | 两个授权分别请求、分别返回，不混合 |
| A entitlement 到期 | B entitlement 继续有效 |
| A 管理员 VIP 到期 | 已激活 A APP entitlement 不因 VIP 到期提前失效 |
| A 管理员账号 disabled/locked 后尝试新核销 | 拒绝创建新 entitlement |
| 管理员账号 disabled/locked | 按明确账号安全策略验证已有 entitlement 下发被拒绝或保留，不得默默依赖 VIP 状态 |
| 同一卡密并发核销 | 只有一个成功 |
| 换绑后旧设备 Token | 立即失效 |
| 换绑后旧设备免费 grant | 按确认策略撤销/转移，不得残留 |
| 换绑后新设备 | 只有新凭证与新 Token 可访问 |
| 对已过期 entitlement 换绑 | 拒绝，不得复活 |
| 换绑并发请求 | 串行化，只有一个最终状态 |
| APP 卡密事件列表 | 不返回明文 code |
| 审计写入失败 | 关键安全动作失败关闭或进入可靠审计队列 |
| Token 通过 query 参数提交 | 兼容期可告警，正式期拒绝；Header Token 正常工作 |
| 体验 VIP 到期 | 未激活 APP 卡密三天宽限 |
| 正式 VIP 到期 | 未激活 APP 卡密三天宽限 |
| 三天后管理员续费 | 只恢复 admin_vip_expired 且卡密自身有效的未激活卡密 |
| 人工停用/超管撤销/卡密自身过期 | 管理员续费后仍不恢复 |

## 7. 本批边界

- 已完成：阅读 AGENTS.md、动作级权限门禁矩阵、第十三/十四/十五/十九批报告；静态检查 APP 核销、Token、状态、节点下发、免费分组、管理员分组配置、换绑和事件接口。
- 未完成：APK 源码解包与客户端调用核验、真实 D1 schema 核验、API 集成测试、设备身份验证测试、并发换绑测试。
- 未修改：Worker、HTML、APK、D1、Secrets、Cron、Cloudflare 部署。
- 版本等级：V2.5-DEV-B1-REVIEW-20，仅静态审计，不是 RC，不可部署。

## 8. 最终结论

当前最需要先修的是 **APP 节点下发越过分组授权范围** 与 **免费分组没有可靠 APP 用户身份验证**。这两项直接关系到管理员分享边界，优先级高于 UI 优化。

同时，卡密事件明文、换绑后旧设备残留免费授权、管理员账号停用仍可能新核销，也必须在正式版前解决。

体验 VIP 与正式 VIP 的 APP 卡密三天宽限规则已由用户明确统一确认，后续不再区分两种 VIP 类型。