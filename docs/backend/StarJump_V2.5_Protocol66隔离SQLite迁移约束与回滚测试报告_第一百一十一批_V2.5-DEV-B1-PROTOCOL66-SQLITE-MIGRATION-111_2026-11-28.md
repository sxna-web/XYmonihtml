# 第一百一十一批｜Protocol 66 隔离 SQLite 迁移约束与回滚测试报告

- 批次：`V2.5-DEV-B1-PROTOCOL66-SQLITE-MIGRATION-111`
- 日期：2026-11-28
- 分支：`release/v2.5.0-rc1-converge`
- 最终提交：`202474db9cfa2ace7511f0c6abf54a505b138472`
- 依据：已归档的 `starjump-staging` schema-only 快照、Batch 108 数据模型草案、Batch 109/110 Protocol66 实现。

## 1. 本批修正

1. 将候选 `app_card_group_admin_requests` 的客户端幂等字段统一为 `idempotency_key`；审计表 `admin_audit_events.request_id` 继续保留服务端追踪 ID，二者不可混用。
2. 候选 fixture 不再使用未经真实 schema 证明的外键；改由显式 owner/mode 约束触发器与历史保护触发器验证归属和防止父记录被删除/转移。
3. 映射表状态约束统一为：
   - active 必须 `removed_at IS NULL`；
   - removed 必须 `removed_at IS NOT NULL`。
4. 索引命名与 Batch108 草案统一：
   - `ix_card_group_mappings_admin_card_status`
   - `ix_card_group_mappings_group_status`
   - `ix_card_group_admin_requests_created`
5. 修订 Batch108 文档中的 DDL 字段名，并明确隔离 fixture 无 FK 的原因及边界。

## 2. 隔离 SQLite 回归覆盖

- 管理员/卡密/分组跨 owner 拒绝。
- 仅允许 `mode='card'` 的同 owner 分组写入；free/assigned 分组拒绝。
- `(card_id,group_id)` 唯一映射、软删除、恢复单行历史。
- active/removed 与 removed_at 一致性。
- 管理员维度幂等唯一键：同管理员重复冲突，不同管理员可使用相同 key。
- 审计插入失败时，映射变更和幂等记录在同一 SQLite 事务回滚。
- 删除/转移已有映射历史的卡或分组被保护。
- 索引存在性和不得复制卡密明文/token 字段。
- 同时继续运行迁移 runner 自身的 checksum、重复执行、失败回滚、schema diff 等测试。

## 3. 最终 CI 证据

最终分支提交：`202474db9cfa2ace7511f0c6abf54a505b138472`

- Push Run [46136887536](https://github.com/sxna-web/XYmonihtml/actions/runs/46136887536)：SUCCESS
- PR checks [46136890869](https://github.com/sxna-web/XYmonihtml/actions/runs/46136890869)：SUCCESS
- PR checks [46136890859](https://github.com/sxna-web/XYmonihtml/actions/runs/46136890859)：SUCCESS
- Python 隔离迁移/SQLite 总套件：68 tests，OK。
- 本批两张候选表专项：映射约束测试 12 项、卡组/幂等与回滚测试 13 项，均通过。
- Worker integration：75/75。
- Protocol66 service：22/22；SQL plan：8/8；D1 adapter：16/16；dispatch contract：12/12。
- APP v2 composition：19/19；APP read handler：23/23；composed group service：26/26。

中间提交曾因测试 SQL 仍有旧 `request_id` 字段引用而失败；已定位并统一为 `idempotency_key`，最终提交的 push 与两项 PR checks 均通过。审计表中的 `request_id` 是刻意保留的服务端追踪字段，并非遗漏。

## 4. 不能越界解释的结果

- 这些是 Python sqlite3 的隔离内存数据库测试，不是 Cloudflare D1 测试。
- SQLite 测试不能证明 D1 兼容性、D1 batch 原子性/并发行为或生产数据完整性。
- 真实 `starjump-staging` 仍未创建这两张表；没有运行任何真实 DDL/DML。
- 候选 fixture 包含用于本地约束测试的辅助触发器；它不是可以直接复制到 D1 的最终迁移文件。
- Protocol66 仍未接入正式 Worker route；APP 6.00.48 的 `Idempotency-Key` 实际客户端契约仍待核验。

## 5. 下一步

优先检查 APP 6.00.48 源码/网络契约是否生成并在逻辑重试中复用 `Idempotency-Key`。若客户端不支持，先制定兼容方案，不得直接开放当前强制要求该 header 的 PUT handler。随后再做 Worker route 接入前的完整契约测试和部署候选评估。

任何 Staging DDL 仍需用户明确批准，并先确认备份/恢复点。

## 6. 本批保护边界

未连接 Cloudflare；未执行 D1 DDL/DML；未访问 Secrets；未修改 Worker binding；未接入正式 Worker route；未部署；未合并 PR。PR #2 保持 Draft/Open/Unmerged。
