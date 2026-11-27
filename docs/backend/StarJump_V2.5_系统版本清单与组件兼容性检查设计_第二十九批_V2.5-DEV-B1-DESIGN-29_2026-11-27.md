# 星跃管理平台 V2.5｜系统版本清单与组件兼容性检查设计

- **批次**：第二十九批
- **版本标识**：V2.5-DEV-B1-DESIGN-29
- **日期**：2026-11-27
- **状态**：需求设计 / 静态核查；不可部署
- **仓库/分支**：`sxna-web/XYmonihtml` / `main`
- **依据**：AGENTS.md、仓库目录规范、V2.5 功能基线、API 权限规范、原始 HTML/Worker、第二十八批双版本号报告
- **本批边界**：设计系统版本 manifest、组件兼容检查、展示位置，并将第三方 APK 源码授权/依赖审计纳入 APP 交付门禁。未修改业务代码、D1、Secrets、Cron 或部署。

## 1. 本批确认的需求

1. 星跃管理系统和星跃 Android APP 各自拥有独立版本号、独立发布记录、独立兼容策略。
2. 管理系统版本必须覆盖 HTML、Worker、D1 schema、API 契约，不允许只改 Worker 的 VERSION 常量。
3. APP 版本必须以实际 Android 构建产物为准，versionCode 严格递增，versionName 对用户展示。
4. 用户补充：APP 基于第三方源码，正式交付前必须审计第三方授权、技术限制、远程依赖和数据外传风险。
5. 用户主要通过手机操作；只有 STABLE 大更新才需要用户上传部署。

## 2. 原始 HTML 版本信息位置核查

原始 HTML 静态核查：
- 后台页脚目前是“星跃 · 超级管理员控制台 · 仅超管会话可用”，没有系统版本。
- 侧栏品牌目前显示“星跃后台 / STARJUMP · V1”，属于固定展示文案，不是可追溯的系统版本字段。
- 现有管理导航有“数据库”“审计记录”“发布公告”等入口，但没有“系统版本 / 关于 / 组件兼容性”独立页面。
- 发布公告页内的“APP 版本”表单是 APP 更新登记，不是管理系统自身版本管理。
- 原始 Worker `/health` 返回 `VERSION` 和固定 `build`，但没有 HTML、D1 schema、API 契约版本，也没有组件兼容矩阵。

**结论**：现有版本文案不足以作为系统版本。建议将侧栏“STARJUMP · V1”替换为动态系统版本展示，并在系统维护区增加“版本与兼容性”只读页面。不得仅通过前端写死版本字符串完成验收。

## 3. 系统版本 manifest 设计

建议文件名：`system-version.json`（正式实现路径在编码前依仓库目录规范确定，构建产物与源码清单需分开）。

字段建议：
- `product`: 固定产品标识 `StarJump`；
- `system_version`: 管理系统 SemVer，例如 `2.5.0`；
- `release_channel`: `DEV | RC | STABLE`；
- `release_status`: `development | candidate | stable | withdrawn`；
- `release_batch`: 本次发布批次；
- `release_date`: UTC ISO 日期/时间；
- `git_commit`: 完整提交 SHA；
- `build_id`: 可追溯构建 ID；
- `components.html.version` / `components.html.build_id`；
- `components.worker.version` / `components.worker.build_id`；
- `components.d1.schema_version` / `components.d1.migration_set`；
- `components.api.contract_version`；
- `compatibility.worker_min` / `worker_max`；
- `compatibility.schema_min` / `schema_max`；
- `compatibility.api_min` / `api_max`；
- `artifact_manifest`: 正式交付文件名、SHA-256、大小（不包含凭证）。

注意：
- manifest 不存储 D1 连接信息、绑定名、Secret、用户数据、订阅 URL 或卡密。
- 构建产物必须由实际提交和构建流程生成，不能人工伪造 commit/build ID。
- 未部署状态只能标记为目标版本或候选版本，不能显示成线上当前版本。
- 版本清单应随正式交付包一同提供，并可由 Worker 只读输出非敏感摘要。

## 4. 版本读取与兼容性检查

### 4.1 推荐只读 API

建议设计 `GET /api/system/version` 或扩展健康检查响应；正式选择前必须检索路由冲突和全部调用方。

响应只包含：
- system_version、release_channel（对外只公开 STABLE；DEV/RC 需权限控制）；
- html_version、worker_version；
- api_contract_version；
- d1_schema_version 与 schema_compatibility；
- build_id / commit 短标识；
- compatibility_status；
- warnings[]（不包含 SQL、内部密钥、绑定名或敏感配置）。

不要让公开接口暴露内部 D1 结构、部署拓扑、Secrets 状态或完整内部提交差异。

### 4.2 页面启动检查

后台加载后：
1. 读取自身 HTML 构建版本；
2. 请求 Worker 的系统版本信息；
3. 比较 HTML 声明的 Worker/API 兼容范围；
4. 检查 Worker 报告的 D1 schema 版本是否满足最低要求；
5. 显示“兼容 / 需升级 / 无法确认”，并记录 request ID。

当版本不匹配时：
- 只读页面可以展示明确警告；
- 数据库迁移、卡密、权限、发布等危险写操作必须阻止，直到兼容性恢复；
- 不允许静默切换到 staging、旧 Worker 或其他环境；
- API 请求失败时显示“版本状态无法确认”，不得伪报兼容。

### 4.3 系统版本展示位置

- 后台页脚：星跃管理系统 Vx.y.z + STABLE/RC/DEV；
- 侧栏品牌：短版本号；
- 系统维护 → 版本与兼容性：HTML、Worker、D1、API 版本、build ID、commit、兼容状态；
- 超管发布管理：系统版本发布与 APP 版本发布分区明确隔离；
- 普通用户只显示稳定正式版本，不展示内部 DEV 分支、commit 全量信息或内部审计数据。

## 5. 系统与 APP 的版本号隔离

| 维度 | 系统版本 | APP 版本 |
|---|---|---|
| 主版本 | system_version SemVer | versionName |
| 数值版本 | 可选 build number | Android versionCode |
| 发布实体 | HTML + Worker + D1/API | APK/AAB 安装包 |
| 构建来源 | 系统仓库构建 | Android 项目构建 |
| 更新接口 | 系统版本只读 API | APP version API |
| 完整性 | 系统交付文件 SHA-256 | APK SHA-256 + 签名证书指纹 |
| 回滚 | 匹配组件组合回滚 | 撤回/暂停 release，发布安全替代版本 |
| 数据兼容 | schema/API 迁移兼容窗口 | APK 与 Worker APP API 协议兼容窗口 |

任何系统发布不得修改 APP versionCode；任何 APP 发布不得改变系统 SemVer。

## 6. 第三方 APP 源码与依赖限制审计门禁

用户明确 APP 使用第三方源码。由于 APK ZIP 尚未解包，本节是待执行审计计划，不代表已确认任何第三方限制。

### 6.1 必须取得并核查的材料

- APK 源码 ZIP 原包及 SHA-256；
- 根目录 README、LICENSE、NOTICE、COPYING；
- Gradle settings/build 文件、版本目录、依赖锁文件；
- AndroidManifest.xml；
- 所有模块的源码与资源；
- 第三方 SDK、AAR/JAR、so 原生库及各自许可证；
- 混淆规则、R8/ProGuard 配置、签名/发布脚本（不得提交私钥）；
- 网络请求域名、API Base URL、远程配置、更新地址；
- 许可校验、激活、设备数量、到期、远程禁用相关代码。

### 6.2 许可证核查

逐项建立 SBOM/依赖清单：
- 组件名称、版本、来源、许可证、源码/二进制形态；
- 是否允许商用、修改、再分发；
- 是否要求开源衍生作品或提供对应源码；
- 是否要求保留版权声明、NOTICE、许可证文本；
- 是否有商标、品牌、素材、字体等独立授权限制；
- 商业授权是否绑定主体、域名、包名、签名证书、设备数或有效期。

GPL/AGPL 等强 copyleft 许可证需由具备相应经验的法律专业人士结合实际分发和网络服务模式判断义务；不能只凭许可证名称下结论。

### 6.3 技术锁定与远程依赖

静态搜索与动态验证：
- 固定第三方 API 域名、授权服务器、遥测/统计域名；
- License/activation/heartbeat/remote config/kill switch；
- 设备 ID、安装 ID、包名、签名证书绑定；
- 原作者后台下发开关、功能白名单、版本拦截；
- 更新下载 URL 是否被固定、是否能完全切换到星跃发布服务；
- 失联时 APP 核心代理、节点导入、订阅更新是否继续工作；
- 是否存在加密/混淆代码无法审计的关键路径。

动态测试必须在隔离测试设备/测试账号和测试网络中进行，不使用真实用户卡密、订阅凭证或生产数据。

### 6.4 数据外传与隐私

逐个网络请求确认：
- 目标域名/IP、TLS、请求时机；
- 上传字段是否包含用户账号、设备 ID、订阅 URL、节点配置、IP、日志；
- 是否存在未告知的数据分析/崩溃收集；
- 数据最小化、关闭遥测、删除数据和隐私声明能力。

### 6.5 APP 自主控制权验收

必须证明：
- 星跃拥有合法使用、修改、构建、签名和分发权；
- 能自主配置 Worker/API 域名；
- 能自主管理 APP 发布版本和下载入口；
- 不依赖第三方授权服务器才能运行核心功能（除非用户明确接受且有合法商业授权）；
- 不存在第三方可未经星跃授权远程封禁星跃用户的机制；
- 星跃掌握自己的签名密钥和更新发布权限；
- 第三方 SDK/闭源组件限制有清单、替代方案和风险说明。

若某项无法审计，必须标记“未知/阻塞”，不能写成“没有限制”。

## 7. 影响、测试与回滚

### 影响范围
- HTML：页脚、侧栏品牌、系统维护版本页；
- Worker：只读版本元数据端点、health build metadata；
- D1：可能需要 schema version / migration ledger，但须先核实真实生产 schema；
- APP：关于页、版本检查、第三方依赖与许可证审计；
- 发布流程：系统发布与 APP 发布分开。

### 测试计划
1. manifest schema 校验、版本格式和 commit/build ID 对照；
2. HTML/Worker/API/D1 兼容矩阵正反例；
3. 版本 API 匿名/已登录/超管权限与信息最小化；
4. API 不可达、schema 过旧、Worker 版本过新时的安全降级；
5. APP versionCode 重复/倒退、签名证书不匹配、hash 不匹配的拒绝测试；
6. APK 第三方域名抓取与网络请求记录；
7. 无网络/授权服务器不可达时的核心功能测试；
8. DEV/RC 信息对普通用户不可见。

### 回滚
- 系统版本回滚必须恢复成套 HTML/Worker 文件；
- D1 迁移只允许追加兼容性修复，不执行未经批准的 DROP；
- APP 版本回滚以暂停/撤回 release 和发布安全替代版本为主，不降低 versionCode；
- 第三方依赖替换必须保留原始 APK 源码 ZIP 与构建记录，逐模块可回滚。

## 8. 当前状态

| 项目 | 状态 |
|---|---|
| 双版本号需求 | 已确认 |
| 原始 HTML 页脚/侧栏版本展示位置 | 已静态核查，未实现 |
| Worker VERSION / health 字段 | 已静态核查，不足以代表系统版本 |
| 系统 manifest 设计 | 本批提出，未实现 |
| 系统组件兼容检查 | 本批设计，未实现 |
| APP versionCode/versionName | 管理页已有字段，客户端实际实现待 APK 审计 |
| 第三方源码许可证 | 未核查，APK ZIP 尚未解包 |
| 第三方授权服务器/远程限制 | 未核查 |
| APP 数据外传 | 未核查 |
| D1 真实 schema | 未核实 |
| API 集成测试/APP 动态测试 | 未执行 |
| 生产部署 | 未执行 |

## 9. 下一步执行顺序

1. 优先解决 APK ZIP 可读取性：通过仓库文件工具或受控二进制处理取得 ZIP 内容/文件清单，保留原始文件和 SHA-256；不能把 ZIP 当 UTF-8 文本处理。
2. APK 解包后先做许可证、Gradle 依赖、Manifest、域名/授权/更新入口、遥测和签名链路静态审计。
3. 对疑似第三方限制逐项定位源码证据，再做隔离动态测试。
4. 同步把系统版本 manifest 设计转为具体实现计划；在生产 D1 只读核验之前不写 schema 迁移。
5. 只有系统与 APP 各自完成测试、第三方授权确认、兼容检查和回滚准备后，才进入 RC/STABLE。

---
**结论：本批建立了系统版本清单与组件兼容性检查设计，并将第三方 APP 源码授权和技术锁定审计纳入正式交付门禁。当前均为设计/待审计，不是实现或测试证明；不可部署。**
