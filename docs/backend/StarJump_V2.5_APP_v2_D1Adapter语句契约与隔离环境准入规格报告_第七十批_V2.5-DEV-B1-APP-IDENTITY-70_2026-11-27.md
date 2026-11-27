# 星跃管理平台 V2.5｜APP v2 D1 Adapter 语句契约与隔离环境准入规格报告

- 批次：第七十批
- 版本：`V2.5-DEV-B1-APP-IDENTITY-70`
- 日期：2026-11-27
- 状态：**设计规格完成；未连接 D1；未执行 SQL；未创建 migration；未接 Worker；不可部署**
- 仓库：`sxna-web/XYmonihtml` / `main`

## 1. 本批目标

承接第六十九批，进一步明确未来 D1 adapter 的：
- 八个持久化方法的 SQL 形状与 bind 参数顺序；
- 成功、零行、唯一冲突、数据库错误的判定；
- RETURNING 与 `meta.changes` 的验证要求；
- upsertBinding 的 insert-if-absent + winner SELECT 批次组合；
- nonce TTL 与签名时间窗口的防重放关系；
- durable rate limit 依赖；
- 独立非生产 D1 准入与 schema snapshot 流程。

## 2. 新增文件

1. `backend/worker/V2.5-DEV-B1-APP-IDENTITY-70/D1-STATEMENT-CONTRACT.md`
   - 八方法 SQL 形状、参数顺序、状态结果、重试边界。
   - 明确 SQL 片段是逻辑设计，不是现有 schema，也不是 migration。
2. `backend/worker/V2.5-DEV-B1-APP-IDENTITY-70/D1-ISOLATED-ENV-ADMISSION.md`
   - 隔离 D1 环境准入门槛、用户授权记录模板、只读 schema 快照、测试数据与清理协议。
3. `backend/worker/V2.5-DEV-B1-APP-IDENTITY-70/README.md`
   - 本批范围、状态和下一批入口。

## 3. 八方法实现规格关键结论

- `insertChallenge`：主键冲突为领域冲突；不得覆盖。
- `consumeChallengeAtomic`：单条条件 UPDATE 同时验证 pending、expires_at、device/admin/version/key；零行统一拒绝，不能泄露具体失败条件。
- `consumeNonceAtomic`：唯一键 (binding_id, nonce)，冲突 DO NOTHING；不允许 REPLACE 或更新既有 nonce。
- `upsertBindingAtomic`：预先构造 INSERT ... ON CONFLICT DO NOTHING 与 owner-scoped SELECT，交给同一个 D1.batch 顺序执行；JS 在 batch 返回后检查 winner，不能在 batch 内途经 JS 分支。必须比较 active/status/key；不得覆盖 key 或复活 revoked。
- `revokeBindingAtomic`：owner-scoped 条件 UPDATE；零行后只能按 binding_id + owner 查询，区分本人已撤销与不存在/非本人。
- `rotateShareCodeAtomic`：version CAS；零行即冲突，不得自动读新版本后重试覆盖；legacy share-code schema 不得擅改。
- `getCurrentShareCode`：只按已认证 owner 读取最小元数据；不得向 APP 返回 code_digest。
- `expireTransientRecords`：分批有界清理 challenge/nonce；绝不清理 binding/revocation/audit。Nonce 必须过了安全重放保留窗口才能删除。

## 4. 本批新增的安全结论：nonce 保留期限

假设服务端只接受满足 `abs(request_timestamp - server_now) <= MAX_CLOCK_SKEW` 的签名请求。若客户端时间戳允许最多向未来偏移 S，首次请求可能在 `now = timestamp - S` 时被接受，而同一签名最晚在 `timestamp + S` 仍然有效。因此 nonce 的记录保留期限至少需要覆盖从首次接收到最后可接受时刻的最长窗口：

```text
retain_until >= first_seen_server_time + 2 * MAX_CLOCK_SKEW + SAFETY_MARGIN
```

每次请求仍必须验证签名时间窗口；nonce 表唯一约束用于防重放，不能由签名校验取代。清理是独立有界任务；记录名义到期但尚未清理时仍应拒绝重复 nonce。若未来协议使用不同时间接受规则，必须重新推导最大可重放区间。

## 5. D1 返回对象与 batch 语义资料核对

已查阅 Cloudflare 官方文档（2026-11-27 可见版本）：
- Prepared statements：`bind()` 参数化；`run()` 返回 D1Result；普通写语句无 RETURNING 时 results 通常为空；D1 对匿名/编号参数有明确规则。
  - https://developers.cloudflare.com/d1/worker-api/prepared-statements/
- D1 return objects：D1Result 含 success、meta、results；需按实际操作读取结果字段。
  - https://developers.cloudflare.com/d1/worker-api/return-object/
- D1 batch：语句按传入顺序执行；batch 是事务批次；任一语句失败会中止/回滚整个 batch；结果按语句顺序返回。
  - https://developers.cloudflare.com/d1/worker-api/d1-database/

重要限制：平台文档只说明 Cloudflare D1 平台能力，不证明本项目实际绑定、schema、runtime 版本、RETURNING/meta.changes 对具体语句的表现。必须在获批准的隔离 D1 实测。尤其不能把 `meta.changes`、RETURNING 或 mock 行为直接当作当前生产证据。

## 6. 隔离 D1 准入状态

当前仓库证据仍未提供可确认的 APP v2 专用隔离 D1 database ID 与 binding。当前未获得用户明确指定/批准的独立 D1 环境。因此：
- 没有连接 production 或 staging；
- 没有运行 PRAGMA 或任何远端 SQL；
- 没有创建、执行或回滚 migration；
- 没有写入测试记录；
- 没有更改 Worker、HTML、APK、Room、Secrets 或 Cloudflare 配置；
- 没有部署。

不得把 `starjump-staging` 或生产数据库自动当成测试环境。隔离准入文档给出授权记录模板和只读快照流程。

## 7. 测试状态

本批是设计/文档批次，没有新增可执行代码，因此没有本批代码测试结果。第六十九批 SQLite 10/10 仍只代表本地合成 SQLite fixture 通过，不升级为 D1 测试。

状态标签：`D1_NOT_TESTED` / `APP_PENDING` / `NOT_DEPLOYABLE`。

## 8. 未解决事项

- 真实 D1 schema、database ID、binding、迁移历史未知。
- RETURNING 与 `meta.changes` 对目标 SQL 的具体组合行为未验证。
- D1 batch 回滚、独立请求/多 isolate 竞争未实测。
- 现有 durable rate-limit 表是否适配未核实。
- share-code v2 schema 与旧路由双读/迁移策略仍未冻结。
- identity binding 审计记录的原子追加/幂等 outbox 方式需进一步细化。
- Android Keystore、签名 canonicalization、6.00.48 兼容仍待 APK 源码审计。

## 9. 第七十一批唯一接手卡

**APP v2 D1 statement contract 独立安全复核与审计幂等方案（不连接 D1）。**

1. 重读 AGENTS、功能基线、API/D1 保护规范、总方案、进度及第六十八至七十批报告。
2. 对第七十批八方法 SQL 逐条做静态审查：参数顺序、表/列假设、条件、唯一冲突、零行语义、异常边界。
3. 重点审查 upsertBinding 批次中 winner SELECT 的并发正确性，以及创建审计的幂等追加方案；不得把 JS 条件分支放入 batch。
4. 对 nonce retention 公式建立边界案例矩阵：最大未来偏移、最大过去偏移、时钟边界、重复请求、清理前/后重放。
5. 审查 share-code rotation 与 legacy route 并存策略，不更改用户未确认的业务政策。
6. 评估 durable rate limit 的原子计数模型和旧表兼容证据；不得假设旧 rate_limits 足够。
7. 无明确批准的隔离 D1 时，不连接任何 D1；不创建/执行 migration，不接 Worker，不改 HTML/APK/Room/Secrets，不部署。
8. 更新总进度、总方案与第七十二批接手卡。
