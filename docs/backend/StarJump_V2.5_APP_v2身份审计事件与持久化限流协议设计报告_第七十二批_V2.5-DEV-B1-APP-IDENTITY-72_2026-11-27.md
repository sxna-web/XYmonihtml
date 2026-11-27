# 星跃管理平台 V2.5｜APP v2 身份审计事件与持久化限流协议设计报告

- 批次：第七十二批
- 版本：V2.5-DEV-B1-APP-IDENTITY-72
- 日期：2026-11-27
- 状态：**协议设计完成；未连接 D1；未执行 SQL；未创建 migration；未接 Worker；不可部署**
- 仓库：sxna-web/XYmonihtml / main

## 1. 本批完成范围

已重读 AGENTS、V2.5 功能基线、API 权限规范、数据库变更保护规范、APP 授权协议设计、总方案、进度和第六十八至七十一批资料。本批只新增设计文档，不改变运行时代码。

新增协议涵盖不可变审计事件信封、binding 创建/撤销/share-code 轮换幂等事件键、审计与状态变更原子性、持久化限流候选算法、签名协议版本/时间戳精度/nonce 保留、legacy share-code 兼容和隔离 D1 验证矩阵。

## 2. 审计事件契约

逻辑字段包括 event_id、event_key、event_type、schema_version、occurred_at、actor_type、actor_id、owner_admin_id、target_type、target_id、operation_id、outcome、reason_code、payload、correlation_id。Actor 与 owner 分离；身份、owner、目标从服务端认证上下文和可信数据解析，不接受客户端自报。

审计事件 append-only；event_id/event_key 唯一；相同 event_key + 不同 canonical payload 属于完整性冲突；审计载荷只允许必要的非秘密元数据。禁止 raw share code、code_digest、token、nonce、private key、device proof、订阅 URL 和原始设备标识进入审计或普通日志。

| 操作 | 建议 event_key | 关键约束 |
|---|---|---|
| Binding 创建 | app.identity.binding.created:<binding_id> | 仅本次尝试生成的 binding_id 与新插入记录完全匹配才追加；竞争失败者不记录 created。 |
| Binding 撤销 | app.identity.binding.revoked:<binding_id>:<new_generation> | 精确匹配 owner、operation ID、新 generation 和撤销时间；同一撤销重试不重复追加。 |
| 分享编号轮换 | app.identity.share_code.rotated:<owner_admin_id>:<new_version> | 仅记录成功 CAS；不记录 raw code/digest。 |

审计写失败时不能报告业务变更成功；优先与状态写入放入经验证的同一原子单元。超时属于 outcome-unknown，必须复用相同 operation_id/event key，并通过 owner-scoped 状态/事件读取确认，不能生成新操作盲目重试。

审计保留期限尚未由用户确认，本批不设置数字，也禁止把审计记录纳入 transient cleanup。

## 3. Durable identity rate-limit 候选算法

旧 Worker 可见的全局 rate_limits helper 不满足 APP identity 安全需求。本批提出 append-only rate event + 单条条件 INSERT-SELECT 滑动窗口候选：
- 每个请求由服务端派生 network/device/admin/action 四类伪匿名 bucket；
- 用独立 HMAC Secret 生成 bucket，不复用 APP identity/entitlement/session 密钥；
- 单条 INSERT-SELECT 同时检查所有适用维度的滑动窗口计数，只有全部低于配置阈值才插入一次 request event；
- event_id 唯一，重复请求不得重复消耗；
- 插入成功才视为准入；未插入需有界 follow-up read 计算 Retry-After，不能误判为准入；
- 身份安全操作的 limiter 不可用时 fail closed，返回通用临时服务错误，不伪装成用户超额，也不 fail-open；
- cleanup 有界且只清理 retain_until 已过的 limiter events。

该算法是候选方案，不是已验证 SQL。必须在专用隔离 D1 验证并发请求、写串行化、RETURNING、查询计划、窗口边界、重复 ID、Retry-After 和清理竞态。不得将转换额度建议值直接套用为 APP 身份限流值。本批不选最终阈值。

## 4. 签名协议与 Nonce 版本化

现有资料能证明有签名/nonce 设计意图，但尚不足以证明完整 canonical signing format、算法、时间单位、APK 实现或已发布客户端兼容。

实施前必须冻结协议版本、签名算法/key type、canonical method/path/query/body、UTF-8 规范、timestamp 单位/精度、nonce 编码和唯一作用域、device key thumbprint、时钟窗口、挑战绑定/过期/单次消费和 key rotation 规则。

对协议版本 v 单独定义 S_v、P_v、M_v。若接受规则为对称且边界包含，则保留期下界为：

    retain_until >= first_seen + 2 * S_v + M_v

不得在同一协议版本中直接扩大 skew；旧 nonce 保留窗口可能不足。更安全做法是发布新协议版本并按版本分别验证/清理。若实际时间窗口不对称，必须按真实最早/最晚可接受时间重新推导，不能机械套用 2S。

APP 6.00.48 尚未审计，因此不宣称 Android 兼容。

## 5. Legacy share-code 兼容策略

采用阶段化流程：调用方盘点 → 独立 v2 身份发现/绑定契约 → 增量兼容设计 → 隔离验证 → 明确批准发布 → 有客户端采用证据后再决定旧接口退役。

本批不修改 legacy 字段和路由；不将公开分享编号直接视为身份认证。轮换后既有绑定、会话、挑战和免费组权限如何处理仍是待确认业务政策，不擅自决定撤销、保留或强制重绑。

## 6. 验证、影响与部署状态

- 新增：backend/worker/V2.5-DEV-B1-APP-IDENTITY-72/AUDIT-AND-RATE-LIMIT-PROTOCOL.md、README、本批报告。
- 本批无新增可执行代码，无代码测试结果。
- 未连接任何 D1；未执行 SQL；未创建/执行 migration。
- 未修改 Worker、HTML、APK、Room、Secrets、Cloudflare 配置；未注册 API 路由；未部署。
- 状态：D1_NOT_TESTED / APP_PENDING / NOT_DEPLOYABLE。

## 7. 第七十三批唯一接手卡

**APP v2 identity audit/rate-limit 契约对抗性复核与隔离测试规格（设计阶段，不连接 D1）。**

1. 重读 AGENTS、功能/API/数据库保护基线、总方案、进度和第六十八至七十二批报告。
2. 对 binding create/revoke/rotation 的并发、超时、重复键、不同 payload、部分提交风险进行独立对抗性复核。
3. 审查滑动窗口 SQL 形状在并发、重复 event_id、缺失维度、共享 NAT、时钟跳变、查询成本、cleanup race 下的边界；不对 D1 执行。
4. 制定隔离 D1 batch/statement atomicity、RETURNING、限流竞争准入、Retry-After 的精确测试输入/预期/证据模板。
5. 复核 nonce 协议版本 rollout 与旧/新 APK 兼容；无客户端源码证据仍标 APP_PENDING。
6. 基于仓库源码完成 legacy share-code 调用方盘点，不改路由/schema。
7. 不连接 D1、不执行 SQL/迁移，不改 Worker/HTML/APK/Room/Secrets，不部署。
8. 更新进度、总方案和第七十四批接手卡。
