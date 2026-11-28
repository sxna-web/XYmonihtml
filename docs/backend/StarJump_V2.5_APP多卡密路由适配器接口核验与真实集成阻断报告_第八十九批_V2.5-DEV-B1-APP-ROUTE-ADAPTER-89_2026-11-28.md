# 星跃管理平台 V2.5｜APP 多卡密路由适配器接口核验与真实集成阻断报告

- 批次：第八十九批
- 版本：`V2.5-DEV-B1-APP-ROUTE-ADAPTER-89`
- 日期：2026-11-28
- 基线分支：`release/v2.5.0-rc1-converge`
- 核验 HEAD：`cc81ab03af9fb53af985a14a7e93521880cbb76f`
- 状态：`READ_ONLY_INTERFACE_AUDIT_COMPLETE / PROTOCOL65_HANDLER_SERVICE_CONTRACT_MATCH / PROTOCOL66_CARD_ADMIN_SOURCE_NOT_PRESENT_AT_HEAD / REAL_D1_ADAPTER_BLOCKED / NO_NEW_CI / NOT_DEPLOYABLE`

## 1. 开始前核对

- PR #2 当前仍为 Draft / Open / Unmerged，未合并。
- 远端当前 HEAD 为 `cc81ab03af9fb53af985a14a7e93521880cbb76f`，与上批记录的 `b70ced6...` 不同；本批以实际远端 HEAD 为准。
- PR 描述中的旧 head/CI 记录不是本批代码验证证据。
- 本批只读源码和目录树；没有改主分支，没有部署，没有连接 D1，没有访问 Secrets。

## 2. Batch49 Session 与身份接口

文件：`backend/worker/V2.5-DEV-B1-CORE-AUTH-49/Worker.js`

实际私有函数签名：
- `resolveSession(req, env)` → null 或 session context。
- context 字段：`actorId`、`effectiveId`、`scope`、`isSuper`、`session`、`legacy`。
- `requireScope(ctx, need)` → null 或 HTTP Response。
- `scopeGuardStmt(db, ctx)` → D1 PreparedStatement 或 null。
- `userBatch(db, ctx, stmts)` → `db.batch(...)` 的结果 Promise。
- `hasScopeGrant(db, adminId, targetUserId, need)` → boolean。

身份语义：
- 普通会话：actorId = effectiveId = session.user_id。
- 超管协助：actorId 是真实超管，effectiveId 是目标用户，scope 来自 `admin_user_scopes`。
- 协助会话在 Session 解析阶段检查 scope 记录有效性；用户态写入的 `userBatch` 再把 scope guard 放进同一 D1 batch。
- `ADMIN_TOKEN` legacy context 不适用于用户态管理 API；`/api/user/*` 明确拒绝 legacy token。
- Worker 没有导出这些私有函数，也没有一个可供 Protocol65/66 直接调用的公开 session-resolver module。

## 3. Worker dispatcher 实际路径

- Worker 入口先执行 `resolveSession(req, env)`，再按路径分派。
- `/api/app/*` 是公开 APP 客户端路由区，位于 `/api/user/*` Session/VIP/assist-scope gate 之前；现有 APP 客户端凭证走独立 entitlement Token 校验，不应把 APP entitlement Token 当后台 Session。
- 当前 dispatcher 明确注册旧路径：`/api/app/resolve`、`/api/app/groups`、`/api/app/free`、`/api/app/links`、`/api/app/nodes` 及 redeem/status 等。
- 当前 Worker 中未找到 `/api/app/v2/groups/composed`、`createComposedGroupsHandler` 或 Protocol65 handler 注册。
- 旧 `/api/app/nodes` 仍按 device 取最新一条 active entitlement（`ORDER BY created_at DESC LIMIT 1`），再按该管理员的来源归属加载节点；不是多卡密组合，也不是卡密分组映射读取。
- 旧 APP group mode 常量仍是 `public / assigned / free`；没有证据可将 Protocol66 候选 `card` mode 直接映射到旧 mode。

## 4. Protocol65 handler/service 接口兼容性

文件：
- `backend/worker/V2.5-DEV-B1-APP-PROTOCOL-65/composed-groups-handler.mjs`
- `backend/worker/V2.5-DEV-B1-APP-PROTOCOL-65/composed-group-service.mjs`
- `backend/worker/V2.5-DEV-B1-APP-PROTOCOL-64/entitlement-token-adapter.mjs`

已确认的接口关系：
1. Protocol65 handler 只要求注入 `composeGroups({ deviceId, credentials })`。
2. Protocol65 service factory 要求四个依赖：`resolveEntitlement`、`classifyEntitlement`、`loadGroupsForEntitlement`、`loadCardSerialLabel`。
3. Protocol65 service 的 resolver 调用形状为 `resolveEntitlement({ entitlementId, deviceId, token })`。
4. Protocol64 `createEntitlementTokenAdapter({ db, env, now })` 返回的 resolver 使用完全相同的参数形状，因此该 resolver 可以作为 Protocol65 的 `resolveEntitlement` 注入；它独立使用 `APP_ENTITLEMENT_SECRET`，不是后台 `SESSION_PEPPER`。
5. 其余三个依赖没有可直接复用的完整生产实现。Protocol64 单 entitlement `loadGroups(entitlement)` 返回 `groups / allowedGroupIds / generation`，而 Protocol65 需要按 entitlement 明确分离的 `cardGroups / freeGroups / allowedGroupIds`；不能把两个形状直接互换。
6. Protocol65 的 `classifyEntitlement` 必须由可信服务端记录分类 CARD/IDENTITY；`loadCardSerialLabel` 必须只返回安全序列号标签。当前未发现可证明这两个依赖已完成生产接线的实现。

因此：**resolver 单项兼容已确认；完整 service adapter 不兼容/不完整；HTTP handler 本身可接收 service 返回函数，但 Worker 尚未注册路由。**

## 5. Protocol66 卡密分组管理端接口复核

在当前 HEAD 的递归目录树中，未找到此前描述的独立 Protocol66 card-group admin handler/service/D1 adapter/SQL plan 文件。可见的 `APP-IDENTITY-66` 目录是 identity binding service，不是 card-group admin 实现。

因此本批不能从当前 HEAD 核实 Protocol66 的真实文件签名，也不能声称其已存在于当前候选分支。需先确认该实现是否位于其他分支/提交，或是否尚未被 cherry-pick 到当前候选分支；不能据旧批次摘要推定当前文件存在。

## 6. 可实施边界与本批决策

- 不新增一个仅把两个现有 factory 串起来的薄 wrapper：它不会补齐缺失的可信分类、card/free group loader、serial label、真实 D1 mapping，也不会解决 Worker 路由注册；新增此类代码和重复 mock 测试没有实质集成价值。
- 可以在不碰 D1 schema 的前提下，后续实现纯依赖注入的 Worker route adapter，但前提是先有明确且完整的生产依赖接口与错误语义；当前缺少的不是 handler 包装，而是生产数据读取与授权分类。
- 真实集成前必须取得隔离 staging 的 schema-only snapshot，并确认其绑定确属 staging；随后核对旧 group mode 与 card mapping 的兼容/迁移策略，再实现真实 mapping loader 与分类器。
- 不允许使用旧 `/api/app/nodes` latest-entitlement 查询作为多卡密 fallback。

## 7. 阻断项

1. 当前候选 HEAD 未包含可核验的 Protocol66 card-group admin handler/service/adapter 文件。
2. 真实 staging schema-only snapshot 尚未取得。
3. Protocol65 的 CARD/IDENTITY 分类、card/free 分组加载、serial label 没有完整生产 adapter。
4. `app_groups.mode='card'` 与旧 `public/assigned/free` 的兼容策略未冻结。
5. Worker 尚未注册 Protocol65 新路由；旧 APP nodes/groups 路径仍 latest-only/legacy。
6. APK 多凭据保存、提交、同步及 tombstone/cleanup ACK 仍未端到端验证。
7. D1-001..034 仍是证据案例编号，不是 statement IDs；Batch85 manifests 仍无 SQL statements。

## 8. 验证与影响

- 本批为 GitHub 源码只读核验，没有新增代码测试，因此 **无本批 CI**。
- 未访问真实 D1/staging/production 数据；未执行 SQL/DDL/DML/migration。
- 未访问/读取/修改 Cloudflare Secrets。
- 未修改 Worker、HTML、APK、Room、生产配置；未部署、未合并。
- PR #2 保持 Draft/Open/Unmerged。

## 9. 下一批唯一接手卡

**第九十批：取得 Protocol66 card-group admin 实际源码来源并核对当前分支差异；同时准备 staging schema-only 快照接收与核对清单。** 只在源码可核验、环境明确为隔离 staging 后继续；没有真实 schema 前不创建 migration、不注册依赖真实 D1 的正式路由、不部署。
