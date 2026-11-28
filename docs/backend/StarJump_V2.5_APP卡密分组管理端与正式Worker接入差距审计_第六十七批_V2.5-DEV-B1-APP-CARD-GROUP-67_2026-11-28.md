# V2.5.0 RC1 第六十七批：APP 卡密分组管理端与真实 Worker 接入差距审计

- 版本：V2.5.0 RC1
- 批次：第六十七批 / `V2.5-DEV-B1-APP-CARD-GROUP-67`
- 日期：2026-11-28
- 基线分支：`release/v2.5.0-rc1-converge`
- 审计基线提交：`a2a221628182876123abe551a5a40d19e452ffe1`
- 性质：只读源码审计；未执行生产 D1 读写、Worker 部署或 PR 合并。

## 一、结论

当前候选仓库中可见的旧版 Worker 数据模型和后台 HTML，**尚不能实现已冻结的“同一 APP 用户可使用同一 VIP 管理员的多张有效卡密，并分别取得每张卡密配置的分组；同管理员免费组只聚合一份；同名卡密组显示非敏感序列号后缀”完整业务**。

主要原因不是组合算法完全缺失，而是实际持久化管理链路和 Worker 生产路由未闭合：

1. `app_cards` 只有卡密自身字段，没有卡密-分组关系字段/关联表。
2. `app_groups` 只记录管理员、组名、mode、排序、启用状态。
3. `app_group_sources` 将分组关联到订阅来源；`app_group_members` 将分组关联到设备；两者都不是卡密分组授权关系。
4. 后台 HTML 的卡密接口只有列表、生成、删除/停用、导出等操作；没有“为某一张卡密配置/编辑分组”的 API 调用。
5. 多卡密组合服务（Protocol 65）可独立验证多个 entitlement credential，但仓库证据尚未证明其已经注册到正式 Worker 路由、已由后台 UI 生成并管理对应授权关系，或已与当前 APK 协议兼容。

因此：当前不能将卡密分组管理、多卡密聚合标记为已完成，也不能把该状态作为上线验收通过项。

## 二、源码证据

### 2.1 后台 HTML 的实际 API 调用

文件：`releases/v2.5.0-rc1/index.html`

可见卡密管理调用：
- `GET /api/user/app-cards`
- `POST /api/user/app-cards`，请求体为 `count`、`days`
- `DELETE /api/user/app-cards/{id}`
- `POST /api/user/app-cards/{id}/disable`
- `GET /api/user/app-cards/export`

可见分组管理调用：
- `GET/POST /api/user/app-groups`
- `PUT/DELETE /api/user/app-groups/{id}`
- 分组来源管理 `/sources`
- 设备成员管理 `/members`

超管页面可见：
- `GET/POST /api/super/app-groups`
- `PUT/DELETE /api/super/app-groups/{id}`
- 分组来源及设备成员管理

在该 HTML 的卡密管理交互中未发现以卡密 ID 为对象的分组授权配置接口，也未发现卡密-分组绑定/解绑 API。当前 UI 的卡密生成只传数量和有效天数，不传分组配置。

### 2.2 Worker 内联建表结构

审计文件：`原始StarJump_V1点0_Final-zip-26-11-25-14:56/Worker.js`

当前内联 DDL 中相关结构：

- `app_cards`：`id, code, admin_user_id, days, status, inactive_reason, inactive_at, restored_at, manual_disabled, expires_at, activated_at, used_at, created_at`
- `app_entitlements`：`id, admin_user_id, device_id, card_id, starts_at, expires_at, purge_at, status, created_at`
- `app_groups`：`id, admin_user_id, name, mode, sort, enabled, created_at`
- `app_group_sources`：`group_id, source_id`
- `app_group_members`：`group_id, device_id`
- `app_free_grants`：`device_id, admin_user_id, granted_at`

以上结构没有 `app_card_groups` 或等价的卡密实例到分组关联关系。不能把 `app_group_members` 当作卡密关联表，因为其主键语义是 `(group_id, device_id)`，无法表达同一设备使用同一管理员多张卡密分别取得不同组的业务。

### 2.3 Worker 现有管理路由行为

`userAppCardsRoute`：
- 读取管理员名下卡密列表；
- 生成卡密时只写入 `app_cards`；
- 删除未激活卡密时停用；
- 已激活卡密不能删除；
- 未见卡密分组关联写入。

`userAppGroupsRoute` / `superAppGroupsRoute`：
- 创建/修改/删除管理员分组；
- 通过 `app_group_sources` 关联订阅来源；
- 通过 `app_group_members` 关联设备；
- mode 为 `public / assigned / free`；
- 没有按 `card_id` 写入分组范围的操作。

### 2.4 旧版 APP 读取接口行为

`appGroupsForDevice` 读取设备最新一条有效 entitlement（按 `created_at DESC LIMIT 1`），验证该 entitlement token 后，只按该条 entitlement 的 `admin_user_id` 读取管理员组。

当没有有效 entitlement 时，按 `device_id` 查询 `app_free_grants`，再按管理员读取 `mode='free'` 的组。此免费分支不要求当前 entitlement token。

该旧读取流程不能满足多卡密聚合，也不能证明免费组只按管理员去重后与多卡密卡组组合。旧接口不得直接改造成新协议而不做 APK 兼容验证。

## 三、Protocol 65 模块接入边界

文件：
- `backend/worker/V2.5-DEV-B1-APP-PROTOCOL-65/composed-groups-handler.mjs`
- `backend/worker/V2.5-DEV-B1-APP-PROTOCOL-65/composed-group-service.mjs`
- `backend/worker/V2.5-DEV-B1-APP-PROTOCOL-60/group-composition.mjs`

模块已实现的隔离契约能力：
- 每个 credential 使用精确的 `entitlementId + deviceId + token` 单独解析；
- 拒绝重复 entitlement ID、错误 token、跨设备授权；
- 对每条 entitlement 分别分类 CARD / IDENTITY；
- 分别加载卡密组和免费组，并验证管理员归属；
- 卡密组要求可加载非空序列号展示标签；
- 将 entitlement 与对应组列表交给纯组合函数处理；
- 返回组合结果及 entitlement 数量。

尚未由当前证据证明：
- Handler 已在真实 Worker 主入口注册；
- D1 loader 已实现并绑定真实表结构；
- 卡密序列号 label loader 不会泄漏 redeem code；
- 后台已能为每张卡密保存和维护组配置；
- APK 已发送多个 entitlement ID/token 并能消费组合响应；
- 节点删除 tombstone/generation/24h cleanup ACK 已形成端到端链路。

独立模块测试通过只证明该模块契约，不等于正式产品接口可用。

## 四、实施前必须补齐的内容

1. 设计并审核卡密实例-分组关系表（建议以 `card_id + group_id` 为核心，必须带管理员归属约束/校验）；先核对现有历史数据和删除策略，不直接在生产库建表。
2. 为卡密分组关系增加管理员 API：读取、批量设置、增删单组；所有写操作必须验证卡密与分组属于同一管理员，且卡密状态/管理员 VIP 权限满足规则。
3. 后台 HTML 增加逐卡密分组配置入口，明确区分免费分组与卡密专属分组；不得仅用设备成员列表模拟卡密授权。
4. 实现 D1 loader：按 entitlement.card_id 读取卡密组；按 device_id + admin_user_id 对免费组去重；多管理员完全隔离；卡密组重名显示非敏感序列号后缀。
5. 将 Protocol 65 Handler/service 正式注册到 Worker，令 token gate 在查询其他 entitlement 前完成；明确错误处理、限额、审计和速率限制。
6. 解决旧 `/api/app/groups` 与新 v2 endpoint 的并存/迁移策略，先取得 APK 实际协议证据，再决定兼容层，不可直接破坏旧 APK。
7. 增加真实路由集成测试与 SQLite schema/SQL 测试；再补充真实 Cloudflare D1 staging 验证（由用户在其 Cloudflare 环境执行，不在本轮执行生产操作）。
8. 对节点删除/改型实现 generation/tombstone、客户端 24 小时清理及 cleanup ACK 的端到端验收。

## 五、验收矩阵（当前）

| 验收项 | 当前状态 |
|---|---|
| 卡密生成/列表/停用 | 旧 Worker 有基础接口 |
| 管理员分组 CRUD | 旧 Worker 有基础接口 |
| 分组关联订阅来源 | 旧 Worker 有基础接口 |
| 分组按设备成员授权 | 旧 Worker 有基础接口 |
| 卡密实例单独配置分组 | 未发现实现 |
| 同设备多张有效卡密聚合 | Protocol 65 隔离模块有契约，未证实接入正式路由 |
| 同管理员免费组去重 | 组合模块有规则测试，未证实真实 D1 loader |
| 多管理员严格隔离 | 组合模块有校验，未证实生产路由端到端 |
| 同名卡密组序列号后缀 | 组合模块有 label 字段，未证实真实 label loader/UI |
| 不泄露 redeem code | 需对真实 loader/响应做专项检查 |
| APK 多 entitlement 协议兼容 | 未验证 |
| tombstone / 24h cleanup / ACK | 未完成端到端验证 |

## 六、风险与兼容性说明

- 不在本轮修改旧 Worker 读取接口，避免现有 APK 立即失效。
- 不执行生产 D1 迁移或数据回填。
- 不将本报告中的建议表结构视为已批准 DDL。
- 不将候选模块单元测试视为真实 D1 并发、事务回滚或线上兼容验证。
- 本报告是差距审计，不是部署包，不可单独上传部署。

## 七、下一轮工作顺序

优先完成真实 schema 对照与卡密-分组关系设计，再做 D1 loader 和正式 Worker 路由注册；随后增加后台逐卡密分组管理 UI，最后联调 APK 协议和增量清理链路。只有所有链路通过测试并完成回滚准备后，才进入 STABLE 大更新交付。

