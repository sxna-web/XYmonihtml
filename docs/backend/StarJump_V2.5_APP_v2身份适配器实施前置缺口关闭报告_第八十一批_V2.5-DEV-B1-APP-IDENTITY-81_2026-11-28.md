# 星跃管理平台 V2.5｜APP v2 身份适配器实施前置缺口关闭报告（第八十一批）

- 批次：`V2.5-DEV-B1-APP-IDENTITY-81`
- 日期：2026-11-28
- 状态：`READINESS_REVIEW_COMPLETE / BUSINESS_FREEZE_BLOCKED / D1_NOT_TESTED / APK_CALLER_AUDIT_INCOMPLETE / NOT_DEPLOYABLE`
- 仓库：`sxna-web/XYmonihtml`，分支 `main`

## 一、本批范围

按第八十批唯一接手卡，继续完成 APP v2 identity adapter 的实施前置核查。仅检查仓库历史 Worker/HTML 源码和已提交协议文件，形成逐方法 statement assertion 矩阵、隔离 D1 harness 审查稿、HMAC overlap 架构比较和 legacy caller 兼容性盘点。

未把技术提案提升为用户确认的业务规则；U80-01..08 在本轮可见项目记录中仍未获得新决定，相关操作保持阻断。

## 二、源码核查结果

### 2.1 Worker / HTML 已确认调用点

历史 Worker 基线 SHA：
- Worker：`5da7aa3582558d9da2c2a0ad25a63c5e95e9fe63`
- HTML：`ab98aecd4c8546eda197bbb4d5a9f5ec0db82613`

Worker dispatch / helper references include:
- `GET /api/app/resolve`
- `GET /api/app/groups`
- `GET /api/app/free`
- `GET /api/app/links`
- `POST /api/app/redeem`
- `GET /api/app/status`
- `GET /api/app/nodes`
- `GET /api/user/share-code`
- `GET /api/super/admins/:id/share-code`

HTML callsites:
- `loadUserPanel()` calls `/api/user/share-code`, displays `data.code`, copies it and creates QR from `data.bind_url`.
- `loadShareCode()` calls `/api/super/admins/{admin}/share-code`, displays code and stores bind URL.

Legacy Worker source shows `admin_share_codes` bootstrap with admin ID/code/created timestamp and `app_free_grants(device_id, admin_user_id)`. It does not show v2 code version/revocation columns or identity binding/challenge/nonce tables in that bootstrap DDL. This is historical source evidence only, not live D1 schema evidence.

### 2.2 APP v2 / APK boundary

Batch 64 APP v2 read handler and entitlement token adapter remain isolated injected modules. Repository evidence does not show them registered in the historical Worker dispatcher or called by an audited APK.

APK source ZIP was not available as an inspectable source tree. Therefore HTTP method/path/header/query/body/response callsites, deep-link handling, token persistence and multi-entitlement behavior remain unaudited. Do not claim full client compatibility; keep v2 feature flag OFF and legacy routes unchanged.

## 三、逐方法实施前契约

新增 `ADAPTER-STATEMENT-ASSERTION-MATRIX.json`，逐项覆盖八个 store methods:
1. `insertChallenge`
2. `consumeChallengeAtomic`
3. `consumeNonceAtomic`
4. `upsertBindingAtomic`
5. `revokeBindingAtomic`
6. `rotateShareCodeAtomic`
7. `getCurrentShareCode`
8. `expireTransientRecords`

每项明确数据来源、bind 顺序语义/类型/nullable metadata、结果分类、receipt、audit assertion 与关联 D1 case。D1-001..034 全部映射。

另将 create-created、create-existing、revoke、rotation 四种 composite operation 分开列出最终断言。尤其：
- existing 不得伪造 `binding.created`，原 binding identity fields 不变；
- owner-scoped receipt 和 audit event key 不得退化成全局 operation ID；
- foreign owner 与 absent resource 外部不可区分；
- rotation 不推断旧 binding/session/challenge/free grant 的撤销或保留策略；
- receipt/audit final assertion 的 D1 原子回滚尚未实测。

该矩阵是实施审查规格，不含可执行 SQL，也不证明 D1 PreparedStatement/batch 行为。

## 四、Disposable D1 harness 审查稿

新增 `DISPOSABLE-D1-HARNESS-IMPLEMENTATION-REVIEW.md`：
- 普通 CI 默认无网络、无凭证、无 D1 SDK、无 SQL；
- D1 harness 默认禁用，缺少显式开关即拒绝；
- 精确 database name/ID、Worker/service、binding mapping 和隔离证明必须独立核实；
- schema read、synthetic write、cleanup 三项授权分别申请；
- 每次执行先创建 immutable run ID 和 append-only synthetic ID ledger；
- 清理只能使用本次 ledger 中精确 ID，不能按宽泛条件删除；
- timeout/outcome-unknown 停止并按原 run ID 对账，不生成替代 ID；
- 任何环境错配、未知对象、跨 owner 行、意外结果或残留均停止。

当前只交付审查稿，未创建可连接 D1 的 runner。

## 五、HMAC overlap 方案比较

新增 `HMAC-OVERLAP-DECISION-REVIEW.md`，比较：
- canonical logical event + per-version aliases；
- dual-write + event_id union/dedupe；
- 单一权威 fingerprint namespace migration。

工程上暂时偏好第一种作为目标模型，但不是生产架构批准。必须先证明 event_id 唯一 tuple、全版本 alias 覆盖、high-water backfill、并发 admission、索引查询成本和 rollback 历史完整性。不能简单 sum 或 max 各版本 bucket。没有设置生产阈值、key、retention 或 migration SQL。

## 六、离线测试与 CI

新增 `test_batch81_readiness.py` 和 workflow `.github/workflows/worker-app-identity81-readiness.yml`。测试只验证：
- 八方法契约结构完整；
- D1-001..034 映射完整；
- U80 decisions 对 composite operations 的阻断仍存在；
- harness 默认禁用、三类授权分离、ledger-only cleanup；
- 三种 HMAC 候选及 rollback proof 存在；
- Worker/HTML caller references 与 APK 缺口明确。

CI 证据：Run `46042241488` failed，日志确认 unittest 将带点号目录误解析为模块名（`No module named 'backend.worker.V2'`）；已改为 unittest discovery。后续 Run `46042360351`、`46042474036` 因新提交而 cancelled；当前最新 Run `46042494745`（head `d6861056ff6a206783167f09edca5a5fe8e806e7`）在本轮核查时仍为 pending，尚无 job/log 可核验。因此本批离线测试**未取得通过证据**，不标记 PASS。

即使离线测试通过，也只证明文档/JSON 结构，不证明 SQL、D1、Worker、APP 行为。

## 七、数据库、生产与回滚边界

- D1：未连接、未读取 schema、未执行 SQL。
- Migration：未创建、未执行。
- Credentials / Secrets：未读取、未修改。
- Worker / HTML / APK / Room：未修改。
- Cloudflare：未改配置、未部署。
- 数据影响：无。
- 回滚：仅需 revert 本批新增 DEV 文档、JSON、测试和 workflow；无业务数据回滚事项。

## 八、下一批唯一接手卡（第八十二批）

**APP v2 adapter pre-implementation blockers closure and protocol source audit。**

1. 重读 AGENTS、功能基线、DB/API 保护规范、总方案、进度和第七十四至八十一批文件。
2. 继续检查 U80-01..08 是否出现用户决定；未确认项不得自行定默认。
3. 若 APK ZIP/源码可在仓库或 Library 读取，先解包盘点全部 HTTP 调用、deep link、token/device storage；不可读继续明确阻塞。
4. 对 statement matrix 做独立负面审查：receipt/audit 作用域、zero-row、batch rollback、RETURNING/meta.changes、bind lexical edge cases。
5. 对 HMAC 候选 A 做 alias completeness / high-water / retry / rollback 反例；不连接 D1。
6. 继续只做离线检查；除非另获明确授权，不连接 D1、不读取凭证、不执行 SQL/迁移、不修改 Worker/HTML/APK/Room/Secrets/Cloudflare、不部署。
7. 更新总进度、总方案与第八十三批唯一接手卡。


## CI 结果后续补充（2026-11-28）

此前报告记录 Run `46042494745` 在首次核查时 pending。后续 GitHub Actions 已完成：
- Run：`46042494745`
- 结论：`completed / success`
- Job：`140655276165`，`offline-readiness`，completed/success
- 核心 step：`Validate offline adapter readiness contracts`，success
- 链接：https://github.com/sxna-web/XYmonihtml/actions/runs/46042494745

更正：第八十一批离线结构检查现已取得通过证据。该结果仍只证明文档/JSON 静态契约检查，不证明 D1、SQL、Worker、APK 行为。
