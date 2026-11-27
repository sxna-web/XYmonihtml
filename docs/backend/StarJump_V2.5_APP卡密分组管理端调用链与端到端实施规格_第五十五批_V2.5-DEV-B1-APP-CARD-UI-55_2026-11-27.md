# 星跃管理平台 V2.5｜APP 卡密分组管理端调用链与端到端实施规格

- 批次：第五十五批
- 版本：`V2.5-DEV-B1-APP-CARD-UI-55`
- 日期：2026-11-27
- 状态：**管理端/Worker 调用链只读盘点完成；端到端实施规格形成；未修改业务代码；不可部署**
- 仓库：`sxna-web/XYmonihtml` / `main`

## 1. 核查基线

已按仓库规则重新读取：
- `AGENTS.md`、功能基线、API 接口与权限规范；
- 工具可靠性总方案、开发进度；
- 第五十四批卡密分组关系核查报告；
- 当前 HTML：`星跃模拟后台 1.4.61.html`，Blob SHA `d046f71caa5af96b0c0978013771cb0a8f101739`；
- 对照 HTML：`星跃模拟后台 1.4.60.html`，Blob SHA `8e7d693e85918d0d4de1cc766ec7d72c1958a7cc`；
- Worker：第四十九批 `Worker.js`，Blob SHA `a4689380215e95c1c9f605fc974cc553b3e7037f`；
- 第五十批 APP 卡密/链接 Handler 测试。

仓库递归 Tree 只有上述两个完整 HTML 页面和独立 Worker 版本文件；当前未发现独立前端构建源码目录。当前 HTML 与 Worker 是不同提交/版本基线，不能推断它们已作为一组部署在 Cloudflare。

## 2. 管理端 HTML 现状（1.4.61 静态源码）

### 2.1 APP 卡密分组配置入口

HTML 的 `identity-lifecycle` 页面包含“APP 卡密分组配置”区域：
- 从本地模拟数据 `DB.cards` 读取卡密；
- 仅展示 `cards.slice(0,100)`；
- 展示卡密、所属管理员、用户、激活状态、授权分组；
- “配置分组”按钮触发 `sj51HandleAction('card-groups', id)`；
- 选项从 `DB.groups` 过滤 `adminId === card.adminId`、`appType === 'card'`、`appEnabled !== false`；
- 保存后写入浏览器侧模拟对象 `c.groupIds` 和 `c.groupConfigUpdatedAt`，再 `saveDB()` 并调用 `sj51Log()`。

这证明 HTML 有界面/模拟业务逻辑，但不证明后端有对应持久化接口。检索 1.4.61 全文，没有发现 `/api/user/app-cards`、`/api/user/app-groups`、`/api/super/app-groups` 等 APP 管理 API 调用，也未发现该卡密配置功能通过 fetch/Worker 保存。

### 2.2 页面权限现状

- 菜单注册将 `identity-lifecycle` 标记为 `masterOnly: true`；
- 页面渲染入口 `sj51RenderLifecycle`；
- 所有 `sj51HandleAction` 开始时调用 `requireMaster('身份与生命周期管理')`；
- 因此该页卡密分组配置当前是超级管理员专用模拟操作，不是 VIP 管理员自主管理入口。
- 普通 APP 分组创建/编辑 UI 在 `openGroupForm`，使用 `requireVip`，可选择 normal/free/card 类型；但这也是当前 HTML 本地 DB 操作，不能视为后端持久化或服务端权限验证。
- 分组来源/节点管理主要复用现有转换分组 UI；需在后续正式接入时明确区分“普通转换分组”与“APP 可授权分组”，避免只靠 appType 前端字段授权。

### 2.3 现有 UI 业务意图

HTML 当前明确表达：
- 每张 APP 卡密可以配置任意数量 APP 卡密分组；
- 分组必须属于卡密所属管理员；
- 仅选择有效启用的 card 类型分组；
- 管理员 VIP 到期不应让已激活 APP 卡密自动失效；
- APP 分组删除/改型应启动 generation + 24 小时本地清理机制。

这些属于 HTML 中的设计/模拟行为，仍需后端真实实现和测试。

## 3. Worker 真实 API 现状（第四十九批源码）

### 3.1 卡密接口

路由：`/api/user/app-cards`，由用户会话路由调用 `userAppCardsRoute`。

- GET：只查询当前 `ctx.effectiveId` 管理员的卡密，返回字段不包含 `groupIds`。
- POST：只接受 `count`、`days`，批量创建卡密；没有分组参数。
- DELETE：未激活/未使用卡密设置 inactive/manual_disabled；已激活/已使用不能删除。
- POST `/:id/disable`：停用卡密。
- GET `/events`：按当前管理员查询卡密事件。
- 写入通过 `userBatch` + `auditStmt`；创建、停用和删除有审计记录。

因此 Worker 已有真实卡密生成、列表、停用和事件接口，但没有卡密分组配置/读取接口。

### 3.2 分组接口

- `/api/user/app-groups`：当前管理员创建、列出、更新、删除自己的 APP 分组；
- `/api/user/app-groups/:id/sources`：添加来源时检查分组归属和 source_ownership；
- `/api/user/app-groups/:id/members`：按设备添加 assigned 成员；
- 删除分组时删除 group_sources / group_members 关系。
- `/api/super/app-groups`：超级管理员跨管理员管理分组，当前部分查询/更新/删除/来源/成员 SQL 未在每个子资源操作中统一重复验证父分组管理员和来源归属，未来接入需单独补足。
- 用户分组路由有历史数据 `formalCutoff` 限制，但需对照完整授权上下文确认各操作；不能仅凭路由名称认定所有动作符合正式 VIP 到期规则。

### 3.3 读取端

- `/api/app/groups` 现有规则是 public/free/assigned 设备可见性；
- 没有 card_id → group_id 关系；
- `/api/app/nodes` 按管理员全部来源下发，未按允许的 APP 分组范围过滤；
- 卡密核销生成 entitlement 时只记录 card_id/admin_user_id/device_id 并写 free grant，不写卡密专属分组关系。

## 4. 已确认需求与尚未确认设计

### 已确认需求（按既有产品规则）
1. 每张 APP 卡密可绑定一个或多个 APP 卡密分组。
2. 只能配置卡密所属管理员名下有效启用的 APP 卡密分组。
3. 卡密激活后，APP 依据该卡密授权其配置的分组。
4. 不得使用普通网页分享链接代替 APP 专用分组授权。
5. VIP 有效管理员可管理自己的 APP 卡密和 APP 分组；VIP 到期后按正式 VIP 历史数据规则只允许查看/删除历史记录，不允许新建/编辑管理数据。体验 VIP 到期按严格只读。
6. 已激活 APP entitlement 不因管理员 VIP 到期而自动失效；卡密自身失效、撤销、人工停用等按各自状态处理。
7. 多管理员 entitlement 必须隔离；同一设备不同管理员授权不混合。

### 需要实施前冻结的设计细节
- 一个卡密是否允许 0 个分组（建议允许保存草稿/未配置，但激活时明确拒绝或按明确免费规则处理；不能默默授予管理员全部组）。
- 是否将 public/free/assigned 旧模式与 card 专属模式叠加。安全建议：卡密授权实例默认只返回 card 明确绑定的组；免费组继续走独立 free grant；public/assigned 是否额外附加必须另行写入 API 契约。
- 一张卡密可以被多个设备激活还是仅一个设备。现有 entitlement 表没有在本批确认唯一约束，需按 APP 源码和历史业务规则核实。
- 用户说“每张卡密独立用户 ID”的既有 UI 描述与 Worker 当前 card/entitlement 字段是否完全一致，需 APK 源码核对。
- 是否允许激活后修改卡密分组，以及修改后已激活设备的生效时间。建议采用 generation/授权版本与 24 小时本地清理规则，不能静默改变历史授权。

## 5. 推荐端到端接口规格（提案，未实施）

保持旧 API 不破坏，新增卡密分组子资源接口：

- `GET /api/user/app-cards/:cardId/groups`
  - 仅查询当前管理员拥有的卡密；
  - 返回该卡密已绑定的分组 ID/名称，以及当前可选的有效 card 类型分组；
  - 卡密和分组必须同属 `ctx.effectiveId`。
- `PUT /api/user/app-cards/:cardId/groups`
  - 请求只传 `group_ids: string[]`；
  - Worker 从会话上下文取得管理员 ID，不接受客户端 admin_user_id；
  - 逐项验证卡密归属、分组归属、appType=card、enabled；
  - 去重、限制数量、原子替换、幂等；
  - 有效 VIP 可写；正式 VIP 到期只能查看/删除历史卡密，但不能更新其授权配置；体验到期只读；
  - 写审计 before/after 的 group ID，不写卡密明文。
- 建议新增关联表 `app_card_groups(card_id, group_id, created_at)`，复合主键 `(card_id, group_id)`，外键策略需结合现有 D1 迁移规范决定。此为草案，不是已批准 migration。
- `GET /api/user/app-cards` 旧响应保持兼容；可在确认调用方后增加可选 `group_count`，不默认暴露敏感分组细节。
- 卡密 POST 可选增加 `group_ids` 批量默认模板，但必须由服务端逐项验证；为减少契约复杂度，第一版建议先生成卡密，再单独批量配置关联。
- 新增批量配置需逐张卡密逐项校验，返回逐卡密成功/失败，不允许第一张合法即放行整个批次。

APP 读取：
1. entitlement resolver 按 entitlement_id + device_id + Token 精确解析；
2. 从 entitlement 记录取得 card_id/admin_user_id；
3. 通过 card_id 关联 app_card_groups，再联 app_groups，要求卡密管理员、授权管理员、分组管理员三者一致，且分组仍启用、类型仍为 card；
4. 节点仅从这些 group_id 的 app_group_sources 获取，并在 SQL 中再次校验 source_ownership 属于该管理员、来源启用/审批通过、节点启用；
5. free grant 单独处理，不得作为 card 专属分组权限；
6. 所有结果按 entitlement 实例隔离，不按 device_id latest-only；
7. 删除/改型/取消卡密分组时更新授权 generation/tombstone，APP 同步确认后完成 24 小时本地清理。

## 6. 权限、审计和风险

- 管理端有效 VIP：本人卡密分组配置增删改；服务端每次请求校验 VIP 状态。
- 正式 VIP 到期：本人历史卡密可查看和删除（按既有基线）；卡密分组关系属于授权配置，禁止新增/编辑。删除卡密是否连带移除关联须采用软失效/审计策略，避免误删历史追溯。
- 体验 VIP 到期：严格只读；不得配置、增删改。
- 超级管理员：可按超管跨用户授权策略管理，但必须记录操作者、目标管理员、卡密和变更原因；不允许隐式 impersonation 绕过审计。
- 每次关联修改记录 actor_id、effective_id、card_id、变更前后 group IDs、时间、结果、原因；不记录 card code、Token、订阅 URL。
- 并发：采用事务/批处理及版本条件，防止并发覆盖；重复请求幂等。
- 删除分组：先使关联失效并递增 generation，再执行异步/APP ack 清理；不能直接删除仍被授权关系引用的分组。
- 数据库：新增表需单独 migration、备份和恢复演练、预检、dry-run、迁移后验证；本批不执行。

## 7. 影响范围、回滚和测试计划

影响：
- Worker：新增卡密分组读写 API、核销/读取查询、节点范围 SQL、审计、兼容逻辑；
- HTML：将当前超级管理员模拟区改为真实 API 驱动的卡密配置入口，并在 APP 管理工作台提供管理员本人入口；不删除超管审计/协助能力；
- D1：未来新增 card-group mapping 与可能的授权 generation/事件字段（字段需求仍待设计核对）；
- APK：需确认 entitlement_id/token/card group 响应支持，未解包前不改客户端协议；
- 旧客户端：旧接口返回字段保持，旧客户端不应获得扩大后的权限。

回滚：
- Worker 回滚到前一版并保留新增关联表数据；
- 若已写入关联表，回滚 Worker 不删除表/数据；
- migration 回滚只允许经用户批准并在备份恢复演练后执行；默认采用向前兼容，不自动 DROP；
- HTML 回滚旧版前确保旧 API 行为不被新页面依赖。

最低测试：
1. 管理员 A 卡密只能绑定 A 的 card 类型有效分组；
2. 管理员 A 卡密提交 B 组、normal/free/disabled 组拒绝；
3. VIP 有效可写；正式 VIP 到期只能查看/删除历史，不可修改配置；体验到期完全只读；
4. 超管跨管理员操作有审计且需明确目标管理员；
5. 卡密 A/B 同一管理员分组互不串用；
6. 不同管理员卡密/entitlement 同设备隔离；
7. 激活、过期、撤销、人工停用、VIP 到期的差异规则；
8. nodes 只能返回当前 entitlement card groups 来源节点；
9. source ownership 错配、组停用、源撤销、D1 异常 fail closed；
10. 24 小时 tombstone/generation/ack 幂等；
11. 旧 API 响应兼容和旧 APK 未支持字段时的安全退化；
12. Worker.fetch + mock D1、隔离 D1 集成、HTML 端到端测试。

## 8. 本批结论

- 管理端 HTML 当前卡密分组配置是本地模拟数据操作，页面为 masterOnly；不是 VIP 管理员的真实后端功能。
- Worker 有真实卡密 CRUD 部分接口和 APP 分组接口，但没有 card-group 配置接口和关联表。
- HTML 与 Worker 当前没有形成可证明的 API 调用链。
- 已形成端到端接口和权限设计提案；其中旧分组模式叠加、未配置卡密激活策略、多设备激活限制、激活后修改的生效时机仍需按 APK/业务规则核实。
- 本批只读盘点和文档设计；没有修改 HTML、Worker、D1、Secrets、APK；没有运行代码测试；未访问生产环境、未部署。

## 9. 第五十六批唯一接手卡

**第五十六批：APP 卡密分组授权业务规则冻结与兼容矩阵。**

1. 重读 AGENTS、功能基线、API 规范、总方案、进度、第五十四/五十五批报告。
2. 对照历史需求记录，核实“卡密独立用户 ID”、同卡密多设备激活、卡密分组为空、激活后修改配置、VIP 到期、免费组叠加等边界。
3. 只读核对 APK 源码 ZIP 是否在仓库或 Library 可用；若无法取得二进制，明确 APK_PENDING，不推测客户端协议。
4. 形成最终状态矩阵：卡密状态 × entitlement 状态 × VIP 状态 × 分组类型 × 设备身份。
5. 冻结旧 APP API 的兼容策略、card group 响应字段、generation/24 小时清理的端到端协议。
6. 对未明确的关键业务冲突列出最少必要确认项，不擅自创建 migration 或接入 Worker。
7. 完成后更新进度、总方案和第五十七批接手卡。

