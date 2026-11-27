# 星跃管理平台 V2.5：统一导航配置与角色权限映射冻结稿

- 批次：第三十六批
- 版本标识：`V2.5-DEV-B1-NAV-RBAC-36`
- 日期：2026-11-27
- 状态：导航信息架构与前端展示策略设计冻结稿；未修改 HTML/Worker；未执行 D1；不可部署
- 基线 HTML：`星跃模拟后台 1.4.61.html`，blob `d046f71caa5af96b0c0978013771cb0a8f101739`
- 基线 Worker：`原始StarJump_V1点0_Final-zip-26-11-25-14:56/Worker.js`，blob `5da7aa3582558d9da2c2a0ad25a63c5e95e9fe63`
- 上游依据：第三十四批 APP 化交互规范、第三十五批首页与导航差距报告
- 冻结范围：导航 ID、入口职责、角色能力维度、显示策略、拒绝行为、前后端安全边界
- 不冻结：尚未核实的生产接口、D1 schema、Cloudflare 实际部署版本

## 1. 本批核心决定

从本批开始，导航不再由手机底部、桌面菜单、首页快捷入口各自维护。统一为一份只读的 Navigation Registry（导航注册表），所有 UI 展示从它派生。

导航配置只负责：
- route ID 与页面归属；
- 显示名称、图标、一级入口归属；
- 所需能力标签；
- 在桌面菜单、手机底栏、首页快捷区中的展示位置；
- 未授权时的安全跳转目标。

导航配置**不负责授予权限**。任何 API 写操作都必须由 Worker 根据当前认证主体、角色、VIP 状态、APP 管理授权、资源 owner、会话类型和操作类型重新判定。

## 2. 唯一五个一级入口

| 一级入口 ID | 中文名 | 默认 route | 责任边界 |
|---|---|---|---|
| `home` | 首页 | `v1-overview`（目标首页） | 身份状态、系统连接、待办、最近工作、快捷入口 |
| `convert` | 转换 | `v1-converter` | 基础转换、任务、批次、历史、方案、过滤规则、模板 |
| `nodes` | 节点 | `nodes` | 订阅源、节点、节点分组、同步与健康记录 |
| `app` | APP | `app`（APP 工作台入口） | APP 概览、授权分享、卡密、APP 用户、设备、版本与更新 |
| `me` | 我的 | `v1-me` | 账号、身份/VIP 权益、个人资料、安全、帮助、个人可访问记录 |

说明：
- route 是 UI 目标入口，不代表原 HTML 已有对应的统一页面实现。
- 首页历史 route `dashboard` 与 `v1-overview` 当前并存，实施时必须做兼容路由映射，不能直接删除旧 route。
- “APP”不等同于“卡密”；卡密只是 APP 工作台下的一个子模块。
- 超级管理员专属维护入口不挤占手机五项底栏，放入桌面系统管理分组及手机侧滑菜单中的“系统管理”。

## 3. 权限模型：角色与能力分开

禁止仅用一个 role 字符串决定全部按钮。至少使用以下独立判定维度：

1. **认证状态**：guest / authenticated / session-invalid。
2. **账号状态**：active / disabled / suspended / banned（具体枚举以服务端最终实现为准）。
3. **身份等级**：guest / registered / vip_trial / vip_paid / vip_expired / master。
4. **VIP 权益**：是否在有效期、是否处于允许的宽限状态、具体到期时间。
5. **APP 管理授权**：app management permission 是否授予、授权范围与有效状态。
6. **会话上下文**：正常本人会话 / 超管协助会话 / 其他受限会话。
7. **资源归属**：当前资源 owner/adminId 与当前主体是否匹配。
8. **动作能力**：read / create / update / delete / issue / revoke / export / migrate / publish。

最终授权表达式必须由服务端形成，不能让浏览器本地存储中的 role、VIP 日期或 appPerm 成为可信凭证。

## 4. 角色与能力矩阵（导航展示基准）

符号：✓ 可见且可进入（仍需服务端授权）；只读 = 可查看但不可更改；条件 = 需独立授权/资源范围校验；— = 默认不显示。

| 身份 | 首页 | 转换 | 节点管理 | APP 工作台 | 我的 | 系统管理 |
|---|---|---|---|---|---|---|
| 未注册访客 | 访客首页 | 基础转换/本人批次/默认分组只读复制 | — | — | 注册/登录/帮助 | — |
| 普通注册用户 | 个人首页 | 基础转换/本人记录 | — | APP 下载信息（若公开策略允许） | 个人资料/权益/帮助 | — |
| 有效 VIP 管理员 | VIP 工作台 | 完整授权范围内转换功能 | 自己名下订阅/节点/分组 | 仅在 APP 管理授权有效时显示管理模块 | 个人资料/VIP/安全 | 非超管系统项按权限 |
| VIP 体验管理员 | 与正式 VIP 相同的体验期功能 | 同有效 VIP | 同有效 VIP | 同有效 VIP + APP 独立授权检查 | 个人资料/体验状态 | 非超管系统项按权限 |
| VIP 到期管理员 | 降级提示/待办 | 只保留规则明确允许的基础功能与历史查看 | 默认只读/不可管理，具体以已确认规则 | 不可进行管理写操作；既有 APP entitlement 不能因 owner VIP 到期而被错误停用 | 个人资料/续费/历史 | — |
| 超管本人会话 | 全局运维首页 | 按超管策略 | 按超管策略 | 全局管理入口 | 个人资料/安全 | ✓ |
| 超管协助会话 | 当前被协助主体的受限首页 | 按被协助主体可见范围 | 按被协助主体可见范围 | 不得继承超管特权 | 协助上下文与退出入口 | — |

重要细则：
- “VIP 到期管理员可查看、删除其此前历史数据”等历史已确认规则，必须按数据类型与动作粒度单独定义；不得把“历史只读”笼统覆盖全部数据，也不得把删除历史数据扩展为可修改/新增。
- APP entitlement 生命周期与 owner 的后台 VIP 生命周期分离。后台 VIP 到期不能自动撤销已激活 APP entitlement。
- 超管协助会话不等于超管本人会话；协助会话默认禁止超管专属操作及跨租户访问。
- 体验 VIP 与正式 VIP 在有效体验期内享有正式 VIP 功能，但仍受 APP 独立授权及服务端资源归属约束。

## 5. 重要业务权限细分

### 5.1 APP 工作台

| 功能 | 普通注册用户 | 有效 VIP | 超管本人 | 超管协助会话 |
|---|---|---|---|---|
| APP 下载/公开信息 | 按公开策略只读 | ✓ | ✓ | 仅公开/被协助主体允许信息 |
| 查看 APP 概览 | — | 需 APP 管理授权 | ✓ | 不继承超管授权 |
| 查看卡密/APP 用户/设备 | — | 需 APP 管理授权 + owner scope | ✓ | 被协助主体范围内只读或拒绝 |
| 创建/修改/删除卡密 | — | 需 APP 管理授权 + VIP 有效 + owner scope | ✓ | 默认拒绝 |
| APP 版本/更新配置 | — | — | 超管专属 | 拒绝 |
| 授权分享管理 | — | 遵循 APP 分享规则 | ✓ | 不继承超管特权 |

### 5.2 两类 APP 分享与普通链接

- “接入星跃 APP”和“星链接”只向注册用户显示。
- 只有未过期有效 VIP 管理员可对前两类分享执行修改、增加、删除等管理操作。
- 注册非 VIP 与 VIP 已过期管理员，对前两类只能查看，不能修改或增减删。
- 普通链接继续按已确认的最低权限规则执行，不得把前两类 APP 分享权限套用到普通链接。
- APP 免费分组与卡密分组必须使用专门 APP 对接分享链接，不得用普通网页链接替代。

### 5.3 访客边界

访客允许：
- 基础节点转换；
- 查看和复制本人转换得到的节点；
- 查看和复制本人批次；
- 查看默认节点分组；
- 注册/登录与帮助。

访客禁止：
- 访问其他用户或管理员数据；
- 创建/管理 VIP 订阅源、节点或分享；
- 查看 APP 卡密、用户、设备；
- 使用未授权的后台管理操作。

## 6. 导航注册表字段规范

后续 HTML 实施必须采用一个统一配置对象/模块，字段建议：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 全局唯一稳定 ID，不因显示文案修改而改变 |
| `label` | string | 简体中文显示名 |
| `icon` | string | 图标名 |
| `route` | string | 实际 hash route |
| `primary` | enum | home/convert/nodes/app/me/system |
| `group` | string | 桌面侧栏业务分组 |
| `capabilities` | string[] | 展示所需能力标签 |
| `surfaces` | string[] | desktop/mobile/home/quick |
| `guestMode` | enum | hide/show/read-only |
| `fallbackRoute` | string | 被拒绝时的安全落点 |
| `order` | number | 同一分组内排序 |
| `status` | enum | active/deprecated/hidden |

规则：
- 所有 route ID 唯一；不允许多个导航项争用同一 route 却展示不同权限。
- 旧 route 采用 alias 映射并保留兼容跳转，确认迁移后才移除。
- `surfaces` 仅决定展示位置，不能成为权限判定。
- 用户自定义隐藏/收藏/排序只能影响展示，不能改变 capabilities。
- 未知 capability 默认拒绝；未知身份不能按普通 VIP 放行。
- 不在浏览器配置中保存 Secret、Token 或授权凭证。

## 7. 路由与服务端权限必须分层

前端路由守卫负责体验：
1. 登录状态失效 → 回登录入口；
2. 未注册访问注册专属页 → 注册说明；
3. VIP 权益失效访问 VIP 页 → 权益说明；
4. 缺少 APP 管理授权 → APP 授权说明；
5. 超管专属页面在协助会话中 → 拒绝并返回受限工作台；
6. 未知 route → 404，不得默认渲染 dashboard 后误导用户。

Worker 必须负责安全：
- 每次请求验证 session/token；
- 根据服务端数据计算角色与有效权益；
- 校验动作 capability；
- 校验 owner/adminId/资源关系；
- 对跨管理员访问拒绝并写入脱敏审计；
- 关键写操作验证幂等键与状态迁移；
- 迁移/发布/撤销等高风险动作使用独立确认和审计。
前端按钮隐藏、route 不显示、localStorage 的角色字段都不是安全边界。

## 8. 现有源码差距（静态证据）

1. 1.4.61 已有 `MENU`、`MENU_MAP`、`PAGE_META`，但它们主要服务桌面侧栏与路由，尚不是覆盖底部导航/首页快捷区的唯一注册表。
2. `renderBottomNav()` 单独硬编码访客与已登录两套数组，访客只有四项，已登录入口为首页/节点/转换/卡密/我的，与目标五项入口不一致。
3. `isMenuItemAvailable()`、`v1RouteDeniedReason()`、`hasEffectiveVipAccess()`、`requireAppPerm()` 已有前端门禁逻辑，但权限判断散落多个函数，不能证明服务端已覆盖每条 API。
4. `hasEffectiveVipAccess()` 会因 `CFG.impersonator` 拒绝有效 VIP 权限，这是协助会话限制的有益基础；但还需逐项审计其他操作入口，不能据此推断全站完整。
5. `VIP_ONLY_MENU_ROUTES` 与 `MASTER_ONLY_ROUTES` 是前端静态集合；APP 权限又是另一维度。实施时要统一计算 UI 可见能力，但不能把多个维度压扁成单一角色。
6. Worker 当前可见路由包括 `/api/convert`、`/api/convert/groups`、`/api/user/vip`、`/api/app/redeem`、`/api/app/status`、`/api/app/nodes`、`/api/super/schema-status`、`/api/super/migrate`、`/api/user/stats`、`/api/super/stats`、`/api/app/groups`、`/api/app/free`、`/api/app/links`、`/api/super/alerts` 等。
7. 该 Worker 源码头部仍标注部署 D1 binding 为 `DB -> starjump-db`，而用户已明确不再使用该库；因此该 Worker 只能作为历史源码分析基线，不能作为现行部署绑定或生产 schema 证明。
8. 目前没有证据证明 Cloudflare 实际部署的 Worker 与这份仓库历史文件完全一致，也没有证据证明线上 API 已具备完整 capability enforcement。

## 9. 实施顺序与验收

### 第一步：只做导航注册表
- 定义唯一 `NAV_REGISTRY`。
- 为旧 route 建立 alias map。
- 桌面侧栏、底部导航、首页快捷区全部从注册表生成。
- 暂不改业务页面逻辑，不改 Worker，不触碰 D1。

验收：每个入口 ID 唯一；桌面/手机同 route；访客入口符合访客范围；当前 route 在所有导航一致高亮。

### 第二步：统一前端能力快照
- 从认证上下文构建只读 `capabilitySnapshot`。
- 仅用于显示和路由体验；数据源必须是可信服务端响应。
- APP 管理能力与 VIP 状态分开。
- 超管协助会话显式标记并降权。

验收：切换角色/授权/会话后重新计算；未知或缺失字段默认拒绝；不以 localStorage 自报身份放行。

### 第三步：Worker API 权限逐路由核对
- 为每条 API 建立 endpoint → capability → owner scope → action 的权限表。
- 逐项检查读写方法、跨管理员资源 ID、协助会话、失效 session、过期 VIP、APP entitlement。
- 未完成后端审计的页面保持演示/未连接状态，不允许伪造成功。

验收：匿名、普通注册、VIP、体验 VIP、过期 VIP、超管本人、超管协助七类会话的正反向 API 测试全部通过。

## 10. 禁止事项与交付状态

- 不直接把旧 HTML 中的角色字段视为可信授权。
- 不把 VIP 到期与 APP entitlement 到期混为一谈。
- 不让超管协助会话继承超管权限。
- 不因 UI 隐藏菜单而省略 Worker 授权。
- 不把旧 Worker 的 `starjump-db` binding 复制到新部署方案。
- 不连接、迁移、清理或写入生产 D1；不操作 Secrets；不部署。
- 不把设计稿称为已经实现或已通过权限测试。

**本批结论：唯一导航架构、五个一级入口和角色/能力分离模型已冻结为后续 HTML 改造依据。实际代码实施、Worker 逐路由权限审计与真实角色测试尚未完成。本批不可部署。**

下一批建议：第三十七批先把 NAV_REGISTRY 的完整 route 清单与旧 route alias 对照表整理出来，逐项匹配现有 PAGE_RENDERERS/MENU_MAP，标出不存在页面、重复入口、旧入口迁移和需要新增的工作台页面，再开始最小范围 HTML 改造。