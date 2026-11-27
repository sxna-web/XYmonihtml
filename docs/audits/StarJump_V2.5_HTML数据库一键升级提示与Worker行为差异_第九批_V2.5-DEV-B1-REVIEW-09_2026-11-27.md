# 星跃管理平台 V2.5 DEV：HTML 数据库一键升级提示与 Worker 实际行为差异（第九批）

- 版本标识：`V2.5-DEV-B1-REVIEW-09`
- 日期：2026-11-27
- 阶段：DEV 静态前后端联查
- HTML：`releases/v2.5-batch1/index.html`
- HTML blob：`a04636d2b9aed0f262c4e520147e9838b21c8556`
- Worker：`releases/v2.5-batch1/Worker.js`
- Worker blob：`5a2739d981e1835e692a04b903052f268fed981a`
- 关联报告：`V2.5-DEV-B1-REVIEW-08`

> 只读静态联查，没有点击后台按钮，没有发起 schema-status/migrate API 请求，没有执行 SQL 或部署。

## 一、确认的前后端行为差异

HTML 数据库升级按钮位于源码约 2144-2154 行：

1. 先请求 `GET /api/super/schema-status`；
2. 如果 `st.data.ready` 为 true，直接弹出“数据表已齐全，无需操作。”并退出；
3. 如果 false，则弹窗提示缺少多少张表，并称“现在自动创建？（只新增，不改动已有数据）”；
4. 用户确认后调用 `POST /api/super/migrate`；
5. 只根据 `r.data.ready` 决定显示“完成”或“仍有缺失”。

结合 Worker 实际实现，确认以下问题。

### UI-DB-09-01：表名齐全就提前退出，无法检查字段缺失

Worker 的 `schema-status.ready` 只代表 18 张 REQUIRED_TABLES 表名存在。HTML 将它解释为“数据表已齐全”，直接终止流程。

所以当 18 张表都存在、但 `convert_links.owner_key` 或 `admin_app_perms.free_group_enabled` 等字段缺失时，用户无法从这个按钮得到完整结构诊断。

更重要的是，22 张基础业务表和 `node_sync_logs` 并未纳入 REQUIRED_TABLES 字段级检查。

### UI-DB-09-02：“只新增，不改动已有数据”提示不准确

Worker 的迁移语句不仅包含 CREATE TABLE/INDEX，还会执行：
- `ALTER TABLE convert_links ADD COLUMN owner_user_id`
- `ALTER TABLE convert_links ADD COLUMN owner_key`
- `ALTER TABLE node_sync_logs ADD COLUMN trigger_kind`
- `ALTER TABLE node_sync_logs ADD COLUMN duration_ms`
- `ALTER TABLE node_sync_logs ADD COLUMN missing_nodes`
- `ALTER TABLE admin_app_perms ADD COLUMN free_group_enabled`

因此实际操作不只是“新增不存在的表”，还会尝试修改已存在的业务表结构。即使这些 ALTER 只增加字段，也必须明确显示受影响表、字段、默认值、兼容性和回滚限制。

### UI-DB-09-03：HTML 的完成判断继承 Worker 的弱 ready

迁移后 HTML 只读取 `r.data.ready` 并显示“完成：新建 X 项，跳过 Y 项”。

但 Worker 的 ready 仍然只检查 18 张表名是否存在，不代表：
- ALTER 字段全部成功；
- 22 张基础表均存在；
- 字段定义、索引、约束正确；
- 审计记录成功；
- migration ledger 已写入；
- 迁移后 schema 复核通过。

所以当前页面可能在结构不完整时显示完成。

### UI-DB-09-04：前端没有展示逐项执行计划和危险范围

现有确认框仅列出缺少表名，不列出：
- 哪些 ALTER 会修改既有表；
- 哪些语句会失败或被静默忽略；
- 哪些基础表属于代码依赖但迁移清单没有创建；
- 迁移部分成功后如何恢复；
- 当前 D1 身份和环境。

这与手机端安全一键升级目标不符。

## 二、修复后的页面行为设计

数据库维护页应改成持续可查看的诊断页，而不是 ready 时退出：

### 只读检查区
- 当前环境和 Worker build；
- D1 binding/数据库身份核验结果；
- 18 张迁移表逐表状态；
- 22 张基础表逐表状态；
- 每张核心表字段、索引、约束检查；
- migration ledger 版本和 checksum；
- 未知/额外结构提示。

### 升级计划区
- 无变更：显示“当前 schema 与目标版本一致”，但仍保留检查结果；
- 有安全增量变更：逐项展示 migration ID、表/字段、默认值和影响；
- 依赖不满足：显示 blocked 和具体原因；
- 环境不明：禁用执行；
- 存在不兼容结构：要求人工复核，不自动覆盖。

### 执行与结果区
- 执行前显示明确的变更摘要和确认；
- 执行中逐项展示 started/applied/failed；
- 执行后重新读取 schema；
- 只有 ledger 与 schema manifest 均通过才显示“升级完成”；
- 部分执行或审计失败时显示“部分变更，需处理”，不能显示成功；
- 提供迁移历史、错误编号、诊断入口和对应版本回滚说明。

## 三、需要修改的最小范围

后续正式实施应限定在：
1. Worker：替换只看表名的 schema-status；拆分 dry-run 与 apply；补齐字段/索引核验；错误不可吞掉；增加 migration ledger 和执行后验证。
2. HTML：数据库页面改为持续显示 schema 检查；展示 dry-run 变更清单；不再用表名 ready 作为唯一完成标准；明确 ALTER 与潜在数据影响。
3. D1：仅在真实 schema 核对和用户批准后增加迁移账本及必要的兼容性增量字段。
4. 测试：覆盖完整结构、缺字段、缺基础表、错误类型、重复执行、部分失败、审计失败、错误环境、旧 Worker/新 schema 兼容等场景。

不得在本轮直接修改候选 Worker 或 HTML；必须先确认目标 D1 真实 schema 和完整部署基线。

## 四、状态声明

- 本批只增加 HTML-Worker 静态联查报告。
- 未修改 Worker、HTML、D1、Secrets、Cron 或 Cloudflare 配置。
- 未发起 API 请求、未执行 SQL、未部署。
- Batch 1 仍为 DEV 候选，不可作为正式数据库初始化工具。
