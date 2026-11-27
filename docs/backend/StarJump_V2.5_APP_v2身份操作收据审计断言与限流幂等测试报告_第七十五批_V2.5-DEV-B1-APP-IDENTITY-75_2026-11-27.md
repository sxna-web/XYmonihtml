# 星跃管理平台 V2.5｜APP v2 身份操作收据、审计断言与限流幂等测试报告（第七十五批）

- 批次版本：`V2.5-DEV-B1-APP-IDENTITY-75`
- 日期：2026-11-27
- 基线分支：`main`；开始时第七十四批相关文件按当前 main 复读。
- 状态：本地 SQLite 语义测试通过；D1_NOT_TESTED / APP_PENDING / NOT_DEPLOYABLE。

## 1. 本批范围

将统一 operation receipt + 必需审计 CHECK assertion 的候选逻辑扩展到 binding create、binding revoke、share-code rotation，并验证 durable limiter 的事件幂等、维度完整性、Retry-After 和清理边界。

本批仅新增版本化 DEV 测试/设计资料及 GitHub Actions workflow；不接 Worker，不更改原始两份 Cloudflare 基准文件。

## 2. 关键设计结论

- create/revoke/rotation 共用 operation receipt 语义：owner-scoped、operation type 与 canonical request fingerprint 固定、结果 ID/version 固定、绑定确定性 audit event key，最终 assertion 必须检查精确业务状态和精确审计信封。
- 同 operation ID + 同 payload 返回原 receipt；同 ID + 不同 payload 为完整性冲突；跨 owner 不暴露 receipt 结果。
- revoke 使用 owner + active status + expected generation CAS；rotation 使用 owner + active status + expected version CAS。
- missing/mismatched audit 必须使最终 CHECK assertion 失败，并在同一已验证原子单元回滚业务状态。
- limiter event_id 同完整 payload 精确重放；同 ID 不同 action/dimension/fingerprint 为冲突。
- 对半开窗口 `[now-window, now)`，左边界计入、now 不计入。整数秒且左边界包含时，单维最早释放秒为最老待过期事件时间 + window + 1；多维限制同时触发时取各维释放秒的最大值。
- cleanup 只删除 retain_until 严格早于当前可信时间的 limiter events；不清理 audit 或 operation receipt。保留时长仍需审批，不在本批定值。

## 3. 测试证据

- 测试文件：`backend/worker/V2.5-DEV-B1-APP-IDENTITY-75/test_identity_operations_and_limiter.py`
- 命令：`python -m unittest discover -s /tmp/batch75 -p 'test_*.py' -v`（本地验证副本）；仓库 workflow 使用对应仓库目录。
- 环境：Python 3.13.5；SQLite 3.46.1。
- 实际结果：24 tests；24 passed；0 failed；exit code 0。
- 覆盖：create/revoke/rotation success 与 audit missing/mismatch rollback、operation replay/conflict、event key same/different payload、owner scope、limiter duplicate ID、missing dimensions、多维 Retry-After、窗口边界、cleanup 边界与幂等。
- GitHub Actions 结果：提交后触发并核验；见本报告后续更新。

## 4. 影响与安全边界

- 数据库：没有连接任何 D1；没有执行 SQL；没有创建/修改 migration；所有 SQLite 表均为内存合成 fixture。
- Worker/API/前端：未修改 Worker、HTML、路由或 API。
- APP：未修改 APK、Room、签名协议或客户端。
- Secrets/Cloudflare：未读取或修改 Secret、binding、配置；未部署。
- 兼容性：不证明 D1 CHECK/EXISTS/batch rollback、D1 多 isolate 并发、真实 schema、Workers runtime 或 Android 兼容。

## 5. 未解决与下一步

1. 必须在用户批准的 disposable D1 环境验证 CHECK、scalar EXISTS、prepared binding、batch rollback、RETURNING/meta changes、唯一冲突及多请求并发。
2. 真实 D1 schema/binding/数据库 ID/迁移历史仍未核实；不能据本地 fixture 生成或执行生产 migration。
3. APP 6.00.48 第三方源码/Android Keystore 兼容仍未审计。
4. share-code rotation 对既有 binding/session/challenge/free-group 的影响政策仍待用户确认。
5. limiter 阈值、窗口、维度适用性、保留期、HMAC Secret 轮换及时钟策略仍需冻结。
6. audit retention 与 legal hold 未确认；不得自动清理 audit/receipt。

回滚：本批为独立版本目录和 workflow；停止引用该目录/禁用该 workflow 或回退对应提交即可，不触及现有业务数据。

结论：本地 SQLite fixture 语义测试通过；真实 D1、Worker、APP 和生产部署均未通过验收。本批不可部署。


### GitHub Actions verification
- Run: [45995374834](https://github.com/sxna-web/XYmonihtml/actions/runs/45995374834) — completed / success.
- Job: 140493331634; runner Python 3.13.18.
- Exact repository command: `python -m unittest discover -s backend/worker/V2.5-DEV-B1-APP-IDENTITY-75 -p 'test_*.py' -v`.
- Log evidence: 24 tests ran; 24 passed; 0 failed; output `OK`; exit code 0.
- This CI evidence is still only the in-memory synthetic SQLite fixture, not D1/Worker/APP/deployment verification.
