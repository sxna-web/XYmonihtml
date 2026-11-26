# StarJump V1.0 原始源码只读初审报告

- 审计日期：2026-11-27
- 审计对象：`原始StarJump_V1点0_Final-zip-26-11-25-14:56/Worker.js`、`原始StarJump_V1点0_Final-zip-26-11-25-14:56/index.html`
- 审计分支：`main`
- Worker blob：`5da7aa3582558d9da2c2a0ad25a63c5e95e9fe63`
- HTML blob：`ab98aecd4c8546eda197bbb4d5a9f5ec0db82613`
- 审计类型：静态源码只读初审；未连接 Cloudflare；未执行 API 请求、SQL、迁移、部署或生产数据操作。

## 一、结论摘要

原始 Worker 已包含多用户会话、订阅源和节点管理、节点覆盖/分组、转换链接、VIP 卡密、APP 授权与分组、公告/发布、审计、订阅同步与生命周期等多个模块。HTML 是单文件后台界面，包含登录、超管与用户面板，并直接调用 Worker API。

本报告只证明源码中存在相应代码，不证明这些代码已部署到生产环境，也不证明生产 D1 结构与源码内迁移定义一致。APK 源码 ZIP 尚未解压审计，因此本报告不评价 Android 端实现。

## 二、优先风险与差异

### P1-01：APP 管理写接口缺少有效 VIP 管理员状态校验

证据：
- `userAppGroupsRoute`（Worker 4521 起）允许当前登录用户创建、修改、删除自己的 APP 分组；路由逻辑未调用 `vipStatus` 或其他有效 VIP 管理权限检查。
- `userAppLinksRoute`（Worker 4285 起）允许当前登录用户新增和删除自己的 APP 入口链接；`addAppLink`（Worker 4264 起）只检查管理员入口开关和数量上限，没有检查 VIP 有效期。
- `userAppCardsRoute`（Worker 3558 起）允许当前登录用户生成 APP 卡密；POST 分支未检查有效 VIP 状态。
- 路由层将这些接口归入普通登录用户 API（Worker 5469-5476）。

与 V2.5 基线的差异：
- V2.5 要求“接入星跃 APP”和“星链接”等分享管理能力仅注册用户可见/使用，但只有未过期的有效 VIP 管理员可修改、增加、删除；普通注册用户和 VIP 过期用户只能查看。
- APP 卡密生成也应服从有效 VIP 管理员权限边界。

风险：普通注册用户或已过期用户可能绕过前端界面，直接调用 API 执行管理写操作。必须在 Worker 服务端统一补齐权限判断，并逐个核对体验 VIP、正式 VIP、到期状态的动作矩阵。当前仅记录差异，不实施修改。

### P1-02：转换过滤/重命名参数未执行登录或 VIP 权限门禁

证据：
- Worker 2843 附近的 `applyNodeFilters` 注释标明“仅登录用户可用”。
- 实际公开转换路由在 Worker 3290 行直接执行 `applyNodeFilters(nodes, body.filters)`，此前未见对登录身份、VIP 状态或功能权限的强制校验。
- HTML 在 Worker API 请求中传入 `filters.include`、`filters.exclude` 和 `filters.rename`（HTML 5583-5597）。

风险：匿名用户可自行构造请求传入过滤/重命名参数，可能获得本应限制给登录用户或 VIP 的功能。应先确认 V2.5 最终转换权限矩阵，再在服务端按已认证身份和服务端会员状态校验；不能依赖前端隐藏输入框。

### P1-03：在线数据库迁移接口具备直接 DDL 执行能力

证据：
- `migrateRoute`（Worker 4086 起）在 POST `/api/super/migrate` 收到 `confirm=yes` 后执行 `MIGRATE_STATEMENTS`。
- 迁移定义包含多项 `CREATE TABLE/INDEX IF NOT EXISTS`，还会尝试对 `convert_links`、`node_sync_logs`、`admin_app_perms` 执行 `ALTER TABLE ADD COLUMN`（Worker 3990-4084、4103-4153）。
- 总路由明确允许 `ctx.isSuper`，包括 legacy `ADMIN_TOKEN`，访问 `/api/super/schema-status` 与 `/api/super/migrate`（Worker 5509-5512）。
- HTML 也包含调用 `/api/super/migrate` 并发送 `confirm: 'yes'` 的操作（HTML 2138-2142）。

风险：这是实际 DDL 执行入口，不是只读诊断。它没有在代码中强制要求先完成 V2.5 规定的真实 schema 对照、备份可恢复验证、迁移审批和回滚方案。不得在正式环境点击或调用此接口。当前审计未调用该接口，也未执行任何 DDL。

### P1-04：节点生命周期注释与实际物理删除行为矛盾

证据：
- 生命周期模块注释称“观察期结束仍不在 → 标记 stale（只标记，绝不删行）”（Worker 3668 附近）。
- 同一函数后续又查询 stale 超过 30 天的记录，并执行 `DELETE FROM node_records WHERE id = ?` 及删除 `node_lifecycle`（Worker 3770-3781）。

风险：代码说明与真实行为相反。是否允许此类自动永久清理，必须按 V2.5 数据保留、历史记录、回收站和审计规则确认。未确认前，不应启用或依赖该清理逻辑；本次未运行 Cron。

### P1-05：APP 分组生命周期缺少 V2.5 所需的版本/失效确认链路证据

证据：
- Worker 的 APP 分组模式仅定义为 `public`、`assigned`、`free`（Worker 4435 附近）。
- APP 读取接口按设备和授权令牌返回分组（Worker 4584 起）；免费授权记录 `app_free_grants` 在卡密激活后插入，代码未见相应的分组 generation、设备同步确认、清理确认或过期租约机制。
- 用户分组删除路径直接删除分组及其关联记录（Worker 4550-4560）。

与 V2.5 基线的差异：
- V2.5 要求 APP 对接分组删除或改型后，设备本地节点在 24 小时内清理，并要求分组变更保留版本、操作者、时间和节点差异。
- 当前源码中未发现足以证明上述端到端机制已实现的证据。Worker 无法在设备离线时直接删除本地缓存，需结合 APK 的租约、版本/代次、防回滚及联网清理确认实现。
- 不能仅凭当前 Worker 代码认定 24 小时清理已经实现。

### P2-01：匿名用户身份依赖浏览器 localStorage

证据：
- HTML 5524-5531 生成并保存 `sj-guest`。
- Worker 3104-3111 将 guest key 哈希后形成 `g:<hash>` 归属键。

风险：清除浏览器数据或换设备后，匿名用户身份无法自动恢复；当前代码未体现匿名历史与注册账号之间的安全认领/合并流程。需结合 V2.5 稳定匿名 ID 与注册关联要求设计。

### P2-02：转换限流缺少原子预占和 Retry-After 证据

证据：
- Worker 3228-3235 先查询过去一小时该 IP 的转换记录数量，再决定是否放行。
- 该检查与后续插入转换记录不是同一原子操作；并发请求可能同时通过检查。
- 该分支返回 429 文本，但未看到设置 `Retry-After` 响应头。
- 当前转换请求也未见 request_id 幂等键处理。

风险：并发下可能突破单 IP 限流；请求重试也可能重复创建转换链接。应按 V2.5 的原子限流、幂等和额度返还要求进一步设计。具体阈值仍应按真实负载校准。

### P2-03：设备状态查询仅凭 device_id 返回授权状态字段

证据：
- `GET /api/app/status`（Worker 3916-3927）按 `device_id` 查询并返回最新授权的状态、到期和清理时间等字段，未要求授权 token。

风险：若设备标识泄露或可被枚举，可能暴露设备授权状态元数据。需要确认 device_id 的生成强度和 APP 调用场景，评估是否应要求设备证明或令牌。

## 三、当前源码中可见的正向安全设计

以下是静态代码中可见的实现点，仍需测试验证：
- 会话 token 使用随机字节生成，数据库保存 token 哈希；会话解析检查撤销、用户状态和过期时间（Worker 189-280）。
- 密码使用 PBKDF2-SHA256 加盐哈希；登录失败有锁定逻辑（Worker 36、160-180、455-510）。
- 用户订阅源、节点、覆盖、分组等多处查询通过 `effectiveId` 和归属关系限制数据范围（例如 Worker 1294-1315、1575-1640）。
- 协助会话具有 read/operate/manage 范围，并在批量写入时加入授权仍有效断言（Worker 201-330）。
- 订阅源 URL 变更会停用并进入重新审核流程；同步只处理已分配且获批准的来源（Worker 1453-1490、legacy sync 路由）。
- 转换记录通过 `sealJson/openJson` 封装载荷；每次成功转换会插入独立 `convert_links` 记录，且返回给前端的订阅 URL 会脱敏（Worker 3221-3340）。
- 节点同步存在 staging、generation/fencing 相关逻辑；仍需专项审计其所有提交路径和失败/重试竞态。

## 四、HTML 与 Worker 接口关系初步结果

HTML 实际调用的主要接口族包括：
- 认证：`/api/auth/login`、`register`、`me`、`logout`
- 用户：`/api/user/sources`、`nodes`、`node-groups`、`vip`、`app-groups`、`app-links`、`app-cards`、`downloads`、`share-code`、`stats`
- 超管：`/api/super/users`、`sources`、`source-approvals`、`source-quotas`、`audit`、`convert-links`、`vip-cards`、`app-groups`、`app-links`、`app-perms`、`app-entitlements`、`node-lifecycle`、`releases`、`announcements`、`downloads`、`alerts`、`stats`、`schema-status`、`migrate`
- 旧兼容接口：`/api/admin/sync`、`/api/admin/sync-logs`
- 公开转换：`/api/convert`、`/api/convert/groups`、`/api/convert/links`、`/api/announcements`

已初步找到这些接口族的 Worker 路由分发，但尚未逐一完成每个 method/path/request/response 的逐项契约比对。HTML 文件中还存在多个 staging Worker 主机名拼写形式，需确认哪些是历史残留、哪些是实际使用配置；不能擅自替换生产地址。

## 五、尚未完成的核查

1. 逐条提取 Worker 完整路由表（method、path、认证要求、角色、数据归属、响应字段），与 HTML 调用逐项配对。
2. 完整审计节点同步 staging/fencing 的 claim、stage、commit、fail、retry 全链路。
3. 完整审计订阅 URL SSRF 防护、重定向、DNS/IP 解析和响应大小限制。
4. 审计超管查询、导出、敏感 URL reveal、卡密查看和审计日志是否泄露不必要信息。
5. 审计 APP 卡密生命周期、VIP 到期三天宽限、恢复原因、并发激活及设备换绑。
6. 核对真实 D1 schema、索引、外键、触发器和迁移历史。源码里的 `MIGRATE_STATEMENTS` 不是生产 schema 证据。
7. 获取并解压 `StarJump-6.00.47-source .zip`、`StarJump-6.00.48-source.zip` 后，才能审计 Android 端与 Worker 的真实调用、离线缓存和 24 小时清理行为。

## 六、操作边界与下一步

- 本次只读取仓库文件；未修改 Worker、HTML、D1 或生产配置。
- 不得调用 `/api/super/migrate`，不得执行生产 SQL 或部署。
- 下一步先完成 Worker 路由/HTML 调用映射与同步 fencing 专项审计，再形成差异矩阵。
- 所有修复必须先给出影响范围、兼容方案、D1 影响、回滚和测试计划，等待明确授权后才可实施。


## 七、同步 fencing 专项复核

### 已看到的保护机制

本轮继续检查 Worker 900-1285 行附近的同步实现，发现以下机制确实写入源码：

1. `acquireLease` 使用 `subscription_sync_state` 的条件 UPSERT：仅当旧租约已过期时才允许接管，并递增 generation；同时更新随机 lease_owner、token hash 和租约截止时间（约 912-954 行）。
2. 每个 stage 分块写入前，将 fencing 断言与节点暂存写入放在同一 D1 batch；每条暂存 INSERT 也带有 generation、owner、token hash 和 lease expiry 条件（约 956-982 行）。
3. `sealTask` 重新读取暂存数据、核对数量并计算 manifest hash；写入 manifest、断言 hash、更新 staged 状态和 fencing 检查放在同一批次（约 984-1010 行）。
4. `commitTask` 在提交前再次读取 stage 并重新计算 hash；最终 D1 batch 内包含 fencing 断言、staged 状态断言、set-based upsert、别名写入、节点数完整性断言、同步日志、审计、任务 committed、清理 stage 和释放租约（约 1012-1085 行）。
5. 手动同步和 Cron 自动同步均通过 `syncSource` / `runSync` 进入同一套租约与提交流程；Cron 注释明确复用 fencing（约 1183-1278、5577-5612 行）。

初步判断：同步 fencing 并非只在日志表保存 generation，而是覆盖了租约获取、分块暂存、封存和最终提交关键路径。当前静态检查未发现明显的“旧 generation 可以在新 generation 接管后继续覆盖节点”的直接绕过路径。这是源码层面的正向发现，不等于并发测试通过。

### 仍需验证的边界

- 租约过期时间由 Worker 的 `Date.now()` 生成并作为参数传入 SQL；多实例时钟偏差和临界时间行为需要测试，最好明确 D1 时间与 Worker 时间的权威口径。
- `acquireLease` 成功更新租约后，再单独创建 task；若创建 task 的 batch 失败，租约会暂时占用至过期，需验证重试体验与恢复时间。
- `failTask` 的清理与状态回写应纳入异常注入测试，覆盖租约过期、被新 generation 接管、stage 分块中断、manifest 不匹配、commit batch 失败等场景。
- 需要用两个并发 Worker/任务做真实竞争测试，验证旧任务在新租约接管后，stage、manifest、节点 upsert、同步日志和租约释放均不能写入。
- 需要核对真实 D1 中 generation、lease_owner、lease_token_hash、lease_expires_at 的字段类型、索引和约束；不能只依据源码迁移注释推断。

## 八、敏感节点凭证存储差异

证据：
- 解析阶段生成的节点记录包含完整 `uri`（包含节点认证信息），并将该字段放入 staging payload（Worker 1183-1265 附近）。
- 最终提交 SQL 将 `json_extract(payload,'$.u')` 写入 `node_records.uri`（Worker 1012-1045 附近）。
- 手动节点创建/更新也将节点 URI 写入 `user_manual_nodes.uri`（Worker 1675-1700 附近）。
- 相比之下，转换短链载荷使用 `sealJson/openJson` 封装；但这并不等于节点主表和手动节点表也已加密。

与 V2.5 数据保护规范的差异：规范要求订阅凭证、节点认证信息按敏感数据处理，并设计静态加密和密钥轮换。当前源码路径中可见 URI 直接写入 D1 字段，未看到应用层加密/解密封装。

风险：如果该规范要求应用层静态加密，则当前节点 URI 持久化方式不满足要求。必须先核实生产 D1 现状、APP/前端读取依赖、历史数据迁移和密钥方案；不能直接改字段或执行迁移。此项需列入高优先级设计评审。
