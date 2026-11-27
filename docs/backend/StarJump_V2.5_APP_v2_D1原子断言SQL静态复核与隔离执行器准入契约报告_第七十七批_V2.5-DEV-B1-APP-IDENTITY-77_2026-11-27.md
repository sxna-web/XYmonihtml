# 星跃管理平台 V2.5｜APP v2 D1 原子断言 SQL 静态复核与隔离执行器准入契约报告（第七十七批）

- 批次：`V2.5-DEV-B1-APP-IDENTITY-77`
- 日期：2026-11-27
- 状态：静态复核与准入设计已提交；离线 CI 待运行；`D1_NOT_TESTED / APP_PENDING / NOT_DEPLOYABLE`。
- 范围：仅第七十四/七十五批 SQL 候选、SQLite fixture、七十六批矩阵和准入方案静态复核；不连接 D1、不执行 SQL。

## 一、本批新增文件

1. `backend/worker/V2.5-DEV-B1-APP-IDENTITY-77/SQL-PORTABILITY-AND-ASSERTION-REVIEW.md`
2. `backend/worker/V2.5-DEV-B1-APP-IDENTITY-77/D1-HARNESS-ADMISSION-CONTRACT.md`
3. `backend/worker/V2.5-DEV-B1-APP-IDENTITY-77/README.md`
4. `backend/worker/V2.5-DEV-B1-APP-IDENTITY-77/validate_batch77_contract.py`
5. `.github/workflows/worker-app-identity77-contract.yml`

## 二、关键复核结论

### 1. CHECK/NULL
SQLite 的 CHECK 表达式为 NULL 时不会按 false 处理，因此 assertion 列必须同时 NOT NULL + CHECK(assertion=1)，且表达式应使用 CASE WHEN ... THEN 1 ELSE 0 END 生成确定的 0/1。Cloudflare D1 实际运行时仍需 disposable D1 验证。

### 2. 审计事件
条件 INSERT-SELECT 零行不触发 SQL 错误；最终 receipt 必须是同一 batch 最后的无条件 INSERT，并通过数据库内 CHECK assertion 确保 required state/audit 精确存在。DO NOTHING 不能单独代表 exact replay，必须核对完整审计信封。

### 3. 发现的协议不一致
- Batch 74 的 existing binding 路径允许不生成 binding.created 审计，receipt audit key 可空；Batch 75 fixture 却把 audit_event_key 定为 NOT NULL，且未覆盖既有绑定返回路径。需后续统一 created/existing 两类结果契约。
- Batch 75 使用全局 operation_id 主键但按 owner 查找收据，owner uniqueness scope 未冻结。
- 74/75 fixture 中 delimiter 拼接 payload 不是无歧义 canonicalization；必须冻结版本化字段类型/顺序/NULL/UTF-8/Unicode 规则。
- SQL NULL 与空串必须区分；NULL 等值比较不会得到 TRUE，undefined 必须在 bind 前拒绝。
- Create/revoke/rotation 最终 assertion 要分别核验 owner、target、generation/version、operation_id、audit event 和 canonical payload，不能只看 UPDATE changes。

### 4. 限流
补充多维并发、共享 NAT、时钟前后跳、cleanup race、HMAC K1/K2 overlap 需要的证据项；不选择生产阈值、窗口、保留期或密钥轮换时长。

## 三、未来 D1 harness 安全门禁

- 默认禁用；无默认 database/binding/worker/service/credential。
- 必须显式指定 disposable DB name + exact ID、Worker/service、binding，并独立证明 binding 指向目标 DB。
- 只读检查、disposable 写入、cleanup 分别取得授权。
- 任何 synthetic row 都有唯一 test_run_id；所有读写与 cleanup 严格限定本 run。
- 不读取 GitHub Secrets、仓库配置、shell history 或通用凭证文件；不打印凭证。
- 任何目标身份不一致、schema 意外、未知提交状态、清理范围不明立即停止。
- 本批只设计，不创建可连接 D1 的 runner。

## 四、验证与边界

本批新增离线结构验证器和 GitHub Actions workflow。当前提交后等待 workflow 运行，未把尚未取得的 CI 结果写成通过。

本批没有：
- D1 / Cloudflare 连接或 schema 检查；
- SQL 执行、migration 或生产 DDL；
- Worker、HTML、APK、Room、Secrets、Cloudflare binding/config 修改；
- APP 端兼容验证或部署。

因此不能将本批称为 D1 SQL 验证、D1 原子性通过或可部署版本。

## 五、回滚

本批只新增独立 DEV 文档、离线校验器和 workflow。回滚可停止引用该批目录/停用对应 workflow 或回退本批提交；无数据库或业务数据变更。

## 六、第七十八批唯一接手卡

**APP v2 identity 原子操作候选协议冲突收敛与离线反例测试（仍不连接 D1）。**

1. 重新读取 AGENTS、功能基线、数据库保护规范、总方案、进度、第七十四至七十七批文件和最新 CI 结果。
2. 冻结 created/existing binding 两种 operation receipt/audit 语义，补充既有绑定路径的反例测试；不能为旧绑定伪造 created 审计。
3. 为 operation_id owner scope、audit event key scope、canonical payload 编码、NULL/空串/缺失字段差异建立明确契约与反例测试。
4. 复核 create/revoke/rotation 三种 final assertion 的每个必需谓词及 CAS 输入输出；建立占位符数量/顺序静态检查。
5. 完善 limiter HMAC 双 key overlap 和 cleanup/admission 竞态证据规格，不设生产阈值。
6. 仍不连接 D1、不读取凭证、不执行 SQL、不创建 migration、不修改 Worker/HTML/APK/Room/Secrets/Cloudflare 配置、不部署。
7. 更新进度与总方案，给出第七十九批唯一接手卡。
