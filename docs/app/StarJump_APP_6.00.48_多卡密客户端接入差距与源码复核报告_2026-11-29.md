# 星跃 APP 6.00.48｜多卡密客户端接入差距与源码复核报告

- 记录日期：2026-11-29
- 审计对象：仓库中的 `StarJump-6.00.48-source.zip`
- 原始 ZIP：2,323,467 bytes
- SHA-256：`1d4f49790ef358d2d8de807fa95fd18c331f06692e1a15c4d9030c6cad8b8012`
- ZIP 完整性：`unzip -t` PASS；628 entries；193 个 Kotlin/Java 源文件。
- 源码取得：从此前 APP 源码审计工作流的临时 artifact ID `15262037576` 恢复，外层 ZIP 内含原始源码 ZIP；原始 SHA 与第一百一十八批记录一致。
- 性质：只读源码审计与仓库候选分支对照；没有修改 APP 源码，没有生成 APK，没有访问 Cloudflare/D1。

## 1. 本轮确认的客户端事实

### 1.1 授权 token 仍为单条覆盖模型

文件：`app/src/main/java/io/nekohasekai/sagernet/starjump/ActivationActivity.kt`

- `doActivate()` 激活成功后只写 SharedPreferences 的 `token`、`expires_at`、`admin_user_id` 三个键。
- 再激活其他卡密会覆盖旧 token 和到期信息，没有按 entitlement/card/admin 保存多条授权。
- `refreshState()` 与 `StarJumpGate.check()` 均只读取单个 `token` / `expires_at`。
- 因而同一 APP 用户绑定多个 VIP 管理员、同一 VIP 多张有效卡的客户端授权状态无法完整表达。

文件：`app/src/main/java/io/nekohasekai/sagernet/starjump/StarJumpApi.kt`

- `redeem()` 只解析单次激活响应中的 token、admin_user_id、expires_at、days。
- `links()` 只接受一个 token，并只发一个 `token=` 参数。
- 当前没有 `groups()` 多卡密读取方法，没有把多条授权 token 作为重复 query 参数发送。
- 当前没有调用 `/api/app/groups`、`/api/app/free` 或 `/api/app/nodes` 的客户端实现。
- 已有 API 方法为 `/api/app/redeem`、`/api/app/resolve`、`/api/app/links`、`/api/app/version`。

### 1.2 现有 Room 模型不能表达远端多管理员/多卡分组

文件：`app/src/main/java/io/nekohasekai/sagernet/database/ProxyGroup.kt`

- 当前仅有 `starJumpBuiltIn: Boolean` 标记。
- 没有远端 `admin_user_id`、`card_id/card_ids`、`remote_group_id`、`entitlement_id`、`generation`、`tombstone` 或 cleanup ACK 元数据。
- `ReferenceSubscription.kt` 维护五个 APK 固定节点槽位：仅 Slot01 有现成 Paste.gg URL，Slot02–05 是占位符。
- 这些固定槽位不是服务端按 VIP/卡密动态下发的 APP 分组，不能当作多卡密分组同步已经实现。

### 1.3 Room 数据迁移存在本地数据风险

文件：`app/src/main/java/io/nekohasekai/sagernet/database/SagerDatabase.kt`

- 当前 Room schema version 为 7。
- 已声明 3→4、4→5、5→6、6→7 自动迁移。
- 数据库 builder 仍启用 `fallbackToDestructiveMigration()`。
- 当前没有 7→8 的多卡密/远端分组数据迁移。
- 后续必须提供显式 7→8 migration 并验证旧数据库迁移；在确认所有升级路径可保留节点、分组、规则和用户配置前，必须移除破坏性 fallback 或改为明确拒绝未知迁移版本，不能允许静默清库。

### 1.4 本地凭据存储

- 现有 token 存在名为 `starjump` 的普通 SharedPreferences 中，没有在本源码中看到加密封装。
- 当前备份规则显式包含数据库文件，没有显式包含 `starjump` SharedPreferences；这不等于凭据已加密。
- 新多卡密实现不得把明文 token 放入 Room、日志、导出备份或崩溃报告。应采用 Android Keystore 保护的加密存储，并为旧版单 token 提供一次性迁移：成功加密落盘并回读验证后再清除旧明文键；迁移失败必须保留旧值并明确报告，不得丢授权。

### 1.5 版本和 API 根地址待核实

- `nb4a.properties`：`VERSION_NAME=6.00.48`、`VERSION_CODE=71`；现有 `Helpers.kt` 会把内部 VERSION_CODE 乘以 5，APK 预期 versionCode 为 355。
- `ActivationActivity.checkUpdate()` 仍调用 `StarJumpApi.version(base(), 60047)`。服务端 current 参数究竟要求项目 VERSION_CODE、APK versionCode 还是旧版本序号，尚未证明；不能擅自改成 71 或 355。
- `StarJumpApi.DEFAULT_BASE` 当前写作 `https://starjump-api-staging.synahcoo.workers.dev`。RC1 文档中的 Staging 精确主机记录为 `starjump-api-staging.synahcooo.workers.dev`（拼写存在一字符差异）。未从 Cloudflare 实际配置核实前，不得猜测并替换，更不得把 Staging 地址作为生产地址。

## 2. 与当前后端候选分支的对照

- 后端候选分支：`release/v2.5.0-rc1-converge`
- 本次核查 head：`a14cf0b90c05fa9547d458aeac59c75ed65efac1`
- PR #2：Draft / Open / Unmerged。
- 当前 head 的 GitHub Actions：
  - Convergence Run `46144348910`：SUCCESS。
  - APP Identity 86 Offline Checkpoint Run `46144348914`：SUCCESS。
  - Candidate artifact `15263073193`，名称 `StarJump-V2.5.0-RC1-candidate`，148,280 bytes。
- Worker 源码已 import 并注册 Protocol66 卡密分组管理 handler，`GET/PUT /api/user/app-cards/:cardId/groups` 路由存在；但两张映射表尚未在 Staging 创建，缺表时保持 503，不自动建表。
- Worker `GET /api/app/groups` 已支持重复 `token=` 参数（最多 100 个），逐个验证 token 对应的 entitlement，并返回多管理员/多卡的 groups、entitlements、card_ids、free_admin_user_ids、card_groups_ready 等信息。
- Worker `GET /api/app/links` 也支持重复 token 参数。
- Worker 旧 `/api/app/nodes` 路径仍按单条最新 entitlement/token 读取，不能作为多卡密客户端的主同步接口。
- 上述是 PR 候选分支代码与 CI 证据，不代表已合并、真实 D1 已迁移、Cloudflare 已部署或 APP 已联调。

## 3. 本轮实际测试

执行环境：本次会话临时工作目录，Java 21；未检测到可用 Android SDK/ANDROID_HOME。

执行命令及结果：

1. `python3 test_five_starjump_slots.py` — PASS，验证五个固定槽位、旧组迁移、独立源、启动更新和失败前不写库。
2. `python3 test_starjump_646_ui_requirements.py` — PASS，验证首组显示、空组隐藏、组名显示、中文连接测试文案、内置节点保护和启动图资源尺寸。
3. `python3 test_offline_recovery.py` — PASS，验证离线恢复签名、篡改拒绝和恢复包签名。
4. 原始源码 ZIP 完整性检查 — PASS；SHA-256 与第一百一十八批记录一致。

测试边界：
- 这些是源码自带 Python/静态/密码签名测试，不证明 Android 编译、APK 安装、真实网络、真实 D1 或设备弱网行为。
- 未执行 Gradle/APK build：当前执行环境没有可用 Android SDK，不能报告 APK 构建成功。
- 未执行真实设备测试、真实 Cloudflare Worker/D1 测试。
- 未执行 D1 DDL/DML；未修改 Secrets/bindings；未部署；未合并 PR。

## 4. 正式客户端接入的最短安全顺序

### A. 多授权持久化
- 建立独立 entitlement 数据模型，最少保存 entitlement_id、admin_user_id、card_id、expires_at、status、token ciphertext、last_verified_at。
- 同一管理员多张卡分别保留；不同管理员严格隔离；一次激活只能追加/更新对应 entitlement，不能覆盖其他有效卡。
- 使用 Android Keystore 加密 token；迁移旧 SharedPreferences 单 token 时采用先加密写入、回读校验、再删除旧明文的顺序。
- 授权到期/停用按 entitlement 精确处理，不因 A 管理员到期清除 B 管理员有效授权。

### B. API 对接
- 新增 `GET /api/app/groups?device_id=...&token=...&token=...` 客户端调用；每条有效 entitlement token 重复添加为独立 query 参数，并正确 URL encode。
- 新增多 token `/api/app/links` 调用；不再只传单条 token。
- 对 `/api/app/groups` 响应逐项校验结构、owner/admin、group id、card_ids、nodes 和授权摘要；空/截断/畸形/HTTP 错误不得覆盖本地有效数据。
- 不依赖当前单 token `/api/app/nodes` 实现多卡密功能；若后续需要保留该接口，应另行设计多 token 契约并通过服务端测试。
- 对 401/403/404/429/5xx、超时、DNS/TLS、离线分别建模；GET 有界重试并尊重 Retry-After，激活等写操作不得盲目自动重放。

### C. Room 数据模型与迁移
- 将远端组身份保存为 `admin_user_id + remote_group_id`，卡密关系单独保存 card_ids/entitlement refs，不能仅用分组显示名称去重。
- 免费组每管理员只出现一次；卡密组按卡片映射；跨管理员同名组不能合并。
- 为 generation/tombstone/24h cleanup/cleanup ACK 设计独立状态表和事务边界。
- Room 从 7 升级时必须使用显式 migration；保留原 proxy_groups、proxy_entities、rules 与所有现有用户配置；禁止 destructive fallback 静默清库。
- 同步先写临时数据、完成完整性/归属校验后原子发布；单个管理员/单张卡失败不能清除其他有效来源的本地节点。

### D. UI 与状态
- 激活成功后显示多条授权及各自管理员/卡片/到期状态。
- 分组按管理员隔离显示：管理员身份末两位作为独立识别码，分组名按既定规则展示；同名组使用稳定序号，不改变后台原始名称。
- 远端不可达时保留本地最后有效数据并显示缓存/最后同步时间；明确区分“没有授权”“授权到期”“上游不可用”和“缓存可用”。
- 保留用户手动节点，远端授权组更新不能误删手动节点。

### E. 版本与构建
- 下一客户端版本候选仍建议评估 `6.00.50` / 项目 VERSION_CODE 72（APK versionCode 360）；这只是版本规划建议，需在真正修改源码前核对工作流和更新接口语义。
- 必须用 GitHub Actions 构建并核对 APK 元数据、签名、SHA-256、安装升级和 Room 7→8 数据保留；本地源码测试不能替代实际 APK 构建。
- 在真实 D1 映射表迁移获得明确批准并验证前，客户端必须把 `card_groups_ready=false` 当作功能暂未启用，不能伪造空分组或覆盖缓存。

## 5. 当前状态与下一批

- 源码恢复：完成。
- 6.00.48 多卡密客户端差距复核：完成。
- 三项源码自带 Python 测试：通过。
- Android Gradle/APK 构建：未执行（当前环境无 Android SDK）。
- APP 多卡密持久化/分组 API/Room migration：未实现。
- Staging D1 两张映射表：未创建；等待迁移审查及用户明确批准。
- Worker/API 部署：未执行。
- PR #2：Draft/Open/Unmerged；不得把候选 artifact 当正式发布包。

下一批优先：在独立 DEV 源码副本实现多 entitlement 加密存储与 Room 7→8 非破坏性迁移骨架；先补迁移与存储单元测试，再接入重复 token 的 groups/links API。完成后使用 GitHub Actions 构建，任何测试失败先修复，不降低断言。只有在客户端与服务端契约一致、Staging 迁移获批并验证后，才进行真实联调。

## 6. 回滚与数据安全

- 本轮只读审计，没有改动源码或线上数据，无需回滚。
- 后续 APP 源码修改必须保留原始 `StarJump-6.00.48-source.zip`，以新版本目录/新 ZIP 提交，不覆盖原始基线。
- Room migration 若失败必须回滚 APK 版本或使用经过验证的反向迁移/备份恢复流程；不得调用 destructive fallback 清空用户数据库。
- 不在 GitHub、报告、测试日志中保存明文 token、卡密、SESSION_PEPPER、APP_HMAC_SECRET 或完整私密订阅 URL。
