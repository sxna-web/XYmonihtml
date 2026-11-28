# 星跃管理平台 V2.5｜APP 卡密分组候选 DDL 唯一来源复核与测试夹具收敛报告（第九十二批）

> 批次：`V2.5-DEV-B1-APP-CARD-GROUP-92`  
> 日期：2026-11-28  
> 分支：`release/v2.5.0-rc1-converge`  
> 本批代码提交：`a7a533342fed93cb9a03685fa449639bb6626e4b`  
> 状态：测试运行中；未部署、未连接 D1

## 1. 开始前核对

- PR #2 当前仍为 Draft / Open / Unmerged。
- 本批开始时最新 HEAD：`db46684d5df68f70f16c4bd97793c993b6b1025b`；不能继续使用第九十批旧 HEAD。
- 第九十一批实际已经将 Batch71 Worker 的 APP schema 诊断白名单扩展为 9 张表，并在 Worker integration test 中覆盖两张候选表；本批复核了当前 Worker 与测试源码，未重复实现。
- 当前诊断仍为只读元数据观察：列、索引、外键和 trigger/view 对象；没有目标 schema baseline 时仍返回 `NOT_CONFIGURED` / `NOT_EVALUATED`。缺表只报告 MISSING，不创建表。

## 2. 本批发现与修正

第九十一批记录已声明候选 DDL 以 Protocol66 fixture 为唯一来源，但重新读取当前 Python SQLite 测试发现，测试的 `fixture()` 仍自行创建 `app_cards` 与 `app_groups` 两张父表，再执行候选 DDL。由于候选 DDL 使用 `CREATE TABLE IF NOT EXISTS`，这会让测试静默保留测试文件中的另一套父表定义，削弱“单一来源”保证。

本批已修改：
- `tools/database_migrations/tests/test_app_card_group_mapping_candidate.py`

修改后：
- 先完整执行 `backend/worker/V2.5-DEV-B1-APP-PROTOCOL-66/fixtures/card-group-admin-candidate-schema.sql`；
- 再插入测试所需的最小种子数据；
- 不再在 Python 测试中另行定义 `app_cards` / `app_groups` DDL；
- 幂等测试仍可重复执行同一权威 fixture。

候选 DDL 仍仅是隔离测试 fixture，不是生产 migration，不得复制到真实 D1 执行。

## 3. 诊断与安全边界复核

当前 Worker 的 `APP_SCHEMA_DIAGNOSTIC_TABLES` 已包含：
- `app_card_group_mappings`
- `app_card_group_admin_requests`

Worker integration tests 已断言两表进入 metadata 观察范围，并检查只读业务写入计数、敏感 payload/hash 字段不回显、非超管在 metadata 读取前被拒绝，以及元数据读取失败不得伪装为兼容性通过。

这些测试属于 mock D1 / Worker integration 测试，不等于真实 Cloudflare D1 结构已验证。

## 4. CI

本批提交触发：
- APP Identity 86 Offline Checkpoint Contract：Run `46128269289`，已 SUCCESS。
- V2.5 RC1 Convergence Checks：Run `46128269234`，核验时仍为 IN_PROGRESS。

因此本报告不提前宣称完整 CI 通过。待该 Run 完成后，以对应 commit SHA 与 job logs 更新本报告和进度记录。

## 5. 未完成与保护措施

- 尚无用户授权提供的 staging D1 schema-only snapshot；无法证明真实表/列/索引/FK/trigger 与候选 fixture 一致。
- 不猜测真实 schema，不创建 migration，不执行 SQL/DDL/DML。
- Protocol66 仍未接入 Batch49 Worker 正式路由。
- 未连接生产或 staging D1，未读取业务行，未访问 Secrets，未部署，未合并。
- PR #2 必须保持 Draft / Open / Unmerged。

## 6. 回滚

本批只修改 Python 隔离测试夹具的初始化方式。若测试环境出现回归，可回退本批单文件提交；不会改变 Worker、HTML、数据库或生产数据。

## 7. 下一批接手卡

第九十三批先核验本批 CI 最终结果及最新 PR HEAD。随后检查 schema diagnostic 的 metadata 输出是否存在敏感默认值/索引名信息暴露风险，并为 staging schema-only snapshot 定义无业务行、无卡密/令牌字段值的输入格式与 manifest 校验；在获得真实 snapshot 前，不生成生产 migration、不接正式 route、不部署。
