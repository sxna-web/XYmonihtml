# 2026-11-29｜APP 47/48 基线确认与 6.00.50 DEV 首版

## 用户目标
用户明确要求：确认 APP 6.00.47 与 6.00.48 哪一个应继续修改，避免后续 AI/自动化误选；确认后可清理一个或指定唯一版本，再产出新版本，以新版本继续研发。

## 版本核查证据
- 6.00.47 Library 原始 ZIP：2,377,487 bytes；SHA-256 `5a45da3d6e6e42a6aabf776336fdfff8424af0e9c7d756a8fea17f882459f7ab`；622 entries；VERSION_CODE 70。
- 6.00.48 GitHub main 根目录有 `StarJump-6.00.48-source.zip`，Git blob SHA `2b8b6d105019fb90341c7178438b2d6b0473699f`。恢复 ZIP：2,323,467 bytes；SHA-256 `1d4f49790ef358d2d8de807fa95fd18c331f06692e1a15c4d9030c6cad8b8012`；628 entries；VERSION_CODE 71。
- 6.00.47 与 6.00.48 解压树逐文件哈希对比：48 新增6文件、修改5文件、删除0文件；新增激活/API/Gate/教程实现。确定 6.00.48 是更完整的原始基线。
- GitHub main 的 `StarJump-6.00.47-source.zip` 路径返回 404；47 只在 Library 找到。没有删除47或48，二者均只读留档。
- 选择：只以 6.00.48 作为生成下一版的原始源；下一版 6.00.50 成为唯一后续研发基线。

## 本次实际修改
在独立副本 `/mnt/data/starjump_650_dev/starjump_work` 修改，没有覆盖47/48原始 ZIP：
- 新增 `app/src/main/java/io/nekohasekai/sagernet/database/StarJumpEntitlementEntity.kt`。
- 新增 `app/src/main/java/io/nekohasekai/sagernet/starjump/StarJumpTokenVault.kt`：Android Keystore AES-GCM。
- 新增 `app/src/main/java/io/nekohasekai/sagernet/starjump/StarJumpEntitlementStore.kt`：多 entitlement 持久化；旧 token 迁移先加密写入并读回解密验证，成功后清理明文，失败保留旧值。
- 更新 `SagerDatabase.kt`：version 8；显式 6→7（starJumpBuiltIn列）和7→8（entitlement表/索引）；主配置 DB 移除 destructive fallback。
- 更新 `StarJumpApi.kt`：RedeemResult承载 entitlement/card ID；links 支持重复 token query 参数。
- 更新 `ActivationActivity.kt`：激活写入独立 entitlement，不覆盖其他授权；展示授权数量。
- 更新 `StarJumpGate.kt`：按独立授权状态计算到期，避免 A 管理员到期影响 B 管理员。
- 更新版本号：6.00.50 / VERSION_CODE 72 / 预期 APK versionCode 360；applicationId com.xingyue.app。
- 更新 ARM64 workflow 和相关版本断言。
- 新增 `test_650_entitlement_room_migration.py`、`6.00.50-DEV-CHANGELOG.md`。
- 生成源码 ZIP：`StarJump-6.00.50-source.zip`，2,355,724 bytes，SHA-256 `1a031e2dc18115e2448b42873d9ace957dc256a2daeb050468fbb9ec3bcbe018`；ZIP integrity PASS；756 entries；无 local.properties、keystore、.git。

## 测试
- 全部 `test_*.py`：18/18 PASS。
- 新增 SQLite 合成迁移测试验证 6→7→8 与 7→8，并检查 proxy_groups/proxy_entities/rules 的样例数据未丢失。
- ZIP 完整性 PASS。
- 未执行 Android Gradle/APK build：执行环境无 ANDROID_HOME / ANDROID_SDK_ROOT。
- 未执行 Android instrumentation/真机安装升级/Keystore实机测试。
- 未执行真实 Worker API、D1、Staging 或生产测试。
- 未修改 Worker/D1/Secrets/Cloudflare；未执行DDL/DML；未部署；未合并PR。

## 关键未决项
- Staging API base hostname 有一字符差异，未核实 Cloudflare 前不改。
- 版本接口 current 参数仍为 60047，语义未核实，不擅改为72或360。
- APP groups 动态分组、多 token groups、generation/tombstone/24h cleanup/ACK、last-known-good同步和手动节点保护尚未实现。
- 真实 Android Room migration test 和 APK build 未完成。
- GitHub main 有 6.00.48 ZIP，但二进制文件连接当前不能直接写入新 ZIP；Library 上传因存储限额失败。6.00.50 ZIP 已在本次会话生成并交付下载，尚未进入 GitHub。目标上传路径：`app/versions/6.00.50/StarJump-6.00.50-source.zip`。不得声称已在 GitHub。
- 新增 GitHub Actions workflow 等待 ZIP 上传后运行；未触发/未验证 Actions build。

## 回滚与安全
- 47、48 原始包不变；新版本独立目录/ZIP。
- 6.00.50 如 Room/设备测试失败，停止发布，回到历史 APK 前必须验证原数据库备份；不得 destructive clear。
- 本轮未触碰 Cloudflare、D1、Secrets、生产环境。

## 下一会话唯一优先任务
1. 将本会话下载的 `StarJump-6.00.50-source.zip` 上传到 GitHub `app/versions/6.00.50/StarJump-6.00.50-source.zip`。
2. 在 GitHub Actions 运行 `.github/workflows/starjump-app-650-build.yml`，确认是否可构建；失败按日志修复，不降低测试断言。
3. 完成 Room 6/7→8 真正 Android instrumentation migration tests、Keystore迁移/失败回滚测试。
4. 然后接入 `/api/app/groups` 多 token、动态分组和安全同步协议；保持 Staging DDL/部署需要用户明确批准。

### 2026-11-29 后续复测补充（用户要求继续）

- 重新从独立 DEV 源码目录逐个执行全部 `test_*.py`：18/18 PASS。
- 再次校验 `/mnt/data/StarJump-6.00.50-source.zip`：大小约2.3MiB；SHA-256 `1a031e2dc18115e2448b42873d9ace957dc256a2daeb050468fbb9ec3bcbe018`；`unzip -t` PASS。
- 尝试执行 `bash gradlew --no-daemon :app:compileOssReleaseKotlin`。未进入 Gradle 项目配置/编译阶段：Gradle wrapper 需要下载 Gradle 8.10.2，但当前环境 DNS/网络不可用（`UnknownHostException: services.gradle.org`）。因此不能把它记为 Kotlin 编译失败，也不能记为编译通过。
- 直接执行 `./gradlew` 时因 ZIP 解包后的 wrapper 执行权限不足返回 Permission denied；改用 `bash gradlew` 后到达上述 wrapper 下载网络阻断。GitHub Actions workflow 中会显式 chmod +x。
- 当前环境 ANDROID_HOME 与 ANDROID_SDK_ROOT 均为空；无本地 Android SDK。
- 源码包仍未上传 GitHub：确认 `app/versions/6.00.50/StarJump-6.00.50-source.zip` 当前 GitHub main 返回 404。新 workflow 未触发。不可声称 APK 已构建。
- 本轮没有修改源码/ZIP/Worker/D1/Cloudflare/Secrets；没有部署、没有合并。
- 下一步仍为用户上传 6.00.50 ZIP 到目标路径，再运行 GitHub Actions 构建；随后真实 Android Room instrumentation 与 Keystore 实机测试。
