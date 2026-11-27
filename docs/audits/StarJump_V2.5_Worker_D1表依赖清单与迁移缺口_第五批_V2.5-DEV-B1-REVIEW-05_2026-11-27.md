# 星跃管理平台 V2.5 DEV：Worker D1 表依赖清单与迁移缺口（第五批）

- 版本标识：`V2.5-DEV-B1-REVIEW-05`
- 日期：2026-11-27
- 阶段：DEV 静态 SQL 依赖盘点
- 对象：`releases/v2.5-batch1/Worker.js`
- Worker blob：`5a2739d981e1835e692a04b903052f268fed981a`
- 前置复核：`V2.5-DEV-B1-REVIEW-04`

> 这是对 Worker 源码中 SQL 语句的静态扫描，不等于完整 SQL AST 分析，也不代表生产 D1 当前真实存在这些表。没有执行 SQL、没有读取生产 D1。

## 一、扫描结论

从 Worker 中可识别出约 40 个业务表/系统表引用（排除 SQL 别名和 SQLite 内部目录表）。其中：
- 18 张表由现有 `MIGRATE_STATEMENTS` 创建；
- 其余 22 张表由业务代码依赖，但没有出现在该迁移清单的 CREATE TABLE 中；
- 其中 `node_sync_logs` 仅有若干 ALTER TABLE 尝试，仍没有 CREATE TABLE；
- `admin_audit`、`admin_audit_events` 是两套不同的审计表，代码均有引用，迁移清单没有创建它们。

这说明当前“一键迁移”不是完整的空库初始化器。它默认基础业务表已经存在，只补建部分功能表和索引。若绑定到一个缺少基础表的 D1，接口可能在业务运行时出现 “no such table” 错误。

## 二、由当前迁移清单创建的 18 张表

1. `convert_links`
2. `admin_vip_cards`
3. `admin_vip_activations`
4. `app_cards`
5. `node_lifecycle`
6. `app_entitlements`
7. `rate_limits`
8. `app_links`
9. `app_groups`
10. `app_group_sources`
11. `app_group_members`
12. `app_free_grants`
13. `admin_share_codes`
14. `download_links`
15. `app_card_events`
16. `releases`
17. `announcements`
18. `admin_app_perms`

迁移清单还包含若干索引创建语句。注意：CREATE TABLE IF NOT EXISTS 只保证同名表不存在时创建，不会修复已存在但字段不完整或类型不匹配的表。

## 三、Worker 依赖、但迁移清单未创建的基础表

| 表名 | 代码用途（按 SQL 调用位置概括） | 当前迁移状态 |
|---|---|---|
| `app_users` | 用户身份、角色、账号状态 | 未创建/未核验 |
| `user_sessions` | 登录会话与 Token 哈希 | 未创建/未核验 |
| `admin_user_scopes` | 超管协助用户授权范围 | 未创建/未核验 |
| `subscription_sources` | 订阅来源主表 | 未创建/未核验 |
| `source_ownership` | 来源与用户归属 | 未创建/未核验 |
| `source_approvals` | 来源审核状态 | 未创建/未核验 |
| `subscription_sync_state` | 来源同步状态 | 未创建/未核验 |
| `sync_tasks` | 同步任务与状态 | 未创建/未核验 |
| `sync_task_stage` | 同步暂存节点 | 未创建/未核验 |
| `sync_task_manifests` | 同步任务清单/摘要 | 未创建/未核验 |
| `node_records` | 节点主记录 | 未创建/未核验 |
| `node_sync_logs` | 节点同步日志 | 未创建；仅尝试 ALTER |
| `node_groups` | 节点分组 | 未创建/未核验 |
| `node_group_members` | 节点分组成员 | 未创建/未核验 |
| `node_overrides` | 节点覆盖字段 | 未创建/未核验 |
| `node_user_metadata` | 用户节点元数据 | 未创建/未核验 |
| `node_identity_aliases` | 节点身份别名 | 未创建/未核验 |
| `user_manual_nodes` | 用户手动节点 | 未创建/未核验 |
| `source_quota` | 来源额度/流量统计 | 未创建/未核验 |
| `app_settings` | 旧后台设置 | 未创建/未核验 |
| `admin_audit` | 旧版审计记录 | 未创建/未核验 |
| `admin_audit_events` | 结构化审计记录 | 未创建/未核验 |

以上 22 张表不是建议现在全部新建。它们可能来自原系统的既有基础 schema；必须先读取目标 D1 的真实结构，再决定兼容、补列或新增迁移。尤其不能对已有表盲目 CREATE、DROP 或重建。

## 四、当前迁移接口的具体缺口

1. `REQUIRED_TABLES` 只核验迁移清单内的 18 张表，没有核验上述基础表。
2. schema-status 只查 `sqlite_master` 的表名，不核验列、索引、约束、外键。
3. `node_sync_logs` 的 trigger_kind、duration_ms、missing_nodes 三个字段采用 try/catch ALTER；失败被忽略，且该表不在 REQUIRED_TABLES。
4. `convert_links` 的 owner_user_id、owner_key 采用逐个 ALTER；失败被收集，但迁移整体没有事务回滚。
5. `admin_app_perms.free_group_enabled` 的 ALTER 失败被忽略。
6. 不存在迁移 ID、checksum、依赖图、迁移账本和“已执行版本”判定。
7. 表结构检查与迁移执行没有严格分离成只读计划、执行、执行后验证三个阶段。

## 五、后续实施要求（不在本报告中执行）

- 先把 22 张基础表逐一归类为“原始基线必需表 / 可选模块表 / 历史兼容表”，并取得目标 D1 的只读结构证据。
- 形成字段级 schema manifest：列名、类型、NOT NULL、默认值、主键、索引、唯一约束、外键。
- 迁移框架只采用可审计的增量迁移；每个 migration 具备稳定 ID、checksum、依赖、执行状态、时间、操作者和验证结果。
- 缺少基础表时必须停止并给出明确诊断，不得把基础表当成普通新表随意补建。
- 对现存数据表的任何 ALTER 前，先检查现有字段和数据兼容性；不执行 DROP、TRUNCATE 或重建表。
- 数据库页面应先显示目标 D1 身份、schema 版本、缺失项和影响，再由超管明确确认执行。

## 六、部署声明

- 本批仅增加静态依赖盘点文档，没有修改 Worker、HTML 或 D1。
- 没有执行 SQL、没有访问生产 D1、没有部署。
- 本文为 DEV 审计记录，不是迁移脚本，不要求用户上传 Cloudflare。
