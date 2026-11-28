# 星跃管理平台 V2.5｜第九十八批：Protocol66 Dispatcher 负向安全组合测试

- 批次：`V2.5-DEV-B1-APP-DISPATCH-NEGATIVE-98`
- 日期：2026-11-28
- 分支：`release/v2.5.0-rc1-converge`
- 代码/测试 HEAD：`b7b77cc9fb6d12ddb4a3f68c2c22368cfc1531f1`
- PR convergence：Run [46130703278](https://github.com/sxna-web/XYmonihtml/actions/runs/46130703278)，SUCCESS
- Worker regression：Run [46130703249](https://github.com/sxna-web/XYmonihtml/actions/runs/46130703249)，SUCCESS

## 本批变更

仅修改：
`backend/worker/V2.5-DEV-B1-APP-PROTOCOL-66/card-group-admin-dispatch-contract.test.mjs`

新增 3 项负向安全组合测试：

1. **Request identity mismatch：**恶意/错误 handler 尝试使用不同 Request 调用 session resolver，必须抛出 `REQUEST_CONTEXT_MISMATCH`；不进入 session resolver 成功路径，不执行 CORS 或 fail 成功包装。
2. **APP authorization deny：**使用真实 `createCardGroupAdminHandler` 组合 dispatcher，APP 授权拒绝返回 403，Protocol66 service 调用次数必须为 0。
3. **Scope deny：**静态核对真实 Worker.js，scopeDenied 分支必须先审计并 CORS 返回，且位于 APP authorization 和 APP-card route dispatch 之前；拒绝分支内不得执行 APP authorization 或旧 card handler。

dispatcher contract suite 从 9/9 增至 **12/12**。

## CI 验证

Worker regression Run `46130703249` / Job `140934989272` SUCCESS，日志确认：
- Batch49 authorization adapter：15/15
- Worker handler integration：62/62
- Protocol60：19/19
- Protocol64：23/23
- Protocol65：26/26
- Protocol66 handler：21/21
- Protocol66 SQL plan：8/8
- Protocol66 fake-D1 adapter：14/14
- Dispatcher + real handler composition + negative cases：12/12
- Worker bundle、Cron/static、isolated SQLite verifier 与 candidate artifact upload 通过。

PR convergence Run `46130703278` SUCCESS。

## 边界与阻塞

本批测试仍分为 Node 隔离组合和真实 Worker.js 静态结构回归，不是 Cloudflare Workers runtime 集成测试。没有 staging schema-only snapshot 证据，Protocol66 生产 D1 schema 仍 NOT VERIFIED；不能据此生成生产 migration 或接入正式 route。

未连接 staging/production D1，未执行 SQL/DDL/DML，未读取业务数据，未访问 Secrets，未部署，未合并。PR #2 必须保持 Draft/Open/Unmerged。

## 下一批接手方向

先核对最新 PR HEAD/CI。继续评估最小 Worker runtime harness 是否能在本地模拟 Cloudflare module worker 的真实 fetch 入口和 Response/CORS/error boundary；若依赖不齐或会把模拟误称 runtime，则只补可验证的隔离测试并清楚标注。真实 schema 未确认前不注册正式 route。
