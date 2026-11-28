# 星跃管理平台 V2.5｜APP 卡密分组只读 Schema 诊断覆盖与候选 DDL 单一来源复核报告

- 批次：`V2.5-DEV-B1-APP-CARD-GROUP-91`
- 日期：2026-11-28
- 核验基线：PR #2 head `db46684d5df68f70f16c4bd97793c993b6b1025b`
- PR 状态：Draft / Open / Unmerged
- 本批性质：当前分支代码与 CI 证据复核、进度记录更正；未新增 Worker 代码、未执行 DDL。

## 1. 核验结论

第九十批记录中的两项缺口，在本批核验的当前 HEAD 上已经由后续提交补齐。本批不重复修改：

1. Batch71 的 `APP_SCHEMA_DIAGNOSTIC_TABLES` 已包含九张 APP 诊断表，其中新增候选表：
   - `app_card_group_mappings`
   - `app_card_group_admin_requests`
2. Python 候选模型测试 `tools/database_migrations/tests/test_app_card_group_mapping_candidate.py` 已从 Protocol66 fixture 读取 `CANDIDATE_DDL`，不再维护第二份 mapping/request 表 DDL。当前唯一候选 DDL 来源为：
   `backend/worker/V2.5-DEV-B1-APP-PROTOCOL-66/fixtures/card-group-admin-candidate-schema.sql`

因此，第九十批“诊断白名单缺少两表”和“两份 DDL 不一致”的描述仅适用于其当时核验的旧 HEAD，不适用于本批核验的 `db46684d`。不得将本批结果倒推为真实 D1 schema 已存在这些表。

## 2. 只读诊断范围核验

文件：`backend/worker/V2.5-DEV-B1-CORE-AUTH-49/Worker.js`

当前诊断覆盖：
- 表存在性（通过 sqlite_master 表名查询）
- 每表列元数据（PRAGMA table_info）
- 索引列表（PRAGMA index_list）
- 外键列表（PRAGMA foreign_key_list）
- 关联 trigger/view 元数据（sqlite_master 中按九张表筛选）

诊断明确维持：
- 不创建表、不执行 migration、不执行业务 DML。
- `baseline_comparison = NOT_CONFIGURED`
- `compatibility_verdict = NOT_EVALUATED`
- 缺表输出 MISSING；元数据读取失败输出 PARTIAL_NOT_VERIFIED，不升级为通过。
- 诊断路由仅允许本人登录的超级管理员 Session，拒绝 legacy ADMIN_TOKEN、非超管和协助会话。

## 3. 回归测试核验

文件：`backend/worker/V2.5-DEV-B1-CORE-AUTH-49/worker-handler.integration.test.mjs`

现有测试已断言：
- schema-status 返回九张 APP 诊断表；
- 两张候选表均出现在 metadata 输出；
- 对两张候选表执行 table_info；
- trigger/view 查询包含两张候选表；
- 不读取 request 表中的 `response_json`、`payload_sha256`；
- 不回显卡密兑换码字段；
- 诊断过程没有业务写入；
- 非本人超管会话在 metadata 读取前被拒绝；
- 元数据读取失败保持 PARTIAL_NOT_VERIFIED。

候选 DDL 测试文件当前从唯一 fixture 读取定义，并覆盖同管理员 card/group 允许、跨管理员/非 card mode 拒绝、重复映射、软删除恢复、owner 转移保护、父表删除限制、fixture 幂等和不复制兑换码等情形。

## 4. CI 证据

- Workflow：V2.5 RC1 Convergence Checks
- Run：`46128109819`
- Job：`140927113393`
- 结果：SUCCESS
- 对应核验 HEAD：`db46684d5df68f70f16c4bd97793c993b6b1025b`
- 日志确认 database_migrations 离线测试 62/62 通过；候选 mapping 测试 11 项通过；候选 SQL 测试 10 项通过；schema diagnostics 的超管授权、两张候选表元数据覆盖、敏感字段不回显和失败 fail-closed 测试通过；候选 artifact 上传成功（Artifact ID `15256596749`）。

上述 CI 是仓库自动化测试与隔离 fixture 证据，不是 Cloudflare D1 实际 schema、真实 D1 batch/trigger 行为或生产兼容性证明。

## 5. 当前仍未完成 / 不得越界

- 没有取得 staging 或 production D1 schema-only snapshot。
- 没有证明真实 D1 中存在两张候选表，也没有确认其真实列、索引、FK、trigger 与候选 fixture 一致。
- Protocol66 handler/service/D1 adapter 仍未注册 Batch49 Worker 正式路由；旧 APP 路由仍在。
- 没有创建或执行生产 migration；没有连接 D1、读写生产数据、访问 Secrets、部署或合并。
- APP 多卡密 entitlement 聚合、免费分组去重、卡密分组正式管理 UI、APK 多凭据同步联调仍是上线阻断项。

## 6. 本批结论与接手卡

本批两项指定任务在当前分支均已有代码与回归覆盖，因此选择不做无意义重复改动，仅补齐本批报告与唯一进度记录。

下一批应转向：整理用户可执行的 staging schema-only 导出接收/核验流程；收到真实脱敏快照后，才运行现有 Schema Manifest 工具，对两张候选表及其列、索引、FK、trigger/view 做 staging manifest compare。没有快照不得猜测生产字段或生成迁移。

PR #2 必须继续保持 Draft / Open / Unmerged。不得合并或部署。
