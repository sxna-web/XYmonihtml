# 星跃管理平台 V2.5：数据库迁移重构技术设计与验收方案

- 批次：第三十三批
- 版本标识：`V2.5-DEV-B1-MIGRATION-DESIGN-33`
- 日期：2026-11-27
- 状态：DEV 设计稿；未修改 Worker 运行代码；不可部署
- 基线：仓库原始 Worker `原始StarJump_V1点0_Final-zip-26-11-25-14:56/Worker.js`
- 关联：第三十二批数据库迁移执行器静态审计、手机端一键数据库初始化与诊断开关方案、API 接口契约与权限矩阵 V1

## 1. 本批目标与边界

本批将第三十二批发现转化为可实施、可测试的迁移系统设计。目标是让后台数据库页面具备“只读检查 → 生成计划 → 超管确认 → 执行 → 结构复核 → 记录结果”的可追踪流程。

本批仅提交设计，不执行 SQL，不连接或修改任何 Cloudflare D1，不读取 Secrets，不触发 Worker 部署。正式 D1 的真实 schema 仍未核实；任何迁移 SQL 必须在取得只读 schema 快照、确认绑定环境和完成备份/回滚评估后另行编写。

## 2. 代码基线核实结果

### 2.1 当前路由与认证边界

原始 Worker 的 `/api/super/schema-status` 与 `/api/super/migrate` 在路由入口有单独分支。该分支判断 `ctx.isSuper`，但没有拒绝 `ctx.legacy`，因此 ADMIN_TOKEN legacy 身份可以进入这两个路由。普通 `/api/super/*` 路由的通用分支则明确拒绝 legacy 身份，并拒绝 actor 与 effective user 不一致的协助会话。

这不是“所有超级管理员路由都接受 ADMIN_TOKEN”，而是迁移专用分支存在例外。重构时必须移除该例外：迁移检查和写操作都只允许有效、本人登录的超级管理员 Session（`ctx.isSuper === true`、`ctx.legacy !== true`、`ctx.actorId === ctx.effectiveId`），并在执行前再次校验会话仍有效。ADMIN_TOKEN 不得用于 schema 读取或 DDL 写入。

### 2.2 当前迁移行为

- `MIGRATE_STATEMENTS` 是顺序数组，当前主要执行 CREATE TABLE/INDEX IF NOT EXISTS。
- 每条语句独立调用 `db.prepare(sql).run()`；不是一个整体事务。
- 对错误文本匹配 `already exists|duplicate column` 后标记 skipped；匹配过宽，可能把名称冲突、结构不一致等问题误判为正常跳过。
- `convert_links` 的 owner 列使用 ALTER TABLE 尝试补齐；`owner_column_added` 是“任一列 ALTER 成功”的布尔值，不是逐列结构验证结果。
- `node_sync_logs` 三个字段、索引及 `admin_app_perms.free_group_enabled` 的部分 DDL 使用空 catch，失败不会进入 errors。
- 最后只复查 REQUIRED_TABLES 的表名是否存在；不核对字段、索引、唯一约束、外键、默认值或列类型。
- 审计写入失败被 catch 忽略，响应仍可能返回迁移结果。
- 当前没有看到迁移 ID/checksum/dependency ledger、计划快照、并发执行锁、逐步骤状态和完整失败恢复记录。

### 2.3 D1 binding 边界

Worker 顶层入口在 API 路由处理前检查 `env.DB`，缺少 binding 时返回错误；这可阻止该请求继续进入迁移路由，但不能替代迁移器内部的环境身份确认。后续设计必须同时验证 binding 可用、环境标签匹配、只读探测成功，并在所有失败时 fail closed。不得用“表不存在”推断是全新空库，也不得自动创建或清空生产库。

## 3. 目标架构

迁移系统拆成六个独立阶段，任何阶段失败都不得伪装成 ready：

1. **Environment Guard**：确认 Worker 环境标识、D1 binding 名称/可用性、目标环境标签；生产与 staging 必须明确区分。
2. **Inspect**：只读读取 `sqlite_master`、`PRAGMA table_info`、`PRAGMA index_list`、`PRAGMA index_info`、必要时 `PRAGMA foreign_key_list`；生成 schema snapshot。
3. **Plan**：将当前 schema 与仓库已审核 migration manifest 对比，生成待执行、已满足、冲突、阻塞项；不执行 DDL。
4. **Approve**：超管本人会话对特定 plan hash 作一次性确认；确认绑定环境、迁移批次、schema snapshot hash 和过期时间。
5. **Execute**：取得互斥执行权，按依赖顺序执行可恢复迁移；每一步记录状态，遇到未识别错误立即停止。
6. **Verify & Close**：重新读取 schema，按 manifest 验证结构；只有所有必需对象和约束满足，且执行记录/审计成功，才可标记该 migration 已完成。

目标接口仅作为新增契约建议，不能认为当前已经存在：

| 方法 | 路径 | 用途 | 写库 |
|---|---|---|---|
| GET | `/api/super/maintenance/status` | 环境、Worker、schema 和迁移状态摘要 | 否 |
| POST | `/api/super/database/inspect` | 只读生成 schema snapshot | 否 |
| GET | `/api/super/database/migrations` | 查看 manifest 与执行账本 | 否 |
| POST | `/api/super/database/migrations/plan` | 生成 plan 与风险清单 | 否 |
| POST | `/api/super/database/migrations/approve` | 确认特定 plan hash | 是，仅写审批记录 |
| POST | `/api/super/database/migrations/execute` | 执行已批准 plan | 是，执行 DDL |
| GET | `/api/super/database/migrations/:id` | 查看执行步骤、验证和错误 | 否 |

路径最终冻结前，必须检查与现有 Worker、后台 HTML 的路由冲突和调用约定。

## 4. Manifest 与账本设计

### 4.1 不可变 Migration Manifest

每个迁移文件采用唯一、单调递增 ID，例如 `20261127_0001_create_migration_ledger`。manifest 至少包含：

- `migration_id`：全局唯一 ID；
- `system_version`：所属系统版本，例如 V2.6.0；
- `app_version_constraint`：如迁移涉及 APP API 契约，写明最低/最高兼容范围；纯数据库迁移可为空；
- `description`：人类可读说明；
- `depends_on`：前置 migration ID 数组；
- `checksum`：对规范化迁移文件原始字节计算 SHA-256；
- `risk_level`：low / medium / high；
- `transaction_mode`：transactional / statement-by-statement / manual；
- `preconditions`、`postconditions`：执行前和执行后的结构断言；
- `statements`：有序 SQL 步骤，禁止运行时拼接用户输入；
- `rollback_class`：reversible / compensating / backup_restore_only / irreversible；
- `min_worker_version`：所需 Worker 版本。

已经发布的 migration 文件不得原地修改。修改必须新建 migration ID；同一 ID 的 checksum 不一致属于严重完整性错误，立即停止。

### 4.2 数据库账本（目标表，待实库核验后创建）

建议表：`schema_migrations`、`schema_migration_runs`、`schema_migration_steps`、`schema_migration_lock`、`schema_snapshots`。

核心字段建议：

- `schema_migrations`: migration_id、checksum、system_version、applied_at、applied_by、status。
- `schema_migration_runs`: run_id、plan_hash、environment_id、actor_id、started_at、finished_at、status、error_code、before_snapshot_hash、after_snapshot_hash。
- `schema_migration_steps`: run_id、migration_id、step_no、step_hash、status、started_at、finished_at、error_code、safe_error_summary。
- `schema_migration_lock`: lock_name、owner_run_id、lease_expires_at、fencing_token、updated_at。
- `schema_snapshots`: snapshot_id、environment_id、schema_hash、captured_at、object_counts、snapshot_format_version。

以上只是目标结构；不得在真实 D1 schema 未核验前直接执行建表或 ALTER。账本应限制写入来源，仅迁移器可写；记录追加优先，禁止后台普通用户编辑/删除。

## 5. 幂等、依赖与错误分类

### 5.1 幂等规则

- 不以错误文本猜测“对象已存在”。
- 执行前通过结构检查判断对象是否已经满足目标定义。
- 对已存在对象逐项比较列名、类型、NOT NULL、默认值、主键、唯一约束和索引定义。
- 对象同名但定义不同，标记 `SCHEMA_CONFLICT` 并停止；不得覆盖、DROP 或重建。
- 只有 postcondition 全部通过，才能将步骤记为 `verified`。
- `skipped` 必须有明确原因，例如 `ALREADY_SATISFIED`，并附结构验证结果，不能只记录数据库错误字符串。

### 5.2 依赖顺序

- migration 依赖必须是有向无环图；检测循环依赖并在计划阶段拒绝。
- 先建独立基础表，再建引用表，再建索引/触发器/视图，最后执行数据回填与约束收紧。
- 数据回填需分页、可续跑，并保存 cursor/checkpoint。
- 对旧字段补齐先 inspect 再决定动作；不能无条件重复 ALTER。
- migration 的排序以 manifest dependency 为准，不依赖文件名偶然顺序。

### 5.3 错误码与停止策略

| 错误码 | 说明 | 自动重试 |
|---|---|---|
| `ENVIRONMENT_MISMATCH` | 环境标签与批准计划不一致 | 否 |
| `DB_BINDING_UNAVAILABLE` | D1 binding 缺失或探测失败 | 否，修复配置后重新 inspect |
| `SCHEMA_CONFLICT` | 同名对象结构不一致 | 否，人工审查 |
| `CHECKSUM_MISMATCH` | migration 内容与账本/批准计划不一致 | 否 |
| `DEPENDENCY_MISSING` | 前置迁移未验证完成 | 否 |
| `MIGRATION_LOCKED` | 已有有效执行锁 | 稍后重新检查 |
| `STEP_FAILED` | SQL 步骤执行失败 | 仅经分类确认安全后人工重试 |
| `POSTCONDITION_FAILED` | 执行后结构不符合目标 | 否，冻结后续迁移 |
| `AUDIT_WRITE_FAILED` | 审计写入失败 | 否，写操作 fail closed |
| `PLAN_EXPIRED` | 计划过期或 schema 已变化 | 重新 inspect/plan |

不得把 D1 超时、网络中断、权限拒绝、缺表、缺列、语法错误等归入“already exists”。

## 6. 执行一致性与并发保护

Cloudflare D1 的 batch/事务能力有边界，不能假定任意多条 DDL 与业务审计都能在一个全局事务中原子提交。设计采用“短事务 + 步骤账本 + 可恢复状态机”：

- 计划批准后先写 run 记录，再申请锁；锁获取失败则不执行。
- 锁采用 lease + 单调递增 fencing token；旧执行器即使恢复，也不能覆盖新执行器状态。
- 每个 migration 或安全步骤单独提交，提交后立即写步骤状态并验证 postcondition。
- DDL 与账本写入无法同事务保证时，使用恢复扫描：发现步骤状态为 running，重新 inspect 其 postcondition；已满足则标记 recovered/verified，未满足则保持 blocked，不盲目重跑。
- 每个步骤设置 statement 数量、耗时和结果大小上限；大批量数据回填必须分批。
- 请求断开不等于执行成功或失败；后台按 run_id 查询真实状态。
- 锁租约超时不能直接允许重复执行；先确认旧 run 是否仍在执行，再递增 fencing token 接管。

## 7. 数据安全、备份与回滚

### 7.1 禁止动作

未经明确授权和完整评估，迁移器禁止执行：

- DROP TABLE / DROP COLUMN；
- 清空、重建或覆盖现有业务表；
- 无条件删除历史数据；
- 将 staging 数据复制到 production；
- 自动更换 D1 binding；
- 自动修改 Cloudflare Secrets、环境变量或 Worker 部署；
- 在未确认数据保留策略时执行不可逆数据转换。

### 7.2 回滚分级

- **可逆结构变更**：仅允许 manifest 提供经过测试的反向迁移，且先验证无新数据依赖。
- **补偿式回滚**：新增字段/表后通过新 migration 修正，不覆盖原始历史。
- **只能备份恢复**：破坏性数据转换或不可逆操作必须提前备份并明确恢复窗口；本项目默认不自动执行。
- **不可逆**：必须由用户单独明确批准，并在计划页醒目标明影响范围；本轮不纳入 V2.6.0 自动迁移范围。

迁移器不得把“执行反向 SQL”当成普遍回滚方案。DDL 回滚可能丢失迁移后写入的数据。

## 8. 手机端后台交互

数据库页面应适合手机操作，并将检查与写操作明显分开：

1. 页面顶部显示系统版本、Worker 版本、APP 兼容范围、环境标签、D1 binding 状态和最近检查时间。
2. 默认进入只读检查，不自动执行任何 SQL。
3. 显示“已满足 / 待迁移 / 结构冲突 / 阻塞 / 未验证”五类状态。
4. 每个 migration 展示 ID、说明、checksum 短摘要、依赖、风险、影响对象、回滚等级。
5. 计划页展示 schema 变更前后差异；无法判断的数据风险必须标为“待人工核实”。
6. 执行前需要输入明确确认短语，并再次核对环境名与 plan hash；不能只靠一个固定 `confirm=yes`。
7. 执行期间展示 run_id、当前步骤、已验证步骤、失败步骤和最后心跳。
8. 失败后保留现场，展示错误编号和脱敏摘要；提供“重新检查”而不是直接提供“强制继续”。
9. 只有 postcondition 全部通过时显示“数据库结构已验证就绪”。
10. 诊断开关默认关闭；开启后记录 request_id、run_id、migration_id、step_no、耗时、错误码和 SQL 模板 ID，不记录卡密、Token、订阅 URL、密码、Secret 或完整 SQL 参数。

## 9. 测试矩阵（必须在隔离测试 D1 执行）

| 场景 | 预期 |
|---|---|
| 无 DB binding | 明确失败，不创建任何账本或成功状态 |
| staging 环境执行计划却传入 production 确认 | ENVIRONMENT_MISMATCH，零 DDL |
| 未登录、普通用户、协助会话、legacy ADMIN_TOKEN | 全部拒绝迁移读写；本人超管 Session 才可继续 |
| migration checksum 改变 | CHECKSUM_MISMATCH，停止 |
| 缺少依赖 | DEPENDENCY_MISSING，零执行 |
| 两个管理员同时提交同一计划 | 仅一个获取锁，另一个 MIGRATION_LOCKED |
| 已存在且结构完全一致 | ALREADY_SATISFIED，postcondition 验证通过 |
| 同名表缺列/类型不同 | SCHEMA_CONFLICT，不自动修复 |
| SQL 语法错误 | STEP_FAILED，停止后续步骤 |
| 执行后验证失败 | POSTCONDITION_FAILED，系统状态 blocked |
| 审计写入失败 | 写操作拒绝或状态标为审计失败，不报告成功 |
| 执行器中途终止 | 恢复扫描识别已完成步骤，不重复破坏性操作 |
| 重复执行同一已完成 plan | 不重复执行，返回已验证结果 |
| plan 生成后 schema 被外部改变 | snapshot hash 不匹配，PLAN_STALE，要求重新 inspect |
| 回滚演练 | 验证备份恢复步骤与数据一致性，不对生产执行 |

测试必须覆盖空库、当前源码预期结构、旧结构、部分迁移结构、同名冲突结构和数据量较大的回填样本。测试结果、D1 临时库标识、测试脚本版本和日志摘要必须归档。

## 10. V2.6.0 交付门禁

只有同时满足以下条件，迁移模块才可进入正式交付候选：

- [ ] 已取得并核实实际目标 D1 的只读 schema snapshot；production/staging 标识无歧义。
- [ ] 已核对后台 HTML 的数据库页面调用与 Worker API 契约。
- [ ] 已移除迁移路由对 legacy ADMIN_TOKEN 的例外；协助 Session 无法执行迁移。
- [ ] manifest、checksum、dependency、ledger、lock、fencing 和恢复流程均已实现。
- [ ] inspect/plan 不写业务表、不执行 DDL。
- [ ] execute 只执行经审核并批准的 plan hash。
- [ ] 任何未识别错误立即停止；无宽泛 duplicate 错误忽略和空 catch。
- [ ] 每个步骤有 postcondition；ready 必须基于完整结构验证。
- [ ] 审计失败不能返回成功。
- [ ] 隔离 D1 全测试矩阵通过，含并发、中断恢复、重复执行和回滚演练。
- [ ] 已准备匹配的 Worker、HTML、D1 migrations、部署说明、诊断开关与回滚包。
- [ ] 独立复核完成，版本标识为 V2.6.0 STABLE 后才通知用户集中上传部署。

## 11. 本批结论

本批已形成数据库迁移重构的目标架构、manifest/账本字段、权限门禁、幂等与错误分类、并发保护、恢复机制、手机端交互和验收矩阵。

**本批状态：设计完成；代码未实现；隔离 D1 未测试；生产 D1 未访问；不可部署。**

下一批建议：第三十四批对照后台 HTML 数据库管理页面，核查现有按钮、接口调用、权限提示和一键升级交互，形成“当前 UI → 新迁移流程”的逐项改造映射。