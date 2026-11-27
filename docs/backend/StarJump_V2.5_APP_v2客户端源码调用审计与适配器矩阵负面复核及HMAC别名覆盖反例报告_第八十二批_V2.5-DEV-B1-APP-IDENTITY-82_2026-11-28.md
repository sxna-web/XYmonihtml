# 星跃管理平台 V2.5｜APP v2 客户端源码调用审计、适配器矩阵负面复核与 HMAC 别名覆盖反例报告（第八十二批）

- 批次：`V2.5-DEV-B1-APP-IDENTITY-82`
- 日期：2026-11-28
- 状态：`APK_6_00_47_SOURCE_AUDIT_COMPLETE / MATRIX_NEGATIVE_REVIEW_COMPLETE / HMAC_MODEL_LOCAL_PASS_11_OF_11 / D1_NOT_TESTED / 6_00_48_SOURCE_PENDING / NOT_DEPLOYABLE`
- 仓库：`sxna-web/XYmonihtml`，分支 `main`

## 一、本批范围与基线

本批按第八十一批接手卡执行：
1. 重读 AGENTS、功能基线、数据库/API 保护规范、目录规范、总方案、进度及第七十七至八十一批协议资料。
2. 从 Library 找到并解包 APP 6.00.47 源码 ZIP，检查 Worker legacy routes、v1 identity API、网络请求、deep link、设备身份、本地存储和备份行为。
3. 对 Batch 81 adapter matrix 做独立负面复核，识别 method-level 与 statement-level 之间的证据差距。
4. 对 HMAC candidate A 建立 canonical event/alias 反例模型，检查 partial backfill、high-water、late retry、retirement、cleanup 和 rollback 约束。
5. 仅做离线工作，不连接 D1，不执行 SQL，不修改 Worker/HTML/APK/Room/Secrets/Cloudflare。

## 二、APP 6.00.47 源码审计结果

### 2.1 源码档案证据

- Library 文件：`StarJump-6.00.47-source.zip`
- 大小：2,377,487 bytes
- SHA-256：`5a45da3d6e6e42a6aabf776336fdfff8424af0e9c7d756a8fea17f882459f7ab`
- ZIP integrity：745 entries，`testzip() = None`，已成功解包。
- 解包统计：622 files；163 Kotlin、26 Java；扫描 503 个文本/配置/文档文件。
- 包名：`com.starjump.client`。
- `VERSION_NAME=6.00.47`；`VERSION_CODE=70`，构建 helper 将其乘以 5，因此配置的 Android versionCode 为 350。

仓库树还包含 `StarJump-6.00.48-source.zip`，但 GitHub 文本接口无法读取 ZIP 二进制；本轮 Library 检索只取得 6.00.47。故本报告严格只对 SHA 对应的 6.00.47 源码负责，不把它当作 6.00.48 或当前已安装 APK 的证明。

### 2.2 Worker 与会员 API 调用

对 Kotlin/Java/XML/config/doc 文本进行静态扫描，未发现 APP 直接调用：
- legacy：`/api/app/resolve`、`groups`、`free`、`links`、`redeem`、`status`、`nodes`；
- 管理端 share-code：`/api/user/share-code`、`/api/super/admins/:id/share-code`；
- membership spec：`/v1/device/bootstrap`、`/v1/license/activate`、`/v1/license/status`、`/v1/catalog/resolve`、`/v1/license/deactivate`。

上述 v1 API 路径及 entitlement/challenge/nonce 等术语只在 `STARJUMP-BACKEND-AND-MEMBERSHIP-SPEC.md` 设计文档中出现；未找到相应客户端请求实现。

实际网络请求入口主要为：
- `RawUpdater.kt`：通用订阅 HTTP 下载；
- `AssetsActivity.kt`：GitHub Releases API/资源下载；
- `SubscriptionUpdater.kt`：调度订阅更新；
- `WebviewFragment.kt`：加载本地 YACD 控制界面。

未发现 StarJump Bearer entitlement token、Authorization header、卡密激活请求、身份 ID 绑定请求、设备证明/nonce 流程或 APP entitlement token 存储。

### 2.3 当前 StarJump 客户端逻辑

- `ReferenceSubscription.kt` 定义五个内置分组 `星跃节点 01..05`。
- `AutoNodeStartup.kt` 启动时创建/核对五个保留分组，并刷新已配置的内置来源。
- `RawUpdater.kt` 从 APK 编译时常量取得内置来源，直接请求上游订阅；没有通过星跃 Worker identity/catalog API。
- 本归档只有 slot 01 配置 HTTPS 来源；slot 02..05 是占位符，未配置时被跳过。
- APK 内嵌上游来源违反 membership spec 所提出的“上游地址只保存在服务端”目标。报告未复制完整订阅 URL，避免扩散敏感地址。

因此，当前 6.00.47 源码实现的是“客户端固定上游订阅 + 五个本地保留分组”，不是已完成的“免费分组/卡密授权/多管理员身份绑定/服务端 entitlement catalog”方案。

### 2.4 Deep link / 设备 / 本地数据

- Manifest 导出 `MainActivity`，注册 `sn://subscription`、`clash://install-config` 和通用代理 profile scheme。
- `MainActivity.onNewIntent()` 将这些 URI 用于订阅或节点导入；未发现 StarJump 身份 ID、卡密、challenge 的专用绑定回调。
- 未发现 Android ID/serial/stable device ID、设备公钥证明、APP entitlement token 或卡密授权状态存储。
- `NGUtil.getUuid()` 仅为随机 UUID 工具，扫描未发现调用点，不能视为设备身份实现。
- 配置与 profile 数据通过 Room-backed store 保存。
- Manifest 的 `android:allowBackup=true`，backup rules 包含 profile/configuration 数据库。当前没有证据表明 APP 身份密钥已被备份；未来 device-bound credential 不得放入备份可迁移数据库，应使用 Android Keystore non-exportable key，并排除凭证备份/设备迁移。

### 2.5 第三方源码提示

README 将该项目标注为 NekoBoxForAndroid personal fork，LICENSE 为 GPL-3.0，并声明上游版权/商标归原权利方。此项不是完整法律意见；商业再分发前仍需盘点所有 native/core/插件/资源依赖的许可证义务，并单独审查商标和品牌许可。

## 三、Batch 81 adapter matrix 负面复核

Batch 81 JSON 有八个方法轮廓和 D1-001..034 标签，但不是 statement-level manifest。主要发现：
- 缺少 statement_id、精确 SQL SHA、placeholder ordinal、逐 statement bind 顺序、result index 和预期 result vector。
- D1-017..026 限流测试没有独立 limiter admission/read 方法；D1-032..034 HMAC/迁移证据没有方法级映射。
- `expireTransientRecords` 目前绑定 `synthetic_run_ledger`，属于测试 harness cleanup，不应混入生产 identity adapter。
- `consumeNonceAtomic` 的 nonce 存储表示/唯一作用域仍未冻结；不得默认保存 raw nonce。
- `rotateShareCodeAtomic.new_digest` 写成 `blob_or_text`，对 prepared bind 来说不够精确，必须冻结一种 storage class/编码。
- SQL placeholder linter 必须识别单/双引号、backtick、bracket、注释、`?NNN` 和 named parameters；不能用简单问号计数或 regex 作为可靠解析器。
- D1 zero-row、CHECK NULL、RETURNING/meta.changes、batch order/rollback 仍无真实 D1 运行证据。

以上已记录到 Batch 81 JSON 的 `review_findings` 字段和本批独立负面审查文件。

## 四、HMAC canonical event + aliases 反例

本批发现一个必须先解决的模型问题：K1 与 K2 的 HMAC fingerprint 对同一维度通常不同，因此 key-version fingerprint 不能被直接当作跨版本相同的 logical tuple 字段。

需要分离：
- 不随 key version 改变的逻辑事件身份/字段；
- 每个 key version 独立生成的 alias；
- 同 event_id 不同逻辑 tuple 或同 event_id+同 key version 不同 fingerprint 必须 integrity conflict；
- 不同 event_id 分散在 K1-only/K2-only 时必须 union 计数；
- 只有新版本 alias coverage 完整、backfill high-water 对账完成、late retry 与 rollback horizon 关闭后才可退役旧版本。

新增 14 个 adversarial scenarios（H82-01..14），覆盖 duplicate/dedupe、split history、tuple conflict、alias conflict、partial backfill、high-water race、late retry、non-unique fingerprint、cleanup、rollback 和 old-key retirement。

本批 Python 合成模型本地测试：11/11 passed。该模型不实现 HMAC cryptography、D1 SQL、事务、索引计划、生产阈值或 retention，不构成 D1 证据。

## 五、CI

Batch 81 最新离线 workflow 最终结果：
- Run `46042494745`：completed/success。
- Job `140655276165`：completed/success。
- Workflow step `Validate offline adapter readiness contracts`：success。
- Run：https://github.com/sxna-web/XYmonihtml/actions/runs/46042494745

Batch 82 新增独立 workflow：`.github/workflows/worker-app-identity82-review.yml`，执行 HMAC model 与静态 review tests。其最终结果以本批报告后续补充记录为准。

## 六、影响、安全与回滚

- 读取并解包 Library 中的 6.00.47 源码归档；未将二进制 ZIP 搬入 Git。
- 新增 DEV 审计文档、JSON review findings、Python 合成模型/测试与 CI workflow。
- 未修改 APK 源码、Worker、HTML、Room、D1、Secrets、Cloudflare 配置。
- 未连接 D1；未执行 SQL/迁移；未读取凭证；未部署。
- 无业务数据影响。回滚仅需 revert 本批 DEV 文档、模型、测试和 workflow；无数据库回滚事项。

## 七、第八十三批唯一接手卡

**APP v2 protocol contract gap closure and source-version compatibility verification。**

1. 重读 AGENTS、功能基线、数据库/API/目录规范、总方案、进度及第七十七至八十二批文件。
2. 继续寻找可读取的 6.00.48 源码副本；未取得前，6.00.47 审计结论不得扩展到 6.00.48/当前 APK。
3. 对照用户已确认的 APP 多管理员、多卡密、免费组去重、同名卡密组序列号、设备上限等规则，建立“当前 APK 已实现/缺失/需新协议”矩阵；不猜测设备解绑/名额释放规则。
4. 把 APP v2 协议明确拆分为 discovery/bind、card activation、entitlement status、composed catalog、group generation/tombstone/ack 五个契约域；U80-01..08 未确认项继续 fail closed。
5. 设计 Android Keystore device-key lifecycle、备份排除和 deep-link challenge callback 的兼容方案；只做文档/测试，不改 APK。
6. 将 SQL manifest 要求拆为 identity、limiter、harness 三个接口；补充 placeholder tokenizer 设计与负面向量，不写生产 SQL。
7. 继续 HMAC A 的跨 key 维度一致性证明方案比较；未冻结前不选生产密钥/阈值/retention，不连接 D1。
8. 更新总进度、总方案和第八十四批唯一接手卡。
