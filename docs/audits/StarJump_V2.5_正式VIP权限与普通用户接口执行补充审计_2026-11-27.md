# 星跃 V2.5 正式 VIP 权限与普通用户接口执行补充审计（2026-11-27）

## 1. 审计基线与范围

- 仓库：`sxna-web/XYmonihtml`
- 分支：`main`
- Worker：`原始StarJump_V1点0_Final-zip-26-11-25-14:56/Worker.js`
- Worker blob SHA：`5da7aa3582558d9da2c2a0ad25a63c5e95e9fe63`
- 方式：只读静态源码审计；未调用真实 API、未修改 D1、未部署。
- 本轮目标：核对登录门禁、VIP 门禁、体验/正式 VIP 到期后的历史操作边界，以及超管独立权限。

本报告中的“发现缺失”是代码静态证据，不代表已经在生产环境复现。实际线上部署版本和 D1 绑定仍待核实。

## 2. 总结结论

**当前 Worker 对 `/api/user/*` 的统一入口只验证有效用户 Session 和协助会话 scope，没有统一验证 VIP。** `requireUser(ctx)` 仅检查是否登录；在本轮检查范围内没有发现 `requireVip`、`requireActiveVip` 或等价的统一服务端门禁。

这会导致以下已确认应受有效 VIP 限制的功能，不能仅凭当前 Worker 代码证明已受保护：

1. APP 分组创建、编辑、删除、来源关联、设备成员管理；
2. APP 入口链接新增、删除；
3. APP 用户卡密生成；
4. 转换过滤/重命名等高级功能。

更严重的是，部分 APP 写接口对普通注册用户和 VIP 到期用户开放；这与已确认的业务规则不一致。前端隐藏按钮不能修复服务端越权。

## 3. 路由层实际执行的权限

### 3.1 用户 API 统一入口

源码位置约第 5424-5433 行：

- 所有 `/api/user/*` 先要求存在 Session；未登录返回 401。
- 拒绝旧版 `ADMIN_TOKEN` 直接访问用户态 API。
- 协助会话按 HTTP 方法计算 scope：GET=read、DELETE=manage、其他写操作=operate。
- 该 scope 只限制超管协助他人时的操作范围；本人 Session 不受 scope 限制。
- 此入口没有调用 VIP 状态检查。

因此，scope=manage 不代表有效 VIP；Session 有效也不代表有效 VIP。

### 3.2 超管独立权限

源码路由分流显示：

- `/api/super/*` 需要有效用户 Session、`role=super_admin`，并且不是协助他人的 effective 身份；协助会话除结束自身会话外不能进入总后台。
- `/api/super/vip-cards` 另有独立超管会话检查。
- `ADMIN_TOKEN` 被限制在旧后台兼容、bootstrap 和迁移/紧急恢复边界，不应当作普通多用户超管 Session。
- 超管权限不依赖其自身是否有 VIP 激活记录；这是独立角色权限。

**结论：超管独立于 VIP 的路由边界有实现证据。** 但生产配置、角色数据与实际部署仍需联测。

## 4. 逐功能核对

| 功能 / 路由 | 当前代码实际门禁 | 与已确认规则的差异 |
|---|---|---|
| `GET /api/user/vip` | 登录 Session | 合理：允许查看自身 VIP 状态 |
| `POST /api/user/vip/activate` | 登录 Session；卡密 unused 校验；批次内竞争断言 | 未发现额外 VIP 门禁；符合用户通过卡密激活/续费的基本方向 |
| `/api/user/app-groups` GET | 登录 Session | 可供注册用户查看；还需确认过期身份可见范围 |
| `/api/user/app-groups` POST/PUT/DELETE | 登录 Session + 协助 scope | **缺有效 VIP 门禁**；创建、编辑、删除均可进入业务代码 |
| `/api/user/app-groups/:id/sources` POST | 登录 Session + scope + 来源归属检查 | **缺有效 VIP 门禁**；普通注册用户可尝试关联来源 |
| `/api/user/app-groups/:id/members` POST | 登录 Session + scope + device_id 格式检查 | **缺有效 VIP 门禁** |
| `/api/user/app-links` GET | 登录 Session | 读取入口与权限设置 |
| `/api/user/app-links` POST/DELETE | 登录 Session + scope；新增另检查 links_enabled、数量上限 | **缺有效 VIP 门禁**；links_enabled 只是功能开关，不是 VIP 状态 |
| `/api/user/app-cards` GET、`events` GET、CSV export | 登录 Session | 读取历史数据；应结合体验/正式 VIP 到期规则细化 |
| `/api/user/app-cards` POST | 登录 Session + 库存/数量限制 | **缺有效 VIP 门禁**；可尝试生成新 APP 卡密 |
| `/api/user/app-cards/:id` DELETE | 登录 Session + 卡密归属和未激活/未使用检查 | **缺正式 VIP/体验 VIP 到期边界**；当前体验 VIP 到期用户也可能删除历史卡密 |
| `/api/user/app-cards/:id/disable` POST | 登录 Session + 卡密归属 | **缺有效 VIP 门禁**；可尝试停用卡密 |
| `/api/convert` POST 的 filters | 公开转换路由 | 注释称“过滤/重命名仅对登录用户开放（VIP 功能）”，但实际没有检查 ctx、Session 或 VIP；匿名请求也会执行 `applyNodeFilters` |
| `/api/convert/links` GET、groups GET、rename、revoke | owner_key / guest_key 归属 | 属于个人转换历史和访客基础管理；需依已确认 L0/L1 规则继续保持隔离，不应把 guest key 当作用户认证 |
| `/api/user/sources`、`nodes`、`node-groups`、`overrides`、`metadata` | 登录 Session、数据归属、协助 scope | 本轮未发现 VIP 检查；是否属于基础注册权益或 VIP 权益，应按产品权限表最终定级，不可擅自扩大或收紧 |
| `/api/user/sync-logs`、`stale-nodes`、`stats`、`downloads`、`share-code` | 登录 Session、数据归属 | 未发现 VIP 检查；需按功能权益表确认哪些只读能力可供过期用户使用 |

### 4.1 APP 分组：确定的缺口

`userAppGroupsRoute()` 源码约第 4521-4581 行，函数注释仍写“注册用户也能用”。POST、PUT、DELETE、sources POST、members POST 直接执行 D1 写操作，没有检查当前 VIP 状态。

这与用户已确认的规则冲突：APP 接入/星链接及相关 APP 分组只有有效 VIP 管理员可管理；普通注册用户、VIP 已过期管理员只能查看。

### 4.2 APP 入口链接：确定的缺口

`userAppLinksRoute()` 源码约第 4285-4302 行：

- GET 返回入口与 `adminPerms`；
- POST 仅由 `addAppLink()` 检查 `links_enabled`、最大数量和 URL 格式；
- DELETE 只检查记录归属；
- 没有有效 VIP 检查。

`links_enabled` 是超管配置的业务开关，不能替代 VIP 授权。

### 4.3 APP 用户卡密：确定的缺口

`userAppCardsRoute()` 源码约第 3558-3661 行：

- GET 读取卡密列表；
- POST 生成新卡密，只检查数量、天数、库存和总记录上限；
- DELETE 将未激活/未使用卡密标为 `inactive`、`manual_disabled=1`；
- disable POST 设置手动停用；
- 所有写操作都没有 VIP 状态门禁。

业务规则要求：有效 VIP 才能新建/生成和管理；正式 VIP 到期后可查看、删除此前历史数据，但不能新建或编辑；体验 VIP 到期只能查看，不能删除历史数据。因此不能简单地对整个路由一刀切 403，必须按操作类型和 VIP 历史类型判定。

### 4.4 转换高级过滤：注释与执行不一致

`convertRoute()` 源码约第 3212-3330 行，过滤位置约第 3289-3292 行：

- 注释写明过滤/重命名是 VIP 功能；
- 实际直接调用 `applyNodeFilters(nodes, body.filters)`；
- 路由入口将 `/api/convert` 作为公开接口传入 `ctx=null`；
- 函数内部虽尝试解析 Session 以决定归档 owner，但没有用该身份控制 filters。

所以当前代码不能证明过滤/重命名只对登录用户开放，更不能证明只对有效体验/正式 VIP 开放。匿名用户可提交 filters 的风险应按真实测试进一步验证。

## 5. VIP 状态函数本身的不足

`vipStatus(db, userId)` 源码约第 3352-3372 行：

- 使用 `MAX(ends_at)` 计算一个整体 `until`；
- `active` 只判断这个最大到期时间是否晚于当前时间；
- `is_formal` 只表示是否存在过 formal 激活历史；
- `has_trial` 只表示是否存在过 trial 激活历史；
- 没有返回当前有效授权属于 trial 还是 formal；
- 查询异常时返回 `unavailable: true`，但没有统一的权限门禁消费此状态。

因此这些字段不足以直接区分“体验 VIP 有效”“体验 VIP 已过期”“正式 VIP 有效”“正式 VIP 已过期”。尤其不能把 `is_formal=true` 当作“当前正式 VIP 有效”。

修复时应按激活记录逐条判定当前有效类型，并保留到期历史：

1. 有效体验 VIP：体验期内享有已确认的正式 VIP 核心管理功能；
2. 有效正式 VIP：开放正式 VIP 管理写权限；
3. 体验 VIP 到期：只读历史，不得删除、编辑、新建；
4. 正式 VIP 到期：可查看、删除此前历史数据；不得新建、编辑、关联或生成新卡密；
5. 从未有 VIP 的普通注册用户：只开放 L1 已确认权益；
6. 超管：按独立角色权限处理，不依赖 VIP 激活状态。

若同一用户存在多条激活记录，必须明确当前有效授权的聚合优先级，不能只依赖一个 `MAX(ends_at)` 与历史布尔值。

## 6. 新增问题登记

### P1-44：用户态管理接口缺少统一 VIP 服务端门禁

**证据：** 用户 API 入口只验证 Session/scope；APP 分组、APP 入口、APP 卡密写路由未检查有效 VIP。

**影响：** 普通注册用户或 VIP 已到期用户可直接调用 API 尝试执行本应受有效 VIP 限制的管理操作；绕过前端隐藏按钮。

**修复要求：**
1. 建立统一服务端授权函数，输入 actor/effective 身份、当前激活记录、操作类型、资源归属。
2. 在每个写路由执行 D1 变更前调用，不得只在 HTML 层检查。
3. APP 分组、APP 入口、APP 卡密的新建/编辑/关联/生成/停用等操作要求有效体验或正式 VIP。
4. 正式 VIP 到期只允许查看和删除此前历史数据；体验 VIP 到期只读。
5. 超管使用独立角色授权，不受 VIP 门禁误伤。
6. 协助会话必须同时满足 scope 与目标用户 VIP 规则；scope 不能提升目标用户 VIP 权益。

### P1-45：转换 filters 高级功能没有登录与 VIP 校验

**证据：** 公开 `/api/convert` 路由直接执行 `applyNodeFilters`，注释与实现不一致。

**影响：** 匿名用户可能使用被定义为 VIP 的过滤/重命名能力；注册用户也没有按体验/正式 VIP 状态区分。

**修复要求：**
1. 基础转换仍允许 L0 匿名用户使用。
2. 请求未提交 filters 时按基础转换执行。
3. 请求包含非空高级 filters 时，必须验证用户 Session，并确认体验/正式 VIP 当前有效。
4. 体验 VIP 到期、正式 VIP 到期、普通 L1、无效 Token 均应拒绝高级 filters，返回稳定错误码。
5. 不得因高级功能鉴权失败而阻断用户使用基础转换。

### P1-46：VIP 状态聚合字段不能可靠区分有效体验与有效正式 VIP

**证据：** `vipStatus()` 以最大 `ends_at` 计算 active，以历史记录计算 `is_formal/has_trial`，没有当前有效授权类型。

**影响：** 后续若直接以 `active` 或 `is_formal` 作权限判断，可能错误授予或拒绝管理权限，尤其在体验/正式激活历史并存、续费和过期场景。

**修复要求：**
1. 返回当前有效授权记录类型、有效起止时间及历史正式/体验记录摘要。
2. 有效授权判定基于 `ends_at > now` 的具体激活行，不以历史 `is_formal` 代替。
3. 明确多条有效授权的合并规则与并发激活规则。
4. VIP 状态查询失败时，敏感写操作必须 fail closed；只读状态接口可返回明确不可用状态。

### P2-25：正式 VIP 到期与体验 VIP 到期的历史删除权限未按操作分级

**证据：** APP 卡密 DELETE 路由只校验归属和卡密是否已激活/使用，没有检查管理员 VIP 类型和到期状态。

**影响：** 体验 VIP 到期后可能删除历史卡密；正式 VIP 到期后删除权限也没有明确限制为此前历史数据。

**修复要求：**
- 将 read、delete-history、create、edit、associate、disable 等动作分别授权；
- 正式 VIP 到期仅允许删除本人到期前已有且仍可删除的历史记录；
- 体验 VIP 到期完全只读；
- 不得把“DELETE HTTP 方法”一概视为允许，必须验证记录归属、创建时间/归属历史和资源状态。

## 7. 建议的统一权限决策表

| 身份状态 | 查看本人历史 | 删除本人历史 | 新建/编辑/关联/生成 | 高级转换过滤 |
|---|---:|---:|---:|---:|
| L0 未注册 | 仅自己的访客转换记录 | 按访客基础规则 | 仅基础转换 | 否 |
| L1 注册、无有效 VIP | 是（按 L1 数据范围） | 按 L1 已确认规则；APP 管理历史待定 | 否（受 VIP 限制的管理功能） | 否 |
| 有效体验 VIP | 是 | 是（仅体验期内且业务允许） | 是 | 是 |
| 体验 VIP 到期 | 是 | **否** | 否 | 否 |
| 有效正式 VIP | 是 | 是 | 是 | 是 |
| 正式 VIP 到期 | 是 | **是，仅限此前历史数据** | 否 | 否 |
| 超级管理员本人 Session | 按超管接口权限 | 按超管操作审计与资源规则 | 按超管权限 | 仅按超管产品授权策略 |
| 超管协助会话 | 受 scope=read/operate/manage 限制 | 需 manage，且仍受目标用户历史/VIP 业务规则约束 | 需 operate/manage，且不得借 scope 越过 VIP 规则 | 不得借协助会话取得总后台权限 |

注：L1 对普通节点、来源、分组等非 APP 功能的读写权益仍须由最终产品权益表确认；本报告不擅自把它们全部改成 VIP 专属。

## 8. 修复实施顺序

1. 先实现可靠的 VIP 状态解析：当前有效类型、历史类型、到期状态、数据不可用状态。
2. 实现动作级授权函数：`read`、`create`、`update`、`associate`、`disable`、`delete_history`。
3. 优先封堵 APP 分组、APP 入口、APP 卡密写接口（P1-44）。
4. 单独修复转换高级 filters 的匿名绕过（P1-45），保留 L0 基础转换。
5. 对所有拒绝操作写审计；敏感写入与审计尽量同 D1 batch。
6. 前端只负责按权限展示入口；Worker 每次请求都重新判定。
7. 在独立测试库验证后，再提交生产变更审批；本报告不授权部署或修改 D1。

## 9. 必须执行的测试矩阵

对每类接口分别使用以下身份请求，并检查 D1 是否真的没有发生越权变更：

- 匿名 L0（含 guest_key、缺失 guest_key）；
- L1 注册无 VIP；
- 有效体验 VIP；
- 体验 VIP 到期；
- 有效正式 VIP；
- 正式 VIP 到期；
- 已停用/锁定用户；
- 无效、撤销、过期 Session；
- 超管本人 Session；
- 超管 read/operate/manage 协助会话；
- 协助 scope 撤销/过期后继续重放旧 Token。

关键场景：
1. 普通 L1 直接 POST/PUT/DELETE APP 分组、关联来源、添加设备成员，必须 403 且 D1 无变化。
2. 普通 L1 直接新增/删除 APP 入口，必须 403 且 D1 无变化。
3. 普通 L1 直接 POST 生成 APP 卡密，必须 403 且 D1 无变化。
4. 有效体验 VIP 可执行允许的管理操作；体验到期后任何历史删除都必须拒绝。
5. 正式 VIP 到期后可以查看并删除允许删除的历史记录，但不能创建、编辑、关联、生成或停用新资源。
6. 匿名提交 filters、L1 提交 filters、体验/正式 VIP 到期提交 filters，必须拒绝高级功能，但无 filters 的基础转换仍成功。
7. 超管在无 VIP 激活记录的情况下仍可进入独立超管接口；协助会话不能访问总后台。
8. VIP 状态表查询异常时，敏感写操作 fail closed，不得默认放行。

## 10. 禁止事项

- 不得只在 HTML 隐藏按钮而不修 Worker。
- 不得把有效体验 VIP 与有效正式 VIP 混为同一历史状态。
- 不得把 `is_formal` 历史标记当作当前正式 VIP 有效证明。
- 不得因正式 VIP 到期而删除或停用其全部历史数据。
- 不得允许体验 VIP 到期后删除历史数据。
- 不得将 L0 基础转换强制改成必须注册/VIP。
- 不得让协助 scope 替代目标用户的 VIP 业务授权。
- 未经明确审批，不得修改生产 Worker、D1、密钥或部署配置。
