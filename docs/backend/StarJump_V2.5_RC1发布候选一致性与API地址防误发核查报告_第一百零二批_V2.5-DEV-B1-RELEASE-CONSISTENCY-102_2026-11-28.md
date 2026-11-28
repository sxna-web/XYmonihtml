# 星跃管理平台 V2.5｜第一百零二批：RC1 发布候选一致性与 API 地址防误发核查

- 批次：`V2.5-DEV-B1-RELEASE-CONSISTENCY-102`
- 日期：2026-11-28
- 分支：`release/v2.5.0-rc1-converge`
- 最终代码/文档 HEAD：`1cc7e162dd6b951de616f44713c4177d7e680554`
- PR #2：Open / Draft / Unmerged
- Push RC1 convergence Run [46132119840](https://github.com/sxna-web/XYmonihtml/actions/runs/46132119840)：SUCCESS
- PR RC1 convergence Run [46132123550](https://github.com/sxna-web/XYmonihtml/actions/runs/46132123550)：SUCCESS
- PR APP Identity 86 Offline Checkpoint Run [46132123587](https://github.com/sxna-web/XYmonihtml/actions/runs/46132123587)：SUCCESS

## 1. 发布一致性核查

核对 `.github/workflows/v25-rc1-convergence.yml`：

- workflow 在单次 checkout 的同一 commit 上构建 Batch49 Worker.js，固定使用 esbuild 0.25.5。
- 同一 workflow run 将 CI 生成的 `releases/v2.5.0-rc1/Worker.js`、仓库内 `index.html`、`README_RC1内部验收说明.md` 一起上传。
- Worker.js 是 CI 生成的 bundle，不要求作为源码提交在仓库；不能将旧 run 的 Worker.js 与新 HEAD 的 HTML 手工拼包。
- 本批最终 artifact 对应同一最终 HEAD `1cc7e162dd6b951de616f44713c4177d7e680554`。

## 2. 修复 HTML API 地址误发风险

文件：`releases/v2.5.0-rc1/index.html`

- 登录页 API 地址默认值由 Staging URL 改为空值。
- 不再猜测或拼接生产 Worker 完整 URL。
- 加载页面时识别并清除旧版 `localStorage.sj-api` 中主机名包含 `starjump-api-staging` 的已知 Staging 地址。
- 其他已保存地址仍保留，用户可以核实后修改。
- 用户手动清空 API 地址时同步移除 localStorage 保存值。
- API 地址为空时，`apiUrl()` 明确阻止请求并提示先填写、核实正式 Worker 根地址。
- 用户手动输入 HTTPS Worker 根地址后仍按原逻辑保存；不影响用户主动选择测试环境的能力。

## 3. 自动化防回归

文件：`scripts/rc1_cron_no_source_regression.py`

新增静态断言：
- HTML 不得内置 Staging API 默认值；
- 必须清除已知旧 Staging localStorage 地址；
- 空 API 地址必须停止请求；
- 页面必须提示用户明确配置 Worker 根地址。

CI 验证：
- Worker source syntax、self-contained bundle syntax：通过。
- HTML inline JavaScript：3 个脚本全部通过 Node syntax check。
- API base 配置、Cron 无来源维护、APP token secret 顺序、只读数据库迁移与 40 张表静态证据清单：通过。

## 4. 最终构建与测试

Run `46132119840` / Job `140939359665` SUCCESS：
- Batch49 authorization adapter：15/15
- Worker fetch + handler integration：72/72
- Protocol60：19/19
- Protocol64：23/23
- Protocol65：26/26
- Protocol66 handler：21/21
- Protocol66 SQL plan：8/8
- Protocol66 fake-D1 adapter：14/14
- Protocol66 dispatcher contract：12/12
- Worker bundle：约 305.0 KB，构建通过。
- HTML 内联脚本 3/3 语法检查通过。
- Candidate artifact upload 成功。

候选 artifact：
- 名称：`StarJump-V2.5.0-RC1-candidate`
- Artifact ID：`15257853344`
- 对应 Run：[46132119840](https://github.com/sxna-web/XYmonihtml/actions/runs/46132119840)
- Artifact 下载页：https://github.com/sxna-web/XYmonihtml/actions/runs/46132119840/artifacts/15257853344
- ZIP SHA-256：`0b46ca3dfa050f268bd90a6df582296b6a9ed9e0bda67ad2da3c47fd07e76bda`
- 上传 ZIP 大小：134,963 bytes
- 包含 Worker.js、index.html、README；应从该同一 Run 下载，不要与其他 Run 的产物混用。

## 5. 仍未解除的生产阻断项

1. **生产 API 根 URL 未确认：**已知主机名标识 `blackstarjump-api-dawn-1242`，但完整 HTTPS Worker 根 URL 没有可靠证据。当前 HTML 留空是防误发措施，不代表已配置生产地址。
2. **真实 D1 schema 未验证：**仍没有用户提供/授权取得的真实 staging schema-only snapshot。静态 40 表清单和本地 SQLite fixture 不等于生产 D1 schema。
3. **APP 客户端契约未闭环：**现有可审计 6.00.47 源码没有调用 APP v2 identity/entitlement API；6.00.48 尚未完成源码审计。不能宣称 APP 多卡密分组功能已与客户端联调。
4. **Cloudflare 运行时与 Secrets 未验证：**本批 CI 是 GitHub runner 离线/模拟验证，不是 workerd 或真实 Cloudflare 环境测试。

## 6. 未执行事项

未连接 staging/production D1；未执行 SQL/DDL/DML；未访问业务数据或 Secrets；未更改 D1 binding；未部署 Worker/HTML；未合并 PR。PR #2 继续 Draft/Open/Unmerged。

## 7. 第一百零三批上线冲刺方向

不再扩展一般性测试。优先准备最小的用户侧只读核对清单，明确如何在 Cloudflare Dashboard 中核实当前正式 Worker 根 URL、D1 binding `DB` 的数据库目标及备份/回滚点；不要求用户提供 Secret，不执行写入。APP 6.00.48 源码若无法从当前仓库读取，则明确列为外部输入阻断，不用猜测替代。
