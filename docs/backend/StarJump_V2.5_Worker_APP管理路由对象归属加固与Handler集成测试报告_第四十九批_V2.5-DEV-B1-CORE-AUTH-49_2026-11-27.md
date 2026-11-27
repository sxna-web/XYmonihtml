# 星跃管理平台 V2.5｜Worker APP 管理路由对象归属加固与 Handler 集成测试报告

- 批次：第四十九批
- 版本：`V2.5-DEV-B1-CORE-AUTH-49`
- 日期：2026-11-27
- 状态：**版本化 Worker 对象归属加固已编码；实际 Worker.fetch + D1 mock 测试通过；Cloudflare Workers runtime/真实 D1 未验证；不可部署**
- 仓库：`sxna-web/XYmonihtml` / `main`

## 1. 本批范围

承接第四十八批的动作级 VIP 门禁，本批做两项工作：
1. 在独立第四十九批 Worker 副本中加固 APP 分组修改和关联写入的对象归属 SQL 条件，避免只依赖前置 SELECT。
2. 增加真正调用版本 Worker `fetch()` 的 Node.js handler 测试，而不只测试 adapter 纯函数。

第四十八批目录恢复并保留为不可覆盖版本；本批改动放在 `backend/worker/V2.5-DEV-B1-CORE-AUTH-49/`。原始 Worker、HTML、D1、Secrets 和生产环境均未修改。

## 2. 版本基线和文件

第四十九批以第四十八批 Worker 副本为起点继续修订，不以生产 Cloudflare 线上版本为依据。

| 文件 | Blob SHA | 说明 |
|---|---|---|
| `backend/worker/V2.5-DEV-B1-CORE-AUTH-49/Worker.js` | `a4689380215e95c1c9f605fc974cc553b3e7037f` | 对象归属加固版 Worker，5,652 行 |
| `worker-auth-adapter.mjs` | `2f91941c68082a44d5e23e1e25b416ae2901e0f0` | 服务端 Session/VIP 动作门禁 |
| `worker-auth-adapter.test.mjs` | `86e226e1a14c00359f7e23ce08913830f1435814` | 12 项 adapter tests |
| `worker-handler.integration.test.mjs` | `d0303a2ed5a9e84d938fb95b9d46711444050abd` | 12 项实际 Worker.fetch + mock D1 测试 |
| `README.md` | `e3b124c9e9977b4eba57fabcb08ac7fb0c943928` | 版本说明和测试边界 |

CI：`.github/workflows/worker-auth49-tests.yml`。

## 3. 发现并修正的对象归属风险

### 3.1 APP 分组 PUT

原处理在 `SELECT ... WHERE id=? AND admin_user_id=?` 后，仅用 `WHERE id=?` 执行 UPDATE。第四十九批改为：

- 最终 UPDATE 同时带 `id` 和 `admin_user_id`；
- 检查 `meta.changes`，资源在检查与写入之间变化时返回冲突，不报告虚假成功。

### 3.2 APP 分组来源关联

来源关联最终 INSERT 改为 `INSERT OR IGNORE ... SELECT`，同一 SQL 同时验证：
- 分组 id 属于当前 effective user；
- 来源 id 属于当前 effective user 的 `source_ownership)。

前置 own/source 查询仍保留用于友好错误提示；最终写入不再只依赖前置查询。

### 3.3 APP 分组成员关联

成员关联最终 INSERT 改为 `INSERT OR IGNORE ... SELECT`，在 INSERT 语句中再次验证分组 `id + admin_user_id)。

### 3.4 路由边界更正

复核发现类似 `/members/:deviceId` 的 DELETE 处理位于超管 `superAppGroupsRoute`，不是用户态 `userAppGroupsRoute`。第四十八批 adapter 中一条错误的用户态 members DELETE 映射已移除；本批测试只覆盖实际存在的用户态 members POST。超管路由仍由现有超管 Session 路由边界保护，本批没有改变超管路由业务规则。

## 4. Worker Handler 测试

新增测试直接导入版本化 Worker 默认导出并调用 `worker.fetch(request, env)`，不是只调用 adapter 函数。

GitHub Actions：
- Workflow：`Worker Auth49 Tests`
- Run ID：`45954269528`
- 测试提交：`8aebec32e652de1cbe95a2c70d2c6f1f8f59d77b`
- Node.js：`v22.23.5`
- 结果：**成功**
- Worker ESM syntax check：通过
- adapter syntax check：通过
- adapter mock tests：12/12 passed，0 failed
- Worker handler tests：12/12 passed，0 failed

Handler 测试覆盖：
1. L1/无 VIP 创建分组被拒绝，业务表无写入。
2. 有效体验 VIP 创建分组成功。
3. 体验 VIP 到期删除分组被拒绝，业务表无写入。
4. 正式 VIP 到期删除截止前本人历史成功，最终 DELETE SQL 同时包含 owner 和 cutoff 条件。
5. 正式 VIP 到期删除截止后资源被拒绝，业务表无写入。
6. 超管本人 Session 不依赖 VIP。
7. 超管协助 Session 即使 scope=manage，也不能提升目标用户 VIP 权益。
8. VIP activation 查询失败时 fail closed。
9. 非本人分组 PUT 被拒绝，业务表无写入。
10. 非本人分组来源关联被拒绝，业务表无写入。
11. 来源关联 INSERT SQL 同时带分组 owner 与来源 owner 条件。
12. 成员关联 INSERT SQL 同时带分组 owner 条件。

**写入断言边界：**测试把 APP 业务表 INSERT/UPDATE/DELETE 作为未授权业务写入进行断言；Session `last_seen_at` 心跳和通用拒绝审计属于既有维护/审计写，不计入业务数据写入。mock D1 不等同真实 D1，也不验证 Cloudflare SQLite/D1 的全部事务、锁和并发语义。

## 5. 尚未覆盖与风险

1. 本批 handler tests 重点覆盖 APP 分组路由；APP links、APP cards 的 handler 级写入测试仍待补齐。它们目前只有 adapter 层动作门禁测试。
2. 本批未在 Cloudflare Workers runtime / Miniflare / workerd 中执行；当前测试是在 Node.js 中调用 Worker.fetch，使用 mock D1。
3. 正式生产 D1 schema 未核实；字段仍只依据仓库原 Worker DDL。
4. APP 分组 DELETE 仍需处理多条 SQL 的失败恢复/事务一致性；tombstone/generation → APK 增量同步 → 本地 24 小时清理 → cleanup acknowledgement 尚未实现。
5. 现有通用 assist-scope 拒绝分支保留审计记录行为；本批只证明未授权业务数据没有变更，不声称整个请求没有任何维护/审计写。
6. APP status token 校验、多管理员 entitlement latest-only、token query 参数等其他风险仍未处理。
7. 不可部署；需要后续完整路由测试、独立安全复核和隔离运行时验证。

## 6. 数据库和生产影响

- D1 schema：无修改。
- D1 数据：未访问、未写入。
- 生产 Worker/Cloudflare：未访问、未部署。
- Secrets/环境变量：未读取、未修改。
- 原始 Worker/HTML：未覆盖。
- APK/通知中心/邮箱：未修改。

## 7. 下一批唯一首要任务（第五十批）

**补齐 APP links 与 APP cards 的 Worker handler 级权限回归，并对全部 APP 管理写路由做独立对象归属复核。**

逐项覆盖 links POST/DELETE、cards POST/DELETE/disable、分组 sources/members、协助 Session、超管本人和跨用户资源 ID；mock 断言业务表未授权写入为零。核查 `userBatch`/D1 batch 的返回与审计语句，区分审计写和业务写。仍不连接生产 D1、不执行迁移、不读取 Secrets、不部署。
