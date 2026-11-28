# 星跃管理平台 V2.5 RC1｜上线前 Cloudflare 只读核对清单

- 批次：第一百零三批
- 标识：V2.5-DEV-B1-CLOUDFLARE-PREFLIGHT-103
- 日期：2026-11-28
- 分支：release/v2.5.0-rc1-converge
- 基线 HEAD：24fcf88bb25fb5f310ae74c4052bbb6bcccb6d1c
- 状态：PREFLIGHT DOCUMENTATION / NOT PRODUCTION APPROVED

## 本批核对结论

1. 当前 RC1 工作流从 backend/worker/V2.5-DEV-B1-CORE-AUTH-49/Worker.js 通过 esbuild 0.25.5 生成单文件 Worker.js；HTML 源文件为 releases/v2.5.0-rc1/index.html。一次 workflow run 上传 Worker.js、index.html、README 为同一 artifact。
2. 仓库当前没有 wrangler.toml / wrangler.jsonc 部署配置。不能从仓库推断生产 Worker 名称、完整 URL、D1 database_id 或环境绑定。
3. Worker 代码使用 D1 binding 名称 DB。正式环境必须继续使用用户现有 DB 绑定与当前数据库目标；禁止改绑 starjump-db，禁止猜测/改绑 staging。
4. GET /health 是代码中可见的健康路由，返回服务标识、版本和 build 信息；该检查只能证明所访问 URL 有响应，不能证明 D1 schema、业务路由或 APK 兼容。
5. HTML API 地址已改为默认留空；不得在未核实的情况下填入猜测的 Worker URL。
6. 生产 D1 schema-only snapshot、APP 6.00.48 客户端契约、真实 Cloudflare runtime/Secrets 兼容性仍未验证。本批不部署、不访问数据库、不读取 Secrets。

## 用户在 Cloudflare Dashboard 的只读核对步骤（手机端可执行）

### A. 复制正式 Worker 完整 URL

1. 登录 Cloudflare Dashboard。
2. 打开 Workers & Pages，进入当前正在承载星跃正式服务的 Worker（不要新建 Worker）。
3. 在 Worker 概览页查看 Domains & Routes / workers.dev 域名，复制页面显示的完整 HTTPS 地址。
4. 只记录完整 URL；不要根据 Worker 名称自行拼接域名，不要把 Staging URL 当正式地址。
5. 若页面没有明确显示正式域名，先停止，不填写 HTML API 地址。

### B. 只读确认 D1 binding

1. 在同一正式 Worker 页面打开 Settings → Bindings（部分界面可能显示为 Variables and Secrets / Bindings）。
2. 找到 D1 database 类型绑定，确认变量名必须为 DB。
3. 点开绑定目标，只记录数据库名称及 Dashboard 可见的数据库标识；核对它是否为当前正式业务数据库。
4. 只查看，不点 Edit、Remove、Add binding；不要选择 starjump-db，不要切换到 Staging。
5. 如果没有 DB、出现多个环境目标不清楚、或数据库名称无法确认，停止上线。

### C. 只读确认备份与回滚点

1. 从 D1 页面打开当前 DB 指向的数据库，查看 Backups / Time Travel（具体入口依账户界面而异）。
2. 记录最近一次可用备份/恢复点的时间，以及界面是否明确显示可恢复；不要执行 Restore。
3. 返回 Worker 的 Deployments / Versions，记录当前 Production deployment 的版本/时间，以及上一份已知可用版本。
4. 只查看，不执行 Rollback、Deploy 或 Promote。
5. 若没有可用备份/恢复点，或找不到上一份可回滚 Worker 版本，停止生产变更。

### D. 回传核对结果（不含任何 Secret）

请只回传以下非敏感信息：
- 正式 Worker 完整 HTTPS URL；
- 绑定变量名（应为 DB）及 Dashboard 显示的 D1 数据库名称/标识；
- 最近可用备份/恢复点时间；
- 当前 Production Worker 版本和上一份可用版本标识。

不要截图或发送任何 Secret、Token、Cookie、数据库内容、用户数据或账号凭据。

## 未来获批部署时的健康检查与回滚原则

- 部署前先确认本批候选 artifact 的 Worker.js 与 index.html 来自同一 GitHub Actions run，且 artifact commit 与最终 PR HEAD 对齐。
- 先在隔离 staging 验证，再由用户明确批准生产操作；本候选目前不满足直接部署条件。
- Worker 更新后仅对已核实 URL 执行 GET /health，核对 ok、service、version、build；再做登录/只读业务冒烟。不得用健康路由代替 D1 schema 验证。
- 若 Worker 新版本异常，回滚到已记录的上一份 Production Worker deployment/version；若 D1 有任何 schema 变更，必须另有经过验证的数据库恢复方案。Worker 回滚不能自动撤销 D1 变更。
- 本候选的迁移路由仍 fail closed（503 MIGRATION_REVIEW_REQUIRED），不应在生产尝试数据库初始化。

## 本批未做事项与阻断项

- 未访问用户 Cloudflare 账号、未读取 Secrets、未查询 D1 内容或 schema。
- 未执行 D1 SQL/DDL/DML、未更改 binding、未部署、未回滚、未合并。
- 未取得真实 D1 schema-only snapshot。
- 未取得 APP 6.00.48 可审计源码并完成 API 契约验证；多卡密分组聚合/卡密分组授权仍是已确认的 APP 核心缺口。
- 因此本批产物是只读核对说明，不代表生产上线批准。
