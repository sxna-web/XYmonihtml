# 第一百一十批｜Protocol 66 委托权限撤销与幂等重放复核修复报告

- 批次：`V2.5-DEV-B1-PROTOCOL66-SCOPE-REPLAY-110`
- 日期：2026-11-28
- 分支：`release/v2.5.0-rc1-converge`
- 最终提交：`f33a9d75bb0bf37463c877834daedf80af194b09`
- 数据库依据：`docs/backend/StarJump_V2.5_starjump-staging_D1结构基准快照_2026-11-28.md`；已复核真实 `admin_user_scopes` 字段：id/admin_user_id/target_user_id/scope/expires_at/revoked_at。

## 1. 问题与修复

此前 adapter 在发现幂等记录后直接返回历史成功响应。对于委托管理员，若其 scope 在首次操作后被撤销或过期，重复请求可能绕过 scope 的最终授权检查。

本批在 adapter 的幂等记录查询之前增加实时委托 scope 查询：

- 委托身份必须匹配 `admin_user_scopes.id`、`admin_user_id`、`target_user_id`。
- scope 仅允许 `operate` 或 `manage`。
- 必须 `revoked_at IS NULL`。
- `expires_at` 必须为空或晚于当前数据库时间。
- 查询失败返回 `SCOPE_CHECK_UNAVAILABLE`，权限不存在/撤销/过期返回 `SCOPE_INSUFFICIENT`；均不得重放旧成功结果。
- 管理员本人操作（actorId === adminId）不额外查询委托 scope。
- 首次委托写操作仍保留原有 D1 batch 内最终 scope guard，避免预检后撤权造成 TOCTOU 写入。

## 2. 新增回归

- 已撤销 scope + 已存在相同幂等键/相同 payload 的旧成功记录：拒绝重放。
- 已过期 scope + 已存在旧成功记录：拒绝重放。
- 有效委托 scope：仍可执行首次写入，且 D1 batch 内仍包含最终 scope guard。

## 3. 最终自动化验证

GitHub Actions push Run：[46136492997](https://github.com/sxna-web/XYmonihtml/actions/runs/46136492997) — SUCCESS。

本次日志确认：
- Protocol66 service：22/22
- Protocol66 SQL plan：8/8
- Protocol66 D1 adapter：16/16
- Protocol66 dispatch contract：12/12
- Worker handler integration：75/75
- APP v2 multi-card composition：19/19
- 相关 APP/授权回归组均通过（23/23、26/26 等见 Actions 原始日志）。

本批中间验证曾出现一次 mock scope 查询未模拟撤销/过期过滤的测试失败；已修正 fake D1 查询语义并在最终提交重新运行，最终 push run SUCCESS。不得将中间失败隐藏为从未发生。

## 4. 证据边界与后续

- 本批测试使用 mock/fake D1；真实 Cloudflare D1 的读写事务、时钟语义、并发仍未实测。
- 新表尚未在 `starjump-staging` 创建。
- Protocol66 尚未接入正式 Worker 路由。
- APP 6.00.48 是否发送 `Idempotency-Key` 仍待核对。
- 下一步应优先：隔离 SQLite 迁移脚本与触发器/索引测试；将 fixture 的幂等字段名统一为 `idempotency_key`；验证原子回滚和软删除恢复；完成后再评估 Worker route 接入。
- Staging DDL 变更仍须用户明确批准并确认备份恢复点。

## 5. 本批边界

未执行 Cloudflare D1 DDL/DML；未连接 Cloudflare；未访问 Secrets；未更改 binding；未接入正式 Worker route；未部署；未合并 PR。PR #2 保持 Draft/Open/Unmerged。
