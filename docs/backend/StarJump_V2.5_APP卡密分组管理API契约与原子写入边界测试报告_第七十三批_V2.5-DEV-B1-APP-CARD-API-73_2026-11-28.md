# 星跃管理平台 V2.5｜APP 卡密分组管理 API 契约与原子写入边界测试报告（第七十三批）

- 批次：`V2.5-DEV-B1-APP-CARD-API-73`
- 日期：2026-11-28
- 状态：**独立 handler/service contract 已编码；15 项测试通过；未接入 Batch 49 正式路由**
- 分支：`release/v2.5.0-rc1-converge`
- 最终测试 head：`02153a1c6304124f466691a75514fcff970c240c`
- PR：#2 Draft/Open/Unmerged

## 1. 新增文件

目录：`backend/worker/V2.5-DEV-B1-APP-PROTOCOL-66/`

- `card-group-admin-service.mjs`
- `card-group-admin-handler.mjs`
- `card-group-admin.test.mjs`

CI 已加入 Protocol 66 测试步骤，并将该目录加入 push 与 pull_request paths。

## 2. 契约行为

- GET：`/api/user/app-cards/{cardId}/groups`，只返回同管理员、`mode='card'` 的组和当前映射；不返回卡密 code、token 或 redeem code。
- PUT：同路径，body 使用明确的 `groupIds` replace semantics；空数组表示清空该卡密的全部专属组；重复 ID、无效 ID、超过 100 项 fail closed。
- 先认证 session，再调用 service；使用 `effectiveId` 作为数据 owner scope，`actorId` 与 `requestId` 用于审计追踪。
- 管理员读取权限与写入权限分离：VIP 到期可只读；写入必须 `canWrite=true`。
- 卡密仅允许 `normal/used` 状态配置；支持已经激活的 used 卡密；inactive、手动禁用、已过期卡密拒绝写入。
- 免费组和 assigned 组不能通过该接口冒充卡密专属组。
- Storage adapter 的正式契约要求在最终 D1 batch 内再次校验当前 VIP/体验权限、卡密状态/过期/手动禁用、卡密与分组 owner、分组 mode/enabled，并将 mapping replace 与 audit INSERT 同批提交。
- requestId 幂等由 adapter 负责；相同 requestId 的重复请求不得重复写审计；相同 requestId 不同 payload 应拒绝为幂等冲突。
- 本模块不提供真实 SQL adapter，不注册正式 Worker route；上述 adapter 原子性要求目前由 contract fixture 模拟，不是 D1 生产实现。

## 3. 测试覆盖

Protocol 66 共 15 项：
1. GET 只返回卡密组且不泄露 redeem code；
2. VIP 到期只读；
3. 跨管理员卡密访问拒绝；
4. 重复 group ID 在写入前拒绝；
5. free/跨管理员 group 拒绝；
6. 已激活的 used 卡密仍可配置；
7. 过期卡密拒绝；
8. inactive/手动禁用卡密拒绝；
9. 成功 replace 由 adapter 原子提交 mapping + audit；
10. VIP 在预检后、commit 前过期时拒绝；
11. batch 失败时 mapping 与 audit 均不提交；
12. 同 requestId 重复请求幂等且只写一次 audit；
13. 空数组明确清空 mapping；
14. Handler 在调用 service 前先认证；
15. Handler PUT 使用明确 groupIds replace contract。

最终结果：**15/15 passed**。

## 4. CI

最终测试 head：`02153a1c6304124f466691a75514fcff970c240c`

- Push Run `46114516960`：SUCCESS  
  https://github.com/sxna-web/XYmonihtml/actions/runs/46114516960
- PR Run `46114520394`：SUCCESS  
  https://github.com/sxna-web/XYmonihtml/actions/runs/46114520394
- Protocol 66 handler/service tests：15/15 passed。
- APP Protocol 65 service tests：26/26 passed。
- Worker bundle、Cron/static regression、isolated SQLite verifier、Batch 49 auth adapter、Worker handler integration、APP v2 contracts、artifact upload 均通过。

注意：Push/PR CI 运行 Node contract fixtures 和 mock adapter，不证明真实 D1 adapter/事务语义已实现。

## 5. 中间失败及修复记录

- 第一轮发现 fixture 将 free group 混入 card-group loader 返回，导致 service 按严格 schema contract fail closed；修正 fixture 只返回 card-mode groups。
- 第二轮发现 service preflight 未保留 adapter 返回的 card expiry flag；补齐状态投影与过期拒绝。
- 第三轮发现 empty replace 测试复用了相同 requestId，违反幂等键约定；改用新 requestId 验证新的 replace 操作。
- 最终 head 双 CI 通过，未通过删减测试掩盖失败。

## 6. 仍未完成 / 不可上线事项

- 无真实 D1 SQL adapter。
- 无 Batch 49 Worker 正式路由注册。
- 无 HTML 卡密逐张分组配置 UI。
- 无生产 schema manifest 或 D1 schema snapshot。
- 无真实 D1 transaction/batch rollback/concurrency 验证。
- 无 APK 多 entitlement 凭据保存与协议联调。
- 旧 `public/assigned/free` 与新 `card/free` 完整兼容策略仍未解决。
- 无生产 D1 读写、无 Secrets 操作、无 Cloudflare 部署、无 PR 合并。

## 7. 下一批

第七十四批优先为 Protocol 66 设计 D1 adapter SQL statement plan 与 isolated SQLite adapter fixture：
- 读取必须按 `admin_user_id + card_id` 双重 owner scope；
- 查询仅取 card mode 分组，free group 仍走单独聚合；
- 写入使用 replace semantics 与最终 owner/card/VIP predicates；
- 使用 D1 `batch` 原子提交 mapping soft-remove/restore/upsert 与审计；
- 以 requestId + canonical payload digest 实现幂等，冲突 payload 拒绝；
- 禁止 SELECT/返回 `app_cards.code`；
- 在没有真实 schema snapshot 前不把 SQL plan 接入 Worker，也不创建生产 migration。

---
**结论：** 第七十三批建立了管理员卡密分组管理的独立 handler/service 契约，并通过 15 项测试。它是下一步真实 D1 adapter 的边界定义，不是正式 API 上线。
