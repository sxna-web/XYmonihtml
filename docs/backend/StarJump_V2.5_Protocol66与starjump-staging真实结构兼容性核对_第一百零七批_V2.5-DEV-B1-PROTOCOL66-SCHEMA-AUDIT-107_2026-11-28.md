# 第一百零七批｜Protocol 66 与 starjump-staging 真实结构兼容性核对

- 批次：`V2.5-DEV-B1-PROTOCOL66-SCHEMA-AUDIT-107`
- 日期：2026-11-28
- 基线分支：`release/v2.5.0-rc1-converge`
- D1 基准：`starjump-staging`（ID `18f422d4-7a4e-4a39-bca7-eada3a493454`）
- 数据来源：本仓库 Protocol66 候选代码 + 用户提供并归档的 `sqlite_master` 只读快照。
- 本批类型：静态结构兼容性核对；没有修改 Worker 业务代码，没有执行 D1 SQL。

## 结论

**Protocol 66 目前不能接入 `starjump-staging` Worker 路由，也不能部署。** 不是因为已证明所有字段不兼容，而是因为候选 SQL 直接依赖的两张核心表在本次真实 Staging schema 快照中不存在，且候选实现尚未接入 Batch49 Worker。

## 已确认的结构对应关系

| Protocol66 使用对象 | starjump-staging 快照 | 判断 |
|---|---|---|
| `app_cards` | 存在，含 `id/admin_user_id/status/manual_disabled/expires_at` | 候选卡密读取字段在快照中可见 |
| `app_groups` | 存在，含 `id/admin_user_id/name/mode/enabled/sort` | 候选分组读取字段在快照中可见；实际数据是否存在 `mode='card'` 未核实 |
| `admin_vip_activations` | 存在，含 `user_id/starts_at/ends_at/kind` | 候选 VIP 有效期查询字段在快照中可见；体验卡/正式卡业务语义仍须与权限实现对齐 |
| `admin_user_scopes` | 存在，含 scope、撤销及到期字段 | 候选委托授权断言涉及字段在快照中可见 |
| `admin_audit_events` | 存在，含审计主体、动作、目标、请求及前后 JSON 字段；有禁止 UPDATE/DELETE 触发器 | 候选审计 INSERT 字段在快照中可见；必须继续验证完整审计策略 |
| `app_card_group_mappings` | **不存在** | 候选映射读取/写入无法在当前结构执行 |
| `app_card_group_admin_requests` | **不存在** | 候选请求幂等读取/写入无法在当前结构执行 |

## Worker 接入状态

- Batch49 Worker 当前仍由 `userAppCardsRoute` 处理 `/api/user/app-cards...`。
- Worker 源码没有导入或调用 `createCardGroupAdminHandler`。
- 当前 `APP_SCHEMA_DIAGNOSTIC_TABLES` 仅把两张 Protocol66 表列为“存在则观察”的候选对象；诊断不创建表。
- 因此 Protocol66 目录中的 handler/service/adapter/sql-plan 仍是隔离候选实现，不是已上线接口。

## 必须完成的后续工作

1. 依据用户确认的业务规则，完成映射表与幂等表的正式数据模型设计：唯一约束、索引、外键/触发器策略、软删除/恢复语义、管理员归属隔离。
2. 将候选 DDL 与真实快照逐项比较，确认与现有 `admin_audit_events` append-only 触发器兼容；不得直接运行 fixture SQL。
3. 明确旧卡密分组、免费分组与多卡聚合的边界：同一管理员免费组只计一次；同管理员多卡分别取卡密分组；不同管理员隔离；同名分组序列号展示。
4. 对服务端接口补齐真实 Worker.fetch 路由测试、VIP/体验期读写权限测试、委托 scope 测试、并发 CAS/幂等测试和 D1 batch 原子回滚测试。
5. 与 APP 6.00.48 实际客户端契约核对；未验证客户端请求/响应契约前不宣称端到端完成。
6. 只有在迁移 SQL 经审查、备份/恢复点明确且用户明确授权后，才考虑对 Staging 执行迁移；生产部署仍需单独审批。

## 安全边界

- 本次仅读取 GitHub 源码和已归档 schema 文档。
- 未访问 Cloudflare；未执行 D1 查询、DDL、DML、迁移或数据写入。
- 未读取或修改 Secrets、Worker bindings。
- 未部署、未合并、未回滚。
- 不把 Staging schema 视为生产 schema。
- 不允许把 `fixtures/card-group-admin-candidate-schema.sql` 当作真实迁移脚本。

## 本批验收

- [x] 找到候选 SQL 所依赖的表与字段。
- [x] 与用户提供的 Staging schema 基准逐项对照。
- [x] 确认两张候选核心表当前缺失。
- [x] 确认候选 Handler 尚未接入 Worker 路由。
- [x] 将阻塞项和后续接入条件记录到项目文档。
- [ ] Protocol66 已接入真实 Worker。
- [ ] Staging D1 migration 已获批并验证。
- [ ] APP 6.00.48 端到端契约已验证。

**本批结果：结构审计完成；功能接入仍阻塞；不具备部署条件。**
