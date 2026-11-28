# 第一百零九批｜Protocol 66 客户端幂等键与映射 ID 修正及回归报告

- 批次：`V2.5-DEV-B1-PROTOCOL66-IDEMPOTENCY-109`
- 日期：2026-11-28
- 分支：`release/v2.5.0-rc1-converge`
- 最终验证提交：`38cf90da59eae0d7655e3eeef95272dcd1e11110`
- 前置数据库基准：`docs/backend/StarJump_V2.5_starjump-staging_D1结构基准快照_2026-11-28.md`（开始数据库相关工作前已复读）
- 前置设计：第一百零八批两张缺失表模型与迁移草案

## 1. 本批修正

### 1.1 客户端操作幂等键与服务端 trace ID 分离

- PUT handler 从 `Idempotency-Key` 请求头读取客户端逻辑操作键。
- 缺失、格式错误、短于 8 字符或超过 128 字符时，返回 400 `IDEMPOTENCY_KEY_REQUIRED`，不调用 service。
- 服务端 session `requestId` 继续独立传递，专供审计/追踪。
- Service、D1 adapter、SQL plan 全链路使用独立的 `idempotencyKey` 字段。
- 幂等记录按管理员 + `idempotency_key` 唯一；同键同 payload digest 返回既有结果，同键不同 payload 返回 `IDEMPOTENCY_CONFLICT`。
- SQL plan 将请求键写入幂等表，将服务端 trace ID 写入 `admin_audit_events.request_id`，不再混用。

### 1.2 映射 ID 改为随机短 ID

- 移除 `cgm_${cardId}_${groupId}` 拼接方式。
- adapter 为每条新映射生成 `cgm_${UUID去横线}`，固定长度 36 字符。
- 仍通过 `UNIQUE(card_id, group_id)` 的候选约束实现同一张卡与同一分组唯一及软删除恢复。
- SQL plan 验证 mappingIds 数量、格式及唯一性，按原 groupId 顺序绑定，避免排序后错配 ID。

### 1.3 数据模型命名同步

第一百零八批草案中幂等表字段原写为 `request_id`。本批候选 SQL 和模型修订为 `idempotency_key`，主键为 `(admin_user_id, idempotency_key)`；服务端追踪字段仍沿用既有审计表的 `request_id`。该新表尚未在真实 D1 创建，因此不存在已部署 schema 的字段迁移。

## 2. 自动化测试结果

GitHub Actions 最终 push run：

- Run：[46136131419](https://github.com/sxna-web/XYmonihtml/actions/runs/46136131419) — SUCCESS
- PR check：[46136130824](https://github.com/sxna-web/XYmonihtml/actions/runs/46136130824) — SUCCESS
- APP Identity check：[46136130835](https://github.com/sxna-web/XYmonihtml/actions/runs/46136130835) — SUCCESS

Protocol 66 相关测试：

| 测试文件 | 通过 | 失败 |
|---|---:|---:|
| card-group-admin.test.mjs | 22 | 0 |
| card-group-admin-sql-plan.test.mjs | 8 | 0 |
| card-group-admin-d1-adapter.test.mjs | 14 | 0 |
| card-group-admin-dispatch-contract.test.mjs | 12 | 0 |
| **合计** | **56** | **0** |

同一 run 还完成 Worker handler integration 75/75、Batch49 authorization adapter 15/15，以及其余收敛检查。构建产物 `StarJump-V2.5.0-RC1-candidate` 已上传，Artifact ID `15259813009`，大小 135,753 bytes。它是 CI 内部候选产物，不代表已获生产部署批准。

## 3. 测试证据边界

- D1 adapter 使用 fake/mock D1；Node 测试通过不等于 Cloudflare D1 真实事务、并发或 schema 已验收。
- Protocol66 仍未连接 Batch49 正式 Worker 路由；本批未宣称真实 API 已启用。
- APP 6.00.48 实际客户端请求头/响应契约仍待核对。
- 两张新表仍未在 `starjump-staging` 创建；第一百零八批 DDL 仍是审阅草案。

## 4. 下一步

1. 为委托操作补充“幂等重放时再次核验实时 scope”的检查，避免已撤销 scope 通过旧幂等记录获得响应。
2. 在隔离 SQLite 环境对候选两表 DDL 做建表、重复执行、唯一冲突、软删除恢复、原子回滚测试。
3. 对照真实 schema 快照复核 DDL 和所有 SQL 字段；完成后再提交 Staging 迁移审批包。
4. 继续核验 APP 6.00.48 的真实 Idempotency-Key 支持情况；若不支持，需制定客户端兼容策略，不能直接假定它会发送该请求头。
5. 完成前述事项后，才考虑将 handler 接入正式 Worker 路由；真实 Staging 迁移必须另获用户明确授权。

## 5. 本批操作边界

- 已修改 Protocol66 候选 handler、service、D1 adapter、SQL plan 及对应测试。
- 已修订第一百零八批模型文档中幂等字段命名。
- 未执行 DDL/DML；未连接 Cloudflare；未读取或修改 Secrets；未变更 D1 binding。
- 未修改正式 Worker 路由；未部署；未合并 PR。
- PR #2 继续 Draft/Open/Unmerged。
