# 星跃管理平台 V2.5｜Worker APP 管理写接口 VIP 门禁接入与测试报告

- 批次：第四十八批
- 版本：`V2.5-DEV-B1-CORE-AUTH-48`
- 日期：2026-11-27
- 状态：**版本化 Worker 已编码；Node/CI 语法与 adapter mock 测试通过；Worker handler/D1 集成未验证；不可部署**
- 仓库：`sxna-web/XYmonihtml` / `main`

## 1. 本批目标与边界

把第四十七批纯函数授权模型接入独立版本化 Worker 副本，优先处理 APP 分组、APP 入口和 APP 卡密的用户态写接口。原始 Worker 保持只读，不修改原始 HTML、D1 schema、Secrets 或生产环境。

本批只依据仓库 Worker 源码和其中的迁移 DDL 核对字段；这不构成 Cloudflare 线上 D1 schema 证明。没有连接生产 Cloudflare/D1，没有执行 SQL、迁移或部署。

## 2. 基线与新增文件

### 原始基线（复核未变）

| 文件 | Blob SHA | 行数 |
|---|---|---:|
| `原始StarJump_V1点0_Final-zip-26-11-25-14:56/Worker.js` | `5da7aa3582558d9da2c2a0ad25a63c5e95e9fe63` | 5,612 |
| `原始StarJump_V1点0_Final-zip-26-11-25-14:56/index.html` | `ab98aecd4c8546eda197bbb4d5a9f5ec0db82613` | 5,770 |

### 第四十八批版本目录

目录：`backend/worker/V2.5-DEV-B1-CORE-AUTH-48/`

| 文件 | Blob SHA | 说明 |
|---|---|---|
| `Worker.js` | `bf04ef31bbd75777263d0dc8b3108da62a852668` | 以原始 Worker 为基线的修订副本，5,638 行 |
| `worker-auth-adapter.mjs` | `2f91941c68082a44d5e23e1e25b416ae2901e0f0` | Worker Session → VIP activation → action gate adapter |
| `worker-auth-adapter.test.mjs` | `86e226e1a14c00359f7e23ce08913830f1435814` | 12 项 Node mock tests |
| `README.md` | `164e3917e1ed714c8c0fc41cc66ede1448c1fc57` | 范围、字段依据、运行方式和限制 |

本批验证由当时的 GitHub Actions workflow 执行；该临时工作流随后由第四十九批专用 workflow 替换。

## 3. 已编码内容

### 3.1 服务端身份来源

- Worker 入口在 `resolveSession()` 后执行 adapter。
- `actorId`、`effectiveId`、`isSuper`、协助会话 `scope` 均来自服务端 Session 解析结果。
- adapter 不读取请求 body、query 或客户端传来的 VIP/角色/owner 字段。
- 先经过现有协助会话 scope 检查，再进入 APP 动作级 VIP 检查。

### 3.2 APP 管理写操作映射

| 路由动作 | 授权动作 | 规则 |
|---|---|---|
| APP 分组 POST | create | 当前有效体验/正式 VIP |
| APP 分组 PUT | update | 当前有效体验/正式 VIP |
| APP 分组 DELETE | delete_history | 有效 VIP 可删除本人资源；正式 VIP 到期仅限到期前创建的本人历史 |
| APP 分组 sources POST | associate | 当前有效体验/正式 VIP |
| APP 分组 members POST | associate | 当前有效体验/正式 VIP |
| APP 入口 POST | create | 当前有效体验/正式 VIP |
| APP 入口 DELETE | delete_history | 有效 VIP可删除本人资源；正式 VIP 到期仅限到期前创建的本人历史 |
| APP 卡密 POST | generate | 当前有效体验/正式 VIP |
| APP 卡密 DELETE | disable | 当前有效体验/正式 VIP |
| APP 卡密 /disable POST | disable | 当前有效体验/正式 VIP |

GET 路由没有被 adapter 做 VIP 写门禁；原有 Session 和协助 scope 仍生效。特别说明：原 Worker 的 APP 卡密 DELETE 实际是软停用，不是物理删除，因此按 disable 处理，不将其误判为历史删除。

### 3.3 VIP 读取和失败策略

- 从 `admin_vip_activations` 按 effective user 读取全部 activation rows，不再使用旧 `vipStatus()` 的 MAX(ends_at) 汇总作为授权依据。
- 仓库原 Worker 迁移语句显示字段：`user_id`、`kind`、`starts_at`、`ends_at`。
- 仓库原 Worker DDL 显示 `app_groups`、`app_links` 均有 `admin_user_id`、`created_at`。
- activation 查询失败或返回格式异常时，敏感写操作 fail closed。
- 直接超管本人 Session 独立于 VIP；超管协助 Session 同时受 scope 与目标用户 VIP 状态约束。

### 3.4 正式 VIP 到期历史删除

- adapter 先用 `id + admin_user_id` 查询资源归属和 `created_at`。
- 正式 VIP 到期时，纯函数校验资源创建时间不晚于正式激活截止时间。
- Worker 最终 DELETE 再次把 `id + admin_user_id + datetime(created_at) <= datetime(formalCutoff)` 放入同一条 SQL 条件，避免只靠前置查询判断。
- 体验 VIP 到期不允许删除；正式 VIP 到期不能创建、编辑、关联、停用或生成新资源。

## 4. 测试证据

GitHub Actions：
- Workflow：`Worker Auth48 Tests`
- Run ID：`45953635805`
- 测试提交：`5ae89f30f1229127efb1deebcadaf00991619088`
- Node.js：`v22.23.5`
- 结果：**成功**
- 检查项：
  1. `node --experimental-default-type=module --check .../Worker.js`：通过
  2. `node --check .../worker-auth-adapter.mjs`：通过
  3. `node --test .../worker-auth-adapter.test.mjs`：12 tests，12 passed，0 failed，exit code 0

12 项覆盖：
- 路由动作映射和 GET 不进入 VIP 写门禁；
- L1/无 VIP 创建拒绝；
- 有效体验 VIP 允许关联；
- 体验 VIP 到期拒绝删除；
- 有效正式 VIP 允许创建；
- 正式 VIP 到期允许删除截止前本人历史并返回 cutoff；
- 正式 VIP 到期拒绝删除截止后资源；
- 超管本人独立授权；
- 协助 scope 不足拒绝；
- 协助 scope 足够但目标用户无 VIP 仍拒绝；
- VIP 查询失败 fail closed；
- 非本人资源删除拒绝。

**测试边界：**以上是 adapter mock 测试，不是完整 Worker handler/D1 集成测试。mock 断言 adapter 拒绝决策没有调用写操作；尚未在 Cloudflare Workers runtime 或隔离 D1 中验证整个请求链。Worker 现有通用协助 scope 拒绝分支仍保留既有 `auditDenied` 记录行为，本批 mock 未覆盖该前置分支。不能据此宣称所有 Worker handler 拒绝路径均零写入。

## 5. 风险、未完成事项与回滚

1. **不可部署。** Node 语法和 adapter mock 通过不代表 Cloudflare Workers runtime、D1 行为或线上兼容通过。
2. **生产 D1 未核实。** 字段依据仅来自仓库原 Worker 的建表/迁移语句。
3. **handler 集成测试待补。** 需在隔离 Worker/D1 环境验证登录 Session、协助会话、所有路由分支、资源归属和写入结果。
4. **APP 分组删除闭环未解决。** 当前仍为物理删除；tombstone/generation → APK 增量同步 → 本地 24 小时清理 → cleanup acknowledgement 尚未实现。
5. **事务/级联风险仍需单独处理。** 分组删除后关联来源和成员仍是多条 D1 操作；本批没有改表或重构删除事务。
6. **通用 scope 拒绝审计未纳入本批 mock。** 后续需明确拒绝审计写入与“业务写操作零写入”的验收口径。
7. **回滚方式：** 不部署本版本；开发分支可回退到第四十七批/原始 Worker 基线。原始文件未覆盖，保留完整 Git 历史。

## 6. 生产和数据库影响声明

- D1 schema：无修改。
- D1 数据：未访问、未写入。
- Worker 生产环境：未访问、未部署。
- Secrets/环境变量：未读取、未修改。
- HTML：未修改。
- APK：未修改。
- 通知/邮箱：继续按用户决定后置。

## 7. 本批后续接手任务（第四十九批，已由后续批次接续）

**建立隔离 Worker handler 测试环境，完成 APP 管理路由端到端权限回归。**

优先覆盖 L1、active_trial、expired_trial、active_formal、expired_formal、direct super、assist scope、activation 查询失败；逐路由验证分组、入口、卡密 POST/PUT/DELETE/disable/sources/members。测试必须区分 Session 心跳/拒绝审计等维护写与业务数据写，并证明每个拒绝分支不会产生未授权业务写入。确认 D1 mock SQL 的 owner/cutoff 条件、分组多语句删除的失败恢复风险。完成前不进入正式部署包，不连接生产 D1，不部署。


### 后续批次说明
第四十九批已另建不可覆盖的版本目录 `backend/worker/V2.5-DEV-B1-CORE-AUTH-49/`，增加实际 Worker handler mock 测试，并进一步把 APP 分组 PUT、sources POST、members POST 的 owner 校验下沉到最终 SQL 条件。第四十九批结果以其独立报告为准；第四十八批仍保留本批原始版本和历史 CI 证据。
