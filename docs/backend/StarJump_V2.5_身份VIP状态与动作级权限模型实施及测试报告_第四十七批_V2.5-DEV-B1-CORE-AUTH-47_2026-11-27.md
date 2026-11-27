# 星跃管理平台 V2.5｜身份/VIP 状态与动作级权限模型实施及测试报告

- 批次：第四十七批
- 版本：V2.5-DEV-B1-CORE-AUTH-47
- 日期：2026-11-27
- 状态：**纯函数权限模型已编码并通过单元测试；尚未接入 Worker 路由；不可部署**
- 范围：新增隔离的 Node.js ESM 授权 helper、表驱动测试和 README；不修改原始 Worker/HTML/D1。

## 1. 本批目标

根据第四十六批源码差距，先建立可靠、可独立测试的 VIP 状态分类和动作级权限决策模型，避免直接在数个 Worker handler 中重复写判断，或继续用 MAX(ends_at) + 历史布尔字段错误授予权限。

## 2. 规则模型

### VIP 状态

- active_formal：当前有效正式 VIP。
- active_trial：当前有效体验 VIP。
- expired_formal：正式 VIP 已过期；保留最新已过期正式激活的截止时间，用于历史删除边界。
- expired_trial：体验 VIP 已过期；只读，不允许历史删除。
- pending：存在未来生效的激活记录；未来激活开始前不授予 VIP 写权限，也不提前授予正式到期历史删除权限。
- none：无激活历史。
- unavailable：查询不可用、数据格式异常或时间无效；敏感操作 fail closed。

同一时刻有有效正式和体验记录时，正式 VIP 状态优先。

### 动作级权限

- read：由调用方认证与资源归属校验后允许；VIP helper 不扩大资源范围。
- basic_convert：保留 L0 基础转换能力。
- advanced_filters：必须有当前有效体验/正式 VIP。
- create/update/associate/disable/generate：必须有当前有效 VIP。
- delete_history：
  - 当前有效 VIP 可按业务规则删除本人历史；
  - 体验 VIP 到期后禁止删除；
  - 正式 VIP 到期后，仅允许删除本人且创建时间不晚于正式 VIP 到期截止的历史资源；
  - 不属于本人的资源或创建时间无法验证时拒绝。
- 超级管理员本人会话独立于 VIP。
- 超管协助会话必须同时满足委派 scope 和目标用户自身 VIP 规则；scope 不得提升目标用户权益。

## 3. 新增文件

- `backend/worker/V2.5-DEV-B1-CORE-AUTH-47/authorization.mjs`
  - Blob SHA：`6dc7ed5656bb3d2bcdd01674c2ee36d0db3863a5`
- `backend/worker/V2.5-DEV-B1-CORE-AUTH-47/authorization.test.mjs`
  - Blob SHA：`71369d5add228b8988f06a57635559b155f4cb9a`
- `backend/worker/V2.5-DEV-B1-CORE-AUTH-47/README.md`
  - Blob SHA：`bd6b12154c43a0d68c987caacdcb58a8d1c42302`

主要提交：
- helper 初次提交：`597d260c5c1ed97e987736474ec6f837cbe9202d`
- 测试初次提交：`9959b986fed7517ac1459ec234b3b49e3892ed0a`
- future activation 边界修正：`2342303f70dfb04612ddbc72db102464a533a9d7`
- future activation 测试：`4116d43fecf3909d4bdfb27ec42d79a60d3f490b`
- README 修订：`0e4d86cbe4031803fb537fa3ebac3571ff18ec20`

## 4. 测试证据

- Node.js：v22.16.0
- 命令：`node --test backend/worker/V2.5-DEV-B1-CORE-AUTH-47/authorization.test.mjs`
- 结果：26 tests，26 passed，0 failed，退出码 0。
- 覆盖：体验/正式有效与过期、正式优先、future activation、无记录、查询 unavailable、脏数据 fail closed、L0 基础转换、VIP 高级 filters、有效 VIP 写操作、体验到期不可删除、正式到期历史删除截止、非本人资源拒绝、超管独立、协助 scope 和目标 VIP 双重约束。

## 5. 明确限制

- 这是纯函数决策模型，不是认证实现。
- 尚未接入 Worker 的 vipStatus、userAppGroupsRoute、userAppLinksRoute、userAppCardsRoute 或 convertRoute。
- 调用方必须从有效 Session 解析 actor/effective identity；不得接受客户端 isSuperAdmin、VIP 状态或 owner 参数。
- 调用方必须自行核实 resource ownership、tenant boundary、资源创建时间、协助 scope、审计和事务。
- 仍需核对真实 D1 activation 表字段、时间格式、重复/重叠激活语义；本批没有 D1 访问和迁移。
- 尚未测试 Cloudflare Workers runtime；Node.js 测试通过不代表 Worker 部署兼容。
- 原始 Worker/HTML 未修改；无生产请求、无 Secrets 操作、无部署。

## 6. 下一批实施建议

第四十八批：以用户指定 Worker.js 为基线创建新的版本化 Worker 修订副本，先接入统一 VIP 状态读取与动作级门禁，优先覆盖 APP 分组、APP 入口和 APP 卡密写操作；保留体验到期只读、正式到期历史删除、超管独立权限。必须同时建立 Worker handler mock/集成测试，确认所有拒绝请求不会写入数据。转换高级 filters 与固定密钥 fail-closed 可在同批独立分支或后续批次处理，避免把多个高风险变化捆成一次发布。

仍不得修改生产 D1、调用迁移 API、更新 Secrets 或部署。用户无需本地操作。
