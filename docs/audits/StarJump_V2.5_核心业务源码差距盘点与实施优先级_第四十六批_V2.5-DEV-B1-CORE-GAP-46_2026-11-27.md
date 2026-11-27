# 星跃管理平台 V2.5｜核心业务源码差距盘点与实施优先级

- 批次：第四十六批
- 版本：V2.5-DEV-B1-CORE-GAP-46
- 日期：2026-11-27
- 状态：**只读源码核查完成；差距与实施顺序已提交；未修改业务源码、未测试线上、不可部署**
- 仓库：sxna-web/XYmonihtml / main
- 依据：用户指定的 Cloudflare 两个基准文件 + 当前仓库功能基线/权限规范/既有审计
- 本批不接生产 Cloudflare/D1，不修改 Worker、HTML、Secrets，不部署。

## 1. 采用的源码基线和证据

| 对象 | 路径 | Blob SHA | 规模 |
|---|---|---|---|
| Worker | `原始StarJump_V1点0_Final-zip-26-11-25-14:56/Worker.js` | `5da7aa3582558d9da2c2a0ad25a63c5e95e9fe63` | 5,612 行 / 265,822 字符 |
| HTML | `原始StarJump_V1点0_Final-zip-26-11-25-14:56/index.html` | `ab98aecd4c8546eda197bbb4d5a9f5ec0db82613` | 5,770 行 / 276,880 字符 |
| 模拟 HTML | `星跃模拟后台 1.4.61.html` | `d046f71caa5af96b0c0978013771cb0a8f101739` | 10,565 行 / 899,551 字符 |

说明：
- 用户指定的两个 Cloudflare 基准文件是原始目录下 Worker.js 与 index.html，继续作为代码基线；保留原文件，未来生成独立修订版本。
- 1.4.61 HTML 是浏览器本地模拟版：源码没有 fetch、/api/、XHR；数据由 localStorage/IndexedDB 管理。不能把它误认为已经接入 Worker 的生产后台。
- 原始 index.html 是另一份 API 接入版，存在 fetch 调用并与 Worker 路由对应；它才是本批 HTML 接入审计对象。
- Blob SHA 只证明仓库源码版本，不证明 Cloudflare 线上运行时版本或 D1 绑定状态。

## 2. 当前真实架构判断

1. Worker 不是空壳：已有认证、用户、超管、来源、节点、分组、VIP、APP 卡密、APP entitlement、转换、下载、公告、统计、迁移等路由。
2. 原始 HTML 已调用 Worker API，但不是所有页面动作都正确对接；有旧接口误用、环境地址分裂和危险迁移按钮。
3. 仓库没有一份可作为生产 D1 当前状态证明的 schema 快照；Worker 内部 MIGRATE_STATEMENTS/REQUIRED_TABLES 不能替代真实 D1 结构。
4. 生产 Worker 版本、线上环境变量/Secrets、D1 binding ID、真实表/列/索引仍未核实。
5. 当前首要任务应是先修复认证与权限、数据归属和 APP 生命周期安全，再推进功能完整性；不宜先做通知、视觉改版或生产建表。

## 3. 核心差距与风险优先级

### P0｜必须先处理的安全与数据隔离问题

| 编号 | 发现 | 源码证据 | 影响 | 处理方向 |
|---|---|---|---|---|
| CORE-01 | 匿名转换缺少 guest_key 时回退共享 owner key `g:anonymous` | Worker `resolveOwnerKey()` | 多个匿名用户可能共享同一归属键，转换分组/链接读写隔离不可靠 | 缺 guest_key 时服务端签发/要求稳定访客身份；不再共享固定匿名 owner；需兼容旧访客记录迁移/只读 |
| CORE-02 | 转换加密密钥存在固定字符串回退 | Worker `convertKey()` 使用 CONVERT_KEY / SESSION_PEPPER / `starjump-convert` | Secret 缺失时密钥可预测，转换归档加密保护失效 | 缺必需 Secret 时 fail closed；定义现存数据密钥迁移与轮换方案，不能直接换 key 导致历史归档不可读 |
| CORE-03 | APP entitlement token 存在固定密钥回退 | Worker `entToken()` 使用 SESSION_PEPPER / `starjump-app` | Secret 缺失时授权令牌可预测 | 缺 Secret 时拒绝生成/验证新 token；先规划 token 版本/轮换和客户端兼容 |
| CORE-04 | APP status 仅凭 device_id 查询，不校验 entitlement token | Worker `/api/app/status` | 设备标识不能作为授权凭证，状态接口可能被未授权探测 | 统一校验 entitlement token；返回最小状态；兼容旧 APP 前先评估客户端协议 |
| CORE-05 | APP 多管理员授权读取路径使用最新一条 entitlement | Worker `appGroupsForDevice`、`/api/app/nodes` 等查询含 ORDER BY created_at DESC LIMIT 1 | 同设备多个管理员授权可能互相遮蔽，破坏多管理员隔离 | 以 entitlement_id/token 精确选授权；客户端可分别展示授权实例；不能混合 owner 数据 |
| CORE-06 | APP 分组删除为物理删除且分多条 SQL | Worker `userAppGroupsRoute` DELETE | 没有 tombstone/generation/ack；不能保证 24 小时客户端清理与故障恢复 | 墓碑/版本/generation、增量同步、客户端清理确认、超时重试形成闭环；保留审计 |
| CORE-07 | 用户态 APP 管理写接口没有统一有效 VIP 门禁 | Worker userAppGroupsRoute/userAppLinksRoute/userAppCardsRoute | 注册非 VIP/过期管理员可直接调用 API 尝试创建/修改/删除/生成 | 统一动作级授权；体验到期只读，正式到期可读/删除历史，超管独立权限 |
| CORE-08 | APP entitlement token 放 URL query | Worker app groups/nodes/links 读取 query token | 可能进入代理/访问日志/诊断日志 | Authorization header 优先；旧客户端兼容过渡和到期计划 |

### P1｜核心业务正确性和可用性

| 编号 | 发现 | 源码证据 | 影响 | 处理方向 |
|---|---|---|---|---|
| CORE-09 | VIP 状态只用 MAX(ends_at) + 历史 formal/trial count | Worker `vipStatus()` | 无法可靠区分当前有效体验/正式身份；权限可能误判 | 返回当前有效 activation 类型、时间、历史状态；查询失败敏感写操作 fail closed |
| CORE-10 | 转换 filters 注释要求登录/VIP，实际公开转换直接执行 | Worker `convertRoute()` | L0/L1 可能执行本应为 VIP 的高级过滤/重命名 | 保留 L0 基础转换；请求高级 filters 时单独验证有效 VIP，拒绝不能阻断基础转换 |
| CORE-11 | 全局限流 helper 是空实现，部分限流异常 fail-open | Worker `bumpGlobalLimit()` 返回 true；checkGlobalLimit catch 后返回 ok | 全局限流可能没有实际效果，D1 表缺失时也放行 | 明确本地/IP/账号/全局限流策略；关键限流数据不可用时按风险 fail closed 或明确降级 |
| CORE-12 | APP 卡密激活后免费 grant 被永久保留 | Worker appRedeemRoute 注释和 app_free_grants insert | 是否符合最终免费分组授权生命周期需确认；可能在授权失效后继续保留 | 先对照已确认 APP 分享规则和授权回收条件；未确认前不擅自删除或延长 |
| CORE-13 | APP 分组删除/改型未形成 APK 24 小时清理闭环 | Worker 当前物理删除，未发现 ack 流程 | 客户端缓存可能长期保留旧节点 | 与 CORE-06 一起实现端到端协议，必须有 APK 源码联调证据 |
| CORE-14 | 迁移状态只检查表是否存在；迁移语句逐条执行并吞掉部分错误 | Worker migrateRoute/schema-status | 可能出现表存在但列/索引/约束不正确，却显示 ready；部分迁移失败仍继续 | 生产迁移入口先禁用/保护；差异检查、版本/checksum/原子批次、备份/回滚；不可在本批直接调用 |
| CORE-15 | 迁移 API 允许 legacy ADMIN_TOKEN 兜底 | Worker fetch 分发 /api/super/schema-status、/migrate | 旧凭据可触达高风险 schema 变更 | 收紧为真实超管 session + actor=effective + capability + 二次确认；紧急恢复需独立受控流程 |
| CORE-16 | HTML 多处同步操作误用 /api/admin/sync | 原始 index.html 来源同步和用户面板；Worker 用户同步路径是 /api/user/sources/:id/sync | 用户操作可能被 legacy 管理路由拒绝或权限边界错位 | 按调用场景分别映射 user/super API；逐一核对方法、payload、响应结构 |
| CORE-17 | HTML 卡密导出独立读取 localStorage 的 sj-api 并回退 staging | 原始 index.html uCfExport | 可能与管理后台 apiBase 指向不同环境，数据导出环境错配 | 全部请求统一通过 apiBase/apiUrl，移除独立 staging fallback |
| CORE-18 | 注册体验发放、卡密激活与状态聚合需并发/失败验证 | Worker grantTrial、userVipRoute | 竞态或发放失败处理可能导致状态/期限错误 | 以 D1 唯一约束与 batch 原子性为基础测试；核实真实 schema 后再改 |

### P2｜产品完整性与体验

- 首页/最近使用/通知目前不能作为真实通知中心证据；Worker 现有提醒偏动态计算/横幅，不是持久化通知系统。用户已允许通知后置。
- 前端原始 index.html 仍有独立环境配置和旧接口遗留；需统一请求封装。
- 1.4.61 模拟版虽然有大量 UI 页面，但不能直接当作真实后端功能；正式接入必须逐动作建立 API/权限/数据映射。
- APP 发布、版本、客户端同步、设备缓存等需要 APK ZIP 审计与真机联调，不能只靠 Worker 静态代码验收。

## 4. 当前主要业务实现状态

| 模块 | 当前仓库证据 | 判断 |
|---|---|---|
| 登录/注册/Session | Worker 有 register/login/logout/session token hash、协助会话 scope | 部分实现；Secret 缺失策略、并发注册、会话撤销需测试 |
| 普通用户来源/节点/分组 | Worker 有对应 user 路由和 ownership 检查 | 部分实现；需逐路由核对对象级权限和限流 |
| VIP 生命周期 | 有 trial/formal activation 和卡密激活 | 部分实现；当前状态聚合不充分，动作级门禁缺失 |
| APP 卡密/设备授权 | 有 redeem/status/nodes/groups/links | 部分实现；token、多个授权、撤销清理有高风险 |
| APP 管理分组/链接 | 有用户态与超管路由 | 部分实现；有效 VIP 门禁和删除闭环不足 |
| 转换 | 有订阅抓取、解析、格式生成、短链和归档加密 | 部分实现；匿名归属、固定密钥、高级 filters 权限、限流有风险 |
| 转换归档 | convert_links 有加密 payload 和 owner_key | 部分实现；共享匿名归属风险、幂等和归档失败恢复不足 |
| 超管运维 | 有统计、审计、用户管理、APP 管理、迁移等接口 | 部分实现；迁移 API 风险高、审计完整性待核 |
| 前端接入 | 原始 index.html 有 API fetch；1.4.61 模拟 HTML 无 API | 部分接入；同步和导出环境错配 |
| 通知中心 | Worker 有提醒横幅/告警相关代码 | 未形成持久化网页通知/邮箱完整体系；按用户决定后置 |
| D1 schema | Worker 有建表/补列语句，仓库有字段映射文档 | 生产真实 schema 未核实；不能判定完全兼容 |

## 5. 建议的主线实施顺序

### 第一阶段：身份与安全基础（下一批优先）

1. 统一 Session/Secret fail-closed 方案；缺失 SESSION_PEPPER 不允许创建/验证新 Session，明确旧会话迁移策略。
2. 修复转换加密密钥和 APP entitlement token 的固定回退；对历史数据和旧 APP 做版本化兼容方案。
3. 统一 VIP 状态解析，区分当前有效 trial/formal、到期历史和查询不可用。
4. 建立动作级授权决策：read/create/update/associate/disable/delete_history；覆盖 APP 分组、APP 链接、APP 卡密。
5. 保留 L0 基础转换；高级 filters 独立要求有效体验/正式 VIP。

### 第二阶段：数据归属与转换可靠性

1. 取消共享 `g:anonymous` 归属；为访客建立可验证的匿名身份与历史兼容。
2. 为转换请求引入 request_id/idempotency，防止重复写入。
3. 归档失败可恢复，转换成功与归档状态可追踪。
4. 修复限流实际执行逻辑与错误降级策略。
5. 统一 HTML 所有 API 调用入口和环境地址，修复用户同步、卡密导出错配。

### 第三阶段：APP 授权与生命周期闭环

1. status/nodes/groups/links 使用一致的 entitlement 授权校验。
2. 多管理员 entitlement 独立返回，不取 latest-only。
3. token 从 query 迁移到 header，兼容期内保持客户端可用。
4. 分组 tombstone/generation → APK 增量同步 → 本地 24h 清理 → acknowledgement。
5. 先运行 APK ZIP 审计，再安排客户端联调。

### 第四阶段：安全数据库升级和前端工作台

1. 只读检查 schema tables/columns/indexes/FK/constraints。
2. 迁移版本/checksum/dependency/lease/失败恢复。
3. 真实 D1 隔离验证后，才设计手机端一键初始化/升级。
4. 前端按角色重构工作台/导航；通知中心按用户要求后置。

## 6. 下一批建议的最小可交付范围

**第四十七批建议：身份/VIP 状态与动作级权限修复的独立实施计划 + 代码测试夹具。**

- 先不触生产 D1，不执行迁移，不部署。
- 以当前 Worker.js 为基线，另建新版本文件，不覆盖原件。
- 先实现并单测纯函数级 VIP 状态分类和动作级权限决策；之后再把门禁接入实际 APP 写路由。
- 同批可设计 Secret 缺失时 fail-closed 变更，但需先确认历史 token/加密 payload 兼容与回滚。
- 任何 D1 schema 变化必须单独报告，等待明确批准。
- 目标是先阻止最严重的越权写操作，不做无关 UI 美化。

## 7. 不可核实事项与禁止推断

- Cloudflare 线上 Worker 是否仍为仓库 Worker.js：未知。
- 生产 D1 binding 是否名为 DB、真实 database ID 和 schema：未知。
- 当前线上 Secrets 是否齐全、实际值是否安全：未知；不读取或输出秘密。
- APK 客户端是否支持多 entitlement、header token、generation/ack：ZIP 未审计，未知。
- 当前生产流量计量数据源、节点主动探测数据源：未确认。
- 不调用生产 `/api/super/migrate`，不运行初始化按钮，不做生产写请求。
- 本批仅静态核查，无业务代码测试，无线上测试，无部署。

## 8. 本批交付状态

- [x] 核对 main 分支树和基准文件 SHA。
- [x] 读取 Worker/HTML 实际源码并定位关键函数/路由。
- [x] 对照功能基线和既有审计整理核心差距。
- [x] 给出分阶段实施优先级。
- [ ] 本批代码修改：无（只读审计批次）。
- [ ] 运行 Worker/D1 集成测试：未运行，缺少隔离 D1 环境。
- [ ] 生产验证/部署：未执行。

用户无需本地操作、无需提供邮箱、无需运行 SQL。
