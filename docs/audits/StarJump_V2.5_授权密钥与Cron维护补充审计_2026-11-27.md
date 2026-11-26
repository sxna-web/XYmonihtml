# 星跃 V2.5 授权密钥与定时维护补充审计（2026-11-27）

## 审计边界

- 仓库：`sxna-web/XYmonihtml`，分支：`main`
- 文件：`原始StarJump_V1点0_Final-zip-26-11-25-14:56/Worker.js`
- Worker blob SHA：`5da7aa3582558d9da2c2a0ad25a63c5e95e9fe63`
- 只读静态检查；未访问生产 Worker、D1、Secrets 或 Cron 配置，未执行部署和数据修改。

## P1-31：APP entitlement Token 使用固定默认密钥

证据：`entToken(env, entitlementId, deviceId)` 使用：
`String(env.SESSION_PEPPER || "starjump-app")`

`verifyEntToken()` 通过重新计算该 HMAC Token 并进行常量时间比较。

风险：
- 若生产环境遗漏 `SESSION_PEPPER`，所有部署都会回退到代码内固定密钥。
- 了解源码的攻击者可推导 entitlement token 的签名算法和固定密钥，设备 ID 与 entitlement ID 不再能提供足够保护。
- 该问题不是“密钥长度不够”，而是缺少密钥时仍继续签发可预测凭证。

修复要求：
1. APP Token 签发与验证必须要求独立强随机 Secret，建议使用专用 `APP_TOKEN_SECRET`，与 Session Pepper 分离。
2. Secret 缺失或低于规定强度时，相关 APP 授权操作 fail closed，不得回退到任何代码常量。
3. Secret 轮换需设计版本号/密钥 ID 和兼容过渡期，避免无计划地使所有现存设备同时失效。
4. 生产 Secret 仅存 Cloudflare Secret，不进入 Git 仓库、HTML、日志或客户端 APK。
5. 增加测试：缺 Secret 时签发失败、验证失败；有效 Secret 时签发/验证成功；轮换后旧 Token 按明确策略失效。

## P1-32：Cron 在没有可同步来源时跳过所有维护任务

证据：`scheduled(event, env, ctx)` 中先查询待同步来源，随后：
`const sources = rows.results || [];`
`if (!sources.length) return;`

而以下维护任务位于该提前返回之后：
- `runVipCardMaintenance(db, cronCtx)`
- `runNodeLifecycle(db, cronCtx)`
- `runEntitlementMaintenance(db)`

风险：
- 当系统没有启用且已分配的可同步来源时，VIP 卡密维护、节点生命周期维护、APP entitlement 到期/清理维护均不会执行。
- 维护任务的执行被错误地绑定到“是否存在同步来源”，二者业务上无关。
- 即使有来源，当前维护调用还使用 `.catch(() => {})` 吞掉单项维护错误，缺少可靠的失败审计和告警证据。

修复要求：
1. Cron 入口只要 D1 可用，就应先运行独立维护任务；同步来源为空只跳过同步阶段。
2. 将维护任务与来源同步拆分成独立步骤，分别记录开始、成功、失败、影响行数和耗时。
3. 维护失败必须可观测：写入可靠的任务日志/审计并触发告警，不可静默吞掉。
4. 为各维护任务建立幂等与并发保护，避免 Cron 重试导致重复副作用。
5. 测试：0 个来源、来源全部停用、来源全部未分配、来源审批未通过时，维护任务仍按计划执行；只有同步步骤被跳过。

## 与既有审计的关系

- 本报告补充既有 P1-15（Session Pepper 默认值风险）、P1-11/P1-21（维护 Cron 执行与错误吞掉问题），不替代原问题编号。
- 本次确认的 `entToken` 固定回退值是 APP 授权签名密钥风险，需单独修复，不能只修改 Session Token 哈希逻辑。
- 生产环境是否实际缺少 `SESSION_PEPPER`、Cron 是否实际配置、运行频率和历史成功率，均须通过只读环境核查确认；本静态审计不对此作推断。

## 实施门槛

- 不得在生产环境直接轮换 Secret 或清空旧 Token，必须先确定迁移兼容方案。
- 不得未经批准修改 Cron、Worker、Secrets 或 D1。
- 先在 staging 进行缺密钥、密钥轮换、0 来源 Cron 和维护失败测试，再进入灰度发布。


## 5. P1-35：Cron 在没有可同步来源时提前 return，跳过全部维护

精确代码位置：`scheduled(event, env, ctx)`。

执行顺序：
1. 查询已启用、已分配且审批通过的订阅来源。
2. `const sources = rows.results || []`
3. `if (!sources.length) return;`
4. 只有通过上述判断后才创建 cronCtx 并执行：
   - `runVipCardMaintenance()`
   - `runNodeLifecycle()`
   - `runEntitlementMaintenance()`
   - `runSync()`

结论：当没有任何符合条件的同步来源时，VIP APP 卡密失活/恢复、节点生命周期和 APP entitlement 到期维护均被跳过。这不是单纯同步跳过，而是整个 Cron 维护入口被来源数量门控。

修复要求：
- 将维护任务放到来源数量判断之前；来源为空只跳过 `runSync()`。
- 每项维护任务独立 try/catch、独立成功/失败日志和告警。
- 不得使用无日志的 `.catch(() => {})` 静默吞掉维护错误。
- 测试零来源、全部停用、全部未分配、审批全部拒绝等情况下，维护任务仍运行。

## 6. P1-36：三天宽限维护只由 Cron 执行，且维护失败会静默

代码证据：
- `VIP_GRACE_DAYS = 3`。
- `vipExpiredOverGrace()` 取管理员 `admin_vip_activations` 的 `MAX(ends_at)`，判断到期时间是否早于等于当前时间减 3 天。
- `runVipCardMaintenance()` 才会实际将符合条件的 APP 卡密改为 `inactive`。
- `scheduled()` 对维护调用使用 `.catch(() => {})`。

结论：
- 三天判断本身是按管理员最近的 VIP 到期时间计算，边界为到期满 72 小时（以 SQLite datetime 比较为准）。
- 但是否及时执行取决于 Cron 是否运行、是否有符合条件的同步来源、D1 查询/更新是否成功。
- 当前实现没有把维护失败可靠暴露给运维，也没有从本静态代码证明生产 Cron 的实际频率和最近成功时间。

修复要求：
1. 维护任务独立于订阅同步来源执行。
2. 记录每个管理员的到期基准、宽限截止时间、实际失活时间和变更数量；普通日志不记录卡密明文。
3. 为维护任务增加 last_success_at、last_failure_at、error_code、duration 等可观测字段或等价监控。
4. 对超过宽限仍未失活的卡密建立告警/补偿机制。
5. 以时间边界测试验证：到期 71:59:59 不失活；到期 72:00:00 或之后才符合失活条件。

## 7. P2-16：体验 VIP 与正式 VIP 的 APP 卡密宽限语义尚未分开

当前 `vipExpiredOverGrace()` 使用该管理员全部 `admin_vip_activations` 记录的 `MAX(ends_at)`，没有按 `kind='formal'` 过滤；`vipActiveNow()` 也将体验 `trial` 与正式 `formal` 激活记录统一视为有效。

而已确认的业务规则明确提到“正式 VIP 管理员过期后，未激活 APP 卡密进入 3 天宽限”；体验 VIP 到期则只读，且不得操作历史数据。

这形成一个尚需业务规则明确的边界：
- 体验 VIP 期间生成的未激活 APP 卡密，在体验期满后是否也享有 3 天宽限？
- 若体验期满后用户购买正式 VIP，恢复逻辑是否应恢复体验期内生成、且仅因 VIP 到期自动失活的卡密？
- 正式 VIP 与体验 VIP 激活记录同时存在时，三天宽限应以哪个有效授权区间为基准？

在用户明确前，不能擅自把体验 VIP 的 3 天宽限设为既定规则。建议将资格来源（trial/formal）和卡密自动失活原因分别记录，避免只依赖一个通用 `admin_vip_expired`。

## 8. 已确认的卡密规则实现情况

| 用户规则 | Worker 静态代码情况 | 结论 |
|---|---|---|
| 管理员 VIP 到期后 3 天宽限 | 常量 3 天，按 MAX(ends_at) 判断 | 时间算法基本符合，但执行可靠性不足 |
| 只停用未激活 APP 卡密 | 过滤 activated_at/used_at 为空 | 符合方向 |
| 不停用人工停用卡密 | 过滤 manual_disabled=0 且仅 status=normal | 符合方向 |
| 不恢复人工停用卡密 | 恢复条件 manual_disabled=0、原因限定 | 符合方向 |
| 不恢复卡密自身过期卡 | 恢复条件检查 expires_at > now | 符合方向 |
| 只恢复 VIP 到期自动停用卡 | 原因限定 admin_vip_expired | 符合方向 |
| 已激活卡密不因管理员 VIP 到期失效 | 失活 SQL 排除 activated_at/used_at 非空 | 符合方向 |
| 管理员续费后恢复 | 有效 VIP 时恢复符合条件的自动失活卡 | 有实现，但 Cron 可能不运行 |
| 体验 VIP 到期行为 | trial/formal 未区分宽限 | 需要明确并修正/确认 |

## 9. 维护任务的推荐结构

建议 Cron 改为：
1. 建立 request/task ID。
2. 无条件（只要 D1 可用）分别运行 VIP 卡密维护、节点生命周期维护、APP entitlement 维护。
3. 对每项维护结果独立写任务记录；失败时写错误并告警。
4. 再查询可同步来源。
5. 来源为空时记录 sync_skipped=no_eligible_sources，然后正常结束；不得跳过前面的维护任务。
6. 有来源才执行 runSync。

此结构不要求生产立即修改；先在 staging 做零来源和维护失败注入测试。
