# 星跃管理平台 V2.5｜APP v2 D1 语句契约独立安全复核与审计幂等方案报告

- 批次：第七十一批
- 版本：`V2.5-DEV-B1-APP-IDENTITY-71`
- 日期：2026-11-27
- 状态：**静态复核与设计修订完成；未连接 D1；未执行 SQL；未创建 migration；未接 Worker；不可部署**
- 仓库：`sxna-web/XYmonihtml` / `main`

## 1. 本批范围与证据

已重读根目录 `AGENTS.md`、V2.5 功能基线、API 接口与权限规范、数据库结构与变更保护规范、总方案、进度记录，以及第六十八至七十批 D1/APP identity 资料。对原始 Worker 只读检查的基线 Blob SHA 为 `5da7aa3582558d9da2c2a0ad25a63c5e95e9fe63`。

原始 Worker 是仓库可见源码基线，不代表 Cloudflare 当前线上 Worker 或 D1 schema。本批没有连接 Cloudflare，不读取任何真实数据库内容。

## 2. 八方法复核结论

| 方法 | 结论 |
|---|---|
| insertChallenge | 参数化 INSERT 可行；只把预期 challenge_id 主键冲突分类为领域冲突，其余错误 fail closed。 |
| consumeChallengeAtomic | 单条条件 UPDATE 保留 pending、严格 expires_at > now、device/admin/version/key 条件；零行统一拒绝；D1 changes/RETURNING 必须实测。 |
| consumeNonceAtomic | UNIQUE(binding_id, nonce) + DO NOTHING；验签和时间窗口检查必须先于 nonce 消费；保留期存储 retain_until。 |
| upsertBindingAtomic | insert-if-absent + owner/device winner SELECT 作为同一 batch；检查 owner/device/status/key/version；不得覆盖 key 或复活 revoked。新增第三条条件审计语句设计。 |
| revokeBindingAtomic | 条件 UPDATE 与零行后的 owner-scoped SELECT 均必须带 binding_id + owner；保留撤销记录。 |
| rotateShareCodeAtomic | version CAS；零行冲突不自动重试；不得擅自更改 legacy schema/路由或未确认的既有绑定轮换政策。 |
| getCurrentShareCode | 只读已认证 owner 的最小元数据；不返回 code_digest/raw code；验证单个 active row 不变量。 |
| expireTransientRecords | 有界清理；只清理过期 pending challenge 与安全保留期后的 nonce；不清理 binding/revocation/audit；禁止 delimiter 拼接复合键。 |

详细参数、错误语义、风险与修订见同目录 `D1-SECURITY-REVIEW.md`。

## 3. 重点修订：binding 创建审计幂等

第七十批的两条语句可以得到唯一 winner，但本身没有解决创建审计原子追加。建议未来在同一个 D1.batch 中加入第三条条件 INSERT-SELECT：

- 仅当本次尝试生成的 binding_id、owner、device、key thumbprint、created_at 与实际插入行完全匹配时追加 created audit；
- audit event 使用确定性唯一键，例如 `binding.created:<binding_id>`；
- 同一逻辑操作重试时复用 binding_id/event key/created_at，避免重复审计；
- 如果唯一 owner/device 竞争中本次 insert 没有胜出，winner 的 binding_id 不同，第三条语句不应生成本次创建审计；
- audit 语句失败应使 batch 整体失败回滚，避免 binding 已提交而创建审计丢失。

该方案要求未来审计表具有唯一 event_key，并且必须在获批隔离 D1 验证 batch rollback、冲突、重试和并发；目前只是设计建议，不是已实现功能或 migration。

## 4. Nonce 时间边界

在签名时间戳按 `abs(T - server_now) <= S` 且两端边界均接受的前提下：
- 最坏情况首次接收发生在时间戳最大未来偏移处：`t0 = T - S`；
- 同一时间戳最晚可在 `T + S = t0 + 2S` 被接受；
- 因此保留期至少为 `first_seen + 2 * MAX_CLOCK_SKEW + SAFETY_MARGIN`；
- 最大过去偏移情况下的实际窗口更短，但统一采用上述上界；
- 只要 nonce 行仍在库中，即使名义期限已过也拒绝重复；清理后则必须确保原签名已超出时间窗口；
- 若后续调大 MAX_CLOCK_SKEW，旧 nonce 保留期限可能不足，必须冻结协议配置、按最大支持值保留或版本化签名协议。

数值例子仅用于解释，不代表已确认项目配置。精度、margin、协议版本和 D1 清理边界仍待冻结及实测。

## 5. Legacy share-code 兼容性

原始 Worker DDL 中 `admin_share_codes` 仅观察到 admin_user_id、raw code、created_at；相关旧调用包含管理员/超管取码、APP resolve、免费组查找和下载链接查找。公开 resolve 返回管理员元数据；旧免费组路径可按 admin ID 或 code 读取数据。这些是原始仓库源码证据，不是线上状态证明。

处理原则：
- 不改写或删除 legacy code 字段；
- 不假设 v2 digest/version/revocation 字段已存在；
- 新身份发现只定位候选管理员，不可仅凭 share code 授予节点/分组访问或建立可信绑定；
- 后续应采用独立版本契约/表或经批准的增量迁移，并先完成所有调用方盘点、双版本兼容、客户端升级窗口和回滚方案；
- share-code 轮换是否撤销旧绑定仍未确认，本批不作业务决定。

## 6. Durable rate limit 结论

原始 Worker 可见 `rate_limits(bucket PRIMARY KEY, count, updated_at)`；旧全局转换逻辑为先 upsert 增量、再单独 SELECT 判断阈值，异常时 catch 后 fail-open。该模型没有证明 APP identity 所需的 IP/network、device、admin、action 多维隔离，也没有单语句原子限额决策或身份安全接口 fail-closed 保障。

建议未来采用服务端派生的伪匿名 subject/action bucket、明确时间窗、单条条件 UPSERT/RETURNING 原子决策、Retry-After、保留与有界清理；真实 D1 结果和并发必须隔离测试。不得直接复用旧 fail-open helper 作为身份限流。

## 7. 本批新增文件

- `backend/worker/V2.5-DEV-B1-APP-IDENTITY-71/D1-SECURITY-REVIEW.md`
- `backend/worker/V2.5-DEV-B1-APP-IDENTITY-71/README.md`
- 本报告：`docs/backend/StarJump_V2.5_APP_v2_D1语句契约独立安全复核与审计幂等方案报告_第七十一批_V2.5-DEV-B1-APP-IDENTITY-71_2026-11-27.md`

## 8. 测试、数据库与部署状态

- 本批完成静态文档/源码审查；没有新增可执行代码，因此没有本批代码测试结果。
- 第六十九批 SQLite 10/10 仍只代表合成 SQLite fixture，不升级为 D1 测试。
- 未连接 production/staging/任何 D1；未执行 SQL；未创建/执行 migration。
- 未修改 Worker、HTML、APK、Room、Secrets、Cloudflare 配置；未注册路由；未部署。
- 当前标签：`D1_NOT_TESTED` / `APP_PENDING` / `NOT_DEPLOYABLE`。

## 9. 第七十二批唯一接手卡

**APP v2 D1 审计/幂等事件契约与 durable rate-limit 协议冻结审查（设计阶段，不连接 D1）。**

1. 重读 AGENTS、功能基线、API/D1 保护规范、总方案、进度及第六十八至七十一批报告。
2. 将 binding 创建审计提案扩展为完整事件契约：event key、actor/owner/target、不可变 payload、保留策略、重复请求和 timeout 行为。
3. 为 binding revoke 与 share-code rotation 设计幂等审计契约，不改变尚未确认的轮换业务政策。
4. 冻结候选 identity rate-limit 算法：维度、窗口、原子判定、Retry-After、清理和 fail-closed；数值阈值保持可配置，不擅自设定最终额度。
5. 对照 APP 签名协议重新核对 nonce 时间精度、协议版本与 skew 变更行为；不宣称 Android 兼容。
6. 保留 legacy share-code 分阶段兼容方案，不改路由和 schema。
7. 不连接 D1、不执行 SQL/迁移，不改 Worker/HTML/APK/Room/Secrets，不部署。
8. 更新进度、总方案和第七十三批接手卡。
