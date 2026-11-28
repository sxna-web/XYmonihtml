# 星跃管理平台 V2.5｜Staging 只读 Schema 快照脱敏与 Manifest 接入报告

- 批次：`V2.5-DEV-B1-APP-SCHEMA-INTAKE-93`
- 日期：2026-11-28
- 代码/文档 HEAD：`c6a1138c931cdfdad33a57788928a2d5f8431f1e`
- PR #2：Draft / Open / Unmerged
- 性质：只读诊断输出脱敏、Manifest intake 适配、测试与操作说明；没有访问任何 D1。

## 1. 本批发现

Batch71 `GET /api/super/schema-status` 原先将 SQLite `PRAGMA table_info` 的 `dflt_value` 原文放进响应。它属于 schema metadata，但默认表达式可能包含不应直接回显的字面量。本批将该字段改为：
- `default_present`：是否存在默认表达式；
- `default_sha256`：默认表达式的 SHA-256；
- 不再输出 `default_value` 原文。

列名、类型、NOT NULL、PK 顺序仍保留；索引名称/唯一性/origin/partial/key columns、FK 元数据和 trigger/view 名称仍供结构观察。不会输出业务行、卡密、token、request payload JSON 或原始 SQL 定义。

## 2. Worker 回归

修改：
- `backend/worker/V2.5-DEV-B1-CORE-AUTH-49/Worker.js`
- `backend/worker/V2.5-DEV-B1-CORE-AUTH-49/worker-handler.integration.test.mjs`

新增/调整断言：构造带有 `DO_NOT_ECHO_SCHEMA_DEFAULT` 的 schema default，确认响应只含 64 位十六进制摘要、`default_present=true)，不存在 `default_value` 字段且不回显原始字面量。原有本人超管授权、只读、两张候选表覆盖、敏感 request 字段不读取、失败 fail-closed 测试保留。

## 3. Worker Diagnostic → Manifest 接入

修改：
- `tools/database_migrations/schema_manifest.py`
- `tools/database_migrations/tests/test_schema_manifest.py`

新增 `manifest_from_worker_diagnostic()` 与 CLI 子命令：

```bash
python tools/database_migrations/schema_manifest.py build-diagnostic --input staging-schema-status.json --environment staging --output staging.app-schema.manifest.json
```

该输入路径接受完整 Worker schema-status JSON 或直接 app_structure 对象，严格要求顶层 diagnostic 与 object metadata 均为 `OBSERVED`；任一表元数据 partial/unverified 即拒绝生成 manifest。缺表记为 `ABSENT`，不生成建表建议。

manifest 固定覆盖七张目标表：app_cards、app_groups、admin_vip_activations、admin_user_scopes、admin_audit_events、app_card_group_mappings、app_card_group_admin_requests。比较结构包括列、默认值存在性/摘要、索引元数据及键列、FK 动作、trigger/view 身份。

**已知比较边界：**Worker endpoint 有意不返回 index/trigger/view 原始 SQL，因此该 intake 的 manifest 明确标记 definition-level SQL digest unavailable；它不能检测同名 trigger/view SQL 内部逻辑变化，也不能替代完整 DDL 语义审核。不能把 MATCH 解释成 migration approval 或上线许可。

新增测试：
- sanitized Worker diagnostic 成功建 manifest；
- partial diagnostic 被拒绝；
- missing table 被记录为 ABSENT；
- 保留原有 manifest 16 项测试。

## 4. Staging 快照操作说明

已在 `tools/database_migrations/README.md` 新增 “Staging schema-only intake”：
1. 仅在已存在且明确绑定 staging D1 的 staging Worker 登录本人超管；
2. 请求 `GET /api/super/schema-status`，保存完整 JSON；
3. 核验 `data.app_structure.verification=OBSERVED_SCHEMA_ONLY` 和 `objects_verification=OBSERVED`；
4. 使用 `build-diagnostic` 生成 staging manifest；
5. 与 capture date、Worker version/commit 一起保管，不保存 Cookie、Authorization header 或 session token；
6. 仅在另一个环境也获得明确只读授权后才进行 manifest compare。

本批未创建 staging 环境、未修改任何 D1 binding、未发起 staging/production 请求，也没有真实快照文件。

## 5. CI 证据

- PR Convergence Run [46128809488](https://github.com/sxna-web/XYmonihtml/actions/runs/46128809488)：SUCCESS，head `c6a1138c931cdfdad33a57788928a2d5f8431f1e)。
- Job `140929243007`：SUCCESS。
- schema manifest suite：65/65。
- Worker schema diagnostic default redaction integration test：通过。
- 候选构建 artifact：`StarJump-V2.5.0-RC1-candidate`，ID `15256228219`，134,337 bytes。
- CI 仅证明代码、mock Worker 与隔离 SQLite 测试通过，不代表真实 staging/production D1 结构、D1 runtime 或迁移兼容性已验证。

## 6. 未完成 / 安全边界

- 没有 staging schema-only snapshot，真实表结构仍 NOT VERIFIED。
- 没有访问 staging 或 production D1，没有业务数据读取/写入，没有 DDL/DML。
- 没有访问 Secrets，没有 Worker/HTML 部署，没有 PR merge。
- Protocol66 管理 handler 仍未接入 Batch49 正式 Worker route。
- 多卡密 entitlement 聚合、免费组去重、卡密分组管理正式 UI/API、APK 同步联调仍未完成。

## 7. 回滚

本批 Worker 改动仅将默认表达式原文改为 presence + digest；工具新增独立 intake 函数和 CLI 子命令。若需回滚，按本批 commit 回退这三个代码/测试文件和 README 文档即可；不涉及数据库或生产数据。

## 8. 下一批接手卡

第九十四批：先以最新 PR HEAD 核验 CI 与代码，再复核 Batch49 的 APP authorization gate 与 Protocol66 handler 接线缺口；设计只在隔离环境可验证的 route adapter contract tests。没有真实 D1 schema 与授权前，不注册正式 route、不建 migration、不部署。
