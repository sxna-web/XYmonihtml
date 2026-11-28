# Protocol 66｜候选 D1 SQL 计划（非生产适配器）

本目录的 `card-group-admin-sql-plan.mjs` 仅生成候选 D1 SQL statements，不执行 SQL，也未被 Batch 49 Worker 导入。

## 依赖的候选表

- 历史表：`app_cards`、`app_groups`、`admin_vip_activations`、`admin_audit_events`。
- 候选表：`app_card_group_mappings`、`app_card_group_admin_requests`。
- 新增的幂等表用于唯一约束 `(admin_user_id, request_id)`、保存 payload SHA-256 和成功响应摘要。未确认真实 D1 schema 前，不能部署这些表。

## 写入顺序

1. 最终条件断言：当前 VIP/体验期仍有效、卡密归属/状态/有效期/手动禁用状态、现有映射 CAS 快照、所有目标组同 owner 且 card mode/enabled。
2. 插入 request idempotency row；重复键让整个 batch 失败，调用方 reread 后比较 payload digest。相同 digest 返回已存结果，不同 digest 返回冲突。
3. CAS 成功后软解绑本次未选择的旧映射。
4. upsert 本次目标映射，恢复 removed 行，不物理删除。
5. 同一 batch 插入审计事件。
6. 最后一条 SELECT 返回当前 active mapping rows。

D1 batch 必须整体原子提交。若任何 assertion、唯一约束或 audit insert 失败，mapping、request idempotency row 与 audit 必须整体回滚。

## 关键限制

- VIP 查询采用现有 `admin_vip_activations` 语义：当前时间落在 starts_at/ends_at 区间内的 trial 或 formal 激活均可写；过期只读权限仍需由上层 access adapter 按产品规则提供。
- 卡密 `normal/used` 状态可配置；`inactive`、手动禁用、已过期卡密拒绝。
- 使用 expectedGroupIds 做 compare-and-swap，避免基于旧 UI 快照覆盖另一管理员操作。
- 不查询或返回 `app_cards.code`；序列号脱敏展示不在该 SQL 计划内。
- 计划依赖候选 mapping/request tables 和真实 schema 尚未确认的字段；不允许直接挂入正式 Worker。
- 当前还没有实现真实 D1 adapter 的异常恢复、并发重试、审计前后快照一致性、生产 trigger/foreign key 兼容测试。
