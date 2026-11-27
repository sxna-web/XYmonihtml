# 星跃管理平台 V2.5 DEV：数据库迁移误报就绪风险与安全升级流程（第八批）

- 版本标识：`V2.5-DEV-B1-REVIEW-08`
- 日期：2026-11-27
- 阶段：DEV 静态代码复核 / 升级流程设计
- 对象：`releases/v2.5-batch1/Worker.js`
- Worker blob：`5a2739d981e1835e692a04b903052f268fed981a`
- 原始 Worker blob：`5da7aa3582558d9da2c2a0ad25a63c5e95e9fe63`
- 依据：`AGENTS.md`、V2.5 功能基线、数据库结构与变更保护规范、D1 字段映射报告

> 本报告只做源码静态复核与流程设计。没有调用 `/api/super/migrate`，没有执行 SQL，没有读取生产 D1，没有部署或修改 Secrets。

## 一、确认的迁移误报风险

### DB-08-01：schema-status 的 ready 判断过于宽松

当前 `GET /api/super/schema-status`：
- 只查询 `sqlite_master` 中 `REQUIRED_TABLES` 列出的表名；
- 只要 18 张表名都存在，就返回 `ready: true`；
- 不读取 `PRAGMA table_info`；
- 不检查字段类型、NOT NULL、默认值、主键、唯一约束、索引或外键；
- 不检查 22 张业务代码依赖的基础表；
- 不检查 `node_sync_logs`。

所以它的 `ready` 实际只能表示“18 个指定表名都存在”，不能表示“Worker 所需数据库结构完整”。

### DB-08-02：node_sync_logs 补列失败被全部吞掉

迁移流程尝试添加：
- `trigger_kind`
- `duration_ms`
- `missing_nodes`

三个 ALTER 都使用空 catch。失败原因不进入 `errors` 数组，最终响应也不提供字段核验结果。

如果表不存在、字段类型冲突、SQL 权限/执行异常或其他错误，当前代码都可能静默忽略。即使后续业务依赖这些字段，也无法从迁移响应得知失败。

### DB-08-03：admin_app_perms 补列失败被吞掉

`free_group_enabled` 的 ALTER 同样采用空 catch。即使字段没有成功添加，最终 `ready` 仍只根据 18 张表是否存在判断。

### DB-08-04：convert_links.owner_column_added 统计不准确

当前循环依次尝试添加 `owner_user_id` 和 `owner_key`：
- 只要其中任意一个 ALTER 成功，就设置 `addedOwner = true`；
- 如果第一个成功、第二个失败，结果仍可能报告 `owner_column_added: true`；
- 如果字段本来已存在，duplicate column 会被跳过；
- 最终没有重新检查两个字段是否都存在。

该字段名容易被误解为“两个 owner 字段均已完整”。实际上它只代表“至少一次 ALTER 成功”。

### DB-08-05：迁移不是整体原子操作

每条迁移语句独立执行：
- 前面语句成功后，后面语句可能失败；
- 失败不会自动撤销前面已成功的 DDL；
- `done`、`skipped`、`errors` 只是逐条执行结果；
- 不存在迁移 ID/checksum/依赖账本；
- 重试时只能依赖对象已存在错误和部分幂等 DDL。

这意味着“本次失败”不代表数据库完全没有变化，“再次执行”也不能替代迁移状态核对。

### DB-08-06：迁移审计失败被吞掉

`schema.migrate` 审计写入失败后使用 `.catch(() => {})`。迁移响应仍可能正常返回，后台无法保证每次数据库变更都有可追溯审计记录。

对数据库结构变更而言，审计失败必须被明确报告；不能把迁移结果伪装成完整可追溯成功。

## 二、现有代码的返回值不能怎样理解

| 当前返回字段 | 实际能证明什么 | 不能证明什么 |
|---|---|---|
| `ready` | 18 张指定表名均存在 | 字段、索引、约束完整 |
| `done` | 对应语句执行时未抛出错误 | 目标 schema 与预期完全一致 |
| `skipped` | 捕获到特定 already exists/duplicate column 错误 | 已存在对象的定义正确 |
| `errors` | 未被 catch 忽略的部分语句错误 | 所有迁移错误均已记录 |
| `owner_column_added` | 至少一个 owner ALTER 曾成功 | 两个 owner 字段都存在 |
| HTTP 200 | 当前代码判定缺失表为零且 errors 为空 | 生产数据库可安全承载全部业务请求 |

## 三、安全的一键数据库升级应采用四阶段

### 阶段 A：只读识别（默认）

后台数据库页面首先显示：
1. Worker 版本与构建标识；
2. 当前环境标识（测试/正式/未确认）；
3. D1 binding 名称与数据库身份指纹（不显示凭证）；
4. schema 当前版本与迁移账本状态；
5. 必需表、字段、索引、约束的核验结果；
6. 未知结构、缺失结构、额外结构和兼容性风险。

环境或数据库身份无法确认时，停止后续操作。

### 阶段 B：生成升级计划（dry-run）

只读生成计划，不执行 DDL：
- migration_id、checksum、依赖关系；
- 每项变更的旧结构与目标结构；
- 新增字段的默认值和历史数据影响；
- 索引建立成本和潜在锁/耗时风险；
- 是否依赖某张基础表；
- 是否存在同名但定义不兼容的对象；
- 回滚能力与不能直接回滚的原因。

若基础表缺失、结构未知、checksum 不一致或依赖不满足，计划标为 blocked，不允许执行。

### 阶段 C：经确认执行

只有通过阶段 A/B 且由有权限的超管明确确认后才可执行：
- 逐个 migration 执行；
- 每个迁移使用稳定 ID 和 checksum；
- 记录 started / applied / failed / verified 状态；
- 对 D1 batch 能保证的操作使用 batch；不能保证原子性的多步骤操作必须拆成独立迁移；
- 不吞掉任何 DDL 错误；
- 执行中断后先读取账本与实际 schema，再决定安全续跑步骤；
- 不允许因为重试而重复回填、重复授权或覆盖业务数据。

### 阶段 D：执行后独立复核

重新读取实际 schema，与目标 manifest 对照：
- 表名、列名、类型；
- NOT NULL、默认值、主键；
- UNIQUE、索引、外键；
- 迁移账本 checksum；
- 关键业务表的行数/数据抽样仅在明确授权的脱敏范围内进行。

只有结构复核和迁移账本均通过，才能显示“升级完成”。若 DDL 已部分成功但复核未通过，显示“部分变更/需人工处理”，绝不显示 ready。

## 四、诊断与错误处理约束

数据库升级和诊断日志必须区分：
- 环境识别失败；
- D1 binding 不存在；
- 迁移依赖缺失；
- schema 不兼容；
- DDL 执行失败；
- migration checksum 冲突；
- 迁移账本写入失败；
- 迁移后 schema 复核失败；
- 审计记录失败。

错误日志只记录 migration_id、表/字段名称、错误编号、执行阶段和脱敏错误摘要。不得记录订阅 URL、节点 URI、卡密、Token、密钥或用户敏感数据。

诊断开关默认关闭；开启时限时生效并自动关闭。诊断开关不得改变业务授权结果。

## 五、迁移账本设计草案（仅设计，不是建表 SQL）

建议逻辑字段：
- migration_id：稳定且唯一的迁移编号；
- checksum：迁移内容摘要；
- depends_on：依赖迁移；
- status：pending / started / applied / failed / verified；
- started_at、finished_at；
- actor_user_id；
- worker_build；
- result_summary；
- verify_checksum / verify_result；
- error_code。

迁移账本表的最终名称、字段和索引，必须先与真实 D1 schema 核对，再进入独立迁移审批。不得直接照此文档创建表。

## 六、与用户要求的手机端流程对应

最终正式版目标操作流程：
1. 用户上传本批 STABLE Worker 与 HTML；
2. 登录超管后台；
3. 打开“系统维护 → 数据库”；
4. 页面自动进行只读结构检查；
5. 显示待升级项目和风险；
6. 用户确认后执行已批准迁移；
7. 自动进行迁移后复核；
8. 显示成功/失败与迁移历史；
9. 出错时在“系统诊断”开启对应模块日志，按错误编号定位。

正式版还必须提供一套与当前版本匹配的回滚包和手机端操作说明。不能要求用户自己拼接 SQL。

## 七、实施前置条件与禁止事项

仍缺少：
- 真实正式 Worker 部署版本与仓库候选版本的对应证据；
- 真实正式 D1 binding 与数据库身份；
- 正式 D1 完整只读 schema 导出；
- 现有历史迁移执行记录；
- 可读取且经过恢复验证的备份证据；
- APK ZIP 二进制源码审计结果。

因此当前不应编写或执行正式 D1 migration SQL，也不应把 Batch 1 的 `/api/super/migrate` 暴露给用户作为安全的一键升级工具。

## 八、部署声明

- 本批只新增复核与流程设计文档。
- 未修改 Worker、HTML、D1、Secrets、Cron 或 Cloudflare 配置。
- 未执行任何 SQL、迁移、API 写操作或生产部署。
- 本报告是 `V2.5-DEV-B1-REVIEW-08`，不属于 RC/STABLE，不要求用户上传。
