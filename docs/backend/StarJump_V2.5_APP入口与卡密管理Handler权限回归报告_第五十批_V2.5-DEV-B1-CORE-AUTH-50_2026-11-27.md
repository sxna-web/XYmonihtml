# 星跃管理平台 V2.5｜APP 入口与卡密管理 Handler 权限回归报告

- 批次：第五十批
- 版本：`V2.5-DEV-B1-CORE-AUTH-50`
- 日期：2026-11-27
- 状态：**APP links/cards 实际 Worker.fetch handler mock 测试通过；Cloudflare Workers runtime/真实 D1 未验证；不可部署**
- 范围：测试补齐批次；未修改 Worker 业务代码、D1 schema、Secrets 或生产环境。

## 1. 测试基线

- 被测 Worker：`backend/worker/V2.5-DEV-B1-CORE-AUTH-49/Worker.js`
- Worker Blob SHA：`a4689380215e95c1c9f605fc974cc553b3e7037f`
- adapter Blob SHA：`2f91941c68082a44d5e23e1e25b416ae2901e0f0`
- 新增测试：`backend/worker/V2.5-DEV-B1-CORE-AUTH-50/app-links-cards-handler.test.mjs`
- 测试 Blob SHA：`4a59fd2c5cb1f2f63ff23042799f775069407fd1`
- CI：`.github/workflows/worker-auth50-tests.yml`

测试直接 import 第四十九批 Worker 并调用 `worker.fetch(request, env)`，通过 mock D1 模拟 Session、VIP activation、资源归属、D1 batch 和 SQL 执行。

## 2. 本批 12 项 APP links/cards Handler 测试

1. L1/无 VIP 创建 APP links 被拒绝，业务表无写入。
2. 有效体验 VIP 创建 APP link 成功。
3. 正式 VIP 到期删除截止前本人历史 APP link 成功；最终 DELETE SQL 同时带 owner 和 cutoff。
4. 删除其他管理员 APP link 被拒绝，业务表无写入。
5. L1/无 VIP 生成 APP cards 被拒绝，业务表无写入。
6. 有效体验 VIP 生成 APP cards 成功；通过 mock D1 batch 验证业务 INSERT。
7. 有效体验 VIP 对本人 APP card 执行 DELETE 软停用成功；UPDATE 带 owner 条件。
8. 正式 VIP 到期不能执行 APP card /disable；业务表无写入。
9. 停用其他管理员 APP card 被拒绝。
10. VIP activation 查询失败时，APP link 创建 fail closed。
11. 超级管理员本人 Session 不依赖 VIP，可生成 APP cards。
12. 超管 assist scope=manage 仍不能为无 VIP 的目标用户创建 APP link。

重要业务语义：
- APP card 的 DELETE 路由实际是软停用，不是物理删除；按 `disable` 授权动作处理。
- 正式 VIP 到期保留的是本人历史数据删除权限，不代表可以继续停用、编辑或生成卡密。
- APP links 删除使用最终 owner + created_at cutoff SQL 条件。

## 3. CI 测试证据

- Workflow：`Worker Auth50 Tests`
- Run ID：`45954434345`
- 测试提交：`63f7c0bae48953e746a94f6fb19031daac2376dc`
- Node.js：`v22.23.5`
- 结果：**成功**
- Worker ESM syntax check：通过
- adapter syntax check：通过
- 第四十九批 adapter tests：12/12 passed，0 failed
- 第四十九批 APP group handler tests：12/12 passed，0 failed
- 本批 APP links/cards handler tests：12/12 passed，0 failed

总计 36 项测试通过。该结果只证明 Node.js + mock D1 测试通过，不证明真实 D1、Cloudflare Workers runtime 或生产行为。

## 4. 未覆盖和风险

1. mock D1 不等于真实 D1；未验证 D1 batch 的实际事务回滚、并发和锁语义。
2. 未连接 Miniflare/workerd 或 Cloudflare Workers runtime。
3. Session `last_seen_at` 心跳、审计 INSERT 等维护写与 APP 业务表写分开统计；拒绝请求测试证明没有未授权业务数据变更，不声称没有任何维护/审计写。
4. APP entitlement status token 校验、多管理员 entitlement latest-only、token query 暴露等问题仍未处理。
5. APP 分组物理删除多语句失败恢复和 24 小时 tombstone/cleanup acknowledgement 仍未实现。
6. 未修改 Worker 业务代码，因此本批没有新的业务代码回滚动作；测试文件和 workflow 可通过 Git 历史回退。

## 5. 生产和数据库影响

- D1 schema：无修改。
- D1 数据：未访问、未写入。
- 生产 Worker/Cloudflare：未访问、未部署。
- Secrets/环境变量：未读取、未修改。
- 原始 Worker/HTML：未覆盖。
- APK、通知中心、邮箱：未修改。

## 6. 下一批唯一首要任务（第五十一批）

**进入 APP entitlement token 与多管理员授权隔离风险的只读核查和测试设计。**

优先核实 status/nodes/groups/links 对 token 的实际校验路径、latest-only 查询、token query 参数、授权实例 ID 与设备绑定关系；先建立可复现测试，不擅自改变 APP 客户端协议，不修改 D1 schema，不连接生产环境，不部署。
