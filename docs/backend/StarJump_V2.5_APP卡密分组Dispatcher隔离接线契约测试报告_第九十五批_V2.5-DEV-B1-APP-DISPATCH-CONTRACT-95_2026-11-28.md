# 星跃管理平台 V2.5｜第九十五批：APP 卡密分组 Dispatcher 隔离接线契约测试

- 批次：`V2.5-DEV-B1-APP-DISPATCH-CONTRACT-95`
- 日期：2026-11-28
- 分支：`release/v2.5.0-rc1-converge`
- 最终 HEAD：`1c14c6a59647580407b66e85cacde7bd2ebcdb47`

## 本批目标与结论

在不把 Protocol66 handler 注册到生产候选 Worker 的前提下，建立可自动回归的隔离 dispatcher contract，验证 APP authorization gate、session context 复用、CORS 包装和异常传播边界。

## 新增文件

- `backend/worker/V2.5-DEV-B1-APP-PROTOCOL-66/card-group-admin-dispatch-contract.mjs`
- `backend/worker/V2.5-DEV-B1-APP-PROTOCOL-66/card-group-admin-dispatch-contract.test.mjs`

新增 contract 明确要求：
1. 缺少已解析 session context 时返回 401，并经过 CORS wrapper。
2. APP authorization 明确拒绝时返回 403，携带拒绝 code/VIP state；handler 和 session resolver 均不得执行。
3. 授权通过时 handler 只能收到原 request，resolveSession closure 返回同一个 `ctxWithReq` 对象引用，不二次解析 token/session。
4. handler 响应只经过一次 CORS wrapper。
5. handler 抛错不被伪装为成功响应；异常交由未来 Worker 外层错误边界处理。

## CI 工作流补齐

首次运行发现新测试文件没有被 convergence workflow 执行；因此本批同步更新 `.github/workflows/v25-rc1-convergence.yml`，将 contract suite 加入 Protocol66 测试步骤。后续最终 run 日志确认命令实际执行。

## 验证结果

- PR Convergence Run [46129796750](https://github.com/sxna-web/XYmonihtml/actions/runs/46129796750)：SUCCESS，匹配最终 HEAD。
- Worker regression job：`140932232824`，SUCCESS。
- 新 dispatcher contract：4/4。
- Batch49 authorization adapter：15/15。
- Worker integration：62/62。
- Database migration/manifest：62/62。
- Protocol60：19/19；Protocol64：23/23；Protocol65：26/26。
- Protocol66 handler：21/21；SQL plan：8/8；fake-D1 adapter：14/14。
- Candidate artifact：`StarJump-V2.5.0-RC1-candidate`，ID `15256773375`，134,348 bytes。

## 严格边界与未完成项

- 该 contract 是隔离的未来接线规范测试；`Worker.js` 本批未 import/调用该 contract，也未注册 Protocol66 正式路由。
- contract test 不等于 Cloudflare Worker runtime 集成测试；真实 CORS 实现、外层异常映射和 D1 handler 尚未在运行时组合验证。
- 真实 staging schema-only snapshot 仍未取得；Protocol66 D1 adapter 仍是候选实现，不能据此确认生产列/索引/约束。
- 未连接 staging/production D1；未执行 SQL/DDL/DML；未读取业务数据；未访问 Secrets；未部署；未合并。

## PR 状态

PR #2 必须继续保持 Draft/Open/Unmerged，不得合并或部署。

## 第九十六批唯一接手卡

复核本批 contract 与真实 Worker dispatcher 现状，重点检查 CORS 与异常处理是否能以纯函数/模块边界安全抽离，并为后续真实 route 接线准备最小差异方案。优先补充测试，不改正式路由；只有 staging schema 证据齐备且用户明确授权后才讨论接线。
