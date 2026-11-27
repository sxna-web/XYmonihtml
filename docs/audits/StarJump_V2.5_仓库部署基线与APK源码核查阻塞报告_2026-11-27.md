# 星跃管理平台 V2.5｜仓库部署基线与 APK 源码核查阻塞报告

- 日期：2026-11-27
- 仓库：sxna-web/XYmonihtml
- 分支：main
- Git Tree commit：43ebfc999ed923a20951e34484de6964880c9861
- 核查方式：GitHub 完整递归 Tree（truncated=false，共 38 entries）及相关文档只读读取
- 本报告不是线上 Cloudflare 环境或生产 D1 实况证明。

## 1. 核心结论

当前 main 分支不是可直接部署的 V2.5 正式源码仓库。完整 Tree 中可见内容主要是项目规范、审计/设计文档、原始归档 Worker/HTML、模拟后台 HTML 和 APK 源码 ZIP。

完整 Tree 未发现以下实际部署目录或配置：
- backend/worker/
- backend/d1/（仅存在 docs/backend/d1/ 下的字段映射文档，不是 SQL migrations）
- frontend/admin/
- tests/
- .github/workflows/
- wrangler.toml、wrangler.jsonc 或其他可确认的部署配置
- 独立 D1 migration SQL 文件/目录

因此当前不能从仓库确认线上 Worker 部署代码、生产 D1 binding/schema、线上管理后台版本、CI 部署流程或 APK 客户端实际行为。

## 2. 完整 Tree 中的关键证据

Tree commit：43ebfc999ed923a20951e34484de6964880c9861
Tree entries：38
truncated：false

| 路径 | SHA / 大小 | 证据意义 |
|---|---|---|
| AGENTS.md | ce90671c95b54e01d000c0c1ecc22949993ff44d | 项目协作规则 |
| README.md | ff5a2f1f13b215c1449982ee61f8cc7b4e0b0c8d | 仓库定位为项目资料库 |
| 原始归档 Worker.js | 5da7aa3582558d9da2c2a0ad25a63c5e95e9fe63 / 286088 bytes | 历史核查基线，不证明线上版本 |
| 原始归档 index.html | ab98aecd4c8546eda197bbb4d5a9f5ec0db82613 / 286281 bytes | 历史前端核查基线 |
| 星跃模拟后台 1.4.61.html | d046f71caa5af96b0c0978013771cb0a8f101739 / 995913 bytes | 本地模拟页面，不是线上后台证明 |
| StarJump-6.00.47-source .zip | 6cadab77895a29db38c3d5e2a4a2c20192255ed7 / 2377487 bytes | APK 源码 ZIP，未解包 |
| StarJump-6.00.48-source.zip | 2b8b6d105019fb90341c7178438b2d6b0473699f / 2323467 bytes | 当前待审计 APK 源码 ZIP，未解包 |

其余文件主要是审计报告、权限矩阵、API 契约、D1 字段映射和部署方案。这些是设计/核查材料，不是部署实现。

## 3. D1 核查结论

已读取：
- docs/backend/d1/StarJump_V2.5_D1字段映射与正式修复优先级_2026-11-27.md
- docs/星跃管理平台V2.5_数据库结构与变更保护规范.md

D1 字段映射文档明确：它只盘点 Worker 源码中的 DDL/SQL 字段依赖，没有访问生产 D1，也没有执行 SQL，不构成正式 schema 导出。

证据等级：
- A：Worker 源码迁移数组中的 DDL；
- B：Worker SQL 使用字段，但缺少完整建表定义；
- C：需求需要、源码暂无可靠证据；
- D：正式生产 D1 的 sqlite_master/PRAGMA 实测。

当前没有 D 级生产 schema 证据。禁止调用历史 POST /api/super/migrate 来补齐结构。必须先确认正式 D1 binding，再做只读 schema 核查。

## 4. APK 源码 ZIP 核查状态

仓库确实包含 6.00.47 和 6.00.48 两个 ZIP，文件大小分别约 2.38 MB 和 2.32 MB。本轮 GitHub 文本读取能力无法将 ZIP 二进制内容解包，因此没有读取 ZIP 内部源码。不能声称已审计其网络调用或功能实现。

解包后必须检查：
1. Gradle 模块、包名、构建配置；
2. APP status/nodes/groups/links/free/redeem 请求路径；
3. Token 签发、存储、刷新、撤销及 Header/query 传递；
4. device_id 生成、持久化、重装和清数据行为；
5. 多管理员 entitlement 并存/选择/合并；
6. 节点缓存、generation/tombstone、24 小时清理、cleanup acknowledgement；
7. Android 后台任务、进程重启和 Doze 下的清理可靠性；
8. 网络错误、授权失效和旧版本兼容。

文件名和大小不能证明 ZIP 完整、可编译或功能已实现。

## 5. Worker 部署基线

仓库可见 Worker 源码只位于原始归档目录；未发现当前部署 Worker 入口、wrangler 配置、构建脚本、CI workflow 或环境 binding 文件。

需核实：
- Cloudflare 当前 Worker 名称、线上版本和最后部署时间；
- 部署来源 commit/源码包版本；
- production/staging 路由与环境区分；
- D1 binding 变量名和对应数据库名称/标识；
- Secret 仅核对变量名和配置状态，不读取明文。

如果无法直接读取线上代码，需要提供当前线上 Worker 导出源码/版本信息。不能以原始归档 Worker 代替。

## 6. 前端管理后台

仓库存在原始归档 index.html 和模拟后台 1.4.61，但没有独立的正式前端部署目录或构建配置。

此前确认的旧归档 HTML 风险包括：
- 用户来源同步按钮调用 /api/admin/sync；
- 匿名 guest_key 在部分读取请求中放在 URL query；
- APP 卡密 CSV 导出没有先验证 HTTP 响应；
- 默认 API base 指向 staging Worker。

以上仅适用于归档 HTML，不能证明线上当前页面仍有这些问题。需取得当前线上后台实际 HTML/源码后复核。

## 7. 后续执行顺序

### A. APK
取得 6.00.48 可解包副本，先做源码目录树，再建立 APK endpoint→request fields→auth→response 的调用矩阵；与 Worker API 契约逐项比对。6.00.47 只作旧版对照。

### B. Worker
取得 Cloudflare 当前部署版本、源码、路由和配置；核实生产/测试环境与 D1 binding；再与归档 Worker 做差异对比。

### C. D1
先确认正式 D1 binding，再只读获取 sqlite_master、table_info、index_list、foreign_key_list 和迁移账本；形成 schema diff。未经批准不执行迁移。

### D. 前端
取得线上当前管理后台源码，建立 endpoint、caller、method、request fields、auth、response handling 清单。

## 8. 安全边界

- 不新建替代 Worker 或替代 D1；
- 不覆盖原始 Worker/HTML；
- 不删除或替换 APK ZIP；
- 不把 staging 当生产；
- 不调用 /api/super/migrate；
- 不创建、删除、迁移、重建或清空正式 D1；
- 不修改 Secrets、Cloudflare bindings 或生产部署；
- 不在 GitHub 文档写真实订阅 URL、节点 URI、卡密、Token 或 Secret；
- 不把静态检查写成测试通过，不把计划写成已实现。

## 9. 本次状态

| 项目 | 状态 |
|---|---|
| 仓库完整 Tree | 已核对，38 entries，未截断 |
| 当前线上 Worker 源码 | 未取得 |
| Wrangler/CI 部署配置 | 当前 Tree 未发现 |
| 正式 D1 migration SQL | 当前 Tree 未发现 |
| 正式 D1 schema | 未取得 |
| 当前线上后台源码 | 未取得 |
| APK ZIP 文件存在 | 已确认 |
| APK ZIP 内部源码 | 尚未解包 |
| 生产操作 | 未执行 |

下一阻塞：取得当前正式 Worker/后台源码、APK ZIP 可解包副本及正式 D1 binding 名称。
