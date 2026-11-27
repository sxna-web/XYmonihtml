# 星跃管理平台 V2.5｜APP 节点下发、同步状态与 24 小时本地清理闭环核查

> 批次：第二十二批  
> 版本标识：V2.5-DEV-B1-REVIEW-22  
> 日期：2026-11-27  
> 阶段：DEV 静态源码审计  
> 核查分支：repair/v2.5-batch1-auth-vip-app  
> 核查文件：releases/v2.5-batch1/Worker.js  
> 关联报告：第十、十一、十三、十五、十六、二十、二十一批  
> 本批范围：APP /nodes、/groups、/free、节点同步提交状态、节点生命周期、entitlement 24 小时保留  
> 边界：未修改业务代码、D1、Secrets、Cron、APK 或生产部署

## 1. 结论摘要

本批确认 APP 节点下发与 24 小时本地清理尚未闭环，且发现一个会让节点生命周期判断失效的状态值不一致问题。

1. **P0：/api/app/nodes 仍然按管理员全部来源下发，不按设备获准 APP 分组过滤。** 该接口验证 entitlement Token 后，查询该管理员所有 source_ownership 来源中的启用节点；没有 JOIN app_group_sources，也没有检查 app_groups mode / app_group_members。第二十批发现仍然成立。
2. **P0：免费节点接口 /api/app/free 仍可仅凭管理员 ID 或分享编号获取免费节点。** 该接口未验证 APP 用户身份 ID、设备授权凭证或 Token；第二十批发现仍然成立。
3. **P1：节点同步任务最终状态写入 committed，但节点生命周期查询只查 success。** commitTask() 将 sync_tasks.status 更新为 committed；runNodeLifecycle() 查最近三次 status='success' 的任务。新同步任务不会进入生命周期判断的成功任务序列，节点 stale 判定会失真。
4. **P1：/api/app/groups 的 free 分组路径可仅凭 device_id 读取历史 app_free_grants。** 无 entitlement 时不验证 Token，仅检查客户端 device_id；设备标识可伪造或复制。
5. **P1：24 小时保留规则只体现在 entitlement.purge_at 字段/注释，未形成 APK 撤销清理协议。** 未发现 cleanup ACK、客户端已清理 generation、重试游标或撤销事件接口。
6. **P1：/api/app/nodes 响应返回 purge_at:null，未返回可供 APK 处理的撤销版本/清理时间。**
7. **P1：来源停用、来源审核撤销、分组改型/删除、来源移除等变更没有统一进入设备增量撤销清单。** /api/app/nodes 只是当前全量查询，不能表达已删除节点/分组的撤销 tombstone。
8. **P2：Cron 在没有可同步来源时提前 return，VIP 卡密维护、节点生命周期、APP entitlement 维护均不会执行。** 第十九批已指出，此处仍存在。
9. **P2：节点同步缺失节点停用由 SYNC_DISABLE_MISSING 控制，默认关闭；且仅在非可疑骤减时执行。** 这是来源同步缺失处理，不等同于 APP 授权撤销和本地清理。

## 2. 关键接口与实现证据

### 2.1 /api/app/nodes

位置：appRedeemRoute() 内的 GET /api/app/nodes 分支。

现有检查：
- device_id 格式；
- listActiveEntitlements(db, deviceId)；
- matchEntitlementToken() 验证 entitlement Token；
- 来源 enabled、节点 enabled；
- source_approvals 不存在非 approved 状态。

实际 SQL 的范围是：
- source_ownership.user_id = ent.admin_user_id；
- 该管理员拥有的所有启用来源；
- 来源中所有启用节点；
- 来源审核状态满足当前条件。

未检查：
- app_group_sources；
- app_groups；
- group mode；
- assigned 组 app_group_members；
- app_free_grants 的可信用户身份；
- 分组 generation / tombstone；
- 已撤销来源或节点的客户端 ACK。

**结论：** entitlement Token 只能证明某设备持有某管理员的一条授权，不能因此把该管理员所有来源节点全部下发。必须再以 entitlement 对应管理员 + 设备身份 + 组授权关系做二次范围过滤。

### 2.2 /api/app/groups

appGroupsForDevice() 当前：
- 有 entitlement 时验证 Token，然后按管理员返回 public/free/assigned 分组；
- assigned 只通过 app_group_members.device_id 匹配；
- 无 entitlement 时按 device_id 查询 app_free_grants，再读取该管理员 free 分组；
- 无 entitlement 的免费分支不验证 Token 或可信 APP 用户身份。

风险：
- 客户端自报 device_id 不足以作为设备身份；
- free grant 只按 device_id 读取时可能被复制/冒用；
- 分组列表和 /api/app/nodes 两条接口的节点范围不一致；
- /api/app/groups 返回 groupNodeList() 的组内来源节点，而 /api/app/nodes 返回管理员全部来源节点，APK 若使用 /nodes 即绕过分组边界。

### 2.3 /api/app/free

appFreeGroupRoute() 接收 admin 或分享 code：
- code 只解析为 admin_user_id；
- 检查管理员是否启用 free_group_enabled；
- 读取该管理员全部 enabled 且 tier='free' 的节点；
- 未要求设备身份、Token、免费授权凭证或可信身份绑定。

这与“免费 APP 分组通过 APP 用户身份 ID 授权”的已确认规则不一致。公开分享编号只能用于解析管理员身份，不能等同于用户授权凭证。

### 2.4 节点同步任务状态

commitTask() 完成原子 D1 batch 后执行：
`UPDATE sync_tasks SET status='committed' ... WHERE status='staged'`

runNodeLifecycle() 查询最近成功同步任务时执行：
`SELECT created_at FROM sync_tasks WHERE source_id = ? AND status = 'success' ORDER BY created_at DESC LIMIT 1 OFFSET 2`

本文件中未发现将 committed 转换为 success 的后续状态更新。

**影响：** lifecycle 的“最近三次成功同步”阈值查不到已提交任务，节点是否连续缺席的判断可能长期停留在默认 present=true，或无法按设计进入 fail_streak / observation / stale 状态。

修复建议：
- 统一成功状态枚举，推荐全链路统一 committed 或 success，不能混用；
- 生命周期查询应使用真实提交成功状态；
- 数据库历史旧状态需兼容处理；
- 测试至少覆盖连续三次成功同步后节点缺席、重新出现、失败任务不计数。

### 2.5 Cron 执行顺序

scheduled() 先查询 enabled sources；如果 sources.length===0 直接 return；后续才执行：
- runVipCardMaintenance()
- runNodeLifecycle()
- runEntitlementMaintenance()
- runSync()

**影响：** 没有同步来源时，维护任务被跳过。维护任务应独立于来源同步任务执行，不能以来源列表非空作为前置条件。

## 3. 24 小时本地清理协议核查

代码注释定义：
- 卡密到期当天停止下发；
- 本地节点保留 24 小时；
- purge_at = expires_at + 24h。

但协议缺少以下环节：

| 必需环节 | 当前核查 |
|---|---|
| 服务端记录 entitlement 过期/撤销事件 | 未发现统一事件流 |
| 返回撤销对象及 generation | 未发现 |
| 返回撤销涉及的 group/source/node IDs | 未发现统一清单 |
| APK 增量同步游标 | 未发现 |
| APK 本地清理成功 ACK | 未发现 |
| 服务端保存每设备 ACK | 未发现 |
| 设备离线重试 | 未发现 |
| 24 小时到期后可验证清理状态 | 未发现 |
| 重复撤销幂等 | 未发现 |
| 换绑后旧设备撤销清单 | 未发现完整闭环 |

/api/app/nodes 的响应中 purge_at 固定为 null。不能将 entitlement 表里有一个 purge_at 字段，视为 APK 已按期清理。

## 4. 影响范围与风险分级

### P0
- APP 节点下发未按已分配 APP 分组过滤，管理员一条卡密授权可能读取该管理员所有启用来源节点。
- 免费节点接口没有可信 APP 用户身份授权。

### P1
- 节点同步 committed/success 状态不一致，生命周期判断失效。
- free group grant 只按客户端 device_id 读取。
- 24 小时本地清理无撤销事件、generation、ACK 和重试闭环。
- /nodes 和 /groups 返回范围不一致，客户端可能使用更宽泛接口绕过分组规则。

### P2
- Cron 无来源提前返回，维护任务不执行。
- SYNC_DISABLE_MISSING 默认关闭，来源缺失节点不一定自动停用；该开关不能代替 APP 授权撤销。

## 5. 修复顺序（本批只提出计划）

1. **先封堵 P0：** 建立唯一 APP 授权解析器，校验设备身份、entitlement、管理员状态、有效期、管理员归属和授权组范围。
2. **统一节点出口：** /api/app/nodes、/api/app/groups、/api/app/free 全部调用同一授权服务；不得保留旁路全量节点出口。
3. **按组过滤：** public/free/assigned 分别按已确认规则计算可见组；组内节点必须通过 app_group_sources、source_ownership、来源审核和启用状态校验。
4. **修复同步状态枚举：** committed 与 success 统一；迁移兼容历史记录。
5. **引入撤销事件账本：** 分组、来源、节点、entitlement、设备换绑等撤销均生成单调 generation 和 tombstone。
6. **增加 APK 增量同步与 ACK：** APK 回传设备身份、generation、清理结果；服务端保存 ACK；离线重试不丢事件。
7. **落实 24 小时规则：** 到期后停止新下发；按规则保留本地节点 24 小时；期限届满执行清理并回传 ACK；服务器只在满足保留策略后做数据清理。
8. **拆分 Cron：** VIP/entitlement/lifecycle 维护与来源同步解耦，来源为空也必须运行维护。
9. **补齐审计：** 每次授权范围变化、撤销、清理 ACK、失败重试都写脱敏审计事件。

## 6. 数据库影响（尚未实施）

可能涉及既有表：
- sync_tasks
- node_records
- node_lifecycle
- subscription_sources
- source_ownership
- source_approvals
- app_groups
- app_group_sources
- app_group_members
- app_entitlements
- app_free_grants
- app_card_events

建议新增结构仅供后续设计，不代表已创建：
- app_revocation_events：撤销事件主账本；
- app_device_sync_state：每设备最后确认 generation；
- app_cleanup_ack：APK 清理 ACK；
- app_group_revisions：分组权限配置版本；
- app_node_snapshots：下发节点快照版本。

在读取真实 D1 schema、索引、外键、历史数据前，不得直接编写生产迁移或执行 SQL。

## 7. 测试验收矩阵

| 场景 | 预期 |
|---|---|
| entitlement A 请求 /nodes | 仅返回 A 实际授权分组中的来源节点 |
| A 的卡密访问 B 管理员来源 | 拒绝 |
| assigned 组设备不在成员列表 | 不返回该组 |
| assigned 组设备被移除 | 产生撤销 generation，APK 清理对应本地节点 |
| free 组无可信 APP 身份凭证 | 拒绝 |
| 只知道 admin ID/share code 请求 /free | 不得直接返回节点 |
| 设备伪造其他 device_id | Token/身份校验失败 |
| 分组改型/删除 | 返回撤销事件，不丢失历史 |
| 来源审核撤销/禁用 | 不再下发，产生撤销事件 |
| 节点同步任务 committed | lifecycle 将其识别为一次成功同步 |
| 同步任务 failed | 不计入成功同步次数 |
| 节点连续三次成功同步缺席 | 按生命周期策略进入观察期 |
| 节点重新出现 | 清零 fail_streak 并取消观察 |
| entitlement 到期 | 停止下发，按 24 小时保留规则清理 |
| APK 24 小时内完成清理 | 服务端记录 ACK |
| APK 离线超过 24 小时 | 撤销事件持续保留，联网后强制补同步 |
| 重复提交 ACK | 幂等 |
| Cron 没有任何 enabled source | VIP、entitlement、lifecycle 维护仍执行 |
| 多管理员授权 | 各管理员授权范围隔离，不合并扩大 |

## 8. 本批边界

- 已完成：Worker 静态检查 /api/app/nodes、/api/app/groups、/api/app/free、groupNodeList、commitTask、runNodeLifecycle、scheduled Cron。
- 未完成：APK ZIP 无法读取，本批不能实证客户端究竟调用 /nodes 还是 /groups、是否本地缓存、是否有清理任务或 ACK。
- 未完成：真实 D1 schema/数据、API 集成测试、Cron 实测。
- 未修改：Worker、HTML、APK、D1、Secrets、Cron、Cloudflare 部署。
- 阶段：V2.5-DEV-B1-REVIEW-22，仅静态审计，不是 RC，不可部署。

**最终判断：** 当前实现不能证明满足“管理员配置分组 → 服务端严格按组授权下发 → 权限变化产生撤销事件 → APK 24 小时清理本地节点 → APK 回传 ACK”的正式要求。P0 的节点越权和免费接口身份验证必须先修；其次修复 committed/success 状态不一致，否则节点生命周期检测不可信。