# 星跃管理平台 V2.5｜现有数据库迁移执行器风险与重构验收清单

- **批次**：第三十二批
- **版本标识**：V2.5-DEV-B1-DBREVIEW-32
- **日期**：2026-11-27
- **状态**：原始 Worker 静态源码审计 / 重构验收清单；不可部署
- **仓库/分支**：sxna-web/XYmonihtml / main
- **核查基线**：`原始StarJump_V1点0_Final-zip-26-11-25-14:56/Worker.js`
- **基线 Blob**：`5da7aa3582558d9da2c2a0ad25a63c5e95e9fe63`
- **本批范围**：只读审计 `MIGRATE_STATEMENTS`、`REQUIRED_TABLES`、`migrateRoute` 和路由权限分发；不执行 SQL、不调用生产接口、不修改 Worker/HTML/D1/Secrets。

## 1. 核心结论

当前原始 Worker 的 `/api/super/schema-status` 与 `/api/super/migrate` 是早期“一键建表”实现，不符合 V2.5 正式数据库升级的安全验收标准。

主要问题：
1. schema-status 只检查一组表名是否存在，不检查字段、索引、唯一约束、外键或字段类型。
2. migrate 逐条执行 DDL，遇错后继续，最终按表名缺失数判断 ready；这可能把结构不完整误报为 ready。
3. 通过数据库错误文本判断“已存在”，不够可靠；错误消息文本不是稳定的结构检测协议。
4. 多处 ALTER/CREATE INDEX 错误被空 catch 吞掉。
5. `done` 统计的是语句执行没有抛错，不代表本次真的创建了对象；`CREATE ... IF NOT EXISTS` 即使对象早已存在，也会进入 done。
6. `addedOwner` 只要两次 ALTER 中任意一次成功就设为 true，不能准确说明两个 owner 字段都存在或都由本次新增。
7. 审计日志写入失败被 `.catch(() => {})` 忽略。
8. 路由权限允许 legacy ADMIN_TOKEN 进入 migrate，绕开了新式超管会话的严格边界。
9. 没有 migration ID、checksum、依赖关系、执行账本、执行锁、分阶段状态或可靠恢复流程。
10. 没有迁移前后完整 schema diff；没有执行后字段/索引/约束复核。

**因此：当前接口不能作为正式生产一键升级入口，也不能以 `ready=true` 作为数据库结构正确的证明。**

## 2. 代码证据与具体风险

### 2.1 schema-status 只看表名

`REQUIRED_TABLES` 列出约 18 个表名。GET `/api/super/schema-status` 查询 `sqlite_master` 中这些表是否存在，并返回 `ready/have/missing`。

风险：
- 表存在但缺关键字段仍会被认为 ready；
- 字段类型、NOT NULL、DEFAULT、PRIMARY KEY、UNIQUE、索引、触发器不检查；
- 表结构与当前 Worker SQL 定义不一致时无法识别；
- 旧表有同名但结构不同也会被当作正常；
- 不能识别 D1 绑定错误或环境错配，只能看到当前绑定数据库里的对象。

验收要求：新检查器必须基于版本化 schema manifest，对每张关键表检查字段名、类型、notnull、默认值、主键、索引与必要约束；不能只比对表名。

### 2.2 迁移语句遇错继续执行

主循环对每个 `MIGRATE_STATEMENTS` 执行 `db.prepare(sql).run()`。除错误消息匹配 `already exists|duplicate column` 外，错误被放进 errors 数组，然后继续跑后续 DDL。

风险：
- 依赖前置对象失败后仍继续执行后续索引/字段；
- 迁移集可能形成半完成状态；
- 当前逻辑没有依赖图，无法判断后续语句是否还能安全执行；
- 没有明确 migration step 状态，重试时无法从可靠检查点恢复。

验收要求：每个 migration 有明确前置条件、步骤 ID、执行前检查、执行后检查；失败应标记 failed/partial，停止依赖该步骤的后续步骤，并生成可复核报告。仅经过验证可独立执行的迁移才允许继续。

### 2.3 静默忽略 DDL 错误

源码中存在以下静默忽略模式：
- `CREATE INDEX IF NOT EXISTS ix_convert_links_owner` 失败时空 catch；
- `node_sync_logs` 的多个 ADD COLUMN 失败时空 catch；
- `admin_app_perms.free_group_enabled` 的 ADD COLUMN 失败时空 catch；
- 最终审计写入失败时 `.catch(() => {})`。

风险：调用方看不到这些操作失败；最终 `ok` 计算又不检查这些列/索引是否存在，可能返回成功。

验收要求：
- 禁止迁移关键路径使用空 catch；
- 每一步必须记录状态与脱敏错误编号；
- 可接受的“已存在”必须先通过结构检查证明对象符合目标定义；
- 审计记录失败时必须显式标记结果不完整，不能伪装为完整成功。

### 2.4 done / skipped / owner_column_added 语义不准确

- `CREATE TABLE/INDEX IF NOT EXISTS` 成功返回不代表对象由本次创建；仍被记入 `done`。
- `already exists` 由错误字符串判断，受数据库引擎错误文本变化影响。
- `addedOwner` 在 `owner_user_id` 或 `owner_key` 任意一个 ALTER 成功时即设 true，不能表示两列都存在，也不能区分原本存在和新建。

验收要求：结果使用 `created`、`already_compatible`、`altered`、`failed`、`blocked` 等基于结构前后检查的状态；每个字段独立记录。

### 2.5 legacy ADMIN_TOKEN 可进入迁移接口

路由分发对 `/api/super/schema-status` 与 `/api/super/migrate` 使用 `if (!ctx || !ctx.isSuper)`，注释明确允许 ADMIN_TOKEN legacy 作为兜底。该门禁没有排除 `ctx.legacy`。

风险：生产数据库结构写操作不应由旧式共享超级凭据作为长期迁移授权通道；也缺少迁移专用二次确认/短时授权上下文和明确操作者审计。

验收要求：
- 迁移检查可由严格超管会话只读执行；
- apply 必须要求非 legacy 的正式超管会话；
- 必须有最近重新认证/二次确认、一次性计划 ID、计划 checksum 和短时有效期；
- 操作者、环境、迁移集合、风险确认必须写入不可静默忽略的审计记录；
- 旧接口在替代方案经过兼容验证前不得直接删除，但必须在新版本中禁止 legacy 凭据执行写迁移。

### 2.6 缺少 migration ledger 与并发保护

当前未见 migration ID、checksum、依赖顺序、执行锁或运行记录表的完整实现。

风险：
- 无法证明某迁移在哪个版本、何时、由谁执行；
- 相同 ID 的迁移内容被修改时无法检测；
- 两次同时点击可能并发执行；
- 部分失败后无法安全判断从哪里继续；
- 无法可靠判断 Worker 版本与 D1 schema 的兼容性。

验收要求：采用追加式迁移账本，至少保存：
`migration_id`、`checksum`、`migration_version`、`status`、`started_at`、`finished_at`、`actor_id`、`plan_id`、`error_code`、`applied_steps`、`worker_build_id`。
同一 migration ID checksum 不匹配必须阻断；通过 D1 原子写/条件更新或经验证的锁策略避免并发重复 apply。账本结构本身需先检查真实 schema，不能盲目创建同名表。

## 3. 正式重构建议：四阶段工作流

### 阶段 A：只读盘点
- 确认当前环境标识与实际 D1 绑定来源；
- 读取 sqlite_master、PRAGMA table_info、index_list/index_info、foreign_key_list；
- 生成结构摘要和与目标 manifest 的 diff；
- 不执行 DDL，不写迁移账本；
- 无法确认环境或对象权限时停止。

### 阶段 B：生成迁移计划
- 每个 migration 有固定 ID、版本、checksum、依赖和风险级别；
- 显示新增表/字段/索引及受影响业务；
- 检查现有对象：缺失、兼容、冲突、未知；
- 对冲突字段、类型不一致、同名索引定义不符标记 BLOCKED；
- 生成 plan_id 和计划 checksum，计划短时有效。

### 阶段 C：执行已审核计划
- 仅严格超管会话，拒绝 legacy token；
- 用户在后台对明确的 migration 集二次确认；
- 只执行服务端预置迁移，不接收任意 SQL；
- 按依赖顺序执行单步 DDL；记录每步开始/成功/失败；
- 对 DDL 非事务性限制不承诺整体自动回滚；
- 失败立即停止相关依赖链，保留 partial 状态，支持结构检查后安全重试；
- 不执行 DROP/TRUNCATE/RENAME 重建或清空正式业务表。

### 阶段 D：执行后复核
- 再次读取表/字段/索引/约束；
- 对比目标 schema manifest；
- 只有全部必需检查通过且账本状态完整，才将迁移标记 applied；
- 返回结构摘要、迁移记录、耗时和错误编号；
- 任一必要项无法验证，状态为 partial/unknown，不得显示 ready。

## 4. 风险级别与执行政策

| 等级 | 例子 | 政策 |
|---|---|---|
| LOW | 新增独立、无副作用索引 | 可计划执行，仍需确认 |
| MEDIUM | 新增 nullable 字段、独立新表 | 显示影响和兼容范围，超管二次确认 |
| HIGH | NOT NULL 字段回填、唯一约束、数据迁移、改变业务读写路径 | 单独计划、备份/恢复评估、分批验证 |
| BLOCKED | DROP/TRUNCATE、未知结构冲突、不可逆覆盖、生产环境无法确认、checksum 冲突 | 禁止自动执行，要求独立人工方案 |

本项目用户已明确禁止自动 DROP/TRUNCATE/重建正式业务表。此限制为硬约束，不可通过风险确认绕过。

## 5. 测试验收矩阵

| 场景 | 预期结果 |
|---|---|
| 空测试库首次计划 | 显示完整新增对象，不自动写库 |
| 完全符合目标 schema | 全部 already_compatible，不重复修改 |
| 同名表缺字段 | 标记冲突/待修复，不得 ready |
| 字段类型/约束不符 | BLOCKED，禁止盲目 ALTER |
| 目标索引缺失 | 计划新增并在执行后验证定义 |
| 迁移中途 DDL 失败 | partial/failed，停止依赖步骤，不报告成功 |
| 同一计划重复 apply | 幂等，不重复回填/发卡/写业务数据 |
| 同一 migration ID checksum 不同 | 阻断并报警 |
| 两个并发 apply | 只有一个获得执行权，另一个明确冲突 |
| legacy ADMIN_TOKEN apply | 403 |
| 普通用户/体验会话/协助会话 apply | 403 |
| 正式超管未二次确认 | 拒绝 |
| 审计写入失败 | 不得返回完整成功 |
| D1 binding/环境无法确认 | 只读检查停止，不写库 |
| 执行后 schema 复核不完整 | partial/unknown，不 ready |
| 迁移失败后重试 | 先重新 inspect，再从兼容检查确认的安全步骤继续 |

## 6. 影响范围与回滚

- **Worker**：未来重构 migrateRoute、schema-status、认证门禁、日志与响应格式。
- **HTML**：未来数据库维护页必须区分 inspect / plan / apply / verify 四个动作。
- **D1**：未来可能追加 migration ledger；必须先核实真实生产 schema，采用兼容性追加迁移。
- **Secrets**：本批无修改。
- **APP**：本批无修改；APP 相关表结构也不能因本次迁移重构直接重建。
- **回滚**：代码回滚到前一套 Worker/HTML；已应用 DDL 不承诺自动反向回滚，优先通过向前修复迁移。保留迁移账本和审计记录，不删除业务数据。

## 7. 当前状态

| 项目 | 状态 |
|---|---|
| 原始 MIGRATE_STATEMENTS | 已静态读取 |
| REQUIRED_TABLES | 已静态读取 |
| schema-status handler | 已静态读取 |
| migrate handler | 已静态读取 |
| legacy ADMIN_TOKEN 路由门禁 | 已静态读取 |
| 字段/索引/约束完整核查 | 当前实现不具备 |
| migration ID/checksum/ledger | 未发现完整实现 |
| 并发执行保护 | 未发现 |
| 正式 D1 实际 schema | 未核实 |
| 测试库迁移测试 | 未执行 |
| Worker 重构 | 未开始 |
| 生产数据库写入/部署 | 未执行 |

---
**结论：当前迁移器只适合视为早期建表尝试工具，不具备 V2.5 正式生产一键升级所需的完整结构验证、迁移账本、失败恢复、并发保护和严格授权。第三十二批完成静态审计和验收清单，未修改代码或数据库，不可部署。**
