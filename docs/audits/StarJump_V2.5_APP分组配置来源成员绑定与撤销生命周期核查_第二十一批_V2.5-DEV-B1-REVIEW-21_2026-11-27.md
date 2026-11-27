# 星跃管理平台 V2.5｜APP 分组配置、来源成员绑定与撤销生命周期核查

> 批次：第二十一批  
> 版本标识：V2.5-DEV-B1-REVIEW-21  
> 日期：2026-11-27  
> 阶段：DEV 静态源码审计  
> 核查分支：repair/v2.5-batch1-auth-vip-app  
> 核查文件：releases/v2.5-batch1/Worker.js、releases/v2.5-batch1/index.html  
> 依据：AGENTS.md、动作级权限门禁矩阵 V1、第十一/十三/二十批报告  
> 本批范围：APP 分组 CRUD、来源绑定、设备成员绑定、超管代管分组、前端提示、删除/改型影响  
> 边界：未修改业务代码、D1、Secrets、Cron、APK 或生产部署

## 1. 本批结论

当前 APP 分组管理只有基础 CRUD 和部分绑定接口，距离正式授权管理仍有明显缺口：

1. **P0：超管可把任意现存来源关联到任意管理员分组。** `superAppGroupsRoute()` 添加来源时只检查 subscription_sources 是否存在，没有验证来源 owner 与分组 admin_user_id 的归属关系。结合第十三/二十批发现的 APP 节点下发范围缺口，存在跨管理员来源被挂入分组并暴露的风险。
2. **P1：用户端分组管理接口缺少来源/成员解绑路由。** 用户端有添加 source/member 的 POST，没有对应 DELETE；前端普通用户页面也只展示分组，没有来源和设备成员编辑入口。
3. **P1：分组删除是多条独立 DELETE，不具备原子性。** 删除分组、来源关系、成员关系逐条执行；中途失败可能留下残留关系。
4. **P1：分组删除、改型、来源移除直接物理变更，没有 tombstone/generation/cleanup ACK。** APK 24 小时本地清理协议仍未实现。
5. **P1：分组与来源/成员变更缺少动作级审计。** 用户端分组新增/修改/删除、添加来源/成员的代码路径未见对应 auditStmt；超管分组新增/改型/删除/来源/成员变更路径也未见逐动作审计。
6. **P2：超管管理页面的分组类型提示容易造成错误理解。** UI 提示“免费组所有绑定管理员编号的设备可见”“VIP 组所有有效卡密用户可见”“指定用户只有列出的设备可见”，但实际接口仍受 entitlement、device_id、group scope、来源关联等多重条件影响；提示不应当作真实授权规则。
7. **P2：管理员端分组读取返回全部 app_groups 行，但普通用户端列表没有显示 enabled 状态/成员/来源范围。** 管理员无法从当前用户端页面确认 APK 实际会收到哪些来源与设备授权。
8. **P2：超管组接口未在本函数内验证目标管理员账号状态。** 超管可以对任意有效格式 admin_user_id 创建分组；目标账号不存在或停用时，数据可能成为孤儿配置。是否允许超管预配置未注册/停用管理员需由产品规则明确，当前不应默认。

## 2. Worker 分组接口核查

### 2.1 管理员自己的分组接口

路径：`/api/user/app-groups`

正向实现：
- GET 通过 ctx.effectiveId 只读取自己的 app_groups。
- 所有非 GET 请求先执行 requireActiveVipForManagement()，有效体验/正式 VIP 可进行管理写操作。
- PUT/DELETE 通过 `id + admin_user_id` 检查分组归属。
- 添加来源时，通过 source_ownership 检查来源属于当前管理员。
- 添加成员时对 device_id 做格式校验。

缺口：
- POST 创建分组没有对应动作审计。
- PUT 改名/改 mode 没有审计，没有 generation/tombstone。
- DELETE 先删 app_groups，再删 app_group_sources、app_group_members；多条 SQL 分开执行。
- 添加 source/member 无审计。
- 当前函数只有 POST sources、POST members，没有 DELETE sources、DELETE members。
- 当前用户 HTML 只提供“创建分组”和分组列表展示，没有分组详情、来源分配、设备成员增删、启停、撤销状态和变更历史。
- 分组查询 SELECT *，但用户页面只显示名称和 mode，未展示来源、成员与 enabled 状态。
- 管理员添加成员只验证 device_id 字符串格式，不证明该 device_id 已通过可信 APP 身份注册或确实属于该管理员 entitlement。

### 2.2 超管分组接口

路径：`/api/super/app-groups`

正向实现：
- GET 可按 admin_user_id 查询，也可分页读取分组。
- PUT/DELETE 按分组 id 定位。
- 添加成员时检查 device_id 格式。
- 超管入口由全局 super 身份路由保护（本批未发现绕过超管身份的路径）。

缺口：
- POST 创建分组只验证 admin_user_id 格式、名称和 mode，没有检查目标 app_users 是否存在/状态。
- 添加 source 只执行 `SELECT 1 FROM subscription_sources WHERE id=?`，没有验证来源属于分组管理员。
- 添加 source/member 不检查 group id 是否存在、目标分组是否属于所选管理员（source/member 的 SQL 直接使用传入 id）。
- PUT/DELETE、添加/移除来源、添加/移除成员均未见逐动作审计。
- DELETE 同样逐条物理删除，未生成撤销事件。
- 超管 UI 仅提供分组新增、类型修改和删除；未提供来源/成员绑定界面。后端虽有子路由，但界面没有完整管理闭环。

## 3. P0/P1 发现详情

### APP-21-01｜超管来源绑定缺少管理员归属约束（P0）

超管添加来源的代码仅验证来源存在：
`SELECT 1 AS ok FROM subscription_sources WHERE id = ?`

未同时验证：
- 分组存在；
- 分组 admin_user_id；
- source_ownership.user_id 与分组 admin_user_id 一致；
- 来源 enabled / 审核状态；
- 来源是否允许被 APP 分享。

**影响：** 超管可把管理员 B 的来源挂到管理员 A 的 APP 分组。若 APP 节点接口按该分组关联下发，可能造成跨管理员来源混入。超管操作权限高不等于可以破坏租户数据归属边界。

**修复：**
- source 绑定必须在一个服务端函数内验证 group owner 与 source owner 一致。
- 除非有明确的跨管理员委托授权记录，否则拒绝跨 owner 绑定。
- 如确需超管跨管理员代管，必须显式写入委托关系、目标管理员确认/授权、到期时间和审计。
- 读取 APP 节点时再次验证来源 owner，不能只信任 app_group_sources 关联表。

### APP-21-02｜管理员分组接口缺少来源和成员解绑能力（P1）

用户端只有：
- POST /api/user/app-groups/:id/sources
- POST /api/user/app-groups/:id/members

没有相应 DELETE 子路由。

**影响：**
- 管理员不能只移除某一个来源；
- 管理员不能只移除某一个设备成员；
- 只能删除整个分组，造成过度删除；
- 无法及时撤销单设备/单来源访问。

**修复：**
- 增加来源移除、成员移除动作。
- 移除时生成 revoke event/generation，不直接物理删除唯一的授权证据。
- 保留审计事件和撤销原因。
- 删除/解绑操作需重新校验有效 VIP 与资源归属。

### APP-21-03｜分组删除非原子且无撤销事件（P1）

DELETE 顺序：
1. DELETE app_groups；
2. DELETE app_group_sources；
3. DELETE app_group_members。

若第一条成功、第二条失败，可能留下孤立关联；更关键的是，APK 不会收到撤销信息。

**修复：**
- 用原子 D1 batch 完成状态变更与事件写入；正式撤销应优先标记 disabled/deleted_at/revoke_generation。
- 物理清理放在设备确认与保留期之后。
- 若关联表需要清理，使用外键级联或显式事务设计，但必须先读取真实 D1 schema。
- 分组删除不能覆盖节点历史快照或 APP 设备清理状态。

### APP-21-04｜分组改型没有授权撤销和重新授权事件（P1）

PUT 直接覆盖 mode：
- free → public
- public → assigned
- assigned → free

没有记录改型前后访问范围，也没有强制 APK 获取新 generation。

**影响：** 分组改型可能扩大或缩小访问范围，但 APK 本地缓存无法知道旧节点授权已改变。特别是 assigned 改 free 或 free 改 assigned 时，设备可见范围发生变化。

**修复：**
- mode 变化作为权限范围变更事件；
- generation 单调递增；
- APK 每次同步比较 generation；
- 缩权时先返回撤销清单，客户端完成清理后 ACK；
- 扩权只在服务端授权检查成功后下发新内容；
- 历史 generation 不得覆盖。

### APP-21-05｜分组和关联变更缺少动作审计（P1）

未见分组 create/update/delete、source add/remove、member add/remove 的逐动作 auditStmt。

**修复：**
每条事件至少记录：
- actor_user_id / actor_role；
- target_admin_user_id；
- group_id；
- action；
- before/after；
- source_id 或 device identity；
- revoke_generation；
- reason；
- request_id；
- created_at；
- result。

审计字段需脱敏，不写 APP Token、卡密明文和设备密钥。

## 4. 前端页面与实际接口差异

### 4.1 普通管理员面板

HTML 中 `loadUserPanel()` 读取 `/api/user/app-groups`，只渲染分组名称和模式文字：
- free → 免费
- public → VIP
- assigned → 指定用户

页面有创建分组按钮，但没有：
- 分组来源配置；
- 设备成员管理；
- 单个来源移除；
- 单设备撤销；
- 分组启停；
- 分组撤销时间线；
- 24 小时清理状态与 ACK。

因此当前用户端分组功能更接近“创建分组与查看列表”，不是完整 APP 分享管理界面。

### 4.2 超管分组页面

超管页面：
- 按管理员选择分组；
- 创建分组；
- 修改 mode；
- 删除分组；
- 显示静态提示。

其中提示文案：
- free：所有绑定了本管理员编号的设备都能看到，卡密过期也保留；
- public：所有有效卡密用户可见；
- assigned：只有下面列出的设备可见。

风险：
- free 的“绑定管理员编号”不等于可信 APP 用户身份授权；第二十批已核实免费接口仍存在只凭管理员 ID/分享编号/device_id 的路径。
- public 的“所有有效卡密用户可见”必须以每条 entitlement 对应管理员范围为前提，不能跨管理员。
- assigned 需要可信设备身份，不能只凭客户端自报 device_id。
- UI 提示没有说明来源必须绑定到组、审核状态、enabled 状态和管理员归属。

**修复：** UI 文案必须从统一服务端授权规则生成，不得自行维护一套与 Worker 不同的解释。

## 5. 数据库影响与修复计划

本批不执行迁移。可能涉及：
- app_groups
- app_group_sources
- app_group_members
- source_ownership
- subscription_sources
- source_approvals
- app_entitlements
- app_free_grants
- APP 撤销事件/同步 ACK（当前未发现实现）

潜在结构（仅为设计建议，不能直接创建）：
- app_group_revisions：保存每次分组配置版本；
- app_group_events：保存创建、改型、来源绑定、成员变更和撤销事件；
- app_device_sync_state：保存设备已确认的 generation；
- cleanup_ack：保存 24 小时本地清理 ACK。

修复顺序：
1. 先补齐 group owner 与 source owner 的一致性验证。
2. 统一所有分组读取和节点下发的授权范围函数。
3. 增加管理员来源/成员单项解绑接口。
4. 分组变更改为 generation/tombstone 事件模型。
5. 补动作审计和超管委托边界。
6. 再完善 HTML 用户端和超管端管理界面。
7. 先只读检查真实 D1 的表字段、索引、唯一约束、外键和数据，再制定兼容迁移。

## 6. 测试验收矩阵

| 测试场景 | 预期 |
|---|---|
| 超管把管理员 B 来源添加到管理员 A 分组 | 默认拒绝；只有显式有效委托时允许 |
| 管理员 A 添加自己的来源到 A 分组 | 成功 |
| 管理员 A 添加管理员 B 来源到 A 分组 | 404/403，不能写关联 |
| 绑定不存在的分组 ID | 拒绝，不产生孤儿关联 |
| 分组目标管理员不存在 | 按产品策略拒绝或进入明确待绑定状态，不静默创建孤儿配置 |
| 管理员 VIP 过期时新增/改型/删除分组 | 按动作级矩阵拒绝 |
| 体验 VIP 有效期内管理分组 | 与正式 VIP 一致允许 |
| 移除单个来源 | 只撤销该来源，不删除整个分组 |
| 移除单个设备成员 | 只撤销该设备，不影响其他成员 |
| 分组改型 | generation 增加并产生范围变更事件 |
| 删除分组 | 生成 tombstone，不能先物理删除唯一撤销证据 |
| APK 24 小时内收到撤销 | 清理本地节点并回传 ACK |
| APK 离线 | 撤销事件保留，恢复联网后继续同步 |
| 同一撤销事件重复下发 | 幂等，不重复破坏其他数据 |
| 分组来源关联变更 | 每次变更均有审计和版本 |
| 超管代管跨管理员资源 | 必须有明确委托授权、理由、期限和审计 |
| HTML 分组提示 | 与 Worker 同一授权规则，不夸大可见范围 |
| 多管理员授权设备 | 不跨管理员合并来源/成员/分组 |
| APP 节点下发 | 只返回授权分组内、归属正确且启用/审核通过的来源 |

## 7. 本批边界与结论

- 已完成：阅读 AGENTS.md、动作级权限矩阵、第十一批撤销协议报告；检查 Worker 的 user/super app-groups 路由和 HTML 普通管理员/超管分组 UI。
- 未完成：真实 D1 schema/数据核验、API 测试、APK 端撤销同步/清理 ACK 测试。
- 未修改：Worker、HTML、APK、D1、Secrets、Cron、Cloudflare 部署。
- 等级：V2.5-DEV-B1-REVIEW-21，仅静态审计，不是 RC，不可部署。

**最终判断：** APP 分组管理尚未形成完整的“分组配置 → 来源/设备授权 → 撤销事件 → APK 增量同步 → 24 小时本地清理 → ACK”闭环。首先必须封堵超管跨管理员来源绑定缺少归属验证，再补齐单项解绑、变更审计与 generation/tombstone 协议。