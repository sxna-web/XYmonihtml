# 星跃管理平台 V2.5：隔离数据库迁移执行器实施计划与安全门禁

- 批次：第四十二批（实施前置计划）
- 版本标识：V2.5-DEV-B1-MIGRATION-PLAN-42
- 日期：2026-11-27
- 状态：影响分析与实施计划；尚未新增执行代码；未运行 SQL；未连接生产 D1；不可部署
- 必读规则：仓库根目录 AGENTS.md、V2.5 功能基线、仓库目录归类规范
- 关联：第三十二批迁移风险审计、第三十三批迁移执行器设计、第三十九批通知 API 契约、第四十一批通知 Migration SQL 草案

## 1. 本批结论

本批先完成实施前置审查，不直接写入迁移执行器或运行 SQL。仓库协作规则要求先核对当前 D1 结构、Worker/API/前端调用与部署配置；当前会话可读取仓库源码与文档，但没有经用户确认的生产 D1 只读结构快照，也不能证明 Cloudflare 线上 Worker 与仓库原始 Worker 完全一致。

因此，本批冻结实现范围、文件计划、数据库影响、风险、回滚和测试门禁。后续代码只能在本地/CI 临时 SQLite 数据库中测试，禁止指向 Cloudflare 生产 D1。生产 schema 核实前，不生成可自动作用于生产数据库的迁移入口。

## 2. 当前已核实基线与未核实项

### 已核实
- 仓库：sxna-web/XYmonihtml，分支 main。
- 根目录 AGENTS.md 存在，要求先读功能基线和模块资料，先提交影响分析、修改计划、数据库影响、风险、回滚和测试计划。
- 功能基线明确禁止未经用户授权创建、删除、迁移、重建、清空或重命名正式 D1 结构。
- 原始 Worker 只能作为仓库历史源码参考，不等于 Cloudflare 线上版本。
- 第四十一批已提供 schema_migrations、migration_locks、四张通知业务表的 SQL 草案与只读结构检查契约。
- 第四十一批明确将事件处理租约字段留待实现前冻结；不能让 processing 状态缺少恢复机制。
- 当前通知 UI/API 仍属于设计阶段，未接入生产。

### 未核实（不得猜测）
- Cloudflare 当前生产 Worker 的实际源码/部署版本。
- 用户最终部署的两个文件的精确版本及线上哈希。
- 生产 D1 binding 名称、数据库 ID、数据库环境和实际 schema。
- D1 外键 enforcement 配置及现有迁移账本是否存在。
- 生产表是否与仓库原始 Worker、旧版 HTML 或 staging schema 一致。

禁止使用 starjump-db。starjump-staging 不能当作生产库。

## 3. 影响分析

### 3.1 代码影响范围（计划，尚未修改）
拟新增隔离工具，全部放在模块目录：
- tools/database_migrations/：本地 SQLite 迁移运行器、schema diff、checksum 工具。
- tools/database_migrations/migrations/：版本化 SQL 文件。
- tools/database_migrations/tests/：自动化测试。
- docs/database/：运行说明、测试报告、迁移清单。

不修改根目录原始 Worker、HTML、APK ZIP，不覆盖历史文件。若仓库现有目录规范另有指定，实施前以目录规范为准。

### 3.2 数据库影响
- 本批没有数据库写入。
- 未来隔离测试仅创建临时 SQLite 文件或内存数据库；每次测试结束销毁临时文件。
- 未来测试 schema 暂定包括 schema_migrations、migration_locks、notification_events、user_notifications、notification_preferences、notification_deliveries。
- 任何真实 D1 只读检查必须在单独授权、确认环境和 binding 后进行；生产迁移另需用户明确授权。

### 3.3 API/前端影响
- 本批不改 Worker API，不改 HTML，不新增菜单或通知入口。
- 迁移工具只负责结构迁移/差异报告，不承担通知业务处理和收件箱授权。
- 后续 Worker API 仍必须使用服务端 session 和 recipient/tenant owner predicate；迁移执行权限不能扩张普通用户权限。

## 4. 第四十一批 SQL 草案需在编码前冻结的修订项

1. 事件处理租约：notification_events 必须明确 processing_execution_id、lease_expires_at、fencing_token（或独立执行租约表），并明确领取、续租、过期回收的原子 SQL。仅有 processing 状态不能可靠恢复。
2. 迁移执行状态：D1 单个 batch 的原子性边界、账本状态写入与 DDL 失败记录路径必须经隔离测试证明；不能假设跨请求事务。
3. 迁移锁：若使用 fencing token，锁表必须通过原子条件更新递增 token；不能先 SELECT 再 UPDATE。
4. SQL checksum：统一 UTF-8、LF 换行、是否剥离 BOM 的规则；manifest 值必须由最终文件自动生成，不手填。
5. schema fingerprint：明确只覆盖表、列、索引、唯一约束、外键和规范化 SQL；不能声称覆盖 SQLite 所有语义。
6. SQLite/D1 差异：PRAGMA 支持、foreign_keys、ALTER TABLE 限制、事务/batch 语义需在 Cloudflare D1 兼容环境验证。
7. 迁移账本兼容：实施前必须检测现有库是否已有同名表或不同结构；不得 CREATE IF NOT EXISTS 后就认为兼容。
8. 第四十一批偏好表 CHECK：时间字符串校验应使用精确格式规则；应用层仍须验证 IANA timezone，禁止只靠 GLOB 作为完整验证。

以上项目未冻结前，不生成 NTF-001 的正式 checksum 和生产可用迁移包。

## 5. 实施文件计划

| 文件 | 作用 | 安全边界 |
|---|---|---|
| tools/database_migrations/runner.py | 本地 SQLite 迁移执行器，支持 plan/check/apply-local | 默认只允许临时库；拒绝远程 URL/生产环境变量 |
| tools/database_migrations/schema_diff.py | 读取 sqlite_master 与 PRAGMA，输出规范化差异 | 只读；不自动修复 |
| tools/database_migrations/checksum.py | 计算 SQL 文件 SHA-256 并校验 manifest | 只读文件 |
| tools/database_migrations/migrations/CORE-MIG-001.sql | 隔离测试账本/锁表 | 不直接对生产运行 |
| tools/database_migrations/migrations/NTF-001.sql | 通知四张业务表与索引 | 需完成第 4 节修订 |
| tools/database_migrations/tests/ | 空库、重复执行、checksum 漂移、结构漂移、锁竞争和失败恢复测试 | 仅临时 SQLite |
| docs/database/ | 使用说明与测试证据 | 明确不可部署状态 |

## 6. 执行器设计约束

命令模式：
- plan：读取迁移目录与目标临时库，只生成执行计划，不写数据库。
- check：只读检查表/列/索引/约束/外键/账本/checksum，发现 drift 以非零状态退出。
- apply-local：只允许本地临时 SQLite 文件；执行前校验路径位于系统临时目录或工具创建的测试目录，并拒绝符号链接、生产文件名和非 SQLite 文件。
- checksum：生成 manifest，不修改 SQL。
- test：运行隔离测试套件。

安全要求：
- migration_id 固定且不可复用。
- checksum 不匹配立即停止。
- dependency 缺失立即停止。
- 已 applied 且 checksum 相同返回 already_applied。
- 表已存在但结构不匹配必须报告 drift，不得跳过。
- 失败时不标记 applied；记录失败状态的能力必须经过原子性测试，否则输出 execution_state_unknown 并停止。
- 所有 DDL 由静态审核过的 SQL 文件提供；禁止拼接用户输入作为 SQL 标识符。
- 锁竞争测试必须证明单执行器获得有效 fencing token，旧 token 无法继续写入。
- 不包含生产 D1 的任何自动发现、连接、上传或部署逻辑。

## 7. 测试计划与验收证据

最低测试集：
1. 空白临时库执行 CORE-MIG-001。
2. 相同 migration/checksum 重跑为 already_applied。
3. 同 ID 不同 checksum 返回 CHECKSUM_MISMATCH。
4. 缺少依赖返回 DEPENDENCY_MISSING。
5. 表存在但字段缺失报告 drift。
6. 列类型、notnull、default 差异逐项报告。
7. 索引列顺序/唯一性差异报告。
8. 外键目标与 ON DELETE 差异报告。
9. 模拟 DDL 中途异常，账本不得误标 applied。
10. 两个并发执行器争锁，只有一个可执行。
11. 旧 fencing token 写入被拒绝。
12. SQL 文件 CRLF/LF 规则一致，checksum 可复现。
13. 拒绝生产路径、远程 URL、Cloudflare binding 变量。
14. 运行工具不访问网络、不读取 Secrets。
15. 临时数据库测试完成后清理，不修改仓库已有数据库文件。

验收证据必须包含 Python 版本、SQLite 版本、命令、测试总数、通过/失败数量、测试日志摘要、临时 DB 路径（脱敏/临时路径）和最终退出码。没有实际运行证据，不得标记“已测试”。

## 8. 回滚与恢复

- 代码回滚：删除或回退本批新增的工具文件，不影响 Worker/HTML/数据库。
- 临时库回滚：测试结束销毁临时 DB；保留测试报告，不保留用户业务数据。
- 未来 schema 回滚：优先使用前滚修复；只有在空隔离库证明可逆且无业务数据时才演练 down migration。
- 正式 D1：本批不提供执行回滚命令，不授权生产操作。未来正式变更必须先备份、验证恢复、检查数据影响并取得用户明确授权。

## 9. 本批状态与下一步

- 已完成：阅读仓库规则、功能基线、目录规范、通知 Migration 设计；形成影响分析和隔离实施计划。
- 未完成：执行器代码、SQL 文件、自动 checksum、schema diff 实现、测试。
- 未执行：任何 SQL、任何 D1 操作、任何 Worker/HTML 修改、任何 Cloudflare 部署。
- 状态：V2.5-DEV-B1-MIGRATION-PLAN-42 / PLAN ONLY / NOT DEPLOYABLE。

下一步实施顺序：
1. 先冻结事件处理租约字段与 D1/SQLite 兼容策略。
2. 在 tools/database_migrations/ 新增纯本地 SQLite 工具。
3. 编写临时库测试并实际运行。
4. 输出可复现测试报告与真实 checksum manifest。
5. 通过独立复核后，再考虑通知 Worker/API 实现。
