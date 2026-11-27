# 星跃管理平台 V2.5｜本地迁移验证器独立复核修正与测试报告

- 批次：第四十五批
- 版本：V2.5-DEV-B1-MIGRATION-REVIEW-45
- 日期：2026-11-27
- 状态：**本地代码修正已提交；SQLite 测试通过；仅 LOCAL-ONLY；不可部署**
- 仓库：sxna-web/XYmonihtml / main
- 范围：仅复核并修正 tools/database_migrations 本地 SQLite 验证器；未接入生产 Worker/D1。

## 1. 本批目标

1. 修复第四十三批 runner 对 CORE-MIG-001 的特殊分支：之前预先创建账本，再只写 checksum，没有真正执行 CORE migration SQL。
2. 修复 schema diff 对同名数据库对象定义变化的差异输出。
3. 增加 CORE bootstrap、路径父级符号链接、index/view/trigger 定义变化测试。
4. 只在隔离临时 SQLite 文件上运行测试，不访问 Cloudflare。

## 2. 影响分析与安全边界

- 修改范围只涉及本地迁移工具：runner.py、schema_diff.py、tests/test_runner.py、README.md。
- checksum.py 与三份 SQL migration 未修改。
- 不修改 Worker、HTML、API、前端、APK、Cloudflare 配置、Secrets。
- 不连接 D1，不执行生产 SQL，不读取生产数据库，不部署。
- 运行器仍只允许专用 `starjump-migration-test-*` 临时目录内的 SQLite 数据库。
- 本工具不构成 D1 migration runner；本地 SQLite 通过不能证明 D1 兼容。

## 3. 修正内容

### 3.1 CORE-MIG-001 真实执行

- 移除 run_apply_local() 在迁移循环前预创建 schema_migrations 的行为。
- CORE-MIG-001 与后续迁移统一调用 apply_one()。
- apply_one() 在账本不存在时仅允许 CORE-MIG-001 作为 bootstrap migration。
- CORE SQL、migration checksum ledger insert 在同一个 BEGIN IMMEDIATE 事务中执行。
- 在事务内重新检查账本和 checksum，降低并发 runner 重复执行风险。
- 若迁移 SQL 或账本写入失败，回滚整个迁移事务。
- 重复执行返回 already-applied；checksum drift 停止执行。

### 3.2 schema diff

- 新增 changed_objects。
- 对相同 (type, name) 的对象比较完整 sqlite_master 定义字段：type、name、tbl_name、SQL。
- 同名 index、view、trigger、table SQL 定义发生变化时，报告 before/after。
- 保留 added_objects、removed_objects 和 changed_tables。

### 3.3 路径保护与测试

- 父目录符号链接与数据库文件符号链接均拒绝。
- 增加同名 index/view/trigger 定义变化测试。
- 增加 CORE bootstrap 实际执行与迁移账本记录验证。

## 4. 修改文件与 GitHub 证据

| 文件 | Blob SHA |
|---|---|
| tools/database_migrations/runner.py | ea969e0a9f13e43900c7e7aaf0c595221f1820cf |
| tools/database_migrations/schema_diff.py | b2458ebe0f0fe62afab53e37df4c3779d468efd4 |
| tools/database_migrations/tests/test_runner.py | 8528552e054acdba84085b5cb61f112981c745c0 |
| tools/database_migrations/README.md | 58700ca03cd202328cde298f2750ff71a3f2354c |

相关提交：
- runner.py：9402fa33600b69f6dba6d5dc78ea1a9639f9c11c
- schema_diff.py：4678206b3df52e149493f4f827c734ac664037d6
- tests：d564c6f5f26516406f629773bc138d57971c741b
- README：ca23217be0d14a0275f00b1e151c5d47384a27c1

所有四个文件在提交后均重新从 GitHub main 读取，并与预期 Blob SHA 核对一致。

## 5. 测试证据

- Python：3.13.5
- SQLite：3.46.1
- 命令：`python -m unittest discover -s /tmp/starjump-mig45/tools/database_migrations/tests -v`
- 结果：24 tests，24 passed，0 failed
- 退出码：0
- 耗时：约 0.096 秒（本轮复测）
- 测试范围：路径拒绝、远程 URI 拒绝、父级/文件符号链接、checksum、迁移列表、CORE bootstrap 实际执行、幂等、checksum drift、lease/fencing 字段、stale worker CAS、schema fingerprint、失败回滚、外键孤儿拒绝、同名 index/view/trigger 定义变化。

## 6. 未覆盖及剩余风险

- 未验证 Cloudflare D1 的 SQL 语法、DDL transaction 行为、并发/锁、binding、真实 schema 和线上数据。
- 未验证 Worker 迁移 API、权限、前端初始化流程。
- SQLite 的 BEGIN IMMEDIATE 不等价于 D1 的并发/锁保证。
- 路径检查无法把普通 Python 路径校验提升为抵御同一主机恶意并发替换目录的操作系统级沙箱；该工具仅供受控本地测试。
- 当前 NTF-002 仍使用 recipient_type/recipient_id，与通知设计中建议统一的 recipient_user_id/通知域模型尚未冻结；不得作为正式业务 schema 直接部署。
- 没有执行 CI Workflow；没有生产访问。

## 7. 回滚

本批只修改 Git 跟踪的四个文件，可通过 Git 历史回退到本批之前的 Blob/Commit。临时测试数据库位于系统临时目录，测试完成后由 TemporaryDirectory 清理。没有生产数据变更。

## 8. 验收状态

- [x] CORE-MIG-001 实际执行并写入 ledger
- [x] migration SQL 与 checksum ledger 同一事务
- [x] checksum drift 拦截
- [x] 失败事务回滚测试
- [x] 父级 symlink 拒绝
- [x] 同名 index/view/trigger 变化可定位
- [x] 24 项本地 SQLite 测试通过
- [x] GitHub 文件复读和 Blob SHA 核验
- [x] 更新进度和接手记录
- [ ] Cloudflare D1 兼容验证（待独立隔离环境与明确授权）
- [ ] Worker/前端集成测试（后续）
- [ ] 生产部署（未授权、未执行）

## 9. 下一批建议

第四十六批不应继续扩展通知功能。建议回到 V2.5 主线，先只读核查仓库现有 Worker、HTML 前端、D1 schema 文档和 API 调用映射，形成一份可编码的核心功能差距清单；优先处理身份/权限、卡密生命周期、转换归档和节点/分享等核心业务中有实际源码证据的差距。生产 D1 与线上 Worker 仍未核实，不得执行迁移或部署。

用户无需本地操作或上传 Cloudflare。
