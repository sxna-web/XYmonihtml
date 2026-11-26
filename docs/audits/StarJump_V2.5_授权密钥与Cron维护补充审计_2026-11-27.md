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
