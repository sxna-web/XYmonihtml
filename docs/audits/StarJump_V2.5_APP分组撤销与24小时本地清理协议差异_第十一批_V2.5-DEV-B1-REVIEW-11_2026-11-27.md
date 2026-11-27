# 星跃管理平台 V2.5 DEV：APP 分组撤销、来源停用与 24 小时本地清理协议差异（第十一批）

- 版本标识：`V2.5-DEV-B1-REVIEW-11`
- 日期：2026-11-27
- 阶段：DEV 静态源码复核
- Worker：`releases/v2.5-batch1/Worker.js`
- Worker blob：`5a2739d981e1835e692a04b903052f268fed981a`
- 关联规范：V2.5 动作级权限门禁矩阵、APP 节点分组分享规则、同步任务/节点生命周期第十批报告。

> 本报告只检查代码路径，没有调用 APP API、没有修改 D1、没有向 APK 下发数据、没有执行清理或部署。未审计 APK ZIP 的客户端实现。

## 一、结论

**当前 Worker 没有实现用户确认的 APP 分组变更后 24 小时本地清理闭环。**

用户要求的正式协议是：

`管理员删除分组/改型 → Worker 生成撤销版本或 tombstone → APK 增量同步收到撤销信息 → APK 在 24 小时内清理本地节点 → APK 回传 cleanup acknowledgement → Worker 保存确认记录`

当前候选 Worker 的可见实现则是：
- 删除 APP 分组时直接物理删除分组和关联记录；
- 修改分组类型时直接更新 mode；
- 从分组移除来源时直接删除关联行；
- 来源停用时直接令 APP 节点查询不再返回该来源；
- 未找到 tombstone、revoke generation、cleanup acknowledgement 的 API/表/写入路径。

这不是细节差异，而是授权撤销与本地缓存清理的协议缺失。Batch 1 不能宣称已满足 APK 24 小时清理要求。

## 二、逐项源码证据

### APP-11-01：管理员删除分组直接删除数据

`userAppGroupsRoute()` 的 DELETE 分支：
1. 检查分组归属；
2. `DELETE FROM app_groups WHERE id = ?`；
3. `DELETE FROM app_group_sources WHERE group_id = ?`；
4. `DELETE FROM app_group_members WHERE group_id = ?`；
5. 返回 `deleted: true`。

这些语句逐条执行，不在同一个 D1 batch 中。没有先生成撤销版本或 tombstone，也没有等待设备确认。

超管 `superAppGroupsRoute()` 的 DELETE 分支同样直接删除分组和关联记录。

### APP-11-02：分组改型直接覆盖 mode

用户态 PUT 直接执行：
`UPDATE app_groups SET name=?, mode=? WHERE id=?`

超管 PUT 也直接更新 mode、enabled、sort 等字段。

没有创建新版本、保存前后节点集合差异、写入待撤销设备清单或生成 APK 增量事件。旧模式授权关系可能因此立即消失，APK 端却没有可靠的撤销通知记录。

### APP-11-03：移除分组来源直接删除关联

`DELETE /api/user/app-groups/:id/sources` 直接删除 `app_group_sources` 行。

该操作没有记录来源撤销版本、影响的设备、节点集合或 cleanup acknowledgement。若 APK 已缓存该组节点，Worker 没有可供客户端增量拉取的持久撤销事件。

### APP-11-04：来源停用会让 APP 节点查询立即过滤

APP 的 `groupNodeList()` 和免费分组/节点查询都要求：
- 来源 `enabled = 1`；
- 节点 `enabled = 1`；
- 来源审核状态符合要求。

用户删除来源的处理会停用来源并解除用户归属；超管来源归档也会停用来源。之后 APP 查询将不再返回该来源节点。

这实现的是服务端立即停止下发，不是“先下发撤销事件并在 24 小时内清理本地”的协议。不能仅凭查询结果为空就证明 APK 已收到并清理缓存。

### APP-11-05：Worker 中未发现撤销事件与确认闭环

对 Batch 1 Worker 全文件检索：
- 未发现 `tombstone`；
- 未发现 `cleanup_ack` / `cleanup_acknowledgement`；
- 未发现面向分组/来源/节点撤销的持久化 generation 事件表；
- 未发现 APK 回传清理确认的路由。

本项结论限于当前仓库候选 Worker 静态代码，不能推断 APK 内部绝对没有本地清理逻辑；APK ZIP 尚未解包审计。但没有服务端撤销事件和确认接口，完整闭环无法成立。

## 三、现有 24 小时保留实现的真实范围

Worker 在 `app_entitlements` 中设置：
- `expires_at`：授权到期时间；
- `purge_at`：授权到期后约 24 小时。

`runEntitlementMaintenance()` 会：
1. 到期后将 entitlement 状态改为 `expired`；
2. 到 `purge_at` 后将状态改为 `purged`。

但它没有：
- 生成节点/分组 tombstone；
- 告知客户端某个授权对应的节点缓存应删除；
- 记录设备是否完成本地清理；
- 保存清理确认时间、确认批次或失败原因；
- 在客户端离线时保留可重试的撤销事件。

并且 `/api/app/nodes` 只通过有效期内的 active entitlement 返回当前节点；到期后不再返回节点，但响应并不携带待清理列表或 purge 指令。

所以现有 `purge_at` 只是授权记录状态转换时间，不是已实现的 APK 本地节点 24 小时清理协议。注释中的“本地节点保留 24 小时”尚未被 Worker API 闭环证明。

## 四、必须区分的四种删除/失效

| 事件 | 服务端正确动作 | APK 本地动作 | 当前候选状态 |
|---|---|---|---|
| APP 分组删除 | 保留撤销事件与旧版本 | 24 小时内清理对应组节点并 ACK | 直接删除关联，缺协议 |
| APP 分组改型 | 新版本 + 授权差异 + 撤销事件 | 清理失去授权的节点 | 直接覆盖 mode |
| 来源停用/归档 | 标记来源状态并生成影响范围事件 | 按撤销事件清理 | 查询立即过滤，无 ACK |
| APP 卡密授权到期 | 记录 expires/purge 与待清理事件 | 到期后按约定保留 24 小时再清理 | 仅 entitlement 状态更新，缺清理事件/ACK |

另外，节点生命周期的 stale 30 天物理删除属于服务端订阅节点清理，不能与以上任何一种 APP 授权撤销混为一谈。

## 五、V2.5 正式协议建议

### 5.1 事件与版本模型

建议引入独立的撤销事件模型（具体表名和字段待真实 D1 schema 核验）：
- event_id；
- scope_type：group / source / entitlement / node；
- scope_id；
- admin_user_id；
- device_id 或目标设备范围；
- generation；
- action：revoke / replace / expire；
- old_group_mode / new_group_mode；
- affected_node_ids 或不可逆的节点集合摘要；
- created_at；
- local_delete_deadline；
- status：pending / delivered / acknowledged / expired / failed。

事件必须不可覆盖；后续恢复授权应产生新的 generation，不得删除旧撤销事件。

### 5.2 APK 增量同步接口

APK 使用设备授权令牌请求增量事件：
- 请求携带 last_seen_generation / cursor；
- 服务端返回事件、影响范围、generation、截止时间；
- APK 对照本地分组和节点 ID 清理；
- APK 提交 event_id、generation、实际清理数量、客户端版本和确认时间；
- Worker 验证设备与授权归属后写入 ACK；
- 重试必须幂等；重复 ACK 不得重复产生业务副作用。

### 5.3 离线设备与时限

- 服务端先持久化事件，再返回操作成功。
- APK 在线时立即拉取；离线时下次启动/同步继续拉取。
- 24 小时期限按业务规则定义为本地清理截止时间，不得因为客户端离线而静默删除服务端事件。
- 超过期限仍未 ACK，后台标记 overdue 并提示超管；不能伪造客户端已清理。
- 对授权到期、管理员停用、分组删除、改型、来源停用分别计算影响范围。

### 5.4 操作原子性与历史保留

分组删除不能先删主表再删关联表。正式方案应：
1. 校验操作者和有效 VIP；
2. 读取旧版本和关联设备/节点范围；
3. 同一事务中生成撤销事件、增加 generation、将分组标记为 revoked/deleted_pending；
4. 保留历史快照和关联审计；
5. 待 ACK/保留策略满足后再做归档清理。

恢复或改型时创建新版本，不覆盖旧版本。节点记录本身仍由订阅源维护，APP 分组撤销不应物理删除共享 `node_records`。

## 六、与节点/历史数据关联的保护边界

1. `node_records` 是订阅来源的共享节点数据，被普通用户列表、APP 免费分组、APP 卡密分组、统计和 stale 页面共同引用。
2. 删除一个 APP 分组绝不能删除 `node_records`。
3. 移除 `app_group_sources` 关系只代表该分组不再引用来源，不代表来源或节点不再被其他分组、其他管理员或转换流程引用。
4. 来源归档当前会解除用户 `source_ownership`，但保留来源和节点；应进一步核实转换历史、节点覆盖、身份别名、APP 分享和审计的保留要求。
5. stale 30 天物理删除当前只查 `node_lifecycle`，没有检查 APP 分组引用、节点覆盖、转换历史引用或待确认撤销事件。不能把它当作安全的全局节点垃圾回收器。
6. 在节点引用与保留策略完成核验前，不应执行扩大范围的物理删除，也不应把自动 purge 纳入新正式迁移。

## 七、需要覆盖的验收测试

- 删除分组后，历史版本与撤销事件仍可查；
- 改型前后节点差异正确；
- 从分组移除一个来源，不影响其他分组引用；
- 同一节点被多个分组引用时，只清理已撤销范围；
- APK 在线时能立即拉取撤销事件并 ACK；
- APK 离线 24 小时以上，重新上线仍能拉取历史撤销事件；
- 重复拉取、重复 ACK 幂等；
- 伪造 device_id 或跨管理员 event_id 的 ACK 被拒绝；
- 授权到期后 24 小时保留窗口与清理截止行为一致；
- 人工停用、超管撤销、管理员 VIP 到期、卡密到期互不混淆；
- 节点仍被其他来源/分组引用时不会被物理删除；
- 失败或审计写入失败时不得向前端返回“已完成”。

## 八、状态与下一步

- 本批只新增 APP 授权撤销协议静态审计报告。
- 未修改 Worker、HTML、D1、APK、Secrets、Cron 或 Cloudflare 配置。
- 未访问生产 D1，未执行 SQL、迁移、API 写操作或部署。
- Batch 1 仍为 DEV，不可部署。

下一批应继续核查转换历史与节点身份映射：确认 `convert_links` 保存的是不可变节点快照、动态引用还是订阅 URL，并梳理 `node_identity_aliases`、`node_overrides`、节点重名/指纹变化对历史转换和 APP 缓存的影响。
