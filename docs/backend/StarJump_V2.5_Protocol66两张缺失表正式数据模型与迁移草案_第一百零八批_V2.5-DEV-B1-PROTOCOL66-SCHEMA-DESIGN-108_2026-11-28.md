# 第一百零八批｜Protocol 66 两张缺失表正式数据模型与迁移草案

- 批次：`V2.5-DEV-B1-PROTOCOL66-SCHEMA-DESIGN-108`
- 日期：2026-11-28
- 目标数据库基准：`starjump-staging`（用户提供 schema 快照，非生产库证明）
- 依据：第一百零七批兼容性审计、Protocol66 SQL plan/adapter/service/handler、用户确认的多卡密分组业务规则。
- 本批仅形成数据模型与迁移草案，不执行迁移。

## 1. 两张表的职责边界

### `app_card_group_mappings`

保存“某 VIP 管理员名下某张 APP 卡密，分配了哪些 card 模式分组”的当前/历史关系。

- 一张卡可关联 0..100 个卡密分组。
- 同一张卡与同一分组最多一条映射记录；移除后软删除，重新选择时恢复同一行。
- 必须同时保存 `admin_user_id`，所有读取/写入均按 admin + card 双重隔离。
- 不保存卡密明文，不改变 `app_cards` 的激活/有效期语义。
- 免费分组不写入此表；免费授权由既有免费授权逻辑负责，避免与卡密分组重复计数。

### `app_card_group_admin_requests`

保存管理员对某张卡的分组替换操作幂等凭据。

- 唯一键：`(admin_user_id, request_id)`。
- 保存规范化请求 payload 的 SHA-256 和成功响应摘要；同 key 同 digest 重放成功结果，同 key 不同 digest 返回冲突。
- 不保存卡密明文、密码、session token。
- 请求行必须与映射变化及审计事件处于同一个 D1 原子 batch；任何一步失败整体回滚。
- 应设置保留/清理策略，但不得用定时删除破坏仍可能重试的客户端请求；初期建议至少保留 30 天，具体保留期由产品确认后实现。

## 2. 迁移 SQL 草案（仅审阅，不可直接执行）

以下 DDL 是根据当前 schema 快照和候选 SQL 推导的候选方案。执行前仍需在隔离 SQLite / Staging 备份副本上验证 Cloudflare D1 语法、约束行为和旧数据兼容性。

```sql
CREATE TABLE app_card_group_mappings (
  id TEXT PRIMARY KEY,
  admin_user_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'removed')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  removed_at TEXT,
  UNIQUE (card_id, group_id)
);

CREATE INDEX ix_card_group_mappings_admin_card_status
  ON app_card_group_mappings(admin_user_id, card_id, status);

CREATE INDEX ix_card_group_mappings_group_status
  ON app_card_group_mappings(group_id, status);

CREATE TABLE app_card_group_admin_requests (
  admin_user_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL
    CHECK (length(payload_sha256) = 64),
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (admin_user_id, request_id)
);

CREATE INDEX ix_card_group_admin_requests_created
  ON app_card_group_admin_requests(created_at);
```

### 有意暂不添加外键的原因

当前真实 schema 快照没有展示 `app_cards(id, admin_user_id)` 或 `app_groups(id, admin_user_id)` 复合唯一键，也没有外键约束清单；D1 运行时外键设置及历史数据孤儿情况尚未验证。现阶段由每条读写 SQL 对 card owner、group owner、group mode 做强制谓词，避免引入未经验证的外键迁移副作用。后续若要加外键，必须先检查数据完整性并单独设计兼容迁移。

## 3. 必须先修正/验证的候选实现问题

1. **幂等键来源不充分**：当前 handler 把 `session.requestId` 传给 adapter。该字段通常是服务端请求追踪 ID，不保证客户端重试时保持不变。正式接口应采用客户端每次逻辑操作生成的 `Idempotency-Key`（或请求体中的独立操作 ID），并把服务端 trace/request ID 单独用于日志/审计。必须拒绝空值、过长值及跨管理员复用。
2. **卡密状态语义**：SQL 目前允许 `normal/used`，并排除 `manual_disabled` 与过期卡；必须与现有卡密状态机及用户确认的未激活/激活/失效/手动禁用语义逐项对照，不能只凭候选实现定案。
3. **体验 VIP 规则**：现有 `admin_vip_activations.kind` 有 `trial/formal` 默认 formal；体验期内可完整写操作，过期后只读。上层 `resolveAccess` 必须正确实现此规则，D1 最终断言也必须阻止权限在预检后过期的写入。
4. **幂等响应与审计一致性**：成功响应摘要应与最终实际提交映射一致；审计 before/after 必须来自同一 CAS 快照，不能在并发冲突时写入虚假的审计记录。
5. **映射行 ID**：当前候选 adapter 用 `cgm_${cardId}_${groupId}` 生成 ID；输入各自最多 128 字符，拼接 ID 可能超过任何未来长度约束。建议使用 `crypto.randomUUID()` 或安全随机 ID，并继续依赖 `UNIQUE(card_id, group_id)` 实现稳定 upsert。
6. **空分组替换**：允许清空卡密分组，仍须保留审计记录；不应影响该管理员的免费分组授权。
7. **组重叠展示**：本表只负责每张卡自己的组分配；同一 APP 用户使用同一 VIP 管理员多张有效卡时，聚合/去重及“同名分组（序列号）”展示由 APP 同步层实现，不能在此表里合并卡密关系。

## 4. 业务约束映射

- 同一 APP 用户同一 VIP 管理员多张有效卡：每张卡分别读取自己的 active mapping。
- 同一管理员免费分组：只按既有 `app_free_grants(device_id, admin_user_id)` 一次性授权，不因多张卡重复授权。
- 不同管理员：数据完全隔离，不能因 group 名称相同跨管理员合并。
- 免费组与卡密组：`mode='free'` 不可写入卡密映射；卡密映射只允许同 owner 且 enabled 的 `mode='card'`。
- 卡密停用、作废、手动禁用、过期：拒绝新增/修改映射；具体可恢复状态只遵循现有卡密状态机。
- 管理员 VIP 过期：保留读取权限（按既定产品规则），禁止写入；体验管理员到期同样只读。
- 管理员委托操作：必须在最终 D1 batch 内复核 `admin_user_scopes` 的 owner、target、scope、revoked_at、expires_at。

## 5. 迁移前置验收清单

- [ ] 从真实 Staging 备份副本确认表名不存在（已有 2026-11-28 快照证据）。
- [ ] 评审 DDL 的 D1 支持性、唯一约束、索引、CHECK 约束及迁移幂等策略。
- [ ] 检查 `app_cards`、`app_groups` 真实数据状态值和 owner 完整性（只读）。
- [ ] 修正客户端幂等键与服务端 trace ID 混用问题。
- [ ] 将随机映射 ID、并发 CAS、D1 batch 回滚和审计快照一致性测试补齐。
- [ ] 在隔离 SQLite 测试库运行空库创建、重复迁移、并发写、冲突回滚、审计失败回滚、恢复软删除等测试。
- [ ] 在 Staging 执行前取得用户明确授权并确认备份/恢复点。
- [ ] 迁移后只读复核表/索引结构，再接入 Worker route。
- [ ] 完成 APP 6.00.48 实际客户端契约及端到端验证。

## 6. 本批执行边界

- 已检查 GitHub 中 Protocol66 候选实现和已归档 Staging schema 基准。
- 本批未执行 DDL/DML；未连接 Cloudflare；未读取业务数据或 Secrets。
- 未修改 Worker 路由、未部署、未合并。
- PR #2 保持 Draft/Open/Unmerged。
- 本草案不是可直接复制到 Cloudflare Console 执行的正式迁移脚本。
