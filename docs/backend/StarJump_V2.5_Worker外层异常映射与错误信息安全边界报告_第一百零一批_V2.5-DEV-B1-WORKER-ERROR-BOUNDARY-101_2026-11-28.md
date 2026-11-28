# 星跃管理平台 V2.5｜第一百零一批：Worker 外层异常映射与错误信息安全边界

- 批次：`V2.5-DEV-B1-WORKER-ERROR-BOUNDARY-101`
- 日期：2026-11-28
- 分支：`release/v2.5.0-rc1-converge`
- 最终代码/测试 HEAD：`80bba0868041e296370b64df9c93270a77951132`
- PR：#2（Draft / Open / Unmerged）
- Worker regression Run [46131727106](https://github.com/sxna-web/XYmonihtml/actions/runs/46131727106) / Job `140938148012`：SUCCESS
- PR convergence Run [46131731115](https://github.com/sxna-web/XYmonihtml/actions/runs/46131731115)：SUCCESS
- APP Identity contract Run [46131731107](https://github.com/sxna-web/XYmonihtml/actions/runs/46131731107)：SUCCESS

## 本批完成

### 1. 修复公开订阅短链异常消息泄露

文件：`backend/worker/V2.5-DEV-B1-CORE-AUTH-49/Worker.js`

- `/c/:id` 的外层异常捕获不再把异常 message 截取后直接返回。
- 统一返回通用错误信息与 `INTERNAL_ERROR`，状态码 500。
- 允许 Origin 的 CORS 仍由同一 Worker 响应边界保留。

### 2. 收紧 DIAGNOSTICS 响应

- `DIAGNOSTICS=1` 不再把内部异常 message、D1 SQL 错误细节或截断后的 detail 返回客户端。
- 仅在服务端日志记录 requestId 与错误类型，不记录异常 message。
- 客户端仍收到通用 500 / `INTERNAL_ERROR` 响应；不依赖生产环境是否误开诊断开关来保证错误信息安全。

### 3. 真实 Worker.fetch 入口测试

文件：`backend/worker/V2.5-DEV-B1-CORE-AUTH-49/worker-handler.integration.test.mjs`

新增 3 项：
1. 公开订阅短链 D1 异常：通用 500、不含内部错误文本、合法 Origin CORS 保留。
2. 已认证用户路由的 D1 异常：外层统一 500、不含内部错误文本、合法 Origin CORS 保留。
3. `DIAGNOSTICS=1`：不返回内部异常 detail，仍保留 CORS。

Worker fetch + handler integration suite：69/69 → 72/72。

### 4. 静态 contract 同步

文件：`backend/worker/V2.5-DEV-B1-APP-PROTOCOL-66/card-group-admin-dispatch-contract.test.mjs`

- 更新旧断言：不再要求诊断响应返回内部 JSON detail。
- 改为要求通用 `INTERNAL_ERROR` 且不得回显异常 message。
- Dispatcher contract suite 保持 12/12。

## CI 结果

Worker regression Run `46131727106` / Job `140938148012` SUCCESS：
- Batch49 authorization adapter：15/15
- Worker fetch + handler integration：72/72
- Protocol60：19/19
- Protocol64：23/23
- Protocol65：26/26
- Protocol66 handler：21/21
- Protocol66 SQL plan：8/8
- Protocol66 fake-D1 adapter：14/14
- Protocol66 dispatcher contract：12/12
- Worker bundle 语法检查通过；Cron/static、隔离 SQLite verifier 与 candidate artifact upload 通过。

CI 生成的单文件 Worker bundle 使用 esbuild 0.25.5，从 Batch49 Worker.js 构建，输出约 305.0 KB。候选 artifact：`StarJump-V2.5.0-RC1-candidate`，Artifact ID `15257806718`，上传 ZIP SHA-256：`0a553f5be121ad9c4b1b71fc18a599b03f7f511df9317f5936a705c74fa46b47`。该 artifact 是内部 RC 候选，不代表生产批准。

## 失败与修正记录

第一轮 Worker regression 暴露 Protocol66 静态 contract 仍断言诊断响应必须调用 `withCors(json(...)))。该旧断言与本批“诊断信息不回显”的安全修复冲突，已将 contract 更新为验证通用错误码和无 detail；随后最终 HEAD 的 Worker regression 与两项 PR 检查全部成功。

## 验证边界与未完成事项

- 入口测试使用 Node 22 原生 Request/Response 和 mock D1；不是 Cloudflare workerd/Workers isolate，也不是 staging/production D1 实测。
- 本批证明异常响应不回显内部异常消息，并保留测试所覆盖的合法 Origin CORS；不证明所有路由的多语句写入都已完成真实 D1 原子性验证。
- D1 运行时异常目前按通用 500 处理；只有明确识别的密钥配置错误返回 503。没有凭未经证实的 D1 错误字符串将所有数据库异常误判为可重试 503。
- 未取得真实 staging schema-only snapshot；Protocol66 正式 route/migration 仍不得接入。
- 未连接 staging/production D1，未执行真实 SQL/DDL/DML，未读取业务数据，未访问 Secrets，未部署，未合并。
- PR #2 保持 Draft / Open / Unmerged。

## 第一百零二批上线冲刺接手方向

先做发布候选一致性与生产阻断项清点：核对 CI 生成的 Worker bundle、HTML、README 是否对应同一最终 HEAD；梳理生产 HTML API 根地址、真实 D1 schema-only 快照、APP 客户端接口契约三项阻断证据。只处理会阻止首个安全版本上线的事项，不扩展无关测试。
