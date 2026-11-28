# 星跃管理平台 V2.5｜第九十七批：Protocol66 真实 Handler 与 Dispatcher 组合隔离验证

- 批次：`V2.5-DEV-B1-APP-DISPATCH-COMPOSE-97`
- 日期：2026-11-28
- 分支：`release/v2.5.0-rc1-converge`
- 代码/测试 HEAD：`df063afd71a9b54ee32a3f324d2849e9930c4d50`
- Worker regression：Run [46130500550](https://github.com/sxna-web/XYmonihtml/actions/runs/46130500550)，Job `140934346562`，SUCCESS

## 本批推进

第九十六批已经确定未来 route 的插入位置，但此前只测试了独立 contract callback，并未把 Protocol66 实际 handler 工厂纳入组合验证。本批新增真实组合测试：使用 `createCardGroupAdminHandler` 创建 handler，再由 dispatcher contract 提供已解析 session closure，验证请求确实进入 handler、session context 只复用一次、服务参数来自同一个管理员上下文、响应只经过一次 CORS wrapper。

新增测试位于：
`backend/worker/V2.5-DEV-B1-APP-PROTOCOL-66/card-group-admin-dispatch-contract.test.mjs`

## 新增验证

1. **真实 handler 成功路径：**通过 dispatcher contract 调用实际 `createCardGroupAdminHandler`，GET card groups 返回 200；service 收到 `admin-1` 和指定 cardId；响应携带 CORS header；CORS wrapper 恰好调用一次。
2. **真实 handler 异常路径：**service 抛出异常时，异常原样传播出 contract；contract 不擅自伪造成功、不提前转换错误、不重复包装 CORS，保留 Worker 外层 catch 的统一错误映射职责。

dispatcher contract suite 从 7 项增至 **9/9**。

## CI

Run `46130500550` / Job `140934346562` SUCCESS：
- Batch49 authorization adapter：15/15
- Worker handler integration：62/62
- Protocol60：19/19
- Protocol64：23/23
- Protocol65：26/26
- Protocol66 handler：21/21
- Protocol66 SQL plan：8/8
- Protocol66 fake-D1 adapter：14/14
- Protocol66 dispatcher + real handler composition：9/9
- Worker bundle、Cron/static、isolated SQLite verifier 与候选 artifact upload 均通过。

## 当前仍然不能做的事

本批是 Node 隔离组合测试，真实 Worker.js 尚未 import/注册 Protocol66 handler，也未在 Cloudflare Workers runtime 中执行真实 Request/Response 与 D1 binding。第九十三批报告明确记载：没有真实 staging schema-only snapshot 文件；本次仓库检查也只找到该报告，没有发现快照 JSON/manifest。因此真实 schema 仍 NOT VERIFIED。

不能据此生成生产 migration、宣称 D1 兼容或提前注册正式 route。未连接 staging/production D1，未执行 SQL/DDL/DML，未读取业务数据，未访问 Secrets，未部署，未合并。

## 下一批

先核对最新 PR HEAD 和 CI；在不改 Worker route 的前提下，补充对 dispatcher 关键不变量的负向组合测试（session/request identity mismatch、authorization deny 不进入 handler、scope 已拒绝时不进入 handler）。若仍无真实 staging snapshot，继续保留正式 route / migration 暂停状态。
