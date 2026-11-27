# 星跃管理平台 V2.5 DEV：同步任务、节点生命周期与审计依赖核查（第十批）

- 版本标识：`V2.5-DEV-B1-REVIEW-10`
- 日期：2026-11-27
- 阶段：DEV 静态源码对照
- 原始 Worker：`原始StarJump_V1点0_Final-zip-26-11-25-14:56/Worker.js`
- 原始 Worker blob：`5da7aa3582558d9da2c2a0ad25a63c5e95e9fe63`
- Batch 1 Worker：`releases/v2.5-batch1/Worker.js`
- Batch 1 Worker blob：`5a2739d981e1835e692a04b903052f268fed981a`
- 对照依据：V2.5 功能基线、数据库变更保护规范、第五批表依赖清单、第七批字段访问报告、第八/九批迁移核查。

> 本报告只做源码静态核查。没有访问 Cloudflare 生产 Worker/D1，没有运行同步或 Cron，没有执行 SQL、迁移或部署。下述结论不能代替真实 D1 schema 核验。

## 一、原始 Worker 与 Batch 1 的数据库兼容性结论

对照两个 Worker 的同步引擎、节点生命周期、同步日志查询和迁移数组后：

1. 两个版本均使用 `subscription_sync_state`、`sync_tasks`、`sync_task_stage`、`sync_task_manifests`。
2. 两个版本均写入和读取 `node_sync_logs`。
3. 两个版本均依赖 `node_lifecycle`。
4. Batch 1 迁移数组有 `node_lifecycle` 的 CREATE TABLE/INDEX。
5. Batch 1 迁移数组没有 `subscription_sync_state`、`sync_tasks`、`sync_task_stage`、`sync_task_manifests`、`node_sync_logs` 的 CREATE TABLE。
6. 原始 Worker 的对应迁移数组也没有上述五张表的 CREATE TABLE。

因此，Batch 1 没有补齐同步引擎核心表的建表迁移，也没有解决 `node_sync_logs` 缺建表 DDL 的问题。若正式 D1 依赖历史手工建表或旧版初始化脚本，必须先找到并核实那份真实结构，不能假设当前迁移能从空库完整启动。

## 二、发现一个节点生命周期判断逻辑错误（高优先级）

### SYNC-10-01：同步任务成功状态写入值与查询值不一致

同步提交函数 `commitTask()` 在成功提交时，将任务状态更新为：

`status='committed'`

但 `runNodeLifecycle()` 计算“最近三次成功同步”的时间阈值时，查询条件为：

`WHERE source_id = ? AND status = 'success'`

当前已检查的同步任务状态流转包括：
- 创建任务：`staging`
- 暂存完成：`staged`
- 提交成功：`committed`
- 失败：`failed`
- 被新一代任务取代：`abandoned`

成功路径写入的是 `committed`，生命周期查询却筛选 `success`。在这条成功写入路径下，查询可能始终取不到任何成功同步记录。

随后代码将 `threshold` 为空解释为 `present = true`。结果可能是：节点即使连续多次没有出现在新订阅数据中，也被当作仍存在，无法按预期进入失败计数、观察期和 stale 状态。

**影响：** 节点生命周期自动识别可能失效，陈旧节点可能长期保留。该问题同时存在于原始 Worker 和 Batch 1 Worker，属于共同继承的逻辑问题，不是 Batch 1 新增问题。

**修复原则：**
- 先确定唯一的同步任务终态枚举和含义；
- 统一写入端与查询端状态值；
- 对历史状态值做兼容映射，不能直接把历史任务标记批量改写；
- 当成功同步样本不足三次时，必须定义清楚“暂不判定”行为；
- 增加三次成功同步、缺席节点、失败任务、被取代任务、并发租约和历史状态兼容测试。

本报告不直接修改状态值，也不执行数据回填。

## 三、节点生命周期自动物理删除风险

当前生命周期逻辑先将节点标记为 `stale`，并在 `stale_at` 超过 30 天后执行：

- 删除 `node_records` 中对应节点；
- 删除 `node_lifecycle` 中对应生命周期记录。

代码注释一处称 stale“只标记，绝不删行”，但后续又实现 stale 满 30 天物理删除，注释与实际行为不一致。

**风险与边界：**
1. 这属于服务端节点记录清理，不是 APK 本地 24 小时清理。
2. 用户已确认的 APP 分组删除/改型规则是：Worker 撤销版本/墓碑 → APK 增量同步 → 本地清理 → cleanup acknowledgement；本地节点在 24 小时内清理。
3. 不能把 stale 30 天清理当成 APP 分组删除流程，也不能用它代替 APK acknowledgement。
4. 服务端物理删除可能影响历史转换、节点版本、审计关联或其他分组引用，必须先检查外键/引用/快照和恢复方案。
5. 在确认数据保留规则前，不应扩大该物理删除范围；正式修复需要将 stale 标记、归档、软删除和物理清理分成不同状态。

**实施建议：** 先暂停把 stale 30 天物理删除纳入任何新迁移或自动清理改造。是否保留现有行为，必须结合真实数据、现有备份和用户批准评估；本报告没有操作线上 Cron。

## 四、四组依赖的结构核查表

| 功能组 | 业务代码引用 | Batch 1 建表迁移 | 主要待核实项 |
|---|---|---|---|
| 同步租约 | subscription_sync_state | 未发现 | generation、lease owner/token hash、expiry、成功任务关联 |
| 同步任务 | sync_tasks | 未发现 | status 枚举、generation、计数、manifest、错误字段、时间字段 |
| 同步暂存 | sync_task_stage | 未发现 | task_id、seq、node_key、payload、唯一约束/索引、敏感 URI 保留时间 |
| 同步清单 | sync_task_manifests | 未发现 | task_id、node_count、stage_hash、canonicalization_version |
| 同步日志 | node_sync_logs | 未发现 | source、状态、节点数量、trigger_kind、duration_ms、missing_nodes、error_message |
| 节点生命周期 | node_lifecycle | 有 | 状态枚举、stale_at、索引、物理清理边界 |
| 新审计 | admin_audit_events | 未发现 | actor/effective、action、target、request、before/after、result、reason、detail |
| 旧审计 | admin_audit | 未发现 | action/detail 的历史用途、数据量、是否仍有业务依赖 |

“未发现”仅指本次检查的 Batch 1 `MIGRATE_STATEMENTS` 没有对应 CREATE TABLE，不表示真实正式 D1 中不存在这些表。

## 五、同步表的最低字段核验线索

以下仅从 SQL 读写路径提取，不是完整 DDL：

### 5.1 subscription_sync_state
- source_id
- generation
- lease_owner
- lease_token_hash
- lease_expires_at
- updated_at
- last_success_at
- last_manifest_hash
- last_task_id

### 5.2 sync_tasks
- id、source_id、generation
- lease_owner、lease_token_hash、actor_user_id、trigger_kind
- status
- staged_count、node_count、missing_count
- manifest_hash
- error_message
- created_at、updated_at、committed_at

注意：上述字段来自已见 SQL 访问线索，实际表可能有额外字段、不同类型或约束。

### 5.3 sync_task_stage
- task_id、seq、node_key、payload

payload 在同步暂存期间可能包含完整节点 URI。失败/提交路径会尝试清理暂存记录，但仍需核实异常中断、过期任务清理和保留策略。

### 5.4 sync_task_manifests
- task_id、node_count、stage_hash、canonicalization_version

### 5.5 node_sync_logs
- source_id、source_name、status
- total_nodes、added_nodes、updated_nodes
- error_message
- trigger_kind、duration_ms、missing_nodes
- created_at
- 查询还引用 id

`node_sync_logs` 的三个新增字段在迁移路由中以空 catch 执行 ALTER，且没有 CREATE TABLE；查询路由又直接读取这些字段。必须在迁移前检查完整字段定义。

### 5.6 admin_audit_events / admin_audit
新旧两套审计表都在 Worker 中被引用：
- `admin_audit_events` 用于结构化 actor/effective/action/target/request/before/after/result/reason/detail；
- `admin_audit` 仍用于部分旧式 action/detail 记录。

不能仅凭新表存在就删除旧表。需要盘点历史审计读取页面、写入路由、保留期限、迁移映射与审计连续性。

## 六、对 V2.5 业务规则的影响

1. 节点同步历史必须可追踪，不能因修复同步状态而覆盖历史任务。
2. 节点 stale 不能直接等同于用户删除分组或撤销 APP 授权。
3. APP 分组删除/改型必须走 generation/tombstone/增量同步/cleanup acknowledgement 独立链路。
4. 节点版本、操作者、时间和差异必须保留；回滚通过创建新版本完成。
5. 敏感 URI 不得进入普通日志、审计 detail 或公开报告。
6. 旧审计和新审计需要有兼容策略，审计失败不能静默伪装成成功。
7. 所有结构变更先对照真实 D1；不得根据本报告字段线索直接 CREATE/ALTER。

## 七、建议的后续实施顺序

1. 获取正式 D1 的只读 schema：sqlite_master、PRAGMA table_info、index_list、foreign_key_list。
2. 对五张同步核心表与 node_sync_logs 逐表核实字段、索引、约束和实际数据量。
3. 明确 sync_tasks 的状态机，并修复 `committed` 与 `success` 不一致的逻辑，补充历史状态兼容测试。
4. 盘点 stale 节点的历史删除行为和外部引用，先定义软删除/归档/物理清理政策。
5. 将 APP 24 小时本地清理协议独立实现并测试，不能依赖 stale 30 天 Cron。
6. 盘点双审计表并定义保留/兼容方案。
7. 再生成 migration manifest、dry-run、回滚与测试计划。

## 八、状态声明

- 本批只新增静态源码对照审计报告。
- 未修改 Worker、HTML、D1、Secrets、Cron 或 Cloudflare 配置。
- 未调用生产 API，未执行 SQL、迁移或部署。
- Batch 1 仍是 DEV 候选，不可上传作为正式版本。
