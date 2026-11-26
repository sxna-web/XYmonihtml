# 星跃 V2.5 Worker API 路由与前端接入盘点（只读初版，2026-11-27）

## 1. 基线与限制

- 仓库：`sxna-web/XYmonihtml`
- 分支：`main`
- Worker：`原始StarJump_V1点0_Final-zip-26-11-25-14:56/Worker.js`
- Worker blob SHA：`5da7aa3582558d9da2c2a0ad25a63c5e95e9fe63`
- 模拟 HTML：`星跃模拟后台 1.4.61.html`
- HTML blob SHA：`d046f71caa5af96b0c0978013771cb0a8f101739`
- 只读静态盘点；未发请求、未查询生产配置、未更改 Worker/D1/Secrets。

## 2. 前端接入结论

当前仓库中的 `星跃模拟后台 1.4.61.html` 没有生产 Worker API 调用：
- 文件说明明确写明本地浏览器模拟、不连接生产 Worker/D1。
- 源码未检出 `/api/`、`fetch(`、`XMLHttpRequest`、`Authorization`、`Bearer `。
- 主业务数据由 localStorage 的 `saveDB/loadDB` 管理；图片使用 IndexedDB。

因此本文件中的 Worker 路由是“后端已有路由盘点”，不是“HTML 已完成接入清单”。正式 HTML 接入前，每个页面动作都必须补齐 API 映射。

## 3. Worker 路由分组（按 fetch 分发层静态代码）

### 3.1 公开/匿名可达或可选会话接口

| 路径 | 分发层行为 | 接入注意 |
|---|---|---|
| `/health` | 健康检查 | 不代表 D1 业务读写正常 |
| `/api/announcements` | 与 APP version 同一公开分支处理 | 需核对具体方法与返回结构 |
| `/api/app/version` | 公开 APP 版本信息 | 不等于 APP 下载/授权 |
| `/api/app/download` | GET 下载信息 | 需校验下载链接、版本与发布状态 |
| `/api/app/resolve` | GET 解析分享/身份相关数据 | 必须核对解析码限流与数据边界 |
| `/api/app/free` | GET 免费分组读取 | 公开入口；需明确匿名免费边界和管理员权限开关 |
| `/api/app/redeem` | APP 卡密兑换 | 需核对设备绑定、卡密原子消费和事件写入 |
| `/api/app/status` | APP 授权状态查询 | 当前审计发现与 nodes/groups 的 Token 验证口径不一致 |
| `/api/app/nodes` | APP 节点读取 | 必须验证 entitlement Token 和来源/节点状态 |
| `/api/app/groups` | APP 分组读取 | 多管理员授权选择、free grant 和来源所有权需统一 |
| `/api/app/links` | APP 链接读取 | 需验证 entitlement 和管理员隔离 |
| `/api/convert` | POST 转换 | 可选登录会话；匿名通过 guest key 归属 |
| `/api/convert/groups` | 转换链接分组读取/管理 | 必须按 owner key 隔离 |
| `/api/convert/groups/rename` | POST 重命名 | 需按 owner key 限定 |
| `/api/convert/links...` | 转换链接读取/撤销等 | 需按 owner key 限定；逐个子路径方法待补 |

### 3.2 用户会话接口

分发层统一要求：
- 必须解析到有效用户会话，否则 401。
- 拒绝 legacy ADMIN_TOKEN 会话（403）。
- 协助会话按方法实施 scope：GET=read、DELETE=manage、其他写操作=operate。
- scope 拒绝会写入拒绝审计。

路由族：
- `/api/user/sources...`：订阅来源管理
- `/api/user/nodes...`：节点管理；包含 overrides、metadata 子路由
- `/api/user/node-groups...`：节点分组
- `/api/user/vip`、`/api/user/vip/activate`：VIP 状态/激活
- `/api/user/convert-groups`：转换分组
- `/api/user/sync-logs`：同步日志
- `/api/user/stale-nodes`：过期/陈旧节点
- `/api/user/stats`：用户统计
- `/api/user/app-cards/export`：卡密导出
- `/api/user/downloads...`：下载记录/管理
- `/api/user/share-code`：分享编号
- `/api/user/app-groups...`：APP 分组管理
- `/api/user/app-links...`：APP 链接管理
- `/api/user/app-cards...`：APP 卡密管理

注意：GET/DELETE/写操作的 scope 只是协助会话的统一范围门禁，不等于各业务路由的 VIP、资源归属和对象级权限检查。每个写路由仍须逐项核对。

### 3.3 超级管理员接口

多数显式 super 路由要求：
- 有效超级管理员会话；
- 非 legacy ADMIN_TOKEN；
- 部分总后台路由还要求 actorId 与 effectiveId 一致，防止协助会话访问总后台。

路由族：
- `/api/super/releases...`、`/api/super/announcements...`
- `/api/super/admins...`
- `/api/super/downloads...`
- `/api/super/app-groups...`
- `/api/super/app-links...`
- `/api/super/app-perms...`
- `/api/super/app-entitlements/.../rebind`
- `/api/super/stats`
- `/api/super/alerts`
- `/api/super/node-lifecycle...`
- `/api/super/vip-cards...`
- `/api/super/impersonation/end`（协助会话结束自身的例外）
- 其他由 `isSuperApi()` 进入 `superRoute()` 的路由。

高风险：
- `/api/super/schema-status`、`/api/super/migrate` 允许 legacy ADMIN_TOKEN 作为兜底；其中 migrate 可能改变 D1 schema，禁止未经审批调用。
- `/api/super/vip-cards` 单独检查超级管理员会话、非 legacy、actorId=effectiveId。

### 3.4 旧版管理接口

`isLegacyApi()` 路由要求超级管理员授权且禁止协助会话；legacy ADMIN_TOKEN 仍可能进入部分旧接口。必须建立旧接口清单，明确哪些只为迁移兼容保留，避免正式 HTML 误用。

## 4. 已知接入错配（沿用既有审计）

- 用户面板同步曾错误调用 `/api/admin/sync`；正确用户同步路径应核对 `/api/user/sources/:id/sync`。
- 转换请求必须在登录态携带用户会话；匿名态使用稳定 guest key；不能把 guest key 当认证 Token。
- APP 管理写接口必须有有效 VIP 和管理员资源归属校验。
- APP 免费组、APP 卡密组必须使用各自专用 APP 授权链路，不得拿普通网页分享链接替代。
- HTML 当前未接入这些 API，模拟点击不构成接口联调证据。

## 5. 正式 HTML 接入前必须完成的接口契约字段

每个前端操作逐项建立一行契约，至少包含：
1. 页面/按钮/业务动作；
2. HTTP 方法、精确路径；
3. 登录要求与 Token 类型；
4. L0/L1/L2/超管/体验 VIP/正式 VIP 到期等身份权限；
5. 资源归属校验（user_id/admin_user_id/source_id/group_id/card_id/device_id）；
6. 请求参数、字段类型、长度、枚举、必填条件；
7. 成功响应 JSON schema；
8. 401/403/404/409/410/429/5xx 的错误码与前端提示；
9. 幂等键/并发控制/重试规则；
10. 审计日志字段；
11. D1 读写表与事务边界；
12. 自动化测试用例。

## 6. 下一轮审计优先级

1. 按路由逐个检查 userSourcesRoute、userNodesRoute、userGroupsRoute、userAppGroupsRoute、userAppCardsRoute 的方法、VIP 门禁和对象归属。
2. 按路由检查 appGroupsForDevice、appFreeGroupRoute、appLinksForDevice、appRedeemRoute、appResolveRoute 的设备授权与数据隔离。
3. 核对 auth 登录/注册/会话刷新、Token 过期和协助会话 scope。
4. 从 HTML 提取全部交互动作与数据模型，建立 mock 功能 → Worker API → D1 表映射；没有后端接口的功能列为待开发，不虚构接口。
5. APK ZIP 解包后才可完成客户端请求字段和缓存联调。

## 7. 安全边界

- 不调用 `/api/super/migrate`。
- 不对生产发起写请求。
- 不导出、复制或记录真实卡密、订阅 URL、Token、Secret。
- 不因 HTML 模拟数据与 Worker 表结构相似就假定两者已同步。
- 本报告只基于当前仓库静态源码，不代表线上部署版本与仓库版本一致；部署版本须另行只读核验。
