# 星跃管理平台 V2.5｜APP 卡密分组委托管理员权限与 D1 最终 CAS 边界加固报告（第七十六批）

- 批次：`V2.5-DEV-B1-APP-SCOPE-76`
- 日期：2026-11-28
- 状态：**委托权限边界已补齐；CAS 投影缺陷已修复；最终双 CI 通过**
- 分支：`release/v2.5.0-rc1-converge`
- 最终测试 head：`d795b0e87166b6f2440987f771421adf84b2d608`
- PR #2：Draft / Open / Unmerged

## 1. 本批主要修复

### 1.1 委托身份与生效身份分离

- `adminId` 始终由会话 `effectiveId` 决定，不能从请求体传入。
- 审计 `actorId` 使用会话真实操作者。
- 自己操作时 actorId 与 adminId 相同，不需要委托 scope。
- 超管协助目标 VIP 管理员时，GET 要求有效 read/operate/manage scope；PUT 要求 operate/manage。
- Handler 从 session 取 `scope` 与 `scopeId`；请求体只接收 groupIds。
- Service 对 actor/effective 不同但 scope 缺失、scope 不足或 scopeId 无效的请求直接 403。

### 1.2 D1 最终写入再校验委托 scope

候选 SQL batch 的第一条最终 assertion 增加 `admin_user_scopes` 检查：
- scope id 必须匹配；
- admin_user_id 必须是真实 actor；
- target_user_id 必须是 effective admin；
- revoked_at 必须为空；
- expires_at 必须尚未过期；
- scope 必须是 operate 或 manage。

因此即使请求预检后委托授权被撤销或过期，最终 batch 也必须失败。该 guard 仍处于候选 SQL plan，不代表真实 D1 已验证。

### 1.3 修复 CAS 快照映射投影

Service 的 `loadState` 已将 mapping rows 安全投影成 group objects；因此 CAS snapshot 应从投影对象的 `group.id` 取 group ID，而不是取原始 mapping row 的 `mapping.group_id`。本批修正后，传入 adapter 的 expectedGroupIds 与 SQL CAS 条件使用同一组 group IDs。

### 1.4 D1 SQL plan 文件重建

连续修改期间 SQL plan 文件曾发生尾部重复与模板字符串转义损坏，导致 CI 失败。已完整重建模块并修复语法，且在最终测试 head 重新跑完整 CI。最终文件仅保留一份 statement plan。

## 2. 新增/强化测试

最终相关 Node 测试结果：
- Protocol 66 service/handler：21/21；
- Protocol 66 D1 adapter harness：14/14；
- Protocol 66 SQL plan：8/8。

新增覆盖：
1. CAS 使用 group ID 而不是 mapping row ID；
2. D1 INTEGER enabled/expiry 归一化；
3. 委托操作者无 scope 时不能写；
4. delegated operate scope 可以进入 adapter；
5. delegated read scope 的 PUT 在 handler 层被拒绝；
6. SQL 最终 batch 绑定 actor/effective/scopeId；
7. adapter 的 D1 batch statement 包含 live scope guard。

当前完整回归：
- Python isolated SQLite verifier：46 tests；
- Batch 49 authorization adapter：12/12；
- Batch 49 Worker handler integration：62/62；
- APP Protocol 60：19/19；
- APP Protocol 64：23/23；
- APP Protocol 65：26/26；
- Protocol 66 service/handler：21/21；
- Protocol 66 adapter：14/14；
- Protocol 66 SQL plan：8/8。

## 3. 最终 CI 与候选制品

最终 head：`d795b0e87166b6f2440987f771421adf84b2d608`

- Push Run `46116688615` SUCCESS  
  https://github.com/sxna-web/XYmonihtml/actions/runs/46116688615
- PR Run `46116692609` SUCCESS  
  https://github.com/sxna-web/XYmonihtml/actions/runs/46116692609
- Worker bundle、Cron/static、isolated SQLite、auth adapter、Worker integration、APP contract、Protocol 66 service/adapter/SQL plan、artifact upload 全部通过。
- Artifact：`StarJump-V2.5.0-RC1-candidate` ID `15252361198`，134,139 bytes，expires 2026-12-12T06:27:43Z。

## 4. 仍未完成、不可上线事项

- Protocol 66 仍未注册 Batch 49 正式 Worker 路由。
- `resolveAccess` 仍是注入依赖，未连接生产 VIP/体验卡判定 adapter。
- 候选 mapping/request 表仍无生产 migration；真实 D1 schema snapshot/列索引约束未核验。
- 没有真实 D1 batch rollback、scope revoke race、并发、trigger/FK、旧数据兼容验证。
- 后台 HTML 卡密逐张分组配置 UI 尚未接入。
- APK 多 entitlement 凭据持久化、节点同步 tombstone/24h cleanup ACK 未完成。
- requestId 仍需由正式 Worker 路由层稳定生成并传入；尚未做端到端联调。
- 未执行生产 D1 读写、Secrets 操作、Cloudflare 部署或 PR 合并。

## 5. 下一批（第七十七批）

优先做真实 D1 schema manifest 的只读诊断设计与现有 Worker schema-status 对照：
- 对 `app_cards`、`app_groups`、`admin_vip_activations`、`admin_user_scopes`、`admin_audit_events` 逐列核对；
- 检查候选 `app_card_group_mappings` / `app_card_group_admin_requests` 是否存在，若不存在只报告，不创建；
- 只读收集 PRAGMA table_info、index_list/index_info、foreign_key_list、sqlite_master trigger/index SQL；
- 检查历史重复/孤儿关系和 owner 冲突时仅输出计数与脱敏摘要，不导出 redeem code、session token 或用户敏感值；
- 产出 staging/production 只读诊断 SQL 与人工执行说明，禁止执行 DDL/DML；
- 不注册正式路由、不触碰 Secrets、不连接或写入生产 D1。

---
**结论：** 第七十六批完成委托身份 scope 的 Handler/Service/最终 SQL guard 三层边界，并修复 CAS group ID 投影。最终 Push/PR 双 CI 通过；当前仍为隔离候选实现，不是生产上线功能。
