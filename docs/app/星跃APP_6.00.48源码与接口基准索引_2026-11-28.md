# 星跃 APP 6.00.48 源码与接口基准索引

- 基准日期：2026-11-28
- 基准包：`StarJump-6.00.48-source.zip`
- SHA-256：`1d4f49790ef358d2d8de807fa95fd18c331f06692e1a15c4d9030c6cad8b8012`
- ZIP：2,323,467 bytes；628 entries；完整性检查通过。
- 包元数据：`com.xingyue.app` / VERSION_NAME `6.00.48` / VERSION_CODE `71`；Gradle helper 乘 5，预期 Android versionCode `355`；minSdk 21、targetSdk 35、compileSdk 35。
- 该文档是本次可读取源码的快照索引，不代表仓库当前包含或构建了该 APP 工程；原始 ZIP 暂时无法访问时，以本索引和关联审计报告继续设计，重新取得源码后再核对漂移。

## 1. 版本与构建入口

- 版本元数据：ZIP 根目录 `nb4a.properties`。
- versionCode 转换规则：`buildSrc/Helpers.kt` 中将 VERSION_CODE 乘以 5。
- 当前 APP 更新请求：`ActivationActivity.checkUpdate()` 使用 current=60047；此值与 APK Android versionCode 355 不一致，服务端 release.version_code 的历史语义未确认，不能贸然改成 355。
- GPL-3.0 fork：README/L​​ICENSE 说明基于 NekoBox for Android；发行需保留 GPL-3.0、上游版权/NOTICE 和修改来源。

## 2. 星跃 API 客户端

主文件：`app/src/main/java/io/nekohasekai/sagernet/starjump/StarJumpApi.kt`

| 当前 API | 方法 | 主要输入/输出 | 现状 |
|---|---|---|---|
| `/api/app/redeem` | POST | JSON: code, device_id；返回激活授权信息 | 当前激活主入口 |
| `/api/app/resolve` | GET | code query | 卡密/链接解析 |
| `/api/app/links` | GET | device_id、token query | 读取链接；HTTP 错误时现代码返回空列表，需区分错误与空结果 |
| `/api/app/version` | GET | platform=android、current=60047 | 版本检查 |

静态检索未发现：
- `/api/app/groups` 或 `/api/app/free` 调用；
- `Idempotency-Key` header；
- 多 entitlement 客户端接口/数据模型；
- generation/tombstone/cleanup ACK 客户端实现。

网络现状：HttpURLConnection；connect timeout 10s、read timeout 15s；无统一有限重试、无 Retry-After 分类；激活按钮无并发点击保护。不得把网络错误伪装为空链接/空分组。

## 3. 激活与本地凭证

- `ActivationActivity.doActivate()` 是激活动作入口，当前以后台 Thread 执行。
- 激活成功目前只保存单一 token、expires_at、admin_user_id；再次激活会覆盖旧授权，不能表达同设备多卡密。
- device_id 保存在 SharedPreferences。
- Android backup rules 当前只 include 数据库文件，不 include shared preferences；现有配置下 device_id/token 不在指定备份范围内。
- 后端同设备同卡密安全重放已在 Worker 完成；APP 仍应增加按钮并发保护和明确激活状态反馈。
- 任何凭证升级必须使用 Android Keystore/安全存储设计；不得把卡密/token 写进日志或诊断包。

## 4. 分组/节点关键类

- `ReferenceSubscription.kt`：创建五个固定内置组“星跃节点 01”至“星跃节点 05”；Slot01 固定 Paste.gg Raw 地址，Slot02–05 为占位符。
- `AutoNodeStartup.kt`：APP 启动时刷新固定内置组；失败时保留本地节点。
- `ProxyGroup`：Room 本地组模型；当前仅有 `starJumpBuiltIn` 标记，不含 admin/card/remote group/generation/tombstone 元数据。
- 当前本地组管理器保护内置组不被普通编辑/删除。
- 不得直接删除五个旧内置组或 destructive migration；动态组模型必须向前兼容，先保留旧节点和用户手动组，再做可回滚迁移。

## 5. 与 Worker 当前契约差距

- Worker `appGroupsForDevice()` 只选最新一条有效 entitlement（`ORDER BY created_at DESC LIMIT 1`）。
- 既有返回模式为 public/free/assigned，不含 Protocol66 的 `mode='card'` 映射。
- 激活成功时 `app_free_grants` 通过 `INSERT OR IGNORE(device_id,admin_user_id)` 去重，可作为免费分组只发一次的既有基础。
- `/api/app/free?admin=...` 存在，但 APP 6.00.48 未调用。
- 当前没有 tombstone/generation/cleanup ACK 闭环。
- 因此 APP 与 Worker 必须共同升级；仅新增后台逐卡密配置界面不会让 APP 看到卡密分组。

## 6. 下一次读取源码时的核对清单

- [ ] 重新计算 ZIP SHA-256，确认是不是 6.00.48 同一包。
- [ ] 核对 `nb4a.properties`、`Helpers.kt`、Gradle plugin/依赖版本。
- [ ] 核对 `StarJumpApi.kt` 请求/响应模型、错误解析和 URL 配置。
- [ ] 核对 `ActivationActivity` 激活 UI、按钮状态、更新检查。
- [ ] 核对 Room Database version、所有 Entity/DAO/Migration。
- [ ] 核对 `ProxyGroup`、节点实体、固定内置组迁移路径。
- [ ] 核对启动刷新、订阅解析、节点导入/删除、收藏/排序行为。
- [ ] 核对通知、后台任务、WorkManager/Alarm、生命周期与进程恢复。
- [ ] 核对备份规则、Keystore、日志脱敏、导入导出。
- [ ] 核对 GPL-3.0、NOTICE、第三方依赖和上游修改范围。
- [ ] 跑 Gradle unit tests、lint、debug/release assemble；有签名和真机环境后再做安装/弱网/离线验收。
- [ ] 将发现写入新版本审计报告，不覆盖本文件的历史事实。

## 7. 持续维护规则

每次 APP 源码可访问时，必须将本索引追加新的版本快照或创建下一版本索引，至少记录 ZIP SHA-256、版本元数据、API 契约、Room schema、关键类、UI 路径、离线策略、第三方许可和测试证据。每次变更同时更新总进度 ledger 与接手卡。禁止保存密钥、卡密、Token、完整订阅 URL 或用户隐私。
