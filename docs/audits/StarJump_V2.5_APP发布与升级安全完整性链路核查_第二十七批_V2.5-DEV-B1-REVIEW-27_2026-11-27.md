# 星跃管理平台 V2.5：APP 发布与升级安全完整性链路核查

- **批次**：第二十七批
- **版本标识**：V2.5-DEV-B1-REVIEW-27
- **日期**：2026-11-27
- **状态**：DEV 静态源码审计；不可部署
- **仓库/分支**：`sxna-web/XYmonihtml` / `main`
- **Worker 基线**：`原始StarJump_V1点0_Final-zip-26-11-25-14:56/Worker.js`
- **Worker Blob SHA**：`5da7aa3582558d9da2c2a0ad25a63c5e95e9fe63`
- **依据**：`AGENTS.md`、V2.5 功能基线、仓库目录规范、第二十六批 APP API 字段字典、原始 Worker
- **范围**：release 数据结构、超管发布/删除路由、版本选择与强制升级、发布 URL 校验、下载入口区别、APK 完整性字段和当前可验证边界。
- **限制**：只读静态源码；未读取生产 D1、未调用线上 API、未解包 APK ZIP、未验证实际 APK 安装器；未修改业务源码、D1、Secrets、Cron 或部署。

## 1. 结论摘要

本批核实了当前归档 Worker 的 APP 发布写入、读取、删除与版本选择逻辑。

**主要发现：**
1. **P1：删除最高版本后，旧版本会重新成为最新版本。** 当前查询只按 `active=1` 和 `version_code DESC` 选择；删除路由物理 DELETE，未见版本撤回 tombstone 或“已发布版本不可回退”保护。
2. **P1：发布允许同一 platform 重复 version_code。** 没有唯一性检查或数据库唯一约束证据；同版本码排序没有第二排序键，结果可能不确定。
3. **P1：强制升级计算存在语义风险。** 发布请求的 `force` 使用 JavaScript truthiness，字符串 `"false"` 也会被当成 true；同时 force 只有在 current < latest.version_code 时才返回 true。
4. **P1：APK 完整性校验链路缺失。** releases 表和 API 响应未见 SHA-256、包名、签名证书指纹、文件大小或签名验证状态；不能证明客户端会拒绝被替换的安装包。
5. **P1：发布 URL 校验较弱。** 仅用 `/^https:\/\/.+/` 判断，不是 URL 解析与主机名校验；虽然限制 HTTPS 前缀，但不能证明 URL 可访问或文件确为合法 APK。
6. **P2：platform 缺少明确 allowlist。** 写入只做长度截断，读取端按字符串精确匹配；拼写不同会形成孤立发布渠道。
7. **P2：发布记录列表使用 SELECT *。** 超管接口返回当前表所有字段；目前表结构本身没有文件密钥，但后续加字段时要避免将内部字段、存储地址或签名材料直接暴露。
8. 普通 APP 下载入口与 APK release 是两套不同机制：`download_links` 允许 HTTP(S)，而 release POST 仅要求 HTTPS。不能把普通下载入口的规则误认为 APK 更新链路已安全。

**本批没有修复上述问题。**

## 2. 数据结构（当前实现）

归档 Worker 的迁移定义中，`releases` 表结构为：

| 字段 | 类型 | 当前定义/默认值 | 用途 |
|---|---|---|---|
| id | TEXT PRIMARY KEY | 无 | 发布记录 ID |
| platform | TEXT NOT NULL | android | 平台标识 |
| version_code | INTEGER NOT NULL | 无 | 数字版本码 |
| version_name | TEXT NOT NULL | 无 | 展示版本名 |
| min_version_code | INTEGER NOT NULL | 0 | 最低支持版本码 |
| url | TEXT NOT NULL | 无 | 下载 URL |
| notes | TEXT NOT NULL | 空字符串 | 更新说明 |
| force | INTEGER NOT NULL | 0 | 强制升级标志 |
| active | INTEGER NOT NULL | 1 | 是否参与更新查询 |
| created_at | TEXT NOT NULL | CURRENT_TIMESTAMP | 创建时间 |

本批静态读取的迁移定义没有包含：
- sha256 / checksum；
- file_size；
- package_name；
- signing_cert_sha256；
- signature_verified；
- release_channel；
- published_at / revoked_at；
- api_compat_min / api_compat_max；
- 同一 platform + version_code 的唯一约束。

说明：这仅是归档 Worker 当前迁移 SQL 的定义，不代表生产 D1 的实际 schema；生产表结构尚未只读核实。

## 3. 发布接口与版本选择（AS-IS）

### 3.1 超管发布列表

路由：`GET /api/super/releases`

- 仅当会话为超级管理员且非 legacy 会话时进入该路由。
- 执行 `SELECT * FROM releases ORDER BY version_code DESC LIMIT 100`。
- 没有按 platform 分组。
- 同 version_code 没有稳定次级排序。
- 直接返回完整行对象。

风险：列表展示顺序不等于客户端每个平台的实际最新版本；如果后台 UI 未明确按 platform 分组，容易误读。新增敏感列时 SELECT * 也会扩大泄露面。

### 3.2 新增发布记录

路由：`POST /api/super/releases`

请求 JSON 字段：
| 字段 | 当前处理 | 说明 |
|---|---|---|
| version_code | num(...,0)，要求正整数 | 版本数字 |
| version_name | s(...,40) | 非空 |
| url | s(...,500)，正则要求以 https:// 开头 | 下载地址 |
| platform | s(...,20) 或 android | 未见 allowlist |
| min_version_code | num(...,0) | 默认 0 |
| notes | s(...,2000) | 更新说明 |
| force | body.force ? 1 : 0 | JS truthiness，不是严格布尔解析 |

成功时插入新 id，响应仅返回 `{id, version_code}`，HTTP 201。

**未发现：**
- 重复 version_code 检查；
- 版本码必须单调递增的检查；
- version_name 与 version_code 对应关系检查；
- APK 文件实际上传/读取；
- 包名、签名证书、SHA-256 核验；
- URL 的标准 URL parser、域名 allowlist、重定向最终地址校验；
- 发布审批或二次确认；
- 发布前预览与回滚记录。

### 3.3 删除发布记录

路由：`DELETE /api/super/releases/:id`

执行：
`DELETE FROM releases WHERE id = ?`

响应：
`{ok:true,data:{deleted:true}}`

没有先检查是否存在记录，也没有软删除状态、撤回原因、操作者快照或“当前最新版本不可直接删除”保护。删除是物理删除；删除不存在的 ID 仍可能返回 deleted=true（取决于 D1 执行成功）。

**版本回退风险复现（静态逻辑推导）：**
- android 平台 active 版本有 100、101；
- 客户端 current=100 时 latest=101；
- 超管删除 101；
- 查询重新选择 100；
- 客户端 current=100 时变成 update=false。

这是由查询和删除代码直接推导出的行为，不是线上实测。若最高版本被误删或恶意删除，系统可能静默回退到较旧版本。

### 3.4 最新版本选择

函数 `pickLatestRelease(db, platform)`：
`SELECT * FROM releases WHERE platform = ? AND active = 1 ORDER BY version_code DESC LIMIT 1`

特点：
- 每个平台独立查最新 active 记录；
- 忽略非 active 记录；
- 同 version_code 多条时无次级排序；
- 没有发布时间窗口、渠道、兼容范围或撤回版本策略；
- 不比较版本名称，仅比较 version_code。

### 3.5 更新检查与 force 语义

路由：`GET /api/app/version`

输入：
- platform：最多 20 字符，默认 android；
- current：数字解析，默认 0。

输出有版本时：
- update：current < latest.version_code；
- force：update && (latest.force=1 或 current < min_version_code)；
- version_code、version_name、url、notes、min_version_code。

风险：
- current 缺失/非数字时默认为 0，可能让参数错误变成“非常旧版本”。
- 发布 force=true 并不意味着所有客户端都强制；客户端 version_code 已达到最新版本时 force=false。
- min_version_code 的实际语义是：低于该最低版本码且同时低于最新版本时强制更新。
- 未验证 min_version_code <= version_code；管理员可提交互相矛盾的边界。
- 没有返回 release_id、SHA-256、签名证书指纹、包名、文件大小、兼容 API 范围。
- 没有确认客户端是否验证响应签名或下载文件内容。

## 4. URL 校验与下载入口区别

### APK release URL
- 发布写入端只检查字符串以 `https://` 开头（长度最多 500）。
- 没有在发布 handler 中使用 URL parser 验证 hostname、端口、用户名密码、域名策略、跳转链最终协议。
- HTTPS 仅表示提交字符串的前缀，不证明资源真实、可用、可信或为 APK。

### 普通 APP 下载入口
- 使用 `download_links` 表；
- `validDownloadUrl` 使用 URL parser，允许 http 或 https；
- 公开读取接口可以按 admin 或分享 code 查询；
- 这类链接可能指向网盘、应用介绍页或管理员自定义下载页，不等于 APP 自动更新 APK 的 release URL。

不可混淆：普通下载入口允许 HTTP 的事实，不代表 release URL 也允许 HTTP；反过来 release 要求 HTTPS，也不代表其下载文件经过完整性验证。

## 5. P0/P1/P2 风险清单

| 级别 | 风险 | 影响 | 建议方向 |
|---|---|---|---|
| P1 | 最高版本物理删除后旧版回退 | 客户端收到旧版本或停止更新 | 撤回状态/版本防回退规则；禁止直接物理删除已发布版本 |
| P1 | 重复 version_code | 最新版本选择不确定 | platform + version_code 唯一约束或原子冲突检查 |
| P1 | force 字符串 truthiness | 管理员误设强制升级 | 严格 boolean schema，只接受 true/false |
| P1 | 缺少 SHA-256 与签名证书校验 | APK 被替换或镜像污染时无法验证 | 发布时计算并存储 SHA-256，客户端独立验证签名证书 |
| P1 | release URL 仅前缀正则 | URL/重定向/资源类型不可信 | URL parser、HTTPS allowlist、重定向策略、下载后哈希验证 |
| P2 | platform 任意字符串 | 渠道拼写错误/版本孤岛 | android 等明确枚举，未知值拒绝 |
| P2 | min_version_code 无边界检查 | 强制升级策略配置错误 | 要求 0 <= min_version_code <= version_code |
| P2 | SELECT * 返回发布记录 | 将来敏感字段被顺带暴露 | 显式选择公开/管理字段 |
| P2 | 删除无存在性检查/原因记录 | 操作不可追踪、界面误报 | 软撤回、记录操作者/理由、审计 |
| P2 | 缺少 API 兼容范围 | 新旧 APK 与 Worker 兼容性难判断 | api_compat_min/max 与发布渠道策略 |

## 6. 建议的安全发布状态机（TO-BE，尚未实现）

建议将发布过程分为：
1. **draft**：填写元数据、上传 APK 文件；
2. **verifying**：服务端读取 APK，检查 ZIP 结构、包名、version_code、签名证书，并计算 SHA-256；
3. **verified**：验证通过，生成不可变文件对象与校验元数据；
4. **published**：经超管明确发布确认，进入客户端版本选择；
5. **paused**：暂时停止新客户端下载，但保留历史发布记录；
6. **revoked**：撤回版本，记录理由、操作者、时间；不得通过删除记录让旧版本自动成为最新；
7. **superseded**：被新版本替代，仍保留可审计记录。

状态转换必须追加审计，不得覆盖历史证据。撤回后版本选择策略必须显式定义：
- 有安全替代版本：返回替代版本；
- 没有替代版本：返回明确的暂停/维护状态，而不是静默选择任意旧版本；
- 对已安装旧版本：按最低支持版本策略决定是否阻止继续使用。

## 7. 建议字段（不代表已经建表）

| 字段 | 建议类型 | 用途 |
|---|---|---|
| release_channel | TEXT | stable/beta 等渠道 |
| status | TEXT | draft/verifying/verified/published/paused/revoked/superseded |
| sha256 | TEXT | APK 文件 SHA-256 |
| file_size | INTEGER | 文件字节数 |
| package_name | TEXT | Android 包名 |
| version_code | INTEGER | 与 APK 实际元数据核对 |
| version_name | TEXT | 与 APK 实际元数据核对 |
| signing_cert_sha256 | TEXT | APK 签名证书指纹 |
| signature_verified_at | TEXT | 验证时间 |
| min_version_code | INTEGER | 最低支持版本 |
| api_compat_min/max | TEXT/INTEGER | Worker API 兼容区间 |
| published_at | TEXT | 发布时刻 |
| revoked_at | TEXT | 撤回时刻 |
| revoke_reason | TEXT | 撤回理由 |
| created_by | TEXT | 创建者 |
| published_by | TEXT | 发布者 |

签名私钥不得上传仓库、D1、普通 Worker 环境变量明文或日志；若采用签名清单，需独立设计密钥托管、轮换与客户端公钥固定策略。

## 8. 数据库影响、兼容与回滚

本批没有执行任何 D1 操作。

未来可能涉及：
- releases 增加状态、hash、签名元数据、渠道和审计字段；
- release_files 独立文件对象表；
- release_events 追加式状态变更账本；
- 唯一索引或等价原子约束；
- 下载文件存储对象与校验元数据关联。

实施前必须：
1. 只读核实生产 D1 当前 schema；
2. 确认 APK 客户端的版本检查与下载实现；
3. 设计旧客户端兼容响应；
4. 先部署可兼容旧字段的读取逻辑，再启用新发布状态；
5. 旧发布记录先补充验证状态为 unknown，不得伪造 verified；
6. 不物理删除旧版本，回滚通过状态切换和保留旧文件完成。

## 9. 测试矩阵（全部待执行）

| ID | 场景 | 预期 |
|---|---|---|
| REL27-01 | 同 platform 重复 version_code | 原子拒绝，不产生不确定 latest |
| REL27-02 | 删除当前最高版本 | 不得静默回退到旧版本 |
| REL27-03 | 撤回最高版本且存在替代版本 | 明确选择安全替代版本并返回撤回状态 |
| REL27-04 | 撤回最高版本且无替代版本 | 返回明确暂停/维护状态 |
| REL27-05 | force 传字符串 "false" | 严格解析为 false 或拒绝输入 |
| REL27-06 | min_version_code 大于 version_code | 拒绝发布 |
| REL27-07 | platform 未知/大小写不同 | 明确拒绝，不生成孤立渠道 |
| REL27-08 | URL 带用户名密码/异常端口/非法主机 | 校验拒绝 |
| REL27-09 | HTTPS URL 重定向到 HTTP | 拒绝或按明确定义策略处理 |
| REL27-10 | 下载文件 SHA-256 不匹配 | 客户端拒绝安装 |
| REL27-11 | APK 包名不匹配 | 发布流程拒绝 |
| REL27-12 | APK version_code 与表单不匹配 | 发布流程拒绝 |
| REL27-13 | APK 签名证书指纹不匹配 | 发布流程拒绝 |
| REL27-14 | 非超管发布/撤回 | 服务端 403 |
| REL27-15 | 已发布记录撤回/恢复 | 状态历史和审计完整保留 |
| REL27-16 | 旧 APK 收到新增可选字段 | 旧客户端兼容，不崩溃 |

上述均为测试计划，没有执行记录或通过证据。

## 10. 验证边界

| 项目 | 状态 |
|---|---|
| AGENTS.md | 已读取 |
| 仓库目录规范 | 已读取 |
| V2.5 功能基线 | 已读取（此前已完成） |
| 原始 Worker releases 表定义 | 已静态读取 |
| pickLatestRelease | 已静态读取 |
| appVersionRoute | 已静态读取 |
| superReleasesRoute POST/DELETE/GET | 已静态读取 |
| download_links 校验与 release URL 区别 | 已静态读取 |
| 生产 D1 实际结构 | 未核实 |
| Cloudflare 线上 Worker 版本 | 未核实 |
| APK ZIP 解包及包签名检查 | 未完成，阻塞 |
| APK 客户端更新/安装实现 | 未核实 |
| API/D1/下载链路实测 | 未执行 |
| 业务代码/D1/Secrets/Cron/部署 | 未修改、未操作 |

## 11. 下一批建议

第二十八批建议检查 APP 发布管理后台 HTML 与 Worker 管理接口的字段映射、操作按钮、确认流程和异常处理，核对前端是否真的提供发布、删除、强制升级、最低版本、平台选择等字段；重点确认 UI 的 force 值类型是否会触发本批发现的 truthiness 风险，以及删除操作是否有二次确认。仍保持静态审计，不改业务代码。

---
**结论：第二十七批完成 APP release 发布/删除/版本选择的静态源码核查。确认存在物理删除导致版本回退风险、重复版本码、force 类型解析和完整性验证缺口；未修复、未联调、不可部署。**
