# 星跃管理平台 V2.5 DEV：APP 节点下发、分组范围与多授权隔离核查（第十三批）

- 版本标识：`V2.5-DEV-B1-REVIEW-13`
- 日期：2026-11-27
- 阶段：DEV 静态源码复核
- 核查对象：`releases/v2.5-batch1/Worker.js`
- Worker blob：`5a2739d981e1835e692a04b903052f268fed981a`
- 关联规范：APP 免费分组身份 ID 规则、APP 卡密授权规则、APP 专用分组分享规则、动作级权限门禁矩阵。

> 本批仅做静态源码核查。未调用线上 APP API，未访问生产 D1，未修改数据库、APK、Worker、Secrets 或 Cloudflare 部署。未解包 APK，因此不能确认客户端实际调用了哪些接口。

## 一、结论摘要

**当前候选 Worker 的 APP 节点接口存在“授权管理员范围”与“管理员实际分组授权范围”不一致的问题。**

最重要的发现：

1. `/api/app/nodes` 验证了一条有效卡密 entitlement，但随后按该管理员的全部 `source_ownership` 查询节点，**没有限制到该设备可见的 APP 分组，也没有 JOIN `app_group_sources`**。只要管理员拥有且来源已启用、审核通过，节点就可能被该设备通过此接口拿到，即使该来源没有分配给设备可见的 APP 分组。
2. `/api/app/groups` 的分组列表按 `public/free/assigned` 模式筛选，但 `groupNodeList()` 只按 `app_group_sources` 取来源，没有在查询中校验 `app_groups.enabled`、管理员归属、来源是否仍归属于该管理员等完整约束。入口筛选虽有 enabled，但节点查询自身缺少独立约束。
3. 普通用户的 `node_overrides`、`node_user_metadata` 不会通过当前 APP 节点查询自动泄漏：APP 查询直接读取 `node_records`，未 JOIN 普通用户覆盖/备注表。这一点符合“个人覆盖不影响管理员分享给 APP 的原始节点”的隔离方向。
4. 免费分组存在两套不一致路径：`/api/app/free` 可仅凭管理员 ID 或分享编号公开返回所有该管理员的 `tier='free'` 节点，不校验 APP 用户身份 ID；另一条 `/api/app/groups` 免费分组路径依赖 `app_free_grants(device_id,admin_user_id)`，而该 grant 是在卡密核销时写入，且无有效卡密时仅凭可自报的 device_id 查询，没有独立设备证明或免费绑定凭证。
5. 同一设备有多个管理员的有效 entitlement 时，当前每次请求只匹配一个 token/entitlement；`/api/app/groups` 和 `/api/app/nodes` 都按匹配到的单个管理员返回数据，未发现一个设备一次请求合并多个管理员授权的实现。
6. 卡密核销生成的 entitlement 与 `app_free_grants` 分开写入，但 `app_free_grants` 在卡密到期后永久保留。该行为与“激活过该管理员卡密的设备永久保留该管理员免费分组资格”的代码注释一致，但必须与用户要求的 APP 身份绑定规则统一定义，不能把卡密历史激活自动等同于用户主动绑定管理员免费分享。

## 二、逐项证据

### APP-13-01：/api/app/nodes 未按分组授权范围过滤

该接口执行顺序：
1. 读取 `device_id`；
2. 查询该设备所有 active 且未过期 entitlement；
3. 使用请求 token 匹配其中一条 entitlement；
4. 取匹配 entitlement 的 `admin_user_id`；
5. 查询该管理员所有 `source_ownership` 下启用、审核通过的来源和启用节点。

SQL 的核心过滤只有：
- `so.user_id = ent.admin_user_id`；
- `s.enabled = 1`；
- `n.enabled = 1`；
- 来源审核状态通过。

没有 `app_groups`、`app_group_members`、`app_group_sources` 的 JOIN/EXISTS，也没有按设备可见分组的 mode 过滤。

**影响：** 如果 APK 使用 `/api/app/nodes` 作为节点同步入口，该接口可能绕过管理员通过 APP 分组设置的来源范围。即使某来源未加入任何可见分组，或设备不属于 assigned 分组，也可能被这个接口返回。

应以 APK 实际调用证据确认影响面；但 Worker 接口自身的授权范围不足已经可以从 SQL 确认。正式版本应让节点下发只接受明确的 group_id / 授权范围，并在服务端校验设备对该分组的可见权。

### APP-13-02：/api/app/groups 与 groupNodeList 的约束不完整

`appGroupsForDevice()` 对有效 entitlement：
- 只查询该 entitlement 对应管理员的分组；
- 分组必须 enabled=1；
- public/free 对有效卡密设备可见；
- assigned 必须在 `app_group_members` 中存在 device_id。

对无有效 entitlement 的分支：
- 查询 `app_free_grants` 中该 device_id 已绑定的管理员；
- 只返回这些管理员 enabled=1 且 mode='free' 的分组。

但 `groupNodeList(db, groupId)` 的 SQL 只通过 `app_group_sources.group_id` 找来源和节点，并检查来源启用、节点启用、审核通过。它没有再次验证：
- 分组是否仍 enabled；
- 分组 admin_user_id 是否与本次 entitlement/grant 一致；
- 来源是否仍在该管理员的 `source_ownership` 中；
- 该设备是否仍有该分组的可见资格。

调用入口当前有部分前置过滤，但底层查询不具备独立安全约束；超管/数据修复造成关系残留时，可能继续下发越权来源。正式接口应将 device、admin、entitlement/grant、group、group-source、source ownership 的约束放在同一查询或同一可信授权函数内。

### APP-13-03：普通用户覆盖没有直接混入 APP 节点

普通用户节点列表 `buildNodeListQuery()` 会将 `node_overrides` 中按 user_id 保存的名称、协议、服务器、端口、等级、启用状态覆盖到个人列表，并从 `node_user_metadata` 读取备注、收藏和排序。

APP 的 `groupNodeList()` 和 `/api/app/nodes` 则直接读取 `node_records`，没有 JOIN 这些用户个人覆盖表。

因此当前静态实现中：
- 用户 A 的个人节点改名不会直接改变 APP 分享节点；
- 用户 A 的个人 enabled 覆盖不会直接关闭管理员原始节点；
- 用户备注/收藏/排序不会作为 APP 节点字段下发。

这是正确的隔离方向，正式修复时应保留；不要为了复用普通用户列表查询而把个人覆盖拼入 APP 结果。

### APP-13-04：免费分组公开接口不验证 APP 用户身份 ID

`GET /api/app/free` 的 `appFreeGroupRoute()`：
- 接受 query 参数 `admin`，或通过公开分享编号 `code` 解析管理员；
- 检查管理员 `free_group_enabled`；
- 查询该管理员所有归属来源中启用、审核通过且 `tier='free'` 的节点；
- 返回来源名称分组后的节点。

该接口没有要求：
- APP 用户身份 ID；
- 设备绑定记录；
- 登录/授权 Token；
- 管理员专用免费分享关系；
- 具体 `app_groups` 分组 ID 或 `app_group_sources` 关联。

这意味着它是“公开管理员免费节点池”接口，不是用户要求的“APP 用户身份 ID 获取该管理员分享的免费节点分组”专用授权接口。公开编号可以作为发现/绑定入口，但不应本身成为无限制节点数据访问凭证。

### APP-13-05：app_free_grants 绑定关系缺少独立设备证明

`/api/app/groups` 无有效 entitlement 时，仅凭请求中的 `device_id` 查询 `app_free_grants`。当前 `app_free_grants` 在卡密核销成功时写入，主键是 `(device_id, admin_user_id)`。

没有有效 entitlement 的情况下，这条免费分组读取路径没有再校验设备持有的独立签名凭证。device_id 是客户端传入字符串，本身不能证明请求来自此前绑定的同一台设备。

因此攻击者如果知道或猜到设备标识，理论上可能尝试冒用该标识读取免费分组。device_id 格式校验不等于设备身份认证。

正式方案应由设备首次绑定时建立不可伪造的设备密钥/凭证，后续请求使用签名或独立 device token；不能仅凭可自报 device_id 授权。

### APP-13-06：多管理员 entitlement 没有自动合并

`listActiveEntitlements()` 会返回该设备所有有效 entitlement，`matchEntitlementToken()` 则遍历并只返回 token 匹配的第一条记录。

随后：
- `/api/app/nodes` 只读取该条 entitlement 的 admin_user_id；
- `/api/app/groups` 也只读取该条 entitlement 的管理员分组；
- `/api/app/links` 只返回该管理员的入口链接。

未发现一个请求将同一设备多个管理员的授权合并成统一结果的逻辑。若产品希望多管理员内容同时展示，APK 必须逐授权请求并按管理员分区合并，或 Worker 提供明确的多授权聚合接口。不得简单把多个管理员的节点混成一个无归属列表。

### APP-13-07：卡密核销与免费授权 grant 的语义需要统一

`/api/app/redeem` 成功核销后：
- 新建一条 entitlement；
- 生成该 entitlement 的 HMAC token；
- 写入 `app_free_grants(device_id, admin_user_id)`；
- 注释明确该管理员免费分组资格在卡密过期后永久保留。

这与“APP 免费分组身份 ID 绑定”不是同一概念。需要分别定义：
- 用户主动绑定管理员身份 ID：免费分组资格；
- 用户核销管理员卡密：卡密 entitlement；
- 卡密到期：停止卡密组更新，按规则保留本地节点 24 小时；
- 卡密历史是否同时授予永久免费组：必须作为独立业务规则明确确认，不应由实现注释单方面决定。

## 三、与用户确认规则对照

| 已确认业务规则 | 当前候选 Worker | 判断 |
|---|---|---|
| APP 免费组按 APP 用户身份 ID 授权 | `/api/app/free` 只需 admin/code；另一路 grant 来源于卡密核销 | 不一致 |
| APP 卡密组按对应卡密授权 | entitlement token 绑定 device_id + entitlement | 部分实现；仍需验证 APK 请求 |
| 必须使用 APP 专用分组分享链接 | 存在 app_groups/app_group_sources，但另有宽泛 nodes/free 接口 | 未形成统一强制入口 |
| 设备只能获取可见分组内来源 | `/api/app/nodes` 返回管理员所有已归属来源 | 不满足 |
| 普通用户个人覆盖不影响 APP 分享 | APP 查询不读 node_overrides | 当前代码符合 |
| 同设备多管理员授权各自隔离 | 每次 token 只匹配单个管理员 | 隔离存在，自动合并未实现 |
| 设备身份不能仅靠可伪造 ID | free grant 分支只凭 device_id | 不满足 |

## 四、正式修复建议（不在本批实施）

### 4.1 统一 APP 节点访问授权函数

所有节点数据 API 统一执行：
1. 验证设备凭证；
2. 验证具体 entitlement 或免费绑定 grant；
3. 确定唯一 admin_user_id；
4. 校验分组属于该管理员且 enabled；
5. 校验设备对分组的 mode 可见性；
6. 通过 app_group_sources 限定来源；
7. 校验来源仍归属该管理员、启用且审核通过；
8. 只返回 enabled 节点；
9. 记录授权来源、group_id、generation，便于撤销与审计。

禁止另设绕过分组的宽泛节点接口。旧 `/api/app/nodes` 应兼容迁移为严格校验，或在确认 APK 升级路径后关闭宽泛返回；不可直接破坏仍在使用的正式 APK。

### 4.2 免费绑定和卡密授权拆分

建议独立数据模型：
- `app_identity_bindings`：设备凭证、管理员 ID、绑定时间、状态、撤销时间；
- `app_entitlements`：卡密授权实例、有效期、卡密来源、设备绑定；
- `app_free_grants`：明确由身份绑定授予的免费组资格，保留来源与撤销原因。

免费接口必须要求设备凭证，不得把公开分享编号当作节点读取授权。公开编号只用于解析管理员资料/发起绑定。

### 4.3 多管理员授权

采用“一个设备、多份独立授权”的模型：
- 每份授权绑定一个 admin_user_id；
- 请求明确携带 entitlement_id/token 或 binding_id/token；
- 响应保留 admin_user_id 与 group_id；
- APK 按管理员分区显示和缓存；
- 撤销其中一个管理员授权，不影响其他管理员数据。

### 4.4 防止个人覆盖泄漏

保持 APP 读取管理员原始节点，不读取普通用户 node_overrides/node_user_metadata。若未来需要管理员对 APP 分享节点做定制，应建立独立的管理员 APP 节点覆盖表，并明确作用范围与版本，不复用个人用户覆盖。

## 五、必须补充的测试

- 卡密设备调用 `/api/app/nodes`，只能获得授权可见分组的来源；
- 未分配给设备的 assigned 分组节点不得返回；
- 未加入任何 APP 分组的来源不得通过旧 nodes 接口泄漏；
- 同一管理员多个分组共享来源时，撤销一个分组不影响另一个仍授权分组；
- 关闭分组、移除来源、来源解除管理员归属后，节点查询立即停止返回并产生撤销事件；
- 普通用户修改个人节点名称/端口/enabled，不影响 APP 分享节点；
- 伪造 device_id 不能读取 app_free_grants；
- 公开 share code 只能解析/发起绑定，不能直接读取完整免费节点；
- 免费身份绑定与卡密 entitlement 分开创建、撤销和审计；
- 一个设备持有管理员 A、B 两份授权时，A 的 token 不得读取 B 的分组/节点/入口；
- A 授权撤销不影响 B；
- assigned 分组成员移除后不能继续获取节点；
- 多授权聚合若实现，必须保留管理员和分组归属，不跨管理员混淆。

## 六、状态与下一步

- 本批只提交静态审计报告，没有修改业务代码。
- 主要风险是 APP 节点宽泛下发接口可能绕过分组范围，以及免费接口缺少设备身份凭证。
- 普通用户覆盖未直接进入 APP 输出，这项隔离当前是正确方向。
- APK 是否调用 `/api/app/nodes`、`/api/app/groups` 或 `/api/app/free` 尚未通过源码审计确认。
- Batch 1 仍为 DEV，不可部署。

下一批继续核查 APP 卡密、管理员 VIP 到期/恢复、设备换绑、手动停用和超管撤销之间的状态机，重点确认任何一种恢复操作都不会错误恢复其他原因停用的授权。
