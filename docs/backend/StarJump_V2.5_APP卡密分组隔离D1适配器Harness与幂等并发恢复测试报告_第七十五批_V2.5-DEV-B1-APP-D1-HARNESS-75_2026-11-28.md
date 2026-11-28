# 星跃管理平台 V2.5｜APP 卡密分组隔离 D1 适配器 Harness 与幂等并发恢复测试报告（第七十五批）

- 批次：`V2.5-DEV-B1-APP-D1-HARNESS-75`
- 日期：2026-11-28
- 状态：**隔离 D1 adapter harness 已实现；13/13 测试通过；未注册正式 Worker route**
- 分支：`release/v2.5.0-rc1-converge`
- 最终测试 head：`20555872b2aa126fd6e7832191232a7b4b6e7b97`
- PR #2：Draft / Open / Unmerged

## 1. 新增实现

- `backend/worker/V2.5-DEV-B1-APP-PROTOCOL-66/card-group-admin-d1-adapter.mjs`
- `backend/worker/V2.5-DEV-B1-APP-PROTOCOL-66/card-group-admin-d1-adapter.test.mjs`

本 adapter 通过依赖注入接收 D1-compatible `db` 与既有 VIP/体验期 `resolveAccess`，实现：
- owner-scoped card/groups/mappings reads；
- 不读取 `app_cards.code`；
- canonical JSON payload + Web Crypto SHA-256；
- requestId 预查与 payload digest 比较；
- 调用第七十四批 prepared statement plan，执行 D1 `batch`；
- 相同 requestId + 相同 digest 返回已提交结果；
- 相同 requestId + 不同 digest 返回 `IDEMPOTENCY_CONFLICT`；
- 并发唯一键冲突后 reread request row，按 digest 恢复或拒绝；
- batch 失败后重新读取权限/卡密/映射/目标组，区分 VIP_READ_ONLY、CARD_NOT_WRITABLE、CARD_MAPPING_CONFLICT、CARD_GROUP_NOT_AVAILABLE 与通用 DB_BATCH_ABORTED；
- 只返回安全映射字段。

Service 额外修复 D1 整数布尔投影：`enabled=1` 与 `is_expired=1` 均按 true 处理，避免真实 D1 返回整数导致卡密过期状态漏判或启用分组被错误拒绝。

## 2. 测试覆盖

Protocol 66 adapter 13 项测试：
1. scoped loader 查询卡密、card mode groups、active mappings，不查询 code；
2. 成功写入通过 prepared statements 执行 batch，响应无敏感字段；
3. 相同 requestId + 相同 digest 直接幂等返回，不重复 batch；
4. 相同 requestId + 不同 digest 拒绝；
5. VIP 只读时不执行 batch；
6. mapping 快照过期时 CAS 拒绝；
7. free group 不能作为 card group；
8. batch 失败后 VIP 到期，映射为只读拒绝；
9. batch 失败且无已提交 request row，返回数据库失败；
10. 并发相同 requestId/相同 digest，重读后幂等恢复；
11. 并发相同 requestId/不同 digest，拒绝；
12. batch 失败后 mapping 已被并发变更，返回 CAS conflict；
13. batch 失败后卡密被禁用，返回 CARD_NOT_WRITABLE。

最终 Protocol 66 adapter tests：**13/13 passed**。

其他当前套件：
- Python isolated SQLite verifier：46 tests passed；
- Batch 49 authorization adapter：12/12；
- Worker handler integration：62/62；
- APP Protocol 60：19/19；
- APP Protocol 64：23/23；
- APP Protocol 65：26/26；
- Protocol 66 service/handler：17/17；
- Protocol 66 SQL plan：7/7。

## 3. CI

最终测试 head：`20555872b2aa126fd6e7832191232a7b4b6e7b97`

- Push Run `46115692564` SUCCESS  
  https://github.com/sxna-web/XYmonihtml/actions/runs/46115692564
- PR Run `46115696474` SUCCESS  
  https://github.com/sxna-web/XYmonihtml/actions/runs/46115696474
- Worker bundle、Cron/static、SQLite、auth、Worker integration、APP contracts、Protocol 66 service/SQL plan/adapter、artifact upload 全部通过。
- Artifact：`StarJump-V2.5.0-RC1-candidate` ID `15251740718`，134,139 bytes，expires 2026-12-12T06:14:55Z。

## 4. 边界与未完成

- 当前 adapter 是 D1-compatible harness，使用 mock D1 测试，不代表真实 Cloudflare D1 联调。
- `resolveAccess` 仍由调用方注入，尚未接入正式 VIP/session/授权上下文。
- 未注册 Batch 49 Worker 路由；未接入 HTML 卡密逐张分组 UI。
- 候选 mapping/request tables 没有生产 migration，真实 D1 schema snapshot 仍缺失。
- 尚未在 staging D1 验证 batch rollback、并发唯一键冲突、trigger/FK、真实 D1 返回结构和旧数据兼容。
- APK 多 entitlement 凭据保存、同步协议和 24h tombstone/ACK 仍未端到端验证。
- 未访问生产 D1、未改 Secrets、未部署、未合并 PR。

## 5. 下一批

第七十六批优先完成 adapter 的**边界加固与正式路由接入前审计**：
- 检查 session actor/effective owner 在 delegated admin scope 下是否一致；
- 对 accessResolver 的异常、不可用和 trial/formal 过期场景补齐 contract；
- 检查 batch 结果结构、幂等记录损坏、重复 mapping 返回、组删除/禁用竞态；
- 检查 requestId 是否由 Worker 请求层稳定生成并传递；
- 形成真实 D1 schema manifest 必需字段清单与只读诊断方案。
在 schema manifest 未取得前，不注册生产 route、不创建 migration、不接真实 D1。

---
**结论：** 第七十五批完成了隔离 D1 adapter harness 的读写、幂等与失败恢复实现，并通过 13 项 Node tests 和当前完整 CI。它仍是隔离适配器，不是生产路由或可部署功能。
