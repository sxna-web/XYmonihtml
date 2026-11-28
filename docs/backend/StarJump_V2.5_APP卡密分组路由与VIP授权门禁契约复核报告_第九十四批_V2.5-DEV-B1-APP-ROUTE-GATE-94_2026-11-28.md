# 星跃管理平台 V2.5｜第九十四批：APP 卡密分组路由与 VIP 授权门禁契约复核

- 批次：`V2.5-DEV-B1-APP-ROUTE-GATE-94`
- 日期：2026-11-28
- 基线：PR #2 分支 `release/v2.5.0-rc1-converge`
- 最终代码/测试 HEAD：`6e74be5bfac0809725f7e01d597ae249db85b86b`

## 本批结论

Protocol66 的卡密分组 PUT 路径此前未被 Batch49 的 `actionFor()` 识别：`/api/user/app-cards/:cardId/groups` 的 PUT 会落入 `null` action，导致 `authorizeAppManagementRequest()` 不执行 APP VIP/体验期授权判断。Worker 通用登录和协助 scope gate 虽仍执行，但不足以替代 APP 管理业务门禁。

本批已将该 PUT 明确归类为 `associate`（配置关联变更），沿用既有 APP 管理授权策略；GET 仍不进入写操作 VIP action 分类，由 Worker 通用 GET=read scope 与 Protocol66 service 的只读访问检查负责。

## 代码变更

1. `backend/worker/V2.5-DEV-B1-CORE-AUTH-49/worker-auth-adapter.mjs`
   - 为 `PUT /api/user/app-cards/:cardId/groups` 增加 `associate` action。
   - 不把该操作误归类为历史删除；因此正式 VIP 到期后的历史删除豁免不会错误放行分组配置修改。
2. `backend/worker/V2.5-DEV-B1-CORE-AUTH-49/worker-auth-adapter.test.mjs`
   - 增加 GET/PUT action 分类断言。
   - 增加有效体验期可执行关联配置、正式 VIP 到期拒绝、VIP 状态查询失败 fail-closed 三项回归。
   - APP authorization adapter 测试由 12 项增至 15 项。

## 接线契约与未完成项

- Worker 仍在 `/api/user/*` dispatcher 中先执行会话校验、legacy 拒绝、通用 scope gate、`authorizeAppManagementRequest`，之后才 dispatch 到旧 `userAppCardsRoute`。
- Protocol66 handler 接口需要 `service` 和 `resolveSession(request)`；Batch49 的 `resolveSession(req, env)` 是 Worker 私有函数，不能从另一模块直接 import。
- 将来若接线，应在上述 gate 之后，把已解析的 `ctxWithReq` 通过闭包提供给 handler resolver；不得二次解析 APP entitlement token，不得信任请求体中的 actor/effectiveId/role/VIP。
- 当前 Worker 尚未 import/register Protocol66 handler；本批只补齐授权分类契约与测试，没有注册正式路由。
- Protocol66 D1 adapter 仍是候选实现。没有真实 staging schema-only snapshot 前，不确认字段/索引/约束，不生成或执行生产 migration。
- 后续正式接线还必须验证 handler 的响应是否统一经过 Worker CORS 包装，以及 APP authorization 结果是否在 dispatch 边界被可靠保留；本批不把单测视为完整 Worker runtime 集成。

## CI 证据

- PR Convergence Run [46129111203](https://github.com/sxna-web/XYmonihtml/actions/runs/46129111203)：SUCCESS，匹配最终代码/测试 HEAD。
- Worker regression job：`140930174943`，SUCCESS。
- Batch49 APP authorization adapter：15/15；Worker integration：62/62；database migration/manifest：62/62；Protocol60：19/19；Protocol64：23/23；Protocol65：26/26；Protocol66 handler：21/21；Protocol66 SQL plan：8/8；Protocol66 fake-D1 adapter：14/14。
- Artifact：`StarJump-V2.5.0-RC1-candidate`，ID `15257161887`，134,348 bytes。
- 以上是仓库 CI、mock Worker 与隔离 fixture 测试，不代表真实 Cloudflare D1 或 Worker runtime 已验证。

## 安全边界

未连接 staging/production D1；未读取或写入业务数据；未执行 SQL/DDL/DML；未访问 Secrets；未部署；未合并。PR #2 保持 Draft/Open/Unmerged。
