# 星跃管理平台 V2.5｜APP v2 身份完整状态转移、审计矩阵与限流轮换反例报告（第七十九批）

- 批次：`V2.5-DEV-B1-APP-IDENTITY-79`
- 日期：2026-11-27
- 范围：create-created / create-existing / revoke / rotation 状态矩阵、审计 envelope 覆盖、prepared bind manifest 静态校验、HMAC overlap 与 cleanup 反例。
- 状态：`DESIGN_MATRIX_COMPLETE / OFFLINE_CI_PASS / D1_NOT_TESTED / APP_PENDING / NOT_DEPLOYABLE`。

## 一、本批交付

1. `backend/worker/V2.5-DEV-B1-APP-IDENTITY-79/OPERATION-TRANSITION-AND-AUDIT-MATRIX.md`
2. `backend/worker/V2.5-DEV-B1-APP-IDENTITY-79/test_batch79_matrix.py`
3. `backend/worker/V2.5-DEV-B1-APP-IDENTITY-79/README.md`
4. `.github/workflows/worker-app-identity79-matrix.yml`
5. 本报告、开发进度记录、总方案连续性记录。

## 二、主要完成内容

### 1. 四类操作状态矩阵
- Binding created：challenge 条件消费、新 binding 唯一性、created_by 与 created audit 精确匹配。
- Binding existing：不改变既有 binding ID / created_by / created_at / generation；只记录独立 resolution 事件，不伪造 created。
- Binding revoke：owner + binding + active + expected generation CAS，generation 精确 old+1。
- Share-code rotation：owner + code-record + active + expected version CAS，version 精确 old+1；既有 binding/session/challenge/free-grant 影响仍待业务确认。

每类都整理了前置条件、CAS、成功状态、审计精确谓词、失败分类、幂等重试、超时 outcome-unknown 恢复和回滚要求。

### 2. Audit envelope 与 canonicalization 覆盖检查
Batch 72 的事件信封字段集包含 actor、owner、target、outcome、reason_code 和 schema_version 等必要维度。但 Batch 78 的 canonical_v1 是通用 ordered-fields 编码器，并未强制每个 operation 的字段清单。因此本批区分：
- canonical request fingerprint：只含冻结的请求身份字段；
- immutable audit envelope：描述已提交结果，包含 event identity、actor/owner/target/outcome/reason/schema 等；
- volatile occurred_at/event_id/correlation_id 不应在没有冻结规则前被混入重试 fingerprint。

明确列出 actor 映射、reason_code nullability/enums、payload allow-list、目标 ID 审计许可及每操作 canonical ordered fields 为 adapter 前冻结项。

### 3. Prepared bind manifest
新增示例与静态 linter，要求 SQL 精确 UTF-8 SHA-256、statement ID、placeholder ordinal、唯一 semantic name、来源、storage class、nullable、missing policy、sensitivity。扫描器覆盖单/双引号、反引号、方括号、双写转义、行/块注释；拒绝 named / numbered placeholders、未闭合词法区域、错序/缺失/类型不符/SQL hash 不符。

### 4. HMAC overlap 重要修正
发现“逐 key-version bucket 分别检查，任一桶未满即放行”可能低估分散历史：old=3、new=3、limit=5 时总事件已超限。安全方案要求以不可变 event_id 合并版本桶的逻辑事件并去重后做一次原子判断，或先证明一个桶覆盖完整历史；禁止盲目求和（双写同一 event 会重复计数）和取单桶最大值。

Cleanup 必须保护活动窗口、重试/幂等 horizon；只允许在 retain_until 严格早于可信 now 且所有保护期限之后清理；审计和 operation receipts 永不进入 limiter cleanup。

## 三、CI 与修订记录

- 首轮 CI Run `45998840209`：completed/success，Python 3.13.18，34/34 tests passed。
- 后续加强 manifest SQL hash 与数字型 named-placeholder 检查时，出现修订失败 Run `45998985251`、`45999030188`、`45999045868`；失败来自测试夹具/编号修订，不涉及应用代码或 D1，均已修正并保留记录。
- 最终修订 CI Run `45999063646` completed/success；Job `140505777656`；Python `3.13.18`；日志 `Ran 36 tests in 0.002s`、`OK`，36/36 通过。
- Run：https://github.com/sxna-web/XYmonihtml/actions/runs/45999063646。该结果仅为离线静态参考测试，不是 D1/SQL/Worker/APP 测试。

## 四、影响与安全边界

- 仅新增 DEV 文档、Python 离线测试、workflow 和报告。
- 未连接 D1；未读取凭证；未执行 SQL；未创建 migration。
- 未修改 Worker/HTML/APK/Room/Secrets/Cloudflare 配置；未部署。
- 不代表 D1 batch atomicity、CHECK、prepared binding、并发 CAS、timeout-after-commit 或 APP/Android Keystore 兼容已验证。
- 回滚只需停止引用本批目录/工作流或回退本批提交；无业务数据变更。

## 五、第八十批唯一接手卡

**APP v2 adapter contract freeze checklist 与 disposable D1 证据缺口关闭计划（仍不连接 D1）。**

1. 重读 AGENTS、功能基线、总方案、进度及第七十四至七十九批材料和最新 CI。
2. 将 Batch 79 标出的 actor mapping、reason enum/nullability、payload allow-list、per-operation canonical ordered fields、rotation side effects 等逐项归类为“已确认 / 待用户确认 / 技术验证项”，不得擅自冻结业务语义。
3. 复核 Batch 79 最终 CI；若失败先修测试自身并保留失败记录。
4. 将 D1 disposable 验证每个 case 映射到所需 schema capability、prepared statement、expected result vector、rollback proof、cleanup evidence；不得执行。
5. 为 HMAC overlap 的 event_id union/dedupe 设计索引/成本验证计划及跨版本迁移证明，不设生产阈值。
6. 核对 legacy share-code 调用方与 rotation side-effect 的兼容风险；不改旧路由/schema。
7. 不连接 D1、不读取凭证、不执行 SQL/迁移、不修改 Worker/HTML/APK/Room/Secrets/Cloudflare 配置、不部署。
8. 更新总进度、总方案与第八十一批唯一接手卡。
