# 星跃管理平台 V2.5｜APP 卡密分组候选表只读诊断扩展与 DDL 单一来源收敛报告（第九十一批）

- 批次：`V2.5-DEV-B1-APP-CARD-GROUP-91`
- 日期：2026-11-28
- 基线分支：`release/v2.5.0-rc1-converge`
- 代码/测试最终验证 HEAD：`a7a533342fed93cb9a03685fa449639bb6626e4b`
- PR：#2，Draft / Open / Unmerged
- 状态：**已修改候选代码与测试 / CI 通过 / 未部署 / 未连接 D1**

## 1. 本批变更

### 1.1 Batch71 APP schema diagnostic 扩展

修改 `backend/worker/V2.5-DEV-B1-CORE-AUTH-49/Worker.js`：

- 在固定白名单增加：
  - `app_card_group_mappings`
  - `app_card_group_admin_requests`
- `/api/super/schema-status` 的表名发现集合也纳入这两张候选表，否则只扩展 PRAGMA 白名单仍会因为表名未进入现有集合而始终报告缺失。
- 两张表若存在，沿用既有只读元数据采集：columns、indexes/index columns、foreign keys、trigger/view object names。
- 若不存在，明确报告 `MISSING`；不创建表、不自动修复、不推断兼容性。
- `baseline_comparison=NOT_CONFIGURED`、`compatibility_verdict=NOT_EVALUATED` 保持不变。
- schema object 查询仍通过绑定参数限定固定表名；PRAGMA 标识符仍经双引号转义。

### 1.2 回归测试

修改 `worker-handler.integration.test.mjs`：

- 断言 APP schema diagnostic 覆盖 9 张表。
- 明确断言两张候选表进入 table_info 与 trigger/view 元数据检查范围。
- 断言诊断不查询 `response_json` 或 `payload_sha256`，不读取请求幂等业务内容。
- 保留非超管 403、metadata failure => `PARTIAL_NOT_VERIFIED`、无业务写入的原有断言。

### 1.3 候选 DDL 单一来源

- 第九十一批后续收敛补充：SQLite mapping test 现在先安装唯一 canonical fixture，再插入 seed rows；不再先建临时 parent tables 造成 fixture 的 app_cards/app_groups 定义被测试库静默遮蔽。

权威候选 fixture 统一为：

`backend/worker/V2.5-DEV-B1-APP-PROTOCOL-66/fixtures/card-group-admin-candidate-schema.sql`

- 加入明确注释：这是隔离候选 fixture，不是生产 migration，不得对 D1 执行。
- 使用 `IF NOT EXISTS`，以便被隔离 SQLite 测试重复加载。
- 映射状态统一为 `active/removed`，默认 `active`；并以 CHECK 保证 active 时 removed_at 为空、removed 时 removed_at 非空。
- 索引、trigger 定义集中在该 fixture。
- `test_app_card_group_mapping_candidate.py` 删除内联 DDL，改为读取上述唯一 fixture。
- `test_app_card_group_admin_sql_candidate.py` 继续读取同一 fixture，并在插入 removed 历史记录时提供 removed_at，遵守统一状态约束。
- 两套测试不再维护各自独立的 mapping 表/trigger DDL。

## 2. CI 验证

最终验证：
- PR Convergence Run：46128266379 — **SUCCESS**
  https://github.com/sxna-web/XYmonihtml/actions/runs/46128266379
- Job：140927616343 — SUCCESS
- 同一 HEAD 的其他关联运行：46128109834、46128105285 — SUCCESS。
- Batch49 authorization adapter：12/12。
- Batch49 Worker handler integration：62/62。
- 本地隔离 SQLite migration/database tests：62/62。
- APP v2 composition/read/service：Protocol60 19/19、Protocol64 23/23、Protocol65 26/26。
- Protocol66 handler/service：21/21；SQL plan：8/8；fake-D1 adapter：14/14。
- Worker bundle、Cron/static regression、candidate artifact upload 均通过。
- Artifact：`StarJump-V2.5.0-RC1-candidate`，ID `15256174306`，134,218 bytes，SHA-256 `749803b6b820790fafc0d6979544cd476d153edcab229d223af497f1caf24879`，expires `2026-12-12T08:58:40Z`。

### 测试过程中的真实失败与修正

- 第一轮 CI 发现 canonical fixture 的 status 没有默认值，旧 inline test 却默认依赖 active；修正 canonical fixture 为 `DEFAULT 'active'`。
- 后续 CI 发现另一个 SQLite candidate test 插入 removed 记录时没有设置 removed_at；修正测试 helper 以符合统一 CHECK 约束。
- 后续 CI 发现新 JS 测试对双引号的字符串转义写错，导致语法错误；改为不依赖引号转义的 SQL 前缀/表名断言。
- 最终 Run 46128109819 全部通过。没有删减失败测试，也没有将失败结果伪报为通过。

## 3. 本批边界与未完成事项

- CI 使用 mock D1、隔离 SQLite fixture 和本地测试；不证明 Cloudflare D1 真实绑定、真实 schema、batch rollback/trigger 行为。
- 未连接 staging/production D1，未读取业务行，未执行 DDL/DML，未访问 Secrets。
- 未注册 Protocol66 正式 Worker route；旧 APP route 仍在。
- 未生成生产 migration；canonical fixture 只用于候选结构测试。
- 未完成真实 staging schema manifest 对比、旧 group mode 兼容决策、HTML 管理 UI 的真实 D1 联调、APP 多卡密聚合及 APK 多凭据联调。
- PR #2 不可合并或部署。

## 4. 回滚与下一批

本批修改只涉及 Worker schema diagnostic 白名单/只读观察、测试、候选 fixture 和文档；无数据库写入。若需回滚，按本批 commit 历史回退上述文件即可，不得以 DDL/DML 方式回滚。

**第九十二批唯一接手卡：**
1. 以最新 PR HEAD 为准，复核本批代码、测试和 CI；
2. 核对 staging schema-only snapshot 的可获取方式与用户授权边界；
3. 若仍无真实 snapshot，继续完善 manifest 对比输入校验/字段脱敏，不猜字段、不做生产 migration；
4. 继续保持 Protocol66 不接正式路由，直至真实 schema、mode 兼容和真实 D1 adapter 证据齐备。

---
**结论：**第九十一批已把两张 Protocol66 候选表纳入 Batch71 只读 schema diagnostic，并把 SQLite 候选 DDL 收敛到单一 fixture。最终 CI 全通过；这不是生产 D1 schema 兼容证明，也不是可部署上线版本。
