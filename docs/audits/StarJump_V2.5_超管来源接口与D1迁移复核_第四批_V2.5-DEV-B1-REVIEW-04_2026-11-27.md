# 星跃管理平台 V2.5 DEV：超管来源接口与 D1 迁移复核（第四批）

- 版本标识：`V2.5-DEV-B1-REVIEW-04`
- 日期：2026-11-27
- 阶段：DEV 静态代码复核
- 复核对象：分支 `repair/v2.5-batch1-auth-vip-app`
- Worker 文件：`releases/v2.5-batch1/Worker.js`
- Worker blob：`5a2739d981e1835e692a04b903052f268fed981a`
- 原始 Worker blob：`5da7aa3582558d9da2c2a0ad25a63c5e95e9fe63`
- 功能基线：`docs/星跃管理平台V2.5_功能基线与权限验收规范.md`（blob `dc8f6fcc0f3e2f8ac18ccdb638e34ace1fd1386e`）

> 本报告只依据仓库源码静态阅读，不代表 D1 实际结构、线上 Worker 行为、API 集成测试或部署结果。没有执行 SQL、没有访问 Cloudflare 生产环境。

## 一、超管来源管理接口复核

### 1. `POST /api/admin/sync` 的外层身份门禁

路由入口先调用 `resolveSession()`。随后 `/api/admin/*` 分支要求：
- 必须解析出身份；
- `ctx.isSuper` 必须为真；
- 协助会话（`actorId !== effectiveId`）被拒绝；
- 普通用户会话不能进入旧后台接口。

因此，当前候选 Worker 中，`/api/admin/sync` 不是匿名公开接口，也不是普通用户可直接调用的接口。它接受两种超管身份路径：
1. 正常超级管理员账号登录后产生的会话；
2. 兼容旧后台的 `ADMIN_TOKEN`（代码注释将该凭据限制用于旧 `/api/admin/*` 与 bootstrap）。

这与 HTML 中“超管来源管理页”调用旧同步接口的上下文相符；不能仅凭 URL 前缀把它改成普通用户同步接口。

### 2. `POST /api/admin/sync` 的数据范围

同步查询会：
- 只选 `enabled = 1` 的来源；
- 只选存在 `source_ownership` 归属记录的来源；
- 排除 `source_approvals.status` 为 pending/rejected 的来源；
- 对指定 `source_id` 和批量同步两种方式都应用上述条件；
- 批量同步最多选取 `MAX_SYNC_SOURCES` 条。

因此未分配、停用或未审核通过的来源不会被该手动同步接口选中。此接口由超管上下文调用，执行的是超管范围内的来源同步，不应被当作普通用户的单来源同步。

### 3. `PATCH /api/admin/sources/:id/enabled`

该接口同样位于 `/api/admin/*` 旧后台路由中，继承超管门禁。启用时额外检查：
- 来源必须存在归属；
- 如果存在审批记录，状态必须为 approved；
- 写入时再通过同批断言检查归属和审批状态，避免检查与写入之间状态变化。

该路径的启停按钮虽位于 HTML 超管来源页面，但它并不是 `/api/user/sources/:id/enabled`。

### 4. `PATCH /api/user/sources/:id/enabled` 是另一条接口

用户态路由有登录门禁，并按请求方法检查协助 scope；随后通过 `loadSourceForCtx()` 检查数据归属：
- 普通用户只能操作自己拥有的来源；
- 超级管理员本人会话可以访问全部来源；
- 协助会话按其 effective user 的归属范围访问，并受 scope 限制。

该用户态启停路由检查审批状态，但源码中没有看到它调用统一的“有效 VIP 管理员”门禁函数。是否应禁止非 VIP 用户管理普通来源，须依据最终确认的普通来源权限规则决定；当前功能基线尚未把该细项明确写成已确认规则，列为待确认/待统一，不能自行推定。

## 二、D1 迁移代码复核

### 1. Batch 1 没有新增或改变迁移 SQL

对比候选 Worker 与原始 Worker，从 `const MIGRATE_STATEMENTS = [` 到迁移处理函数结束的完整代码块：
- 候选块长度：11,058 字符；
- 原始块长度：11,058 字符；
- 内容完全一致。

所以 Batch 1 候选版没有通过迁移语句引入新的表结构；但也没有把既有迁移机制升级成正式迁移账本方案。

### 2. 现有一键迁移仍存在的不足

当前 `/api/super/schema-status` 只检查 `REQUIRED_TABLES` 中列出的表名是否存在，未核验：
- 每张表的完整字段、字段类型、NOT NULL、默认值；
- 主键、唯一约束、索引和外键；
- 现有业务表与预期版本之间的兼容性；
- 迁移依赖、迁移 ID、checksum、执行人、执行时间和版本账本。

当前 `/api/super/migrate` 的行为：
- 逐条执行 CREATE TABLE/INDEX IF NOT EXISTS；
- 随后逐条尝试 ALTER TABLE；
- 迁移语句不是一个整体原子事务；
- 对部分 ALTER TABLE 错误直接 catch 并忽略；
- 对重复列/已存在对象按跳过处理；
- 末尾审计写入失败也被 catch 忽略。

这意味着接口返回的 `ready` / `missing` 不能证明所有字段和索引均正确；部分 ALTER 失败也可能不完整地反映在结果中。当前机制不满足已经确定的“迁移 ID + checksum + 依赖顺序 + 迁移账本 + 迁移后复核”交付目标。

### 3. 现有迁移涉及的对象

现有迁移清单包含以下新建表：
- `convert_links`
- `admin_vip_cards`
- `admin_vip_activations`
- `app_cards`
- `node_lifecycle`
- `app_entitlements`
- `rate_limits`
- `app_links`
- `app_groups`
- `app_group_sources`
- `app_group_members`
- `app_free_grants`
- `admin_share_codes`
- `download_links`
- `app_card_events`
- `releases`
- `announcements`
- `admin_app_perms`

并创建相应索引；另尝试给 `convert_links` 添加 `owner_user_id`、`owner_key`，给 `node_sync_logs` 添加同步日志字段，并给 `admin_app_perms` 添加 `free_group_enabled`。

以上是代码中的目标清单，不是生产 D1 的真实表结构。不能据此断言生产库缺少这些表或字段，也不能直接执行迁移。

## 三、结论与后续处理

| 项目 | 静态复核结论 | 状态 |
|---|---|---|
| `/api/admin/sync` 外层权限 | 超管会话或兼容 ADMIN_TOKEN；拒绝普通用户和协助会话 | 代码路径已核实，未做 API 测试 |
| `/api/admin/sync` 来源筛选 | 仅启用、已分配、审批通过来源 | 代码路径已核实，未做 D1 测试 |
| `/api/admin/sources/:id/enabled` | 超管门禁；启用时检查归属/审批并有同批断言 | 代码路径已核实，未做并发测试 |
| `/api/user/sources/:id/enabled` | 归属与协助 scope 检查；未见统一有效 VIP 门禁 | 需结合普通来源权限最终规则确认 |
| Batch 1 D1 迁移 SQL | 与原始 Worker 迁移块完全一致 | 静态比较完成 |
| 迁移账本/checksum/字段级核验 | 当前代码没有完整实现 | 未达标 |
| 生产 D1 结构 | 未读取 | 未核实 |

### 建议的下一批工作（仍为 DEV，不部署）

1. 继续只读盘点候选 Worker 全部 SQL 表/字段依赖，与迁移清单逐项比对，输出“代码实际依赖但迁移清单未创建/未校验”的差异。
2. 单独设计新迁移框架：只新增迁移账本和只增不删的迁移步骤；每个迁移具备 ID、checksum、依赖、执行状态和复核结果。
3. `schema-status` 升级为表/字段/索引级只读检查；不把“表存在”当作结构正确。
4. 对所有迁移先生成 dry-run 计划和风险清单；未获得用户明确授权前，不执行任何生产 D1 变更。
5. 明确普通用户是否可以创建、编辑、启停和同步普通订阅源；确认后再决定 `/api/user/sources/*` 的 VIP 门禁，避免擅自扩大或收紧权限。

## 四、部署声明

- 本批没有修改 Worker、HTML 或 D1。
- 本批没有执行 SQL、没有运行线上 API 测试、没有部署。
- 此报告是 `V2.5-DEV-B1-REVIEW-04` 静态复核记录。
- 不构成 RC 或 STABLE，不要求用户上传 Cloudflare。
