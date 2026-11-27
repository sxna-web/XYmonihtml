# 星跃管理平台 V2.5｜本地隔离数据库迁移验证器实施与测试报告

> 批次：第四十三批
> 版本：V2.5-DEV-B1-MIGRATION-IMPL-43
> 日期：2026-11-27
> 状态：**LOCAL-ONLY / NOT DEPLOYABLE**
> 范围：仅新增本地 SQLite 验证工具、通知表本地 SQL 草案与自动化测试。

## 1. 本批完成内容

在 `tools/database_migrations/` 新增：

- `runner.py`：plan、只读 check、apply-local 三种命令；仅允许专用临时目录中的 SQLite 文件。
- `checksum.py`：SQL 文件 SHA-256，统一 CRLF/CR 为 LF 后计算，其他字节不改写。
- `schema_diff.py`：只读 schema 快照与 fingerprint，覆盖表、字段、索引、外键及 SQL 对象。
- `migrations/CORE-MIG-001.sql`：本地迁移账本结构。
- `migrations/NTF-001.sql`：通知事件表和可恢复租约字段。
- `migrations/NTF-002.sql`：收件箱、通知偏好、投递记录表。
- `tests/test_runner.py`：20 项自动化测试。
- `README.md`：运行方式、安全限制和 D1 兼容边界。

## 2. 租约字段冻结（本地验证模型）

`notification_events` 加入：

- `processing_execution_id TEXT`：当前处理者执行实例 ID。
- `lease_expires_at TEXT`：UTC ISO-8601 租约到期时间。
- `fencing_token INTEGER NOT NULL DEFAULT 0 CHECK (fencing_token >= 0)`：成功领取/接管时单调递增的 fencing token。

处理流程要求：claim、renew、reclaim、complete 均使用条件原子 UPDATE；必须检查受影响行数。完成操作必须同时匹配执行实例 ID 与 fencing token，旧 worker 即使恢复运行也不能提交已过期租约的结果。本批测试验证了本地 SQLite 中的条件更新与 stale-worker 拒绝。

**重要限制：** 本批没有实现 Worker 侧 claim/renew API，也没有证明 Cloudflare D1 对相同 SQL、事务、锁和并发语义的支持。不得将本地租约测试当成 D1 生产验收。

## 3. 安全边界

- 不调用 Cloudflare、Wrangler、D1、网络 API。
- 不读取 Secrets、环境变量中的数据库凭证或生产绑定。
- 不包含远程数据库 URL 支持。
- 拒绝相对路径、URI/远程路径、符号链接、临时目录之外的路径和生产风格数据库文件名。
- `apply-local` 只允许在系统临时目录下的 `starjump-migration-test-*` 专用目录运行。
- `check` 以只读模式打开已存在的临时数据库。
- 不修改 Worker、HTML、生产 D1、Secrets，不部署。
- SQL 草案和本地测试文件不是生产迁移授权。

## 4. 自动化测试结果

实际运行环境：

- Python：3.13.5
- SQLite：3.46.1
- 测试命令：`python -m unittest discover -s tools/database_migrations/tests -v`
- 测试数量：20
- 结果：20 passed / 0 failed
- 退出码：0

覆盖：路径安全、远程 URI 拒绝、符号链接拒绝、checksum 换行归一化、checksum drift、迁移幂等、通知表结构、租约字段、租约约束、fencing token 递增、旧 worker 完成 CAS 被拒绝、schema fingerprint、失败回滚、外键孤儿记录拒绝。

测试结果只适用于本地 SQLite。没有运行 D1 测试、Worker 集成测试、前端测试或设备测试。

## 5. GitHub 文件复核

以下文件已通过 GitHub 重新读取并核对 blob SHA 与文件长度：

| 文件 | Blob SHA | 字符数 |
|---|---|---:|
| tools/database_migrations/runner.py | `2e29438da7a3bb600ef39bc45806cbde2453014e` | 7034 |
| tools/database_migrations/checksum.py | `89e1b63f3cd3111cdbb3b9c0cd6b20a62ecf69ba` | 531 |
| tools/database_migrations/schema_diff.py | `64157f39ae41ece6f6df13f6414200083aee2f1d` | 1872 |
| tools/database_migrations/migrations/CORE-MIG-001.sql | `1aeea78cb53c541e4dd24d42382b0a807e9cd20f` | 244 |
| tools/database_migrations/migrations/NTF-001.sql | `16daccc75203a1d776ccb95447867f1206818d45` | 1145 |
| tools/database_migrations/migrations/NTF-002.sql | `3d44f0a807205fddccb16bc7951b6c70a53c410e` | 1682 |
| tools/database_migrations/tests/test_runner.py | `19a8d28df2a5bbbcddb0add5aff62005eeff7caf` | 7756 |
| tools/database_migrations/README.md | `d994b63ca073916b08d4270dd872a8bac69f9cc1` | 2503 |

## 6. 尚未完成与下一阶段门槛

1. 必须核对实际生产 D1 schema、真实 Worker 部署版本和生产 binding；本批没有这些证据。
2. 必须单独验证 D1 SQL 语法、事务与并发语义；SQLite 通过不能代替。
3. 必须对 migration checksum 规范、迁移依赖、并发锁与故障恢复做独立复核。
4. 通知 Worker API、事件 outbox 触发、recipient/tenant/owner 权限隔离、通知中心持久化 UI 尚未实现。
5. 不得把本批本地 SQL 直接复制到生产 D1 执行。
6. 生产迁移必须另行提交影响分析、回滚计划、备份验证和执行计划，并等待用户明确批准。

## 7. 交付结论

第四十三批完成的是**可重复的本地 SQLite 迁移验证器与测试基线**，不是生产迁移执行器，不是通知中心上线版本，也不是可部署大更新。用户无需上传 Cloudflare，也无需执行 SQL。
