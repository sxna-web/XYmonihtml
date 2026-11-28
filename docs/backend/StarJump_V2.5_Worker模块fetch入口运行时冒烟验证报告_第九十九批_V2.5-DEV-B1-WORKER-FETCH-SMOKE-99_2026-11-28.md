# 星跃管理平台 V2.5｜第九十九批：Worker 模块 fetch 入口运行时冒烟验证

- 批次：`V2.5-DEV-B1-WORKER-FETCH-SMOKE-99`
- 日期：2026-11-28
- 分支：`release/v2.5.0-rc1-converge`
- 代码/测试 HEAD：`f4a84dd4e3baad3c69d8d9724c00a034c594d21c`
- Worker regression：Run [46131071731](https://github.com/sxna-web/XYmonihtml/actions/runs/46131071731)，Job `140936108198`，SUCCESS

## 本批变更

仅修改：
`backend/worker/V2.5-DEV-B1-CORE-AUTH-49/worker-handler.integration.test.mjs`

利用测试文件现有的 `import worker from "./Worker.js"`，直接调用真实导出对象的 `worker.fetch(Request, env)`，使用 Node 22 原生 Request/Response Web API，新增 4 项入口冒烟测试：

1. GET `/health`：验证实际模块入口响应状态、候选版本、服务标识、no-store 与允许 Origin 的 CORS。
2. OPTIONS 预检：验证允许 Origin 返回 204、允许方法包含 PUT，且不需要 D1。
3. 非允许 Origin 预检：验证返回 403 且不泄露 allow-origin。
4. API 请求缺少 DB binding：验证真实入口按既有逻辑返回 500 JSON，并保留允许 Origin 的 CORS。

Worker handler integration suite 从 62/62 增至 **66/66**。

## CI 验证

Run `46131071731` / Job `140936108198` SUCCESS：
- Batch49 authorization adapter：15/15
- Worker module fetch + handler integration：66/66（本批新增 4 项全部通过）
- Protocol60：19/19
- Protocol64：23/23
- Protocol65：26/26
- Protocol66 handler：21/21
- Protocol66 SQL plan：8/8
- Protocol66 fake-D1 adapter：14/14
- Protocol66 dispatcher composition/negative contract：12/12
- Worker bundle、Cron/static、isolated SQLite verifier 与候选 artifact upload 通过。

## 运行时证据边界

本批是真实导入候选 Worker.js 并调用其导出 `fetch` 的 Node 22 Web API 入口测试，不再只是对 Worker 源码做静态文本匹配；但它**不是 Cloudflare workerd/Workers isolate**，也没有真实 D1 binding、Cloudflare Secrets 或生产环境运行证据。现有 fake-D1 handler integration 仍仅为隔离测试。

因此本批不能证明真实 Cloudflare 部署行为，也不能替代 staging smoke test。未连接 staging/production D1，未执行真实 SQL/DDL/DML，未读取业务数据，未访问 Secrets，未部署，未合并。

## 下一批接手方向

先核对最新 PR HEAD/CI。继续增强真实导出 Worker.fetch 的请求路径测试，优先覆盖 API session 缺失/无效、Origin 拒绝、外层错误映射与 APP authorization 拦截；评估是否能在不引入未经审查依赖的前提下运行 workerd/Miniflare。没有真实 staging schema-only snapshot 之前，禁止正式注册 Protocol66 route 或生成生产 migration。
