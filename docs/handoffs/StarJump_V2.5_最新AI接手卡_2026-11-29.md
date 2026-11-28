# 星跃管理平台 V2.5｜最新 AI 接手卡

- 记录日期：2026-11-29
- 记录版本：HANDOFF-2026-11-29-APP-DIAGNOSTICS
- 仓库：sxna-web/XYmonihtml
- 分支：main
- 本文件性质：跨会话接手索引；不是实现或部署证明。

## 1. 下一位 AI 开始工作前必须执行

1. 读取根目录 `AGENTS.md`。
2. 读取本文件。
3. 读取 `docs/星跃管理平台V2.5_功能基线与权限验收规范.md`。
4. 读取 `docs/星跃管理平台V2.5_开发进度与测试验收记录.md` 的末尾最新记录。
5. 读取 `docs/audits/StarJump_V2.5_工具可靠性项目连续性与总进度控制总方案_V1_2026-11-27.md`。
6. 按任务模块继续读取最新设计、实施、测试、迁移文件；并检查当前 main 分支实际源码和提交 SHA。不得仅依赖聊天摘要或本接手卡。
7. 开始前先向用户简短确认已读取资料，并报告当前真实状态；若不能访问仓库，明确说明并请求用户提供仓库访问，不得假装已读取。

## 2. 本轮最新事实（2026-11-29）

- 原始 Worker 已从项目文件库恢复到本地工作路径 `/mnt/data/starjump_resume/StarJump_V2.5_Production_Worker.js`，大小 29,823 bytes；来源 file_id `file_0000000010348207a6a12f2d956420e7`。
- APP 授权 SQL 已恢复到 `/mnt/data/starjump_resume/StarJump_V2.5_APP_Authorization_Additive_v1.sql`，大小 11,862 bytes；来源 file_id `file_000000004bac820baf3043311682487f`。
- 原始 Worker 的 `digestHex()` 用于后台 SESSION token，算法为 SHA256(`SESSION_PEPPER:token`)。本次核对未发现 APP 卡密创建、激活、card_code_hash 写入或卡密诊断路由。
- 授权 SQL 定义 `app_access_cards.card_code_hash`，但未定义摘要算法。
- 历史摘要提及 APP 卡密管理 DEV v1.5，但本次 GitHub 仓库代码搜索和文件库检索均未找到其实际源码/报告；不得凭摘要臆测算法。下一步先恢复/定位真实 DEV v1.5 Worker 和报告，再追踪创建、激活、持久化、查询的完整算法链。
- 诊断查询优先卡密，APP user ID 辅助；VIP 只能查询自身租户，超管可跨租户但必须审计。卡密不得进入 URL 或日志；不能返回节点凭据。
- APP 用户 ID 辅助诊断曾有本地 DEV v1.2 候选记录，但在重新核对其源码/提交与测试证据前，不得将其认定为 GitHub 主分支实现或真实 API 已完成。
- 目标测试环境为 Cloudflare D1 `starjump-staging`；Worker `starjump-api-staging`。其他数据库名不得替代。Staging 曾记录 `DIAGNOSTICS=0`，启用前须检查 feature gate 与权限审计。
- 当前没有本轮 D1/API/APP/生产测试证据；没有部署生产环境；没有修改生产 Worker 或 D1。

## 3. 下一步执行顺序

1. 在 GitHub 全仓和历史提交中定位卡密管理 DEV v1.5 的 Worker、SQL、测试和报告。
2. 对比卡密创建/激活实际代码，确认唯一、兼容的 card hash 算法及密钥来源；若找不到，保持卡密查询关闭并提出最小兼容设计。
3. 将已验证的分组诊断方案与当前仓库 Worker/API 基线对照，做影响分析和独立版本实现；禁止覆盖原始基线。
4. 完成 VIP/超管租户隔离、审计、限流、敏感字段脱敏和拒绝路径测试。
5. 在 `starjump-staging` 先只读核对 D1 schema 与 Worker 绑定，再经用户授权进行 Staging 迁移/API 测试。
6. 管理后台页面、APP 客户端联调和真实第三方代理 APP 拉取诊断另行验收。
7. 同步接口继续 fail-closed，直到完整安全同步协议通过验证。
8. 每批更新总进度、批次报告和下一会话接手卡；生产部署必须单独取得用户明确批准。

## 4. 不可违反的状态标记

- 需求已确认 ≠ 已编码。
- 已编码 ≠ 已测试。
- 本地 SQLite ≠ Cloudflare D1。
- handler mock ≠ 真实 Worker API。
- 代码检查 ≠ APP 客户端联调。
- Staging 验证 ≠ 生产部署。
- 没有部署记录就不得写“已部署”。
- 不得把 SESSION token hash 擅自当作 APP 卡密 hash。
- 不得提交卡密明文、真实令牌、Secret、订阅 URL 或数据库凭证。

## 5. 每批必须更新

- 当前版本/批次/日期/提交 SHA
- 修改文件及路径
- API、数据库影响
- 测试命令、环境、结果与证据
- 未完成事项、阻塞、风险
- 回滚方法
- 下一步唯一优先接手任务
- 是否部署及部署环境（没有则明确未部署）

## 6. 本次会话归档补充（2026-11-29）

- 用户特别强调：**尤其换会话时必须自动记录历史**，不能只记录业务关键节点或只依赖聊天记忆。
- 已更新根目录 AGENTS.md，新增“跨会话历史自动归档”强制要求。新会话必须读取最近会话记录；每个实质进展阶段及时归档；会话结束/切换/暂停前进行完整交接；中断或写入失败后下次恢复优先补记。
- AGENTS 更新 commit：`7ef67544290b2d64b07095936868a0a34c50e9a5`；read-back blob SHA：`fbcd3181b692a5ace6de86e88fb7e9fb60e81fae`。
- 本次独立会话记录：`docs/handoffs/sessions/2026-11-29-cross-session-history-archival.md`；创建 commit：`e3c4d263bb4b3de0bb4d371247f77c1178e4b36e`。
- 总进度更新 commit：`792b95a531e47bcbb089cc83d3b10fd155784922`；内容 blob SHA：`9b7f65c7fc40bc4b393b1d1e4efa5ef4b6b9a7d2`。
- 自动化边界：GitHub 规则不能让 AI 在会话外后台运行，也不能强制未连接仓库的任意 AI 自动读取；若会话被突然终止，无法保证中断前写入，下一会话必须检查并补记。
- 本会话未修改 Worker/API/D1/APP/Secrets/Cloudflare；未执行业务测试；未部署。
- 下一会话先读取本文件、AGENTS.md、上述会话记录、总进度、工具可靠性总方案，再继续定位 APP 卡密管理 DEV v1.5 实际源码。

## 7. 主任务续接更新（2026-11-29｜以当前源码复核为准）

### 7.1 当前候选分支状态
- 后端 RC1 候选分支：`release/v2.5.0-rc1-converge`。
- 本次核查 head：`a14cf0b90c05fa9547d458aeac59c75ed65efac1`。
- PR #2：Draft/Open/Unmerged；不得把候选分支当 main 已合并代码。
- 该 head 的 Convergence Run `46144348910`、APP Identity Offline Checkpoint Run `46144348914` 均 SUCCESS；候选 artifact `15263073193`，148,280 bytes。只证明 CI 指定自动化检查，不证明真实 D1/Cloudflare/APP 实机或生产。
- Worker 候选已注册 Protocol66 卡密分组管理 handler；`GET /api/app/groups` 和 `GET /api/app/links` 支持重复 token 参数（最多100）；旧 `/api/app/nodes` 仍是单 token/最新 entitlement 路径。两张映射表尚未在 Staging 创建，缺表时 fail-closed 503。

### 7.2 APP 6.00.48 源码已恢复
- 从此前 Actions artifact `15262037576` 恢复原始 ZIP，SHA-256：`1d4f49790ef358d2d8de807fa95fd18c331f06692e1a15c4d9030c6cad8b8012`；2,323,467 bytes；ZIP integrity PASS；628 entries、193 个 Kotlin/Java 文件。
- 完整差距报告：`docs/app/StarJump_APP_6.00.48_多卡密客户端接入差距与源码复核报告_2026-11-29.md`；commit `92ad7ada47961a21ff91f6f75db685b8c88b9353`。
- 本会话独立记录：`docs/handoffs/sessions/2026-11-29-main-task-app-648-audit.md`；commit `c1bc97364443fab1bf7415163a5d008a4e9af7ba`。
- 总进度追加本轮源码审计：commit `ff61ef0e289f46aa8f5fa8014755f1086cdb165b`；内容 SHA `0bacfa709ca4d42b36c80778ca1680afba65335b`。

### 7.3 客户端确认阻断项
1. APP 当前只存一条 token/expires/admin；新激活会覆盖旧授权。
2. StarJumpApi 只实现 redeem/resolve/links/version；links 单 token；没有 groups/free/nodes 客户端调用。
3. Room version 7，当前启用 `fallbackToDestructiveMigration()`；新 schema 必须显式 7→8 迁移并验证保留所有本地节点/分组/规则。
4. token 当前存普通 SharedPreferences，未见加密封装；新实现须 Android Keystore 加密并安全迁移旧值。
5. ProxyGroup 无远端 admin/card/group/entitlement/generation/tombstone/cleanup ACK 字段；五个固定 Paste.gg 槽位不等于动态服务端分组。
6. APP DEFAULT_BASE 主机名与 RC1 Staging 文档拼写有差异；版本检查 current 仍传 60047。未核实前禁止猜测修正。
7. APP 6.00.48 版本元数据 VERSION_CODE=71，现有 Gradle helper 乘5，APK 预期 versionCode=355。

### 7.4 本轮测试与边界
- PASS：`python3 test_five_starjump_slots.py`
- PASS：`python3 test_starjump_646_ui_requirements.py`
- PASS：`python3 test_offline_recovery.py`
- PASS：原始 ZIP 完整性与 SHA-256 核验。
- Android Gradle/APK build 未执行（当前执行环境无可用 Android SDK/ANDROID_HOME）。
- 未做真实 Android、弱网、Worker runtime、D1 测试；未执行 DDL/DML；未部署、未合并；未修改 APP/Worker/HTML/Secrets/bindings。

### 7.5 下一会话唯一优先任务
在独立 DEV 源码副本实施多 entitlement 加密持久化与 Room 7→8 非破坏性迁移骨架：
- 每个 entitlement 独立保存 admin/card/expiry/status/token ciphertext；
- Android Keystore 加密 token，旧单 token 一次性迁移先加密写入并回读验证，成功后才清旧明文；
- Room 显式迁移，移除静默 destructive fallback；迁移失败必须保留原库；
- 补旧库升级、回滚、多卡多管理员隔离测试；
- 随后接入重复 token groups/links API、动态分组与 generation/tombstone/24h cleanup/ACK。
保留 6.00.48 原始 ZIP，下一版另建版本目录/ZIP。Staging DDL 仍须用户明确批准。此前 APP 卡密 hash 算法/诊断 DEV v1.5 定位任务仍是独立待办，不能把它误认为本轮已解决。

## 8. APP 版本基线锁定与 6.00.50 DEV 更新（2026-11-29｜最新优先级，覆盖旧 APP 接手顺序）

- 后续 APP 开发唯一基线：**6.00.50 DEV**。不得继续在 6.00.47/6.00.48 上直接修改，不得删除/覆盖两个历史源包。
- 对比证据、SHA、文件差异和风险详见：`docs/app/versions/6.00.50/APP_版本基线锁定与DEV交付报告_2026-11-29.md`。
- 6.00.47 ZIP：Library，2,377,487 bytes，SHA-256 `5a45da3d6e6e42a6aabf776336fdfff8424af0e9c7d756a8fea17f882459f7ab`，VERSION_CODE 70。
- 6.00.48 ZIP：GitHub main 根目录存在，Git blob SHA `2b8b6d105019fb90341c7178438b2d6b0473699f`；恢复件 2,323,467 bytes，SHA-256 `1d4f49790ef358d2d8de807fa95fd18c331f06692e1a15c4d9030c6cad8b8012`，VERSION_CODE 71。对比47新增6文件/修改5文件/删除0文件，48为更完整原始基线。
- 新版本：6.00.50，VERSION_CODE 72，预期 APK versionCode 360，applicationId com.xingyue.app。
- 新 ZIP：`StarJump-6.00.50-source.zip`，2,355,724 bytes，SHA-256 `1a031e2dc18115e2448b42873d9ace957dc256a2daeb050468fbb9ec3bcbe018`，ZIP integrity PASS，756 entries。
- 6.00.50 已有多 entitlement Room entity/DAO、Keystore AES-GCM vault、旧 token 安全迁移、显式 Room 6→7→8、主配置 DB 移除 destructive fallback、重复 token links 和按授权独立的 Gate。
- 18/18 Python tests PASS；SQLite 合成迁移测试通过。Android Gradle/APK build 未执行（无 SDK）；真机/Room instrumentation/Worker/D1/API 测试未执行；未部署。
- GitHub 已提交版本报告、目录说明、ARM64 workflow 和独立会话记录；提交依次为 `fca0b5dcf1ff11dd1e992c1e30c82f1086517fa4`、`c08329962191651f45f5e345df539c05bf61cb06`、`42b9b0eaa9579008483665575dc78f3a18758781`、`867d774230668b1b1cbedcc7e181dadfd57c6cd0`。
- **ZIP 尚未上传 GitHub**：目标路径 `app/versions/6.00.50/StarJump-6.00.50-source.zip` 已预留，当前 GitHub 二进制写入不可用且 Library 已满。用户需要上传本次下载的 ZIP。若后续 AI 发现该路径仍无 ZIP，必须先请用户上传，不得改回47/48。
- 新构建工作流：`.github/workflows/starjump-app-650-build.yml`；待 ZIP 上传后运行。它尚未执行，不得说 APK build 已通过。
- 下一会话唯一优先任务：确认 6.00.50 ZIP 已进入目标 GitHub 路径；运行 ARM64 workflow；补 Android Room migration instrumentation/Keystore 实机测试。随后接入 `/api/app/groups`、多 token、动态分组、generation/tombstone/24h cleanup/ACK、last-known-good 和手动节点保护。
- 未决：Staging base hostname 差异和 version API `current=60047` 参数语义未核实，禁止猜改；Staging DDL/部署须用户明确批准。

### APP 6.00.50 最新复测补充
- 再次 18/18 Python tests PASS；ZIP SHA/完整性 PASS。
- `bash gradlew --no-daemon :app:compileOssReleaseKotlin` 被环境网络阻断：Gradle 8.10.2 wrapper 下载时 `UnknownHostException: services.gradle.org`，未进入编译阶段；ANDROID_HOME/ANDROID_SDK_ROOT 为空。
- GitHub main 的目标 ZIP 路径仍为 404，新 workflow 未运行。先让用户上传 ZIP，再跑 Actions。不得声称 APK build 成功。


## 2026-11-29｜6.00.50 上传与构建状态补充（覆盖本卡旧状态）

- 用户已上传 ZIP 至 `app/versions/6.00.50/StarJump-6.00.50-source.zip`；Git blob SHA `176f88023962f27c759157f456cb85e0b295b563`，ZIP 2,355,724 bytes，SHA-256 `1a031e2dc18115e2448b42873d9ace957dc256a2daeb050468fbb9ec3bcbe018`。
- Actions run `46184869195` / job `141102408156` / head `84546b5042ae2fafd84b8574f662ba21e0f60c04` 正在构建。
- 最近状态：源码校验、工具链准备、LibCore AAR build/verify、Gradle assets 初始化 success；ARM64 APK assemble in_progress；验证与上传 pending；无 Artifact。
- 早期“ZIP 尚未上传”的旧描述仅为历史，不再是当前事实。下一步继续轮询该 run；成功后下载并核验 APK，不成功则按真实日志定位。
