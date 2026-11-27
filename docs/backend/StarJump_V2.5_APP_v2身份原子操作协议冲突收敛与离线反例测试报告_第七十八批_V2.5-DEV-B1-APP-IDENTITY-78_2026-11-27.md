# 星跃管理平台 V2.5｜APP v2 身份原子操作协议冲突收敛与离线反例测试报告（第七十八批）

- 批次：`V2.5-DEV-B1-APP-IDENTITY-78`
- 日期：2026-11-27
- 状态：协议设计已提交；离线 CI 待实际运行核验；`D1_NOT_TESTED / APP_PENDING / NOT_DEPLOYABLE`。

## 一、本批交付

1. `backend/worker/V2.5-DEV-B1-APP-IDENTITY-78/OPERATION-CONTRACT-CONVERGENCE.md`
2. `backend/worker/V2.5-DEV-B1-APP-IDENTITY-78/test_batch78_contract.py`
3. `backend/worker/V2.5-DEV-B1-APP-IDENTITY-78/README.md`
4. `.github/workflows/worker-app-identity78-contract.yml`

## 二、协议冲突收敛

### 1. 新建与既有绑定分开

- `created`：本次操作真实插入绑定，必须记录 `binding.created`。
- `existing`：绑定此前已存在，不能伪造 `binding.created`，不能改写原 `created_by`/generation；由于本次仍消费 challenge，建议记录独立 `binding.existing_resolved` 操作解析审计。
- 两种成功结果都有 owner-scoped receipt 和精确审计事件键，因此不再出现 Batch 74 可空 audit key 与 Batch 75 NOT NULL 不兼容的问题。
- 此为待后续实现验证的协议建议，不表示线上行为已经改变。

### 2. 幂等键归属

明确采用 `(owner_id, operation_id)` 和 `(owner_id, event_key)` 逻辑唯一范围。所有收据读取和审计断言必须带认证上下文中的 owner；同 owner 不同 payload/type 为完整性冲突，不能将另一 owner 的记录暴露给调用者。

### 3. Canonical payload v1

定义带版本标记、字段顺序、类型标签、长度前缀的 UTF-8 编码；字符串 NFC；区分 missing、NULL、空字符串、整数和布尔；拒绝 float、对象、数组和 undefined；SHA-256 由服务端计算。字段顺序/编码变更必须升级版本，禁止继续使用 delimiter 拼接。

### 4. Prepared binding 顺序

增加 SQL 占位符计数与 manifest 检查规则：忽略字符串和注释内的问号，拒绝 named placeholder，核对 ordinal 1..N、bind 数量及 undefined。该静态工具不证明 D1 PreparedStatement 的实际兼容性。

### 5. 限流 HMAC overlap / cleanup

定义轮换期间双版本检查、同一原子决策、旧 key 最短安全退役条件；补充清理不能删活动窗口或幂等重试仍需记录的竞态证据要求。不设生产阈值、保留期、密钥或轮换时长。

## 三、测试计划与范围

新增 23 个离线 Python 反例测试，覆盖 created/existing 语义、owner scope、分隔符碰撞、NULL/空/缺失、bool/int、Unicode NFC、字段顺序、digest 稳定、占位符扫描、manifest 顺序、undefined 拒绝和 HMAC 双版本 overlap 参考逻辑。

测试只验证 Python 参考模型，不执行 SQLite DDL、D1 SQL、Worker 请求或真实并发，不证明 D1 batch rollback / CHECK 语义或 APP 客户端兼容性。GitHub Actions 结果以实际 Run 为准。

## 四、影响、风险与回滚

- 只新增版本化文档、离线测试与 workflow。
- 未修改生产表结构、migration、Worker 路由、HTML、APK、Room、Secrets、Cloudflare binding/config。
- 未连接 D1、未读取凭证、未执行 SQL、未部署。
- 回滚：停止引用本批协议目录/停用本批 workflow 或回退本批提交；无数据库数据变更。
- 主要风险：canonicalization v1 和 existing-resolution audit 是新提案，必须在未来 adapter 设计评审、用户批准的 disposable D1 验证及 APP 协议兼容测试后才能实施。

## 五、第七十九批唯一接手卡

**APP v2 identity adapter 设计前置：三类原子操作完整状态转移与审计矩阵（仍不连接 D1）。**

1. 重读 AGENTS、功能基线、数据库保护规范、总方案、进度及第七十四至七十八批材料和最新 CI。
2. 将 create-created/create-existing/revoke/rotation 的前置状态、CAS 条件、成功状态、失败分类、receipt、audit exact-match 谓词、重试/超时恢复整理为逐字段矩阵。
3. 检查 canonicalization v1 的字段清单和事件 envelope 是否覆盖 actor/owner/target/outcome/reason/schema version；缺项列为待确认，不擅自补业务语义。
4. 设计 bind manifest 示例与静态校验器反例；覆盖 SQL 字符串、注释、转义、问号及占位符顺序。
5. 完善 HMAC key overlap 状态机、cleanup/admission 原子性前置条件及证据表；不设生产阈值。
6. 仍不连接 D1、不读取凭证、不执行 SQL、不创建 migration、不修改 Worker/HTML/APK/Room/Secrets/Cloudflare 配置、不部署。
7. 更新总进度、总方案和第八十批唯一接手卡。
