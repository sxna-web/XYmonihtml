# 星跃管理平台 V2.5｜APP v2 身份原子操作 D1 隔离验证准入包报告（第七十六批）

- 批次：`V2.5-DEV-B1-APP-IDENTITY-76`
- 日期：2026-11-27
- 状态：D1 隔离验证方案与机器可读矩阵完成；仅离线结构校验；D1_NOT_TESTED / APP_PENDING / NOT_DEPLOYABLE。

## 1. 本批目的

将第七十至七十五批的 D1 adapter、原子审计、operation receipt、限流契约，整理成未来经用户批准后可在专用 disposable D1 执行的验证准入包。当前没有获批数据库标识或 binding，因此本批不连接 Cloudflare，不查询或写入任何 D1。

## 2. 新增内容

- `backend/worker/V2.5-DEV-B1-APP-IDENTITY-76/D1-ISOLATED-VALIDATION-PLAN.md`
- `backend/worker/V2.5-DEV-B1-APP-IDENTITY-76/d1_validation_matrix.json`
- `backend/worker/V2.5-DEV-B1-APP-IDENTITY-76/validate_d1_validation_matrix.py`
- `.github/workflows/worker-app-identity76-matrix.yml`
- 本批报告与 README。

矩阵 26 项，覆盖数据库/binding 身份、CHECK、scalar EXISTS、prepared binding、batch 顺序和回滚、零行语句、RETURNING/meta.changes、唯一冲突、owner scope、create/revoke/rotation 竞争、commit 后响应丢失恢复、限流多维并发/重复 event_id/缺失维度/共享 NAT/时钟/窗口/Retry-After/cleanup race、查询计划成本和 HMAC key rotation。

## 3. Cloudflare 官方资料核对

本批核对官方文档：
- D1 Database API：`batch()` 使用 prepared statements，按顺序执行；批次语句错误会 abort/rollback；结果按输入顺序返回。
- D1 return objects：`success` 与 `meta.changes` 是不同字段，必须分别解释。
- D1 limits：单个 D1 database 是单线程处理请求，过载时可能返回错误；来自多个 Worker 请求的并发仍需验证排队、one-winner 和应用重试行为。
- Debug D1：Promise.race 仅限制等待，不取消写操作，写入可能仍提交。
- D1 Insights：可观察 rows read/written、query duration、错误和查询开销。

官方链接：
- https://developers.cloudflare.com/d1/worker-api/d1-database/
- https://developers.cloudflare.com/d1/worker-api/return-object/
- https://developers.cloudflare.com/d1/platform/limits/
- https://developers.cloudflare.com/d1/observability/debug-d1/
- https://developers.cloudflare.com/d1/observability/find-expensive-queries/

重要边界：D1 batch 的事务语义不代表成功但影响 0 行的语句自动失败；不得依赖 batch 后 JS 检查 changes 回滚。

## 4. 本批测试与证据

- 离线 validator 检查 26 个唯一 case ID、必需字段、允许的测试模式、审批门禁和安全边界。
- GitHub Actions 只执行离线 JSON 结构校验，不调用 Cloudflare，不运行 SQL。
- CI 通过只能证明矩阵结构完整，不能证明 D1 CHECK、scalar EXISTS、batch rollback、并发或限流行为。

## 5. D1 准入门槛

当前均未满足：
- 专用 disposable D1 名称/ID：未提供。
- Worker/service 和准确 binding：未提供。
- binding 与数据库 ID 对照：未核实。
- 环境隔离：未验证。
- 用户只读核查授权：未授予。
- disposable 写入/回滚授权：未授予。
- schema/migration baseline：未采集。
- fixture 重建与清理：未验证。

不得把 `starjump-staging` 当作默认 disposable 数据库；不得猜测 binding；不得访问生产。

## 6. 影响与回滚

仅新增版本化文档、JSON 矩阵、离线 Python 校验器和 CI workflow。未改 Worker、HTML、APK、Room、Secrets、Cloudflare 配置；未连接 D1、未执行 SQL、未建表/迁移、未部署。回滚可停止引用本批目录/Workflow 或回退本批提交，不影响业务数据。

## 7. 未解决事项

- D1 CHECK + scalar EXISTS + 同批次回滚需真实 disposable D1 验证。
- RETURNING 结果形状与 meta.changes 需核实。
- 多请求/多 Worker 请求竞争、限流 admission、队列和 overload 行为需核实。
- 限流阈值、窗口、时钟精度/偏差、保留期、共享 NAT 策略未确认。
- HMAC bucket key 轮换的 overlap 策略未定。
- 审计/receipt 保留期限未确认；禁止清理。
- share-code rotation 对现有 binding/session/challenge/free grant 的策略未确认。
- APP 源码和第三方授权审计仍未完成。

结论：D1 验证准入资料完成，D1 本身仍未测试，本批不可部署。
