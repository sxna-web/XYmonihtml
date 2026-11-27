# 星跃管理平台 V2.5｜Worker 正式修复影响分析、实施计划、测试与回滚方案 V1

- 日期：2026-11-27
- 仓库：`sxna-web/XYmonihtml`
- 分支：`main`
- 依据：
  - `AGENTS.md`
  - `docs/星跃管理平台V2.5_功能基线与权限验收规范.md`
  - `docs/backend/StarJump_V2.5_API接口契约与权限矩阵_V1_2026-11-27.md`
  - `docs/backend/StarJump_V2.5_动作级权限门禁矩阵_V1_2026-11-27.md`
  - 第三批《统一权限门禁与底层安全函数核查》
- 本文件性质：**正式代码实施前的影响分析与执行方案，不是修复完成报告。**
- 本轮状态：只读检查与计划文档；没有修改 Worker、HTML、D1、Secrets、生产配置或部署。

---

## 1. 执行结论

当前应进入 Worker 修复准备阶段，但**不能直接在归档 Worker 文件上开始生产修复**。

本轮读取到的 Worker 基线为：

`原始StarJump_V1点0_Final-zip-26-11-25-14:56/Worker.js`

Blob：`5da7aa3582558d9da2c2a0ad25a63c5e95e9fe63`

该文件位于原始归档目录。仓库规则明确要求原始版本只读；它可以作为历史核查基线，不能未经确认就当作线上当前部署版本。正式修复开始前必须取得/核对：
1. 当前线上 Worker 的实际代码版本或部署 commit；
2. 仓库当前准备部署的 Worker 源码及其与线上版本的差异；
3. 当前生产 D1 binding 指向的数据库身份和真实 schema（只读）；
4. HTML 管理后台及 APK 对这些 API 的真实请求字段、响应字段和 Token 保存/传递方式；
5. 当前 Worker 部署配置与已设置 Secrets 的“名称/是否存在/长度策略”状态；不得读取或输出 Secret 明文。

在上述信息不齐之前，只能完成离线补丁设计和测试用例，不得改生产文件、迁移正式 D1 或部署。

## 2. 当前源码已证实的修复目标

以下是对仓库归档 Worker 的静态源码观察，不等同于线上复现：

| 编号 | 发现 | 影响 | 修复优先级 |
|---|---|---|---|
| R-01 | `resolveOwnerKey` 对无 guest_key/格式错误输入返回共享 `g:anonymous` | 多个匿名用户可能共用归属空间 | P0 |
| R-02 | 转换路由内部 Session 解析存在 catch 后匿名继续的路径 | 无效凭证可能被降级为匿名转换 | P0 |
| R-03 | Session pepper 缺失时没有显式拒绝相关认证流程 | Token 哈希缺少部署级密钥保护 | P0 |
| R-04 | APP entitlement HMAC 缺 Secret 时回退固定 `starjump-app` | Token 可被预测/跨部署伪造 | P0 |
| R-05 | 转换数据密钥缺失时回退固定 `starjump-convert` | 历史加密数据保护失效 | P0 |
| R-06 | `/api/app/status` 仅按 device_id 查询，不验证授权 Token | 未认证方可能查询设备授权状态 | P0 |
| R-07 | APP Token/device_id 通过 URL query 传递 | 可能进入访问日志、代理日志和历史记录 | P1 |
| R-08 | APP nodes 路径只取最新一条有效 entitlement | 同设备多管理员授权可能被遮蔽 | P1 |
| R-09 | APP groups/links/cards 管理写操作未见统一有效 VIP 门禁 | 非 VIP/过期 VIP 可能执行管理写操作 | P0 |
| R-10 | `applyNodeFilters` 没有服务端登录/VIP 等级校验 | 高级过滤/重命名功能门禁缺失 | P0 |
| R-11 | `loadSourceForCtx/loadSubscriptionNode` 只验证 ownership，未统一覆盖 source/node 状态 | stale、停用或待审核资源可能被误用 | P1 |
| R-12 | `vipStatus` 以 MAX(ends_at) 与历史类型字段概括会员状态 | 不能可靠区分当前有效 trial/formal | P0 |
| R-13 | APP 激活事件写入 catch 静默 | 卡密成功激活但审计事件可能缺失 | P1 |
| R-14 | APP free grant 以裸 device_id 关联且永久保留 | 免费授权凭证和生命周期边界不清 | P1 |
| R-15 | 密文没有 envelope version/key_id/AAD | 密钥轮换、历史兼容和密文跨记录绑定不足 | P1 |
| R-16 | 用户态路由有 Session/scope，但缺统一动作级 VIP 授权层 | 登录权限和 VIP 管理权限混淆 | P0 |

## 3. 修复分阶段与依赖关系

### 阶段 0：基线锁定（开始编码前的硬门槛）

**目的：** 避免修复错误版本。

工作：
1. 读取仓库当前目录规范和所有相关模块说明；
2. 确认当前线上 Worker 版本、部署来源、绑定名称和 API 路由；
3. 对比归档 Worker、当前开发 Worker、线上 Worker 的差异；
4. 只读核验生产 D1 的表、字段、索引、外键、触发器和迁移历史；
5. 检查前端 HTML 的 fetch/API 调用及 APK 网络请求、Token 存储；
6. 列出兼容接口字段和客户端版本范围。

输出：
- 基线版本对照表；
- API 调用方清单；
- D1 只读 schema 快照（脱敏，不包含数据和凭证）；
- 当前 Secret 名称/配置状态清单（不显示明文）；
- 可回滚的源码 commit/部署版本记录。

未完成上述项目，阶段 1 不得合并到生产分支。

### 阶段 1：身份认证和匿名归属隔离（P0）

范围：
- `resolveSession`、Session 签发/哈希；
- `resolveOwnerKey`；
- `/api/convert`、`/api/convert/groups`、`/api/convert/links`、rename/revoke；
- guest credential 生成、保存和注册关联。

设计要求：
1. 请求完全没有 Authorization，才可能按 L0 匿名路径处理。
2. 请求携带 Bearer，但 Token 无效、过期、撤销或解析异常，必须 401；不得吞错后降级 L0。
3. 用户 Session 解析只做一次，结果在当前请求上下文传递。
4. 不允许共享 `g:anonymous`。
5. guest credential 必须由安全流程产生并保持稳定；不能只信任客户端任意字符串。注册后匿名历史关联需验证双方持有凭证并有明确确认流程。
6. `SESSION_PEPPER` 缺失或不满足策略时，认证相关操作 fail closed；上线前先确认 Secret 已配置，不能在生产直接切换导致所有既有 Session 失效。
7. 新旧 guest identity 迁移必须有兼容映射或用户确认的关联流程，不能把旧匿名记录直接合并到同一用户。

数据库影响：
- 可能需要 guest credential 的服务端签名/版本、迁移映射或凭证登记字段/表；是否新增由实际 schema 与数据迁移方案决定。
- 本阶段先尽量使用现有字段；确需变更时单独提交 migration SQL、checksum、前置检查、回滚限制和数据影响。
- 不得直接改生产 D1。

### 阶段 2：Secret fail-closed 与加密版本化（P0/P1）

范围：
- Session pepper；
- APP Token 专用 HMAC Secret；
- 转换专用 `CONVERT_KEY`；
- `sealJson/openJson`；
- APP Token 传递方式。

设计要求：
1. 删除固定字符串密钥回退；相关 Secret 缺失时明确拒绝相关功能。
2. Session pepper、APP HMAC Secret、CONVERT_KEY 分离用途，强随机、最小长度策略由部署说明固定。
3. 不能把 Secret 明文写入 Git、诊断日志或错误响应。
4. 转换密文采用版本化 envelope，至少有 version、key_id、algorithm、iv、ciphertext。
5. AES-GCM AAD 绑定记录 ID、用途和 envelope 版本。
6. 采用“旧 key 受控读取、新 key 单一写入”的轮换方式；旧数据解密失败必须停止迁移并保留原数据。
7. APP Token 从 URL query 迁移至 Authorization Header 或经审计的安全请求头。过渡期是否兼容 query，必须结合访问日志、APK 版本和泄露风险确定；不能永久同时接受明文 query Token。
8. Secret 配置和轮换必须先做 staging 演练、旧 Token 兼容验证和回滚验证。

数据库影响：
- 加密 envelope 可先尝试自描述格式，不一定需要新增列；如需索引 key_id 或迁移状态，必须单独设计。
- 不可直接重加密覆盖唯一副本；迁移应支持旧/新格式并记录进度。
- 生产 Secret 由用户/管理员在 Cloudflare 控制台配置；AI 不读取、不输出 Secret 值。

### 阶段 3：统一身份/会员/动作/资源授权层（P0）

范围：
- `vipStatus` 和 membership resolver；
- `/api/user/*` 路由入口；
- `userAppGroupsRoute`、`userAppLinksRoute`、`userAppCardsRoute`；
- filters、sources、nodes、groups 的写操作；
- 协助会话 actor/effective/scope。

统一授权判断必须同时使用：
- actor 身份；
- effective user；
- L0/L1/L2 或 superadmin；
- 当前 VIP kind（trial/formal/none）；
- VIP 状态（active/expired/revoked/unavailable）；
- action（read/create/update/delete/copy/share/manage/reveal/export）；
- resource owner 与 resource lifecycle；
- impersonation scope；
- 必须审计的动作。

强制业务约束：
1. L0 基础转换继续可用；不得因 VIP 门禁影响基础转换。
2. L1 注册不等于 VIP。
3. 有效体验 VIP 与有效正式 VIP 核心 VIP 管理权限一致。
4. 体验 VIP 到期严格只读：可查看本人历史，不得新建、编辑、删除；复制默认禁止。
5. 正式 VIP 到期可查看、删除本人历史；不得创建/编辑需有效 VIP 的管理资源。
6. APP 对接分组、星链接：注册用户可查看；仅有效 VIP 管理员可创建/编辑/增减/删除。正式 VIP 到期的一般历史删除权不得覆盖此专门限制。
7. APP 卡密管理写操作仅有效 VIP 管理员；管理员 VIP 卡池与 APP 用户卡池隔离。
8. 高级 filters 的 L1/L2 逐项分级仍待用户最终确认；未确认前不得将候选清单擅自写死为正式等级。
9. VIP 查询不可用或 D1 错误时，VIP 管理写操作 fail closed；不能因查询异常当作 active。
10. 协助会话先检查 actor 身份与 scope，再对 effective user 计算业务权限；不得借助协助 Session 提权。

实施方式：
- 先写纯函数/服务端 helper 和单元测试；
- 再在路由/handler 逐动作接入；
- 每个 handler 保留资源 owner 条件；
- 避免只在前端隐藏按钮；
- 对已有 API 响应字段保持兼容，新增错误码需同步前端。

### 阶段 4：APP entitlement / free grant / 设备绑定（P0/P1）

范围：
- `appRedeemRoute`；
- `/api/app/status`、nodes、groups、links、free；
- APP 卡密激活、事件、entitlement；
- 多管理员授权；
- APK Token/device_id 调用端。

设计要求：
1. status/nodes/groups/links/free 统一验证可验证凭证，不允许仅凭裸 device_id 作为认证。
2. 多 entitlement 必须按 entitlement ID 显式选取或按业务授权合并；不得 `ORDER BY created_at DESC LIMIT 1` 隐式遮蔽其他授权。
3. device_id 只是标识；需要设备凭证注册、轮换、撤销和重装/迁移策略。不能把客户端自报 ID 当作强设备证明。
4. 免费组通过管理员身份 ID 授权的规则要形成明确签发/验证链路；卡密组必须验证对应卡密授权关系。
5. APP 专用分享链接与普通网页链接严格隔离。
6. 卡密状态、entitlement、free grant、激活事件应在同一原子边界或可恢复 outbox 内完成；审计事件失败不得静默丢失。
7. 管理员到期三天宽限、已激活卡密继续有效、恢复仅针对 `owner_vip_expired` 等状态必须保留。
8. APP 分组删除/改型要通过 generation/tombstone、APK 增量同步、客户端清理和 acknowledgement 闭环；不能只做服务端删除。

APK 兼容要求：
- 必须先检查当前 APK 版本和调用代码；
- 若 Token 从 query 改 Header，旧 APK 的过渡兼容策略需明确；
- 不得未经确认让已安装 APK 突然全部掉线；
- 不得把 device_id 格式校验当作设备认证。

### 阶段 5：资源归属和生命周期（P1）

范围：
- `loadSourceForCtx`；
- `loadSubscriptionNode`；
- `loadManualNode`、`loadAnyNode`；
- source_ownership、source_approvals；
- node_lifecycle；
- APP 分组/分享/卡密关联。

设计要求：
1. 读取和写入都必须校验资源 owner。
2. 来源必须检查 enabled、approval、archive/transfer 状态。
3. 节点必须检查所属来源、ownership 和 stale/lifecycle 状态。
4. 写入语句尽可能将 owner/state 条件放入同一 SQL/batch，避免先查后写竞态。
5. 归属转移、撤销分享和删除分组必须检查关联授权及活跃链接。
6. 删除和改型采用可追踪 tombstone/generation；不得直接物理删除破坏历史审计。
7. 管理员 A 不能通过替换 ID 访问管理员 B 资源。

### 阶段 6：审计、错误处理、限流和诊断（P1）

范围：
- auditStmt/auditDenied；
- APP card events；
- 转换幂等键；
- rate limit；
- 诊断模块开关。

要求：
1. 安全敏感写操作与审计记录同一 batch；无法同批时使用可靠 outbox，不允许 catch 静默。
2. 诊断默认关闭，分模块 0/1；仅超管可改，变更需审计和 TTL 自动关闭。
3. 日志不记录完整订阅 URL、卡密、Session/APP Token、Secret 或数据库凭证。
4. 诊断信息包含 request ID、模块、阶段、错误码、耗时和脱敏资源 ID。
5. 限流必须原子执行；并发不能通过 SELECT count 后再 INSERT 绕过。
6. 转换 POST 使用幂等键；相同请求重试返回同一任务/结果，不重复扣额度。
7. 限流/数据库不可用时按安全策略 fail closed；不得静默放行高风险管理动作。

## 4. 文件影响范围（候选，待基线确认）

| 模块 | 预期影响文件 | 说明 |
|---|---|---|
| Worker | 当前实际部署 Worker 源码（待确认路径） | 不能直接覆盖 archives/original 中的原始文件 |
| 前端管理后台 | 当前正式 HTML/JS（待确认路径） | 需同步 401/403、会员状态、诊断开关和管理按钮展示 |
| APK | 当前源代码/网络客户端（待解包核验） | Token Header、设备凭证、多 entitlement、24h cleanup ack |
| D1 | 现有 schema + 新增 versioned migrations（如确需） | 先只读核验；未经批准不改生产 |
| 配置 | Worker 配置文件、部署文档 | 只列 Secret 名称和绑定，不含明文 |
| 测试 | `tests/` 对应单元/集成/回归测试 | 需要隔离的测试 D1 与 Worker 环境 |
| 文档 | API 契约、权限矩阵、迁移说明、诊断说明 | 与实现版本同步 |

当前尚未证明前端和 APK 具体文件路径/调用字段，不能将候选路径视为已核实。

## 5. 数据库影响评估

### 5.1 目前可以确认的原则
- 不能 DROP、TRUNCATE、重建或清空正式业务表。
- 不能把 Worker 内的 `MIGRATE_STATEMENTS` 当成生产 D1 当前 schema 的证据。
- 不能把 staging 数据库当成生产。
- 所有迁移必须版本化、幂等、有 checksum、依赖顺序、执行记录和前置 schema 检查。
- 新增索引/字段/表也属于正式 D1 变更，必须先给出影响分析并获得用户批准。
- 任何数据回填必须可重复执行、可暂停、可核对，不能覆盖未知数据。

### 5.2 当前未知
- 生产 D1 真实表清单、字段、索引、外键、触发器；
- 生产数据库 binding 的实际资源 ID/名称；
- 现有迁移账本和已执行 migration 版本；
- 当前线上是否存在未提交的手工 schema 变更；
- 历史转换密文数量、格式、可解密比例；
- 多 entitlement、free grant、guest identity 的真实数据分布。

因此本文件不生成可直接执行的生产 SQL。先完成只读 schema 快照，再决定是否需要 migration。

## 6. API 与客户端兼容策略

1. 先列出每个 endpoint 的方法、请求字段、响应字段、鉴权方式和调用端版本。
2. 保持既有响应结构，新增字段优先可选；错误码新增但不能改变既有成功响应含义。
3. Token 从 query 迁移 Header 前，必须查明 APK 当前发布版本与活跃用户比例；设计有限过渡期和停用日期。
4. 对无效 Bearer 从匿名降级改为 401，属于安全行为变更，前端需正确处理登录过期，不得自动无限重试。
5. APP status 新增 Token 校验时，必须与 APK 同步发布/兼容；不得造成合法用户全量授权状态丢失。
6. 多 entitlement 需明确响应如何表达管理员授权列表，不能只改 SQL 后让客户端误读。
7. filters 门禁错误应返回明确 403 和 feature code，前端可显示权益提示；但服务端必须始终执行判断。
8. 旧客户端兼容不能成为长期保留弱密钥、裸 device_id 或 query Token 的理由。

## 7. 测试方案

### 7.1 测试环境要求
- 独立测试 Worker 和独立测试 D1；
- 测试数据与生产数据完全隔离；
- 采用虚构账号、虚构卡密和虚构订阅源；
- 测试 Secret 使用测试专用随机值；
- 生产环境仅允许只读核验，不进行破坏性测试；
- 记录 Worker commit、D1 schema version、APK build、HTML 版本和测试时间。

### 7.2 身份与匿名隔离
- 无 Authorization 的 L0 基础转换成功；
- 有效 Bearer 的转换归属为当前 user；
- 无效/过期/撤销 Bearer 返回 401，绝不匿名继续；
- 两个匿名用户 credential 不同，数据完全隔离；
- 缺失/格式错误 guest credential 不落入共享 owner；
- Session pepper 缺失时认证相关接口 fail closed；
- 注册后关联匿名历史需验证凭证，不能把其他访客历史并入。

### 7.3 VIP 动作门禁
- L0 基础转换不受 VIP gate 影响；
- L0/L1 访问 APP 管理写接口被拒绝；
- 有效体验 VIP 可执行核心 VIP 管理动作；
- 体验 VIP 到期可查看历史但不能新增/编辑/删除，复制默认拒绝；
- 正式 VIP 到期可查看/删除本人历史，但不能新建/编辑 VIP 管理数据；
- 正式 VIP 到期仍不能删除/修改 APP 对接分组和星链接；
- 重新激活 VIP 后恢复本人管理能力；
- 协助会话越权、scope 不足、actor/effective 不匹配均被拒绝；
- VIP 状态查询异常时管理写操作 fail closed。

### 7.4 APP Token 与卡密
- 无 Token 调 status/nodes/groups/links/free 被拒绝；
- 错 Token、过期 Token、撤销 Token、错 device credential 均被拒绝；
- Token 不出现在 URL、普通日志和分析事件；
- 多管理员 entitlement 同设备可完整读取/选择；
- 卡密并发兑换只成功一次；
- 已激活卡密不因管理员 VIP 到期失效；
- 未激活卡密按宽限期状态转换；
- 续费只恢复 owner_vip_expired；
- 超管撤销、卡密自身过期不得自动恢复；
- 激活事件与 entitlement 一致，不出现成功但审计缺失。

### 7.5 加密与密钥轮换
- 缺少 CONVERT_KEY/APP HMAC Secret/SESSION_PEPPER 时对应功能 fail closed；
- 新密文写入新 envelope；
- 旧密文在旧 key 可用时仍可读取；
- key rotation 期间新写入只用当前 key；
- AAD 不匹配时解密失败；
- 错误密钥、篡改密文不能返回明文；
- 迁移中断后可继续，不重复破坏数据；
- 任何失败都保留原密文。

### 7.6 数据归属与生命周期
- 管理员 A 访问管理员 B 的 source/node/group/card/link ID 返回拒绝；
- ownership 撤销与并发写入不能出现越权成功；
- disabled/pending/stale/revoked 资源不被 APP 下发；
- APP 分组删除/改型：generation/tombstone→APK 拉取→本地清理→ack；
- 旧版本 APK 未确认 ack 时，不提前清理必要的同步状态。

### 7.7 回归测试
- 注册、登录、登出、Session 续期；
- VIP 卡密激活、到期、恢复；
- 普通订阅源管理和审核；
- 节点列表、手动节点、覆盖项、分组；
- 转换所有目标格式和已有 filters；
- 转换链接访问、撤销、重命名；
- APP redeem/status/nodes/groups/links/free；
- Cron 同步、卡密维护、entitlement 维护、节点生命周期；
- 超管审计、下载、统计和现有后台页面。

### 7.8 验收记录格式
每项测试记录：
- Test ID；
- 测试环境；
- Worker commit；
- D1 schema version；
- 客户端版本；
- 前置数据；
- 请求与响应（脱敏）；
- 预期结果；
- 实际结果；
- 日志/截图证据；
- 通过/失败/阻塞；
- 缺陷编号。

没有真实执行证据不得标记“通过”。

## 8. 回滚计划

### 8.1 Worker 回滚
- 每个阶段独立 commit/PR；
- 保留当前生产部署版本和上一稳定版本；
- 回滚仅恢复 Worker 代码，不自动回滚已执行的不可逆 D1 迁移；
- 回滚前检查新旧 Worker 与 schema 的双向兼容；
- 不允许直接 force push 覆盖历史。

### 8.2 D1 回滚
- 迁移前做备份并验证备份可读；
- 只允许设计可前滚修复或兼容性回滚；
- DROP/数据覆盖/字段重命名等不可逆动作必须另行审批；
- 对加密 envelope、guest identity、entitlement 迁移保留旧字段/旧密文，直到完成验收与恢复窗口；
- 任何恢复操作必须先在测试库演练，正式恢复需要用户明确批准。

### 8.3 Secret 回滚
- 旧 key 在过渡期内安全保留，不能在确认旧数据/旧 APK 全部迁移前删除；
- Secret 轮换记录 key_id 和生效时间，不记录 Secret 值；
- 发现新 key 失效时恢复旧 key 读取能力，但新写入切换策略必须明确；
- 不得回滚到公开固定字符串作为默认密钥。

### 8.4 客户端回滚
- APK 新旧版本并行兼容；
- Token Header 切换需先确认旧客户端策略；
- 服务端在停用旧 query Token 前确认活跃客户端已升级；
- 分组 tombstone/generation 与 cleanup ack 需兼容旧客户端，不得因客户端回滚导致节点复活。

## 9. 风险登记

| 风险 | 可能后果 | 预防措施 |
|---|---|---|
| 修复了归档旧 Worker，而非线上版本 | 线上漏洞仍存在/新版本功能丢失 | 阶段 0 锁定部署基线 |
| Session pepper 直接切换 | 所有旧 Session 失效 | 旧/新 pepper 兼容与用户会话迁移方案 |
| 删除固定密钥回退但未先配置 Secret | APP/转换/认证功能不可用 | 先核验 Secret 配置状态，staging 演练 |
| 改 Token query 到 Header 未同步 APK | 已安装 APP 授权请求失败 | APK 调用审计与过渡版本 |
| VIP gate 粗暴应用到所有 API | L0 基础转换、正式到期删除历史等被误阻断 | action-level matrix 与逐路由测试 |
| 体验/正式 VIP 状态合并 | 体验到期误允许删除或正式到期误禁止删除 | 独立会员状态解析与边界测试 |
| 多 entitlement 只取一条 | 用户漏节点/授权丢失 | 明确多授权选择/合并协议 |
| 密文直接换 key 重写 | 历史数据不可恢复 | 版本 envelope、双读单写、备份 |
| 迁移未经 schema 核对 | 正式 D1 失败或数据丢失 | 只读快照、幂等迁移、审批 |
| 审计写失败被吞 | 敏感操作不可追踪 | 原子 batch/outbox + 故障注入测试 |

## 10. 本轮不做的事情

- 不修改 `archives/original` 中的 Worker 原始文件；
- 不直接改线上 Worker；
- 不创建/删除/迁移/重建/清空正式 D1；
- 不修改 Cloudflare Secrets、环境变量或生产 binding；
- 不部署 staging 或 production；
- 不解密、导出或公开真实订阅凭证、Token、卡密；
- 不把静态源码检查标成运行测试；
- 不将待确认的 L1/L2 高级 filters 分配写成已确认规则；
- 不擅自决定体验 VIP 到期复制、体验管理员卡密宽限和免费 grant 生命周期。

## 11. 开始实际编码前的阻塞项

以下资料未完成前，不能进入生产修复：

1. **当前线上 Worker 源码/部署版本**：必须明确其与仓库归档 Worker 的 commit 差异。
2. **正式 D1 只读 schema**：表、字段、索引、外键、触发器和迁移版本；不得手工执行 SQL 作为前置要求。
3. **前端 API 调用清单**：管理后台每个相关 endpoint 的字段与处理逻辑。
4. **APK Token/设备调用清单**：当前 APP 版本、Token 存储、query/header、device_id 和多授权处理。
5. **Secret 配置状态**：仅核实是否配置及命名，不读取明文。
6. **测试环境**：独立 Worker/D1 及可回滚测试数据。
7. **待确认业务项**：至少冻结高级 filters L1/L2 归属；其余未确认项按保守默认处理，不阻塞身份/密钥修复设计。

## 12. 变更记录

- 2026-11-27：基于归档 Worker 和已提交权限矩阵，形成正式修复影响分析、分阶段实施、数据库影响、API/客户端兼容、测试和回滚计划。只读检查，无代码和生产变更。


## 13. 补充：旧版管理 HTML API 调用方静态核对

核对文件：
`原始StarJump_V1点0_Final-zip-26-11-25-14:56/index.html`

Blob：`（本轮读取到文件内容；此处不以归档 HTML 代表线上当前后台版本）`

本轮静态检索结果：
- 文件约 276 KB；
- 发现约 20 处 `fetch(`；
- 引用了 `/api/user/app-groups`、`/api/user/app-links`、`/api/user/app-cards`、`/api/convert`、`/api/convert/groups`、`/api/convert/links`、`/api/convert/groups/rename`、`/api/user/sources` 等路径；
- 未发现该 HTML 直接调用 `/api/app/status`、`/api/app/nodes`、`/api/app/groups`、`/api/app/links`、`/api/app/free`；这些属于 APK/APP 客户端调用范围，必须另行解包核对，不能据此认为 APK 不调用。

发现的兼容风险：
1. 该 HTML 用户面板的“立即同步”按钮调用 `/api/admin/sync`，而用户态来源同步的正确 API 是 `/api/user/sources/:id/sync`。此前审计已登记该差异；修复前需确认线上当前 HTML 是否仍有该调用。
2. 普通转换页面将 guest_key 放在 `/api/convert/groups?guest_key=...` 和 `/api/convert/links?guest_key=...` 的 URL query；rename/revoke 使用 `x-guest-key` 请求头。修复匿名凭证时必须同时迁移这些调用点，不能只改 Worker。
3. HTML 的用户态管理请求使用 `Authorization: Bearer <token>`；导出 APP 卡密的请求也通过 Bearer Header，但当前前端代码对导出响应没有先验证 `res.ok`/错误 JSON，可能把错误响应当 CSV 下载（此前已登记）。
4. HTML 的 API base 默认值包含 staging Worker URL。它是归档页面中的默认值，不构成当前生产 API 地址或生产部署配置的证明。
5. HTML 调用 APP 管理端点，但没有 APP 客户端授权 Token 传递逻辑；APP entitlement Token/device_id 的真实调用端仍须从 APK 源码核实。

**结论：** 本轮只核对了归档 HTML，未核对当前线上管理后台/最新前端版本。任何接口鉴权或字段修改前，必须再次对照实际部署 HTML 和当前 APK 客户端，建立 endpoint→caller→request fields→response fields 的完整兼容清单。

## 14. 阶段 0 核查状态更新

| 项目 | 当前状态 | 是否允许进入生产修复 |
|---|---|---|
| AGENTS.md / V2.5 功能基线 | 已读取 | 是（规范已明确） |
| 动作级权限矩阵 / 第三批审计 | 已读取 | 是（需求与差异已有基线） |
| 仓库归档 Worker | 已读取 | 否（不能证明是线上版本） |
| 仓库归档 HTML | 已读取部分 API 调用点 | 否（不能证明是线上 HTML） |
| 当前线上 Worker 版本 | 未核实 | **阻塞** |
| 当前线上 HTML 版本 | 未核实 | **阻塞** |
| APK API 调用与 Token 存储 | 未解包核验 | **阻塞 APP Token 改造** |
| 正式 D1 schema/迁移账本 | 未核实 | **阻塞所有生产 D1 变更** |
| Secret 配置状态 | 未核实 | **阻塞密钥 fail-closed 上线** |
| 独立测试 Worker/D1 | 未核实 | **阻塞集成测试** |

因此下一步仍然是补齐当前部署基线和客户端调用证据。不能因为已有归档 Worker/HTML 静态检查就直接开始生产代码替换。
