# 星跃管理平台 V2.5｜APP 卡密分组候选 D1 SQL 计划与隔离原子性验证报告（第七十四批）

- 批次：`V2.5-DEV-B1-APP-D1-PLAN-74`
- 日期：2026-11-28
- 状态：**候选 D1 statement plan 已编写；隔离 SQLite/Node contract 测试通过；不是生产 D1 adapter**
- 分支：`release/v2.5.0-rc1-converge`
- 最终测试 head：`a3694adb0c83df7db57d51a655376cbd6d3ec79a`
- PR #2：Draft / Open / Unmerged

## 1. 新增与修改

新增：
- `backend/worker/V2.5-DEV-B1-APP-PROTOCOL-66/card-group-admin-sql-plan.mjs`
- `backend/worker/V2.5-DEV-B1-APP-PROTOCOL-66/card-group-admin-sql-plan.test.mjs`
- `backend/worker/V2.5-DEV-B1-APP-PROTOCOL-66/fixtures/card-group-admin-candidate-schema.sql`
- `backend/worker/V2.5-DEV-B1-APP-PROTOCOL-66/CARD_GROUP_D1_ADAPTER_PLAN.md`
- `tools/database_migrations/tests/test_app_card_group_admin_sql_candidate.py`

修改：
- Protocol 66 service 在 replace adapter input 中传递当前 active mapping 的 `expectedGroupIds`，供最终 D1 batch 做 compare-and-swap。
- CI 增加 SQL-plan Node tests；Python isolated SQLite suite 自动收录新增候选 schema tests。

## 2. SQL 计划边界

`card-group-admin-sql-plan.mjs` 仅生成 D1 prepared statements，不连接数据库，也没有被 Batch 49 Worker import。

读路径：
- 卡密查询按 `card_id + admin_user_id` 双重 scope。
- 分组查询按管理员并限制 `mode='card'`。
- 映射查询按管理员、卡密、active 状态。
- 不 SELECT `app_cards.code`，不读取 redeem code/token。

写路径计划顺序：
1. 最终断言当前存在有效 VIP/trial 激活；卡密属于当前管理员、状态为 normal/used、未手动禁用且未过期；active mapping 集合与 UI 读取快照一致；目标组均属于同一管理员、mode=card 且 enabled。
2. 插入 `app_card_group_admin_requests` 幂等记录（owner + requestId 唯一，存 payload SHA-256 和结果摘要）；重复 requestId 使 batch 中断，adapter 需 reread 并比对 digest，相同 digest 返回既有结果，不同 digest 返回冲突。
3. CAS 通过后，将未选中的 active mapping 软解绑为 removed。
4. 对目标组 upsert，恢复 removed 关系，不物理删除历史行。
5. 在同一 batch 插入 `admin_audit_events`。
6. 最后 SELECT 当前 active mappings。

D1 batch 失败时，mapping、幂等记录和审计必须整体回滚。SQL 计划使用 bind parameters，不拼接用户输入值；IN 占位符数量只由已验证的数组长度生成。

## 3. 隔离 SQLite 候选 schema

新增 fixture 只用于内存 SQLite 测试，包含：
- 最小化 app_cards / app_groups / admin_vip_activations / admin_audit_events；
- 候选 app_card_group_mappings 和 app_card_group_admin_requests；
- owner + card-mode trigger；
- owner transfer guard、active mapping mode downgrade guard；
- FK RESTRICT、mapping 唯一键、requestId 唯一键。

Python 新增 10 项测试：同 owner 绑定、跨 owner 拒绝、free 组拒绝、软解绑恢复唯一历史行、requestId 唯一、审计失败整体回滚、父表 owner 转移保护、active mode downgrade 保护、父记录删除 RESTRICT、映射表不含 redeem code/token 字段。

这些是 isolated SQLite fixture 结果，不是 Cloudflare D1 生产 schema 验证。

## 4. Node SQL plan 与 service contract tests

- SQL plan tests：7/7 passed。
- Protocol 66 service/handler tests：16/16 passed。
- SQL plan tests核对 read owner scope、无 code 查询、VIP/card/group/CAS 最终断言、soft remove/upsert restore、audit + idempotency 同批 statement plan、empty replace 和重复 request guard。
- Service 测试新增 CAS snapshot 传递验证。

## 5. CI 结果

最终 head：`a3694adb0c83df7db57d51a655376cbd6d3ec79a`

- Push Run `46115274952` SUCCESS  
  https://github.com/sxna-web/XYmonihtml/actions/runs/46115274952
- PR Run `46115278626` SUCCESS  
  https://github.com/sxna-web/XYmonihtml/actions/runs/46115278626
- Python isolated SQLite verifier：46 tests，全部通过。
- Batch 49 authorization adapter、Worker handler integration、APP Protocol 60/64/65、Protocol 66 service、Protocol 66 SQL plan、Worker bundle、Cron/static regression、candidate artifact upload 全部通过。
- Artifact：`StarJump-V2.5.0-RC1-candidate` ID `15251212485`，134,139 bytes，expires 2026-12-12T06:09:20Z。

## 6. 测试过程中发现并修复的问题

- Python fixture 一处 JSON 字符串语法错误：修复后 SQLite suite 通过。
- Service CAS snapshot 初次从错误的字段名取值：改为从安全投影的 group `id` 生成 expectedGroupIds，并增加测试。
- SQL plan 初次返回未 prepare 的描述对象：修复为 `db.prepare(sql).bind(...binds)`，以符合 D1 batch 输入形式。
- 以上修复均在最终双 CI 成功的 head 中，未删减测试用例。

## 7. 明确未完成/不可上线

- 该文件是候选 statement plan，不是可直接部署的 D1 adapter。
- 候选 mapping/request 表尚无生产 migration；真实 D1 schema snapshot 未取得。
- 没有把 Protocol 66 service/handler/plan 注册到 Batch 49 Worker。
- 没有后台 HTML 卡密逐张分组配置 UI。
- 没有真实 D1 batch rollback、并发、trigger、foreign key 或 schema compatibility 测试。
- requestId 冲突后的 reread/hash 比较与 retry orchestration 尚未实现。
- 没有真实 APK 多 entitlement 凭据持久化/接口联调。
- 未执行生产 D1 读写、Secrets 操作、Cloudflare 部署或 PR 合并。

## 8. 下一批

第七十五批优先完成 Protocol 66 的**隔离 D1 adapter harness**，以可注入的 D1-compatible adapter interface 实现：
- `loadCardGroupState` 的三个 scoped reads；
- payload canonicalization + SHA-256；
- D1 batch 执行及重复 requestId 后 reread/hash 匹配；
- requestId 相同但 payload 不同的冲突；
- final assertion/batch failure 的统一错误映射；
- 结果集安全投影和不泄露 code/token；
- 不将 adapter 注册正式路由，不创建生产 migration，不连接真实 D1。

只有真实 D1 schema manifest、历史数据检查、staging D1 batch/rollback/concurrency 验证齐全后，才进入正式 Worker route 接入评估。

---
**结论：** 第七十四批完成候选 SQL statement plan 和隔离 SQLite/Node contract 验证，最终 Push/PR 双 CI 通过。它仍然不是生产 adapter 或可部署功能。
