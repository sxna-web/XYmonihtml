# 星跃管理平台 V2.5｜Worker 数据库迁移入口真实 fetch 失败关闭测试

- 批次：第一百零六批
- 标识：V2.5-DEV-B1-MIGRATION-FAIL-CLOSED-106
- 日期：2026-11-28
- 分支：release/v2.5.0-rc1-converge
- 基线 HEAD：7c6aabdaa8b1c82dd73bf204497dc4bc1241d3be

## 本批发现

Worker 已在 migrateRoute 中将自动迁移固定为 503 MIGRATION_REVIEW_REQUIRED，且只读 schema-status 限制为本人登录的超级管理员会话。但现有 Worker.fetch 集成测试覆盖了 schema-status 读权限和 HTML 不触发 DDL，尚未对真实模块 fetch 入口的 POST /api/super/migrate 做直接授权边界与无写入验证。

## 新增验证

文件：backend/worker/V2.5-DEV-B1-CORE-AUTH-49/worker-handler.integration.test.mjs

1. 本人登录的超级管理员 session 调用 POST /api/super/migrate：必须返回 503 + MIGRATION_REVIEW_REQUIRED；DB writes、batch 均为 0；不得出现 CREATE/ALTER/DROP TABLE。
2. 使用 ADMIN_TOKEN legacy 凭据调用同一路由：必须在进入迁移 handler 前返回 403；无写入。
3. 使用协助/impersonation session 调用同一路由：必须返回 403；无写入。

这三项均直接调用导出的 module Worker.fetch，经过 CORS、D1 binding、session resolution、super-admin actor/effective identity gate 与最终路由，不是单测 migrateRoute 的替代路径。

## 安全与验证边界

- 测试使用 Node 22 Web API + mock D1，不连接 Cloudflare workerd 或真实 D1。
- 未发送任何真实迁移请求；测试只在本地 mock 环境中调用 Worker.fetch。
- 未访问 Cloudflare、D1 生产数据或 Secrets；未执行真实 SQL/DDL/DML。
- 这批证明代码在模拟环境中的路由边界和 fail-closed 行为，不证明生产 D1 schema 兼容，也不批准生产迁移。
- 不部署、不合并；PR #2 继续 Draft/Open/Unmerged。
