# 星跃 V1.0 HTML—Worker API 兼容性初审（2026-11-27）

## 1. 审计范围与证据

- 仓库：`sxna-web/XYmonihtml`，分支 `main`
- HTML：`原始StarJump_V1点0_Final-zip-26-11-25-14:56/index.html`（本次读取 SHA：`ab98aecd4c8546eda197bbb4d5a9f5ec0db82613`）
- Worker：`原始StarJump_V1点0_Final-zip-26-11-25-14:56/Worker.js`（本次读取 SHA：`5da7aa3582558d9da2c2a0ad25a63c5e95e9fe63`）
- 方法：静态提取 HTML 中 API 调用，核对 Worker 路由分发、处理函数及权限检查。
- 未进行线上请求、D1 查询/写入、迁移、部署或源码修改。
- 本文是静态兼容初审，不等于运行测试；未覆盖的接口参数/响应字段必须在后续逐项补齐。

## 2. 总体结论

HTML 与该 Worker 存在大范围同源接口设计，主要业务路由可在 Worker 中找到；但至少有以下高优先级兼容/权限问题：

1. **APP 对接管理写接口缺少有效 VIP 门禁**：`/api/user/app-groups`、`/api/user/app-links`、`/api/user/app-cards` 的 POST/PUT/DELETE 由普通用户 Session 进入，处理函数中未见有效 VIP 状态检查。与 V2.5「仅有效 VIP 管理员可管理 APP 对接/星链接」冲突。
2. **转换过滤/重命名权限未落实**：Worker 注释标注 VIP 功能，但公开 `POST /api/convert` 直接执行 `applyNodeFilters`；未见登录或有效 VIP 校验。匿名转换本身应保留，但过滤/重命名应按最终权限矩阵受服务端门禁。
3. **APP 分组删除为直接物理删除**：`userAppGroupsRoute` 删除分组后直接删除关联关系；未见回收站、版本历史、卡密/分享/转换引用检查、generation 或设备清理确认。
4. **APP 设备状态接口仅凭 device_id 查询**：`GET /api/app/status` 未验证设备授权 token，设备 ID 若泄露/可猜测可能暴露授权状态元数据。
5. **APP 节点接口回传完整 URI**：`GET /api/app/nodes` 查询 `n.uri` 并返回，需与 APK 安全存储、传输和本地缓存保护方案一起审查。
6. **HTML 暴露在线迁移操作入口**：页面调用 `/api/super/migrate` 并传 `confirm:'yes'`。本审计没有调用它；生产页面应移除普通操作入口或加离线审批/明确环境隔离，严禁误触迁移。

## 3. HTML—Worker 路由对照

| HTML 功能/API | Worker 路由证据 | 初审结论 |
|---|---|---|
| 登录、注册、退出、当前用户：`/api/auth/*` | `routeAuth`；登录/注册公开，其余要求 Session；bootstrap 需 legacy super | 基本有路由；注册开放策略受 Worker 配置控制 |
| 用户订阅源：`/api/user/sources`、单条删除、enabled | `userSourcesRoute`；列表按 `ctx.effectiveId` 关联归属 | 有路由和 owner 过滤；写权限与配额需逐操作继续核验 |
| 用户节点、手动节点、覆盖、metadata | `userNodesRoute`、`userOverridesRoute`、`userMetadataRoute` | 有路由；读写均由用户 Session 和 effectiveId 上下文约束 |
| 普通节点分组：`/api/user/node-groups` | `userGroupsRoute` | 有路由；按当前 effectiveId 查询归属 |
| 用户 VIP：`/api/user/vip`、`/activate` | `userVipRoute` | 有路由；需另行核对体验卡/正式卡及到期语义是否符合 V2.5 |
| 转换：`/api/convert`、`/api/convert/groups`、`/api/convert/links` | 公开分发到 `convertRoute` | 基础转换可匿名；过滤/重命名未见门禁；访客组/匿名归属仍需检查安全认领 |
| 超管用户、审计、统计、协助授权 | `superRoute` | 路由存在；总路由要求超管 Session，拒绝协助会话进入总后台 |
| 超管来源配额、来源审批、来源分配 | `superRoute` 中有 `source-quotas` 等处理；其他路径需按分支逐项核验 | 不应仅因存在总路由就判定每个页面动作都兼容 |
| 超管 APP 分组、入口、权限、授权 | `superAppGroupsRoute`、`superAppLinksRoute` | 有路由；仍需核对 V2.5 的历史版本、删除保护和授权联动 |
| 用户 APP 分组、入口、APP 卡密 | `userAppGroupsRoute`、`userAppLinksRoute`、`userAppCardsRoute` | 有路由，但有效 VIP 写门禁缺失（P1） |
| APP 设备：version、download、resolve、groups、free、links、redeem、status、nodes | 对应公开 `/api/app/*` 分发 | 部分接口凭设备 ID/token；status 只见 device_id，nodes 返回 URI；需 APK 联调 |
| 超管迁移：`/api/super/schema-status`、`/api/super/migrate` | `migrateRoute` | 高风险运维入口；本次未执行，生产不得误触 |

## 4. 已确认的路由级权限行为

- 所有 `/api/user/*` 先要求有效 Session，拒绝 legacy ADMIN_TOKEN。
- 用户 API 的协助会话权限按方法粗分：GET=read、DELETE=manage、其他写操作=operate；具体业务还应检查资源归属。
- 多个用户资源查询使用 `ctx.effectiveId`，如订阅源、节点分组、APP 分组和 APP 入口。
- `/api/super/*` 总路由要求超级管理员 Session；协助会话不能访问总后台，结束自身协助会话是唯一例外。
- `/api/app/*` 与 `/api/convert` 中有公开接口，不能把公开路由本身误判为缺陷；关键在于公开能力边界和授权令牌校验。

## 5. 必须进入后续修复设计的问题

### P1：APP 管理写操作统一有效 VIP 门禁

需要在 Worker 服务端对以下操作执行统一 VIP 检查：
- `/api/user/app-groups`：POST、PUT、DELETE，以及 sources/members 等管理写操作。
- `/api/user/app-links`：POST、DELETE。
- `/api/user/app-cards`：POST、DELETE、disable 等管理操作。

注册非 VIP、体验 VIP/正式 VIP 已过期者应按 V2.5 规则只读；超管操作仍走独立超管授权路径。不能只依赖 HTML 隐藏按钮。注意：体验 VIP 过期和正式 VIP 过期的历史数据权限不同，不能用一个简单的 `active=false` 全部处理。

### P1：转换高级过滤权限

- 保留 L0 基础转换，不增加注册强制门槛。
- 对 `body.filters` 的 include/exclude/rename 等高级处理，在 Worker 服务端核验登录身份和有效 VIP。
- 未授权时应明确拒绝高级参数或安全降级为基础转换，不能静默接受 VIP 功能。
- 最终策略须与 V2.5 权限矩阵一致，并通过匿名、注册非 VIP、体验 VIP、正式 VIP、过期 VIP 测试。

### P1：APP 分组生命周期和设备清理

- 删除/改型前检查关联卡密、授权、分享、转换链接等依赖。
- 保留变更版本、操作者、时间、节点差异；回滚必须创建新版本。
- 使用 generation/version、短期授权租约和设备端防回滚。
- APK 联网后执行清理并回传 cleanup acknowledgement；离线期间不能承诺 Worker 远程强制删除。
- 先停止下发，再让 APK 在租约到期/版本变化时拒绝旧数据并清理本地缓存。

### P1：APP 状态和节点数据保护

- `/api/app/status` 应评估是否必须验证授权 token；至少确保 device_id 不可枚举并避免泄露不必要元数据。
- `/api/app/nodes` 返回 URI 属于敏感凭证传输；APK 必须安全保存，接口日志不得记录完整 URI。
- 继续评估传输之外的 D1 静态加密与密钥轮换，但不得在未核对现有表和 APK 兼容前修改字段。

### P1：迁移入口隔离

- HTML 中不应把 `/api/super/migrate` 作为日常可点击功能。
- 任何迁移必须独立审批、备份、核对目标环境、执行前后 schema diff，并且明确针对 staging 还是 production。
- 本项目当前暂停 D1 变更；此项仅登记风险，不执行。

## 6. 当前不能宣称已完成的事项

- 未完成所有 HTML 请求的逐字段 request/response schema 核验。
- 未对所有 `superRoute` 分支、来源审批/分配、转换链接管理等操作完成逐动作权限审计。
- 未对真实 Worker 运行接口测试、并发测试或 D1 兼容测试。
- 未审计 APK 6.00.47/6.00.48 源码，故不能确认设备端清理、租约、防回滚或缓存加密已实现。
- 未检查当前部署 Worker 是否与仓库这份原始 V1.0 Worker 完全一致。

## 7. 下一步审计顺序

1. 把 HTML 每个页面动作拆成 METHOD + PATH + 请求字段 + 读取响应字段。
2. 对照 Worker handler 的实际分支，补齐状态码、字段和失败行为。
3. 逐操作标注 Session、VIP、owner、super、device token 门禁。
4. 形成接口兼容矩阵与缺失接口清单，再进入 Worker 修改方案。
5. APK 源码可读取后，逐项对照设备注册、授权租约、generation、防回滚、清理确认和凭证存储。

**保护声明：本文件只记录审计结果和待办，不授权修改 Worker、D1、生产变量或部署。**
