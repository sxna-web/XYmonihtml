# 星跃管理平台 V2.5｜APP 卡密分组管理候选实现复核与只读诊断缺口报告

- 批次：第九十批
- 版本：V2.5-DEV-B1-APP-CARD-GROUP-90
- 日期：2026-11-28
- 分支：release/v2.5.0-rc1-converge
- 核验 HEAD：74c1e4132e5864dbc171d895cf2fd875870cd3d6
- 状态：PROTOCOL66_SOURCE_PRESENT / RC1_CI_PASS / CANDIDATE_SQL_ONLY / WORKER_ROUTE_NOT_REGISTERED / STAGING_SCHEMA_NOT_OBTAINED / NOT_DEPLOYABLE

## 1. 基线与第八十九批更正

- PR #2 当前为 Draft/Open/Unmerged；当前 head 为 74c1e4132e5864dbc171d895cf2fd875870cd3d6。
- 第八十九批核验的旧 head 为 cc81ab03...。本次在新 head 发现 Protocol66 文件已存在，因此“当前分支找不到 Protocol66 文件”仅是旧 head 的历史观察，不再适用于当前 head。
- PR 描述正文仍留有旧 head cc81ab03...，与 GitHub 当前 PR head 不一致；以 PR 元数据中的 head 为准。
- 本批只读复核；没有改主分支、没有部署、没有访问 D1 或 Secrets。

## 2. 当前分支已存在的 Protocol66 文件

- card-group-admin-handler.mjs
- card-group-admin-service.mjs
- card-group-admin-d1-adapter.mjs
- card-group-admin-sql-plan.mjs
- card-group-admin.test.mjs
- card-group-admin-sql-plan.test.mjs
- card-group-admin-d1-adapter.test.mjs
- CARD_GROUP_D1_ADAPTER_PLAN.md
- fixtures/card-group-admin-candidate-schema.sql

因此 Protocol66 不再是“只有概念”。当前已有 handler/service/候选 D1 adapter/SQL plan 和隔离测试；但文件自身注释明确：SQL plan 尚未被 Batch49 Worker 导入，候选 adapter 不是生产 Worker 接线，仍需 schema review。

## 3. 当前实现边界

### 3.1 管理端 handler/service

- GET/PUT /api/user/app-cards/:cardId/groups。
- handler 需要 service.get、service.replace 与 resolveSession(request)。
- session 字段需要 effectiveId、actorId、requestId、delegated scope，并从顶层或 session.scopeId 读取 scope ID。
- GET 对 delegated read/operate/manage 开放；PUT 对 delegated operate/manage 开放。
- service 只允许同管理员 mode='card' 且 enabled 的组；拒绝 free/其他管理员组；允许空数组清空映射；有效 used 卡密仍可配置；VIP 过期只读。
- replace adapter 契约要求最终 D1 batch 重验 VIP、卡密状态/有效期/手动禁用、卡密和分组 owner/mode、mapping CAS，并将 mapping 与 audit 同批提交。

### 3.2 与 Batch49 Worker 的接线适配

- Batch49 Worker 的真实入口是 resolveSession(req, env)；当前返回的 ctxWithReq 已包含 actorId、effectiveId、scope、requestId，scope ID 位于 ctxWithReq.session.scopeId。
- /api/user/* 路由 gate 已拒绝匿名和 legacy ADMIN_TOKEN，并执行通用 scope 与 authorizeAppManagementRequest 检查。
- 因此未来可在既有 /api/user/* gate 之后，把当前 ctxWithReq 作为 handler 的 session resolver 结果，不需要再次解析 token；但仍须核对 APP-specific authorization gate 是否对新路径使用正确的 VIP/体验期读写语义。
- 当前 Worker 没有 import/create/register createCardGroupAdminHandler，/api/user/app-cards/* 仍整体进入旧 userAppCardsRoute；新路径不会自动生效。
- 不应把 Batch49 私有 resolveSession 当成可直接 import 的模块；不要在 handler 中重复验证后台 session 或混用 APP entitlement token。

### 3.3 候选 D1 adapter / SQL

候选 SQL 使用：
- 已有历史表候选：app_cards、app_groups、admin_vip_activations、admin_audit_events；
- 尚未证实存在的新增表：app_card_group_mappings、app_card_group_admin_requests；
- 新增索引、唯一约束和触发器见 fixture。

候选写批次包含最终权限/owner/mode/卡密状态与 mapping CAS assertion、幂等请求插入、软解绑、映射 upsert、审计插入和最终读取。代码明确要求整批原子提交。

**测试边界：**
- Node adapter tests 使用 fake D1 API，不是 Cloudflare D1。
- Python SQLite tests 执行的是 candidate fixture，不是 staging/production schema。
- Fixture 与另一份 test_app_card_group_mapping_candidate.py 内联候选 DDL 并非同一个权威 migration 文件；存在两套相近但不完全一致的候选 schema 定义，必须合并成唯一候选来源后才可讨论 migration。
- 目前没有真实 D1 schema 证据证明候选表、列、索引、触发器和 audit columns 与目标数据库兼容。

## 4. CI 证据（本批复核已有 run，不重复运行）

RC1 Convergence PR Run 46127212215，Job 140924366885：SUCCESS，head 与本批核验 head 74c1e4132e5864dbc171d895cf2fd875870cd3d6 一致。

日志明确通过：
- Protocol66 handler/service：21/21
- Protocol66 SQL plan：8/8
- Protocol66 D1 adapter fake-D1 tests：14/14
- Protocol65 composed service/handler：26/26
- Protocol64 read handler：23/23
- 上述五组共 92/92。
- 本地隔离 SQLite migration verifier：62/62；其中包含 candidate schema/constraint tests。
- Worker bundle、Cron/static regression、Batch49 auth adapter、Batch49 Worker handler integration、candidate artifact upload 均通过。

这些结果证明当前 CI 指定的 Node 测试、SQLite fixture 与构建步骤通过；**不证明真实 Cloudflare D1、真实 schema、D1 batch rollback/trigger 行为、Worker 路由运行时或 APK 联调通过。**

## 5. 新发现的诊断缺口

Batch71 的只读 APP schema diagnostic whitelist 目前仍只含七张表：
app_cards、app_entitlements、app_groups、app_group_sources、app_group_members、app_free_grants、app_card_events。

它没有包含 Protocol66 新候选的：
- app_card_group_mappings
- app_card_group_admin_requests

所以即使 staging 数据库未来已经有这两张表，现有 /api/super/schema-status 的 APP metadata block 也不会输出它们的 columns/indexes/FKs/trigger-view metadata。不能把现有七表诊断当成 Protocol66 mapping schema 已核验。

## 6. 仍然阻断正式集成的事项

1. staging schema-only snapshot 未取得。
2. Protocol66 两张候选表/索引/约束/触发器未被真实 schema 证明。
3. 两套 candidate DDL 尚未收敛为唯一版本化候选 schema。
4. Worker 未注册 Protocol66 管理端 route；现有 userAppCardsRoute 仍接管路径。
5. Protocol65 composed route 与真实 entitlement/card/free group loaders 未注册。
6. APP card mode 与历史 public/assigned/free 的数据迁移和旧后台 CRUD 兼容仍未冻结。
7. APP 卡密序列号安全标签、APK 多凭据持久化/同步、tombstone/24h cleanup ACK 未端到端验证。

## 7. Staging schema-only 快照的安全采集范围

只允许用户明确指定的隔离 staging D1。导出结构元数据，不导出任何业务行、卡密 code、token、用户资料或订阅 URL。

至少覆盖九张表：
app_cards、app_entitlements、app_groups、app_group_sources、app_group_members、app_free_grants、app_card_events、app_card_group_mappings、app_card_group_admin_requests。

每张表需要：
- PRAGMA table_info(table)
- PRAGMA index_list(table) + 每个索引的 PRAGMA index_info(index)
- PRAGMA foreign_key_list(table)
- sqlite_master 中相关 table/index/trigger/view 的 SQL 定义 hash（敏感默认值只保留 hash，不回显原值）
- staging database 的非敏感环境标识与快照时间。

如果 candidate mapping/request 表不存在，应明确记录 MISSING，不创建、不补建。采集结果先进入 manifest compare；不得从 fixture 反推 staging 结构。

## 8. 本批结论与下一批唯一接手卡

- Protocol66 候选代码已存在且 CI 通过，较上批进展更靠前。
- 但它仍是候选 SQL/fixture adapter，不是已接入的生产 D1 实现。
- 本批没有修改 Worker/HTML/SQL/DDL/APK；未连接 D1、未访问 Secrets、未部署或合并。
- PR #2 保持 Draft/Open/Unmerged。

**第九十一批：**先将 Batch71 schema diagnostic 扩展为覆盖上述两张候选映射表的只读元数据输出，并加入回归测试；同时收敛两套 candidate DDL 的差异清单。该工作只扩展只读诊断，不创建表、不执行迁移、不接入生产 route。取得真实 staging schema 后再做字段/索引/FK/trigger manifest compare。
