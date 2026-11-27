# 星跃管理平台 V2.5：发布后台字段映射与系统 / APP 双版本号规范核查

- **批次**：第二十八批
- **版本标识**：V2.5-DEV-B1-REVIEW-28
- **日期**：2026-11-27
- **状态**：DEV 静态审计 + 双版本号需求纳入基线；不可部署
- **仓库/分支**：`sxna-web/XYmonihtml` / `main`
- **依据**：`AGENTS.md`、原始 HTML、原始 Worker、V2.5 API 契约、第二十七批发布链路报告、用户本轮新增确认
- **范围**：核对 APP 发布后台 HTML 表单与 Worker 接口字段；检查删除确认/强制升级；核实系统版本与 APP 版本现状；建立双版本号规则。
- **限制**：静态源码核查；没有修改业务 HTML/Worker/D1，没有执行 API/D1 测试，没有部署；APK ZIP 未解包，APP 客户端显示和升级行为仍待验证。

## 1. 用户本轮新增的明确需求

用户明确要求：**系统和 APP 都要有版本号。**

本项目必须把两个版本体系独立管理、独立展示、独立升级，不得混用：

### A. 星跃管理系统版本（System Version）

覆盖整个管理平台交付组合：
- 管理后台 HTML；
- Cloudflare Worker；
- D1 schema / migrations；
- API 契约与必要的系统组件。

建议统一使用语义化版本：`MAJOR.MINOR.PATCH`，例如 `2.5.0`。
- MAJOR：不兼容的大架构/数据/API 变更；
- MINOR：兼容新增功能；
- PATCH：兼容修复。
- 另有构建标识：日期、批次、Git commit SHA、构建通道（DEV/RC/STABLE）。

系统版本不能仅靠 Worker 的 VERSION 常量代表完整系统；HTML、Worker、D1 schema 可能出现版本不匹配，必须分别报告组件版本与兼容范围。

### B. 星跃 Android APP 版本（App Version）

APP 自身独立维护：
- `versionCode`：Android 整数递增，必须唯一递增，不回退；
- `versionName`：用户可读版本，如 `6.00.50`；
- release channel（正式/测试等，具体渠道需结合现有产品规则）；
- 最低支持版本；
- 下载地址；
- SHA-256、包名、签名证书指纹等完整性元数据。

APP 版本由 APP 源码构建与发布流程产生；管理后台只能登记并验证实际 APK 元数据，不可随意填写一个版本号就宣称 APK 已对应。

### C. 展示位置建议（TO-BE）

- 管理后台登录页或页脚：显示“星跃管理系统 V2.5.0”，并可在系统维护 → 关于/版本信息查看完整组件版本。
- 系统维护 → 版本信息：展示系统版本、HTML 版本、Worker 版本、D1 schema 版本、API 契约版本、构建批次、commit SHA、兼容状态。
- APP 设置 → 关于：显示“星跃 APP x.xx.xx”与 versionCode；APK 版本检查接口返回 APP 最新版本。
- 超级管理员发布管理：单独显示“系统版本”和“APP 版本”两张卡片/两个独立入口，不能共用同一套 version_code。
- 普通用户不应看到 DEV 内部构建信息；DEV/RC 信息只对授权测试人员展示。

上述展示位置是需求设计，当前没有实现。

## 2. 当前源码核查事实

### 2.1 Worker 已存在的版本常量，但不等于完整系统版本

原始 Worker 顶部定义：
- `VERSION = "1.0.0"`
- `CANON_VERSION = "v1.0-1"`

另有公开 `GET /health` 响应：
- `service: "starjump-api"`
- `version: VERSION`
- `build: "2026-11-23-diag"`
- `auth_mode: "multi_user_session"`
- `legacy_admin_token: "restricted"`
- features 数组。

结论：
- Worker 服务版本常量存在；
- build 字段是硬编码日期/标记，不是自动 Git commit 或完整构建 ID；
- CANON_VERSION 是节点规范化/指纹流程版本，不是平台系统版本；
- 当前没有发现统一的 HTML + Worker + D1 schema 总版本登记和兼容状态核验；
- 当前 Worker VERSION=1.0.0 不能直接作为星跃管理平台 V2.5 的系统版本。

### 2.2 HTML 没有发现正式系统版本展示

原始 HTML：
- 页面 title 为“星跃 · 超级管理员控制台”；
- 源码注释标识“星跃后台 V1.0 · 单文件模拟管理系统”；
- 未发现统一系统版本元数据/版本显示组件；
- 发布页面存在的是 APP 版本表单，不是系统版本发布管理。

因此，当前页面注释 V1.0 不能被当成正式系统版本，页面标题也没有显示系统版本。

### 2.3 APP 发布表单与 Worker 字段映射

HTML 发布表单：
- relCode → version_code；
- relName → version_name；
- relMin → min_version_code；
- relUrl → url；
- relNotes → notes；
- relForce → force（checkbox，JS 布尔值）；
- 没有 platform 输入，前端未传 platform，Worker 默认 android。

Worker POST `/api/super/releases`：
- 接收上述字段；
- version_code 正整数校验；
- version_name 非空；
- url 只检查 https:// 前缀；
- platform 截断后默认 android，没有 allowlist；
- min_version_code 未检查不得大于 version_code；
- force 用 body.force truthiness 转 1/0。

本次字段映射确认 HTML checkbox 当前发送布尔值，因此普通页面正常操作时字符串 "false" 风险未必由该 HTML 表单触发；但 API 仍接受其他调用方传入的字符串，服务端必须严格解析。不能因当前页面使用 checkbox 就忽略 Worker 风险。

### 2.4 删除按钮与确认行为

HTML `loadReleases()`：
- 每行显示 version_name/version_code、min_version_code、force、URL；
- 每条发布记录都显示“删除”按钮；
- 点击后直接请求 DELETE；
- 没有 `confirm()` 二次确认；
- 删除成功后重新加载列表。

Worker DELETE：
- 直接物理删除 releases 记录；
- 没有软撤回、撤回原因、状态事件或最新版本保护。

这与第二十七批确认的“删除最高版本后旧版可能重新成为最新版本”形成完整前后端风险链。

### 2.5 发布列表展示不足

当前列表只显示版本、最低版本、强制标志、地址、操作：
- 没有 platform；
- 没有 release 状态；
- 没有创建/发布时间；
- 没有 SHA-256/包大小/签名证书；
- 没有发布者、撤回原因；
- 没有系统版本入口。

## 3. 双版本号统一规范（需求基线草案）

| 项目 | 系统版本 | APP 版本 |
|---|---|---|
| 代表对象 | 管理后台 + Worker + D1/API 组合 | Android 安装包 |
| 版本格式 | SemVer，如 2.5.0 | versionCode 整数 + versionName |
| 版本生成来源 | 系统发布流程 | APK 构建流程 |
| 主要展示 | 后台页脚、系统维护、超管版本页 | APP 关于页、APP 发布管理 |
| API | 系统 meta/version 或 health/build metadata | /api/app/version |
| 兼容性 | HTML↔Worker↔D1 schema↔API | APK↔APP API↔Android |
| 发布门禁 | DEV→RC→STABLE | 构建→签名/哈希验证→发布 |
| 回滚 | 回到匹配的系统文件组合/兼容迁移策略 | 撤回发布并提供明确安全替代版本 |
| 禁止事项 | 不能只改一个 VERSION 常量冒充完整系统版本 | 不得降低/复用 versionCode |

### 3.1 系统版本清单

正式系统交付时至少生成一个机器可读 manifest（建议 `system-version.json`）：
- system_version；
- release_channel；
- release_status；
- release_batch；
- release_date；
- git_commit；
- html_version；
- worker_version；
- d1_schema_version；
- api_contract_version；
- min_worker_version / max_worker_version；
- min_schema_version / max_schema_version；
- migration_set_version；
- build_id。

具体文件位置和是否由 Worker 公开读取，待正式实现方案确定。公开 health 只返回非敏感版本元数据，不能返回密钥、内部 D1 名称或敏感部署信息。

### 3.2 组件版本一致性

- HTML 启动时读取自身构建版本和 Worker 版本；
- Worker 返回系统版本、Worker 版本、API 契约版本、D1 schema 状态；
- 系统维护页进行兼容矩阵检查；
- 如果 HTML 与 Worker 不兼容，显示明确错误并禁止危险写操作；
- 如果 D1 schema 低于 Worker 最低要求，提示先执行安全迁移，不可继续运行不兼容写操作；
- 当前版本不匹配不得静默回退到 staging 或其他环境。

### 3.3 DEV/RC/STABLE 标识

- DEV：内部开发，禁止生产部署；
- RC：候选测试，需通过自动测试与人工验收；
- STABLE：可部署正式版，需完整文件包、版本清单、测试记录、数据库迁移、回滚方案。
- 小修复累积在开发分支；只有大更新完成核对、测试和回滚准备后才通知用户上传。
- 本批及前序审计报告均为 DEV 文档，不构成 STABLE。

## 4. 必须新增的验收项

| ID | 验收要求 | 状态 |
|---|---|---|
| VER28-01 | 后台清晰显示系统版本 | 未实现 |
| VER28-02 | 系统维护页显示 HTML/Worker/D1/API 组件版本 | 未实现 |
| VER28-03 | 系统版本与 APP versionCode/versionName 独立 | 需求已确认，未实现 |
| VER28-04 | 系统版本 manifest 与构建 commit 可追溯 | 未实现 |
| VER28-05 | Worker health 返回准确版本和 build ID | 现有字段不完整，待修 |
| VER28-06 | APP 关于页显示 versionName/versionCode | APK 源码未解包，待核实 |
| VER28-07 | APP version API 与 APK 实际版本信息一致 | 未实测 |
| VER28-08 | APP versionCode 严格递增且唯一 | 当前未实现证据 |
| VER28-09 | APP 发布表单 platform 明确且受 allowlist 约束 | 未实现 |
| VER28-10 | force 严格 boolean 校验 | 未实现 |
| VER28-11 | min_version_code 不大于 version_code | 未实现 |
| VER28-12 | 已发布版本删除改为撤回/停用流程 | 未实现 |
| VER28-13 | 删除/撤回必须二次确认并填写理由 | 未实现 |
| VER28-14 | 发布前核对 APK 包名/versionCode/versionName/签名/SHA-256 | 未实现 |
| VER28-15 | 系统版本与 APP 版本各自具备回滚策略 | 未实现 |

## 5. 影响分析与实施顺序

建议分阶段实现，不一次性改变现有 APP API：

1. **版本元数据基线**：先定义系统版本 manifest、APP release 字段字典和版本号规则。
2. **只读版本展示**：后台显示当前系统/组件版本；APP 关于页显示自身版本；暂不改变发布行为。
3. **兼容性检查**：Worker 暴露非敏感版本元数据；系统维护页检查 HTML/Worker/D1/API 兼容。
4. **APP 发布安全修复**：严格字段验证、重复 versionCode 防护、撤回替代物理删除、发布审计。
5. **APK 完整性链路**：解包 APK 源码，核实客户端版本展示和升级流程，再实现 hash/签名验证。
6. **系统 STABLE 发布**：只有 Worker、HTML、D1 migrations、版本清单、测试与回滚包一致后，才生成正式部署包。

### D1 影响

本批不执行 D1 操作。未来可能新增：
- system_release_manifest 或独立构建元数据；
- releases 的状态、渠道、hash、签名元数据；
- release_events 追加式审计账本；
- migration ledger / schema version 记录。

必须先只读核实生产 D1 真实 schema，再编写幂等迁移。不能直接在生产表上猜测 ALTER。

### 回滚

- 系统版本回滚必须回到一组匹配的 HTML/Worker/API 文件，不能只回滚单个 Worker 常量；
- D1 新字段保留，不执行破坏性 DROP；
- APP 发布撤回应保留原 release 记录与文件，选择安全替代版本；
- 不允许 versionCode 倒退或复用；
- 新旧客户端协议需保留兼容窗口。

## 6. 本批验证边界

| 检查项 | 结果 |
|---|---|
| AGENTS.md | 已读取 |
| 原始 HTML | 已读取 |
| 原始 Worker | 已读取 |
| API 契约 | 已读取 |
| APP 发布表单与 POST 字段映射 | 已核实 |
| 删除按钮二次确认 | 未实现（源码未发现） |
| Worker release 物理删除 | 已核实 |
| Worker VERSION/CANON_VERSION/health | 已核实 |
| 系统统一版本展示 | 未发现 |
| APP 版本与系统版本分离 | 当前仅有 APP release 表单；统一分离规范未实现 |
| APK 关于页/版本升级客户端实现 | 未核实，APK ZIP 未解包 |
| D1 真实 schema | 未核实 |
| API/D1/浏览器测试 | 未执行 |
| 业务源码、D1、Secrets、Cron、部署 | 未修改/未操作 |

## 7. 下一批计划

第二十九批建议建立“系统版本 manifest 与 HTML/Worker/D1/API 兼容性检查”技术设计，并继续核对现有 HTML 登录、页脚、系统维护入口适合放置版本信息的位置。只做设计与静态审计，不先改生产文件；同时保持 APP 版本独立，不把 APP 的 versionCode 当作系统版本号。

---
**结论：本批已将“系统和 APP 都必须有独立版本号”正式纳入 V2.5 需求基线。当前 Worker 有 1.0.0 服务常量，APP 发布页有 versionCode/versionName 表单，但没有完整系统版本体系和统一展示；两套版本号必须分开管理。不可部署。**
