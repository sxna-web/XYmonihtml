# 星跃管理平台 V2.5｜APP v2 设备占额生命周期与客户端映射对照报告

- 批次：第六十一批
- 版本：`V2.5-DEV-B1-APP-PROTOCOL-61`
- 日期：2026-11-27
- 状态：隔离生命周期 helper 已编码；GitHub Actions 10/10 通过；生命周期业务策略仍有待用户确认项；未接入 Worker；D1_NOT_TESTED；APP_PENDING；不可部署。

## 1. 执行边界与复核证据

- 已重新读取根目录 `AGENTS.md`、功能基线、API 权限规范、D1 变更保护规范、工具连续性总方案、进度日志及第五十七至第六十批相关报告。
- 第六十批 CI Run `45965260408` 的 job `isolated-tests` completed/success；完整日志核对第五十八批 36/36、第五十九批 16/16、第六十批 19/19，SQLite 3/3，语法检查通过，0 失败。
- 第六十批 group projection 复核：输出字段白名单；拒绝重复 entitlement、额外 loader 结果、同一 entitlement 重复 card group row；同名序列号仅在同一管理员范围触发；不同管理员同名组不加卡密序列号；同管理员 free group 按 group ID 去重。
- 本批仅新增独立目录、测试 workflow 和报告；未改原始 Worker/HTML/APK/D1/Secrets，未连接 Cloudflare，未部署。

## 2. 设备占额生命周期方案（提案，不是已确认业务规则）

### 2.1 槽位身份与唯一性

- 逻辑唯一键：`(card_id, device_key)`。
- 同一 APP 设备使用两张不同卡密，分别占用两张卡密的一个名额。
- 同一设备对同一卡密重复激活/重试必须幂等，不重复占额。
- `device_key` 应为服务端不透明设备标识或 keyed digest；不得保存原始 IMEI、硬件序列号或可直接追踪用户的硬件指纹。
- 槽位记录是设备绑定审计记录；授权 entitlement 状态与槽位生命周期必须分开，不能用删除 entitlement 来隐式释放设备名额。

### 2.2 建议状态机

| 状态 | 是否计入容量 | 含义 |
|---|---:|---|
| ACTIVE | 是 | 当前设备绑定有效 |
| GRANDFATHERED | 是 | 历史存量超出新上限，保留既有绑定但禁止新增 |
| RELEASE_PENDING | 是 | 已提交解绑申请，审批完成前不释放 |
| HELD_EXPIRED | 是（提案） | 卡密过期，授权停止；槽位记录暂时保留 |
| HELD_REVOKED | 是（提案） | 卡密/授权撤销，授权停止；槽位记录暂时保留 |
| RELEASED | 否 | 已经完成有审计依据的释放 |

**待用户确认的业务决策：**卡密自身过期或撤销后，是否立即释放容量，还是保留槽位等待审批/续期恢复。本批 helper 采用保守的“先保留、不自动释放”策略，目的是避免通过过期/撤销绕过设备数限制；这只是安全默认提案，不得在生产中启用为硬规则，直至用户确认。

### 2.3 续期、VIP 到期与设备解绑

- 同一卡密续期：建议复用原 `(card_id, device_key)` 槽位，恢复/延长 entitlement，不创建第二个槽位。
- VIP 管理员到期：按既有业务规则，不撤销已激活卡密；设备槽位保持原状。
- VIP 管理员恢复：恢复管理权限，不自动释放或重建槽位。
- 卡密过期/撤销：本批模型先将槽位标记为 HOLD 状态；是否在何时释放仍待确认。
- 设备更换/解绑：客户端不得自行删除服务端槽位。建议先提交申请，服务端校验登录用户、卡密归属、设备证明/二次验证和风险状态，审批通过后写入 approver、reason、released_at 与审计事件。
- **审批人范围待确认：**建议卡密所属有效 VIP 管理员可审批名下卡密的普通换机申请；超管可处理争议、管理员失效或高风险申请。若用户不确认，本提案不应进入生产写接口。
- 重复审批/释放请求幂等；已 RELEASED 槽位不得通过普通续期请求静默复活，需走新的受控 reservation 流程。

## 3. 既有数据回填冲突报告设计（只读预演）

回填必须先生成报告，后续审批后才可能生成 migration。候选预演步骤：

1. 从经确认的隔离 D1 schema 读取 entitlement/card/device 状态；本批没有可用的明确隔离 D1，因此没有执行查询。
2. 先按真实字段映射为规范化行：cardId、deviceKey、entitlementId、state、expiresAt；映射规则必须有 schema/源码证据。
3. 仅把明确 active、设备键有效且过期时间晚于可信服务器时间的记录列为活动占额候选。
4. 对同一卡密同一 deviceKey 多条 active entitlement 去重为一个槽位，同时保留全部来源 entitlement ID。
5. 同设备不同卡密分别形成槽位，不跨卡密去重。
6. 缺 card ID、缺 device key、未知状态、无效到期时间、无法判断 owner 的行全部进入 conflict report，不自动猜测、不自动丢弃。
7. 每张卡密计算 distinct active device count 与目标 max_devices。超限时保留全部既有设备为 GRANDFATHERED，禁止新设备；报告超额数量及需要人工核查项，不撤销现有用户。
8. 输出 dry-run 摘要：总扫描数、候选数、去重数、冲突数、每卡密存量/上限/超额数、待人工审批列表、回填 checksum。不得输出卡密明文、原始订阅凭证或硬件标识。
9. 只有冲突报告经审核、备份恢复验证、迁移方案批准后，才允许准备隔离 D1 实测；正式 D1 仍需另行明确授权。

本批纯函数 `planSlotBackfill` 只验证规范化输入的分组与冲突规则，不执行 SQL，也不证明任何真实 D1 字段映射。

## 4. 6.00.47 客户端 Room 映射核查

只读材料：Library 中 `StarJump-6.00.47-source.zip`，2,377,487 bytes。已解包检查以下源码：

- `ProxyGroup.kt`：Room `proxy_groups` 主键为本地数值 `id`；含名称、type、订阅对象、排序等字段；没有 entitlementId/adminId/cardId/generation/lease/cursor/ack 字段。
- `ProxyEntity.kt`：节点通过本地 `groupId` 关联分组；没有 entitlement 维度。
- `SagerDatabase.kt`：Room 数据库 version 7；当前 builder 使用 `fallbackToDestructiveMigration()`。若直接添加 APP v2 实体而未先替换该策略，存在本地数据库破坏性重建风险。
- `GroupManager.deleteGroup`：本地删除 group 与其 proxy rows 并通知 UI；这是本地管理行为，不等同远端授权撤销或服务端 ACK。
- `GroupUpdater.finishUpdate`：释放内存中的 updating/progress 状态并通知监听器；不是远程 tombstone ACK，也不执行 24 小时授权清理。
- `SubscriptionUpdater`：调度常规订阅刷新；不构成 entitlement lease 或授权版本同步。

### v2 客户端需要新增的映射维度（设计要求）

- Room entitlement 表：entitlement_id、admin_id、card_id、device_id、状态、过期时间、独立 cursor。
- 授权分组表：entitlement_id + group_id 复合身份、类型、generation、lease_expires_at、状态。
- 节点本地记录：entitlement_id + group_id + generation 关联，防止相同 group name/id 跨授权混合。
- 变更事件/ACK 队列：event_id、entitlement_id、group_id、generation、结果和重试元数据。
- 删除 tombstone 的处理必须与普通用户本地删除区分；ACK 失败不能恢复已删除的本地授权节点。
- 每次启动、回前台、发起连接前校验租约；租约过期或时间可信度不足时 fail closed。
- Room schema 更新必须采用显式、非破坏性 migration；不得沿用 destructive fallback 作为 APP v2 升级策略。

以上是基于 6.00.47 的结构差异和接入需求，不代表已修改或构建 APK。

## 5. 新增隔离实现与测试

目录：`backend/worker/V2.5-DEV-B1-APP-PROTOCOL-61/`

- `slot-lifecycle.mjs`：规范化旧 entitlement 回填计划、重复设备去重、超限 grandfather、生命周期转换及容量占用判定。
- `slot-lifecycle.test.mjs`：10 项测试。
- `README.md`：本批方案和限制。
- Workflow：`.github/workflows/worker-app-protocol61-tests.yml`

CI Run `45966848333` completed/success：
- Node.js 22 语法检查通过；
- 10/10 tests passed，0 failed；
- 日志 job：`140397454374`。
- Run：https://github.com/sxna-web/XYmonihtml/actions/runs/45966848333

测试只证明纯函数的规范化模型，不证明 D1、Worker、Android Room 或真机行为。

## 6. 阻塞与未完成

- Library 当前仍只有 6.00.47；没有 6.00.48 ZIP 可读取副本。仓库中的 6.00.48 ZIP 元数据不能代替二进制源码审计。
- 6.00.48 许可证、第三方 SDK、授权服务器、远程停用、域名依赖、遥测、API 和客户端协议仍未知；APP 状态保持 `APK_PENDING`。
- 无可确认的隔离 D1，未验证 Cloudflare D1 事务/唯一约束/并发语义；未创建正式 migration。
- 设备解绑审批人、卡密过期/撤销是否自动释放名额、释放后能否复用卡密等业务边界仍待用户确认。
- 新增 slot lifecycle helper 未接入 Worker；6.00.47/6.00.48 APK 未修改、未构建、未安装、未真机测试。
- 未修改 Worker/HTML/D1/Secrets；未连接 Cloudflare；未部署。

## 7. 回滚

本批只新增版本目录、CI workflow 和报告，并更新进度/总方案。代码回滚可 revert 本批 commit；不涉及数据库回滚，也没有线上影响。不得通过删除历史第五十八至第六十批目录进行回滚。

## 8. 第六十二批唯一接手卡

**APP v2 设备槽位策略确认准备与隔离 D1 可用性核查（不部署）。**

1. 重读 AGENTS、功能基线、API、D1 保护规范、总方案、进度和第五十七至六十一批报告。
2. 复核第六十一批 CI Run 45966848333 与 backfill helper 边界；若测试失败先修复。
3. 继续只读核查仓库中是否出现 6.00.48 可读取文件；若无则维持 APK_PENDING，不推测第三方限制。
4. 梳理设备释放策略最少确认项，保留本批“保守 hold”仅作为提案；不得擅自冻结成业务硬规则。
5. 如出现经明确标识的隔离 D1，先做只读 schema 核对和 backfill dry-run 报告；否则只完善 fixture/冲突报告测试，不触碰生产或 staging。
6. 继续评估把 entitlement resolver、group loader、group composition 和 slot adapter 接入真实 Worker 的最小影响方案，但不修改基准 Worker。
7. 更新总进度、总方案和第六十三批接手卡；不改 HTML/APK/Secrets，不创建正式 migration，不部署。
