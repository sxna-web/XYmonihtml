# 星跃管理平台 V2.5｜APP 数据库只读结构诊断 Worker 与后台接入实施报告（第七十一批）

> 批次：V2.5-DEV-B1-APP-SCHEMA-DIAG-71  
> 日期：2026-11-28  
> 状态：**已编码 / GitHub Actions 已测试 / 未部署 / 未连接生产 D1**  
> 分支：`release/v2.5.0-rc1-converge`  
> 测试 head：`3f4980a90ef4c81d45a63b2352b5effbf6d1ff20`  
> PR：#2 Draft/Open/Unmerged

## 1. 本批实施内容

### 1.1 Worker 只读结构诊断
修改：
`backend/worker/V2.5-DEV-B1-CORE-AUTH-49/Worker.js`

保留原 `/api/super/schema-status` 的 40 张表存在性检查与 `verification: TABLE_NAMES_ONLY` 字段，新增 `data.app_structure`，只针对以下 7 张 APP 关联表：
- `app_cards`
- `app_entitlements`
- `app_groups`
- `app_group_sources`
- `app_group_members`
- `app_free_grants`
- `app_card_events`

新增只读元数据采集：
- `PRAGMA table_info`：列名、类型、NOT NULL、默认值、主键顺序；
- `PRAGMA index_list` + `PRAGMA index_info`：索引名称、唯一性、来源、partial 标记及索引列顺序；
- `PRAGMA foreign_key_list`：外键来源/目标列及 update/delete action；
- `sqlite_master`：仅观察关联表的 trigger/view 对象名称和类型。

安全语义：
- 表名只来自固定白名单；PRAGMA 标识符统一转义。
- 路由沿用既有本人登录超级管理员校验；非超管、旧 ADMIN_TOKEN、协助会话均不得读取。
- 元数据查询采用只读查询；无业务表行读取、无 INSERT/UPDATE/DELETE、无 DDL。
- 结构数据状态为 `OBSERVED_SCHEMA_ONLY`，元数据查询异常为 `PARTIAL_NOT_VERIFIED`；不存在已批准的目标 schema manifest，故始终返回 `baseline_comparison: NOT_CONFIGURED` 与 `compatibility_verdict: NOT_EVALUATED`。
- 未将“结构观察到”误判为“生产兼容通过”。

### 1.2 HTML 诊断展示
修改：
`releases/v2.5.0-rc1/index.html`

后台数据库检查增加 7 张 APP 关联表的列数、索引数、外键数和逐表观察状态。页面明确提示未与批准基线比较，不构成兼容性通过；继续说明不读取业务数据/卡密/令牌/订阅内容，迁移暂不开放。

### 1.3 Worker 集成测试
修改：
`backend/worker/V2.5-DEV-B1-CORE-AUTH-49/worker-handler.integration.test.mjs`

新增 3 项：
1. 本人登录超管能读取 APP schema 元数据，返回只读观察状态，不产生 APP 业务写入；
2. 普通用户访问被 403 拒绝，且没有执行 PRAGMA 元数据读取；
3. 元数据读取失败显示 `PARTIAL_NOT_VERIFIED`，不得伪装为结构通过。

早期 CI 揭示了测试 mock 与 Worker D1 PreparedStatement 调用形态不一致，以及 SQLite master 匹配器转义错误；已修正 mock/断言，并以最终 CI 结果为准，未删减失败测试。

## 2. D1 SQL 能力依据

Cloudflare 官方 D1 SQL statements 文档列出兼容的元数据命令，包括 `PRAGMA table_info`、`table_xinfo`、`index_list`、`index_info`、`index_xinfo`、`foreign_key_list`、`foreign_key_check`，并允许查询 `sqlite_master` 查看表/索引定义。官方文档同时提醒 D1 PRAGMA 仅在当前事务内适用。

来源：
- https://developers.cloudflare.com/d1/sql-api/sql-statements/
- 官方文档更新时间：2026-04-21（本批查阅日期 2026-11-28）

本批实际 Worker 查询只使用上述文档列出的只读元数据语句；GitHub CI 运行的是 mock D1 Worker integration tests，不代表 Cloudflare D1 真实绑定已运行这些语句。

## 3. CI 验收证据

测试 head：`3f4980a90ef4c81d45a63b2352b5effbf6d1ff20`

- Push Run #? ID `46113685467`：SUCCESS  
  https://github.com/sxna-web/XYmonihtml/actions/runs/46113685467
- PR Run #? ID `46113689633`：SUCCESS  
  https://github.com/sxna-web/XYmonihtml/actions/runs/46113689633
- Batch 49 Worker handler integration：**62/62 passed**（本批新增 3 项）。
- Batch 49 authorization adapter：12/12 passed。
- APP v2 composition/read/service suites：19/19、23/23、26/26 passed。
- Isolated local SQLite migration verifier：workflow step passed；仅本地隔离 SQLite。
- Worker bundle、Cron/static regression、candidate artifact upload 均 passed。

Artifacts：
- Push run：`StarJump-V2.5.0-RC1-candidate`，ID `15250059466`，134,139 bytes，expires 2026-12-12T05:47:40Z。
- PR run：`StarJump-V2.5.0-RC1-candidate`，ID `15250507178`，134,139 bytes，expires 2026-12-12T05:47:45Z。

## 4. 未完成与边界

- 本批没有访问 Cloudflare D1，没有执行生产 schema 查询、数据查询或迁移。
- 没有用户提供的真实 D1 schema snapshot，因此没有基线比较和兼容性 PASS。
- 只详细观察 7 张 APP 关联表；其余 33 张表仍只有表存在性统计。
- 当前仍未实现卡密实例-分组映射表、管理端映射 API/UI、真实 D1 resolver/group loader、Protocol 65 正式 route 注册和 APK 多 entitlement 凭据保存/同步。
- 旧分组 mode `public/assigned/free` 与 Protocol 65 `card/free` 的兼容决策仍未解决。
- `POST /api/super/migrate` 继续返回 503 `MIGRATION_REVIEW_REQUIRED`。
- PR #2 保持 Draft/Open/Unmerged；未部署、不可作为正式上线包。

## 5. 回滚与下一步

回滚：本批仅 Worker/HTML 诊断功能。若真实 D1 上诊断语句运行出现异常，回退这三个文件到本批前版本即可；不会产生业务数据写入。不要通过删除表或执行 SQL 回滚。

第七十二批建议：
1. 检查真实 D1 schema snapshot 的安全获取方式；由用户确认目标环境后，只读导出 APP 7 表 schema metadata，禁止导出业务行；
2. 基于已批准 schema manifest 对实际元数据做字段/索引/外键/对象逐项比较；
3. 设计并测试 `app_card_group_mappings` 的隔离 migration fixture；
4. 解决旧 mode 兼容与映射保留策略；
5. 继续保持生产 D1 不写入、Worker 不部署、PR 不合并，直到 APK 兼容闭环与用户部署授权齐备。

---
**结论：** 第七十一批已完成 APP 关联表只读结构诊断的候选 Worker/HTML 实施，最终 push 与 PR CI 均通过。CI 证明当前 mock/integration 与构建检查通过，不证明真实 D1 运行时或生产 schema 兼容；本批未部署。
