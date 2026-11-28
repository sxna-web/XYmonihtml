# 星跃管理平台 V2.5｜第九十六批：Worker Dispatcher、CORS 与异常边界复核

- 批次：`V2.5-DEV-B1-APP-DISPATCH-BOUNDARY-96`
- 日期：2026-11-28
- 分支：`release/v2.5.0-rc1-converge`
- 代码/测试 HEAD：`f9b6b778d7129ca20f9291a0ba22f12c94abe16f`
- CI：PR Convergence Push Run [46130127369](https://github.com/sxna-web/XYmonihtml/actions/runs/46130127369)，Job `140933222894`，SUCCESS

## 本批结论

真实 Worker 已具备可供未来 Protocol66 路由复用的边界：请求先完成 session 解析并形成 `ctxWithReq`；`/api/user/*` 再经过登录、拒绝 legacy token、scope 检查和 `authorizeAppManagementRequest`；各路由响应在 dispatcher 分支处调用一次 `withCors`；handler 抛出的异常进入同一外层 `try/catch`，映射为带 CORS 的 400/409/503/500 响应。

因此，未来最小安全接线点已明确：在 `isUserApi` 内、现有 APP authorization gate 通过且 `ctxWithReq.appAuthorization` 已赋值之后，放在现有 `/api/user/app-cards` 通用 fallback 之前，精确匹配 `/api/user/app-cards/:cardId/groups` 的 GET/PUT；把当前 request、同一个 `ctxWithReq`、已计算的 `appAuthorization` 以及真实 `withCors/fail` 传给 handler/contract。handler 异常应直接向外抛，由 Worker 已有 catch 统一处理；不得在 handler 或新 dispatcher 中重复包装 CORS、重复解析 session/token 或重新计算授权。

## 真实源码核对

1. Session：Worker 在 dispatcher 主体前调用私有 `resolveSession(req, env)`，随后构造 `ctxWithReq`，包含原 session 上下文和 requestId。
2. User gate：`isUserApi(url.pathname)` 分支先拒绝未登录与 legacy ADMIN_TOKEN，再执行 `requireScope`，随后调用 `authorizeAppManagementRequest({ db, path, method, ctx: ctxWithReq })`。
3. APP gate：拒绝 `appAuthorization.allowed === false` 时以 403 + code/VIP state 返回；允许时把授权结果放入 `ctxWithReq.appAuthorization`。
4. 当前 card route：`/api/user/app-cards` 仍统一进入 `userAppCardsRoute`。Protocol66 路由尚未注册；专用 route 必须置于该 fallback 前。
5. CORS：现有 route 分支以 `withCors(await route(...))` 返回；失败响应也由 `withCors(fail(...))` 包装。
6. Exception：dispatcher 外层 catch 对 GUEST_KEY_REQUIRED、SECRET_NOT_CONFIGURED、请求体错误、断言失败分别映射 400/503/400/409；诊断模式返回有限错误详情，否则返回通用 500。以上错误响应均经过 `withCors`。

## 本批变更

仅扩充隔离 contract 测试文件：
`backend/worker/V2.5-DEV-B1-APP-PROTOCOL-66/card-group-admin-dispatch-contract.test.mjs`

新增 3 项针对真实 Worker.js 源码的静态结构回归：
- APP-card route 插入点必须位于 session/user scope/APP authorization gate 之后，并处于旧 card route fallback 之前。
- Worker 外层 catch 必须保留已知错误映射及 CORS 包装。
- 旧 APP-card route 响应必须仍在 dispatcher route 边界包装 CORS，且 route 所在区域仍处于 APP authorization gate 之后。

这三项是源码结构静态回归，不冒充 Cloudflare Workers runtime 集成测试。未修改 Worker.js，未 import dispatcher contract，未注册 Protocol66 route。

## CI 验证

Run `46130127369` / Job `140933222894` SUCCESS：
- Batch49 authorization adapter：15/15
- Worker handler integration：62/62
- Protocol60：19/19
- Protocol64：23/23
- Protocol65：26/26
- Protocol66 handler：21/21
- Protocol66 SQL plan：8/8
- Protocol66 fake-D1 adapter：14/14
- Protocol66 dispatcher contract（含本批 3 项真实 Worker 源码静态回归）：7/7
- Worker bundle、Cron/static、isolated SQLite verifier 与 candidate artifact upload 均通过。

## 限制与安全边界

- 静态源码检查不证明真实 Cloudflare Request/Response、CORS preflight、异常传播和 D1 调用的 runtime 组合行为。
- 第九十五批独立 contract 仍是隔离模块，不是 Worker 的实际运行路径。
- Protocol66 真实 D1 schema-only staging snapshot 仍未取得，候选 D1 adapter 不可据 fixture 认定生产兼容。
- 本批没有接入正式 route，没有连接 staging/production D1，没有执行 SQL/DDL/DML，没有读取业务数据，没有访问 Secrets，没有部署，没有合并。

## 后续唯一接手方向

取得经授权的 staging schema-only snapshot 后，先完成 Protocol66 adapter 的真实 schema 对照；随后在明确批准下，单独实现精确 GET/PUT route 接线和 Worker runtime harness（覆盖真实 gate、CORS 与外层错误映射），通过 CI 后再评估部署候选。PR #2 必须继续 Draft/Open/Unmerged。
