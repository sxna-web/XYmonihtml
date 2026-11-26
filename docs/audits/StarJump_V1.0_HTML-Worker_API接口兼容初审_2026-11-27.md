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


## 8. 第二轮逐调用核对补充（HTML 请求与 Worker 分发）

本轮继续读取 HTML 请求封装、用户面板动作、转换页面和 Worker 对应处理分支，确认以下具体兼容缺陷：

### P1-06 用户面板“立即同步”调用错误接口

- HTML 用户面板在约 2435-2438 行调用 `POST /api/admin/sync`，Authorization 使用当前用户 Session token。
- Worker 路由入口把 `/api/admin/*` 归为 legacy API；legacy 分支要求 `ctx.isSuper`，普通用户会被拒绝。
- Worker 已实现用户态同步路径：`POST /api/user/sources/:id/sync`，在 `userSourcesRoute` 中检查 operate scope、来源归属、审批通过和启用状态。
- 结论：HTML 用户面板同步按钮与 Worker 接口不兼容，普通用户不能通过当前按钮同步自己的来源。
- 修复方向：HTML 改用 `/api/user/sources/{source_id}/sync`；不要放宽 `/api/admin/sync` 让普通用户访问。还需核对该用户态路由实际返回字段与 HTML 状态提示兼容性。

### P1-07 转换请求没有携带已登录用户 Session

- HTML 转换主请求约 5594-5598 行使用裸 `fetch`，只传 `content-type` 和 `x-guest-key`，没有传当前登录 token。
- HTML 的 `/api/convert/groups`、`/api/convert/links`、分组改名和链接失效请求同样只使用 guest key，没有 Authorization。
- Worker 的 `convertRoute` 会尝试 `resolveSession`；无有效 Session 时按 guest key 建立 `g:<hash>` 归属，而非注册用户的 `u:<id>` 归属。
- 结论：即使用户已登录，当前 HTML 转换页仍可能把转换历史归入匿名 guest 空间，无法可靠实现“注册用户转换记录按用户 ID 归档”及跨设备历史关联。
- 修复方向：转换页在存在有效用户 Session 时携带 Authorization；匿名用户仍使用 guest key。Worker 继续以服务端 Session 身份优先确定 owner，不信任客户端传入的 user_id。匿名历史安全认领另行设计，不能仅凭 guest key 直接转移。

### P1-08 高级过滤的 Worker 注释与实际执行不一致

- Worker 在转换代码中注释“过滤/重命名仅对登录用户开放（VIP 功能）”，但随后无条件调用 `applyNodeFilters(nodes, body.filters)`。
- HTML 公开转换页面无登录态也始终提交 include/exclude/rename 字段。
- 结论：当前实现没有落实注释所述的登录限制，更没有有效 VIP 门禁；匿名访客也能提交高级过滤参数。
- 修复方向：保留匿名基础转换；服务端按最终 V2.5 权限矩阵识别高级过滤参数，并对注册身份、有效 VIP 状态进行强制判断。前端可隐藏/提示，但不承担安全裁决。

### P1-09 用户 APP 卡密导出缺少前端错误状态判断

- HTML 约 3095-3104 行直接请求 `GET /api/user/app-cards/export`，不检查 `res.ok` 或响应 Content-Type，直接把响应作为 CSV 下载。
- Worker 路由存在，按 `ctx.effectiveId` 导出当前管理员的卡密 CSV。
- 结论：接口存在，但遇到 401/403/500 时，页面可能把 JSON 错误响应保存成 CSV，用户误以为导出成功。
- 修复方向：下载前检查 HTTP 状态和 Content-Type；失败时读取 JSON 错误并显示，不生成下载文件。

### P2-04 转换分组改名/链接失效未检查 HTTP 失败

- HTML 对 `/api/convert/groups/rename` 和 `/api/convert/links/:id/revoke` 使用裸 fetch 后未判断 `res.ok` 与 `data.ok`。
- Worker 会对 owner 不匹配返回 404，对无效参数返回 400。
- 结论：服务端拒绝时，页面仍可能刷新并表现为操作完成，错误反馈不可靠。
- 修复方向：统一检查状态码与 JSON `ok`；保留 owner_key 校验，不能为了让前端成功而放宽归属检查。

### P2-05 用户页面调用超管接口属于无效探测

- 登录成功后的公共流程会调用 `/api/super/alerts`、`/api/super/stats` 等超管数据接口；普通用户会被 Worker 正确拒绝，其中部分调用被 HTML catch 吞掉。
- 结论：当前不构成权限绕过，但会产生无效请求和噪声；应按 `me.user.role` 分流初始化，普通用户只请求用户态接口。

## 9. 请求封装与接口响应兼容规则

- HTML 通用 `api()` 封装会携带 Bearer token，解析 JSON 并检查 HTTP 状态及 `data.ok`；多数管理 API 使用该封装，基本具备错误检查。
- 但页面中仍存在多处裸 `fetch`。凡是访问需要 Session 的接口，必须显式携带 Authorization；凡是执行写操作，必须检查 HTTP 状态和业务响应。
- 转换页应采用“双身份”模式：已登录用户带 Session，匿名用户带 guest key；Worker 通过服务端 Session 确定注册用户归属。
- 不应把 `/api/admin/*` 当作普通用户 API。legacy 接口仅用于旧后台/超管凭据兼容；普通用户应使用明确的 `/api/user/*` 路由。
- 本轮只确认了关键字段使用点，没有宣称全部 96 处调用的 request/response schema 已逐字段完成。

## 10. 本轮修复优先顺序

1. 修复用户面板同步接口路径：`/api/admin/sync` → `/api/user/sources/:id/sync`。
2. 转换页在登录状态下携带 Session，修复注册用户归档归属。
3. Worker 对过滤/重命名实施有效 VIP 服务端门禁，同时保留 L0 基础转换。
4. 修复 APP 分组、入口和 APP 卡密写操作的有效 VIP 门禁。
5. 修复分组删除生命周期与设备清理版本机制。
6. 修复导出、改名、失效等裸 fetch 的响应检查。
7. 普通用户和超管初始化请求按角色分流。

以上仍是源码静态审计和修复建议，不是已修改或已通过测试的代码。


## 11. 第三轮：后台 VIP / APP 卡密生命周期核对

### 已确认的正向实现

1. 后台 VIP 卡密与 APP 用户卡密在表、路由和激活流程上分离：
   - 后台 VIP：`admin_vip_cards`、`admin_vip_activations`、`/api/user/vip/activate`、`/api/super/vip-cards`。
   - APP 用户卡密：`app_cards`、`app_entitlements`、`/api/user/app-cards`、`/api/app/redeem`。
   - 没有发现两类卡密共用同一个激活路由的证据。
2. 新用户体验记录使用 `kind='trial'`，正式卡激活记录使用 `kind='formal'`；体验天数常量为 7 天。
3. 正式卡激活会检查卡密 unused，并通过批次断言 + 条件 UPDATE 防止同一卡密重复激活。
4. APP 卡密到期维护只将满足以下条件的卡密自动失活：状态 normal、未手动停用、未激活/使用、卡密自身未过期。
5. APP 卡密恢复只恢复 `inactive_reason='admin_vip_expired'` 且未手动停用、未激活/使用、自身未过期的记录。人工停用与已使用/过期卡密不会被该恢复 SQL 恢复。
6. APP 卡密激活会创建独立 `app_entitlements`，并按卡密天数计算授权到期时间；节点下发接口检查授权有效期和 entitlement token。

### P1-10 体验 VIP 与正式 VIP 到期权限没有在用户管理写接口统一执行

- `vipStatus` 能返回当前到期时间、是否有效、是否有正式卡激活历史、是否有体验记录。
- 但 `userAppGroupsRoute` 的 POST/PUT/DELETE 及 sources/members 写操作未见有效 VIP 门禁；`userAppLinksRoute` 的 POST/DELETE、`userAppCardsRoute` 的 POST/DELETE/disable 同样未见有效 VIP 门禁。
- 这意味着体验 VIP 到期和正式 VIP 到期后，接口没有依据 V2.5 对两类身份执行不同的历史权限限制。仅有有效 Session 和 owner 归属不能替代会员权限检查。
- 需在未来 Worker 修复中建立统一策略函数，至少区分：未注册、注册非 VIP、体验 VIP 有效、体验 VIP 过期、正式 VIP 有效、正式 VIP 过期、超管。过期正式 VIP允许查看和删除历史数据；过期体验 VIP只读；新增/编辑等有效 VIP 管理动作必须拒绝。
- 不得把 `is_formal` 这个“历史上曾激活正式卡”的布尔值直接当作当前正式 VIP 有效状态。

### P1-11 APP 卡密 3 天宽限维护没有充分证明会按时运行

- `vipExpiredOverGrace` 的时间比较逻辑是到期时间 <= 当前时间减 3 天；符合“到期满三天后”才进入自动失活的意图。
- 维护任务 `runVipCardMaintenance` 会遍历所有存在 APP 卡密的管理员，当前有效 VIP 时恢复符合条件的卡密；无有效 VIP 且已过三天宽限时失活。
- 但本轮静态核查未建立完整证据证明 Cron 触发器已在目标部署环境配置、定时执行且失败会重试。因此不能认定实际环境能准时在三天边界执行。
- 此外，维护任务审计写入使用 `catch(() => {})`，审计失败不会阻止维护任务结束；应改为可观测、可告警的可靠审计/任务日志机制，不能静默丢失审计。
- 需在部署配置与运行日志中核实 Cron，而不是只看函数存在。

### P1-12 APP 卡密激活事件审计可能静默丢失

- `/api/app/redeem` 在完成卡密状态变更和 entitlement 创建后，另行插入 `app_card_events`，并使用 `.catch(() => {})` 吞掉写入错误。
- 这导致业务激活成功但事件日志可能缺失；与关键操作应具备可靠审计的要求不一致。
- 修复方向：把激活事件记录并入同一 D1 batch/事务性业务批次；若底层不支持则设计 outbox/重试与告警，不得静默吞错。

### P1-13 APP 卡密激活后免费分组授权规则与 V2.5 口径需要确认/修正

- `/api/app/redeem` 每次激活 APP 卡密后都会写入 `app_free_grants(device_id, admin_user_id)`。
- `appGroupsForDevice` 在 entitlement 失效后仍会读取该表，并向该设备返回管理员的 `mode='free'` 分组；代码注释称该资格在激活过一次后永久保留。
- 当前已确认的 V2.5 规则是：APP 免费分组通过 APP 用户身份 ID 获取，卡密分组通过 APP 卡密获取。现有实现把“曾经激活过卡密的设备 ID”永久变成免费分组资格，可能与按 APP 用户身份 ID 授权的规则不一致。
- 需先确认 APK 当前身份 ID 的定义、设备更换/多设备规则，以及免费分组到底是用户身份授权还是设备历史激活授权；在确认前不得直接删除此 grant 逻辑或改 D1。

### P2-06 后台 VIP 状态计算只暴露“曾有正式卡”而非当前会员类型

- `vipStatus` 的 `is_formal` 是对全部历史激活记录的 formal_count 判断，不要求正式激活记录当前仍有效。
- 例如用户曾激活过正式 VIP，现已过期且仅有历史记录时，仍可能返回 `is_formal=true`、`active=false`。
- 前端若仅按 `is_formal` 判断当前会员类型，容易把“正式 VIP 历史”误认为“当前正式 VIP”。
- 建议响应明确拆分 `current_membership_kind`、`active`、`expires_at`、`has_formal_history`、`has_trial_history`，但是否新增字段需先做 HTML 兼容核对，不在本轮改接口。

### P2-07 体验卡自动赠送与并发唯一性待核实

- `grantTrial` 先 SELECT 是否存在激活记录，再 INSERT trial 记录；从可见 SQL 未见数据库唯一约束保证每个用户只能有一条体验记录。
- 如果注册流程可并发触发，可能存在两个请求同时通过 SELECT 并重复赠送的竞态。需核对注册入口调用次数、D1 表约束和实际批次行为。
- 不能只依赖前端或注册流程调用一次；应由数据库约束/原子条件保证同一用户体验资格不可重复领取。

### P2-08 APP 授权状态查询与免费分组访问边界

- `GET /api/app/status` 只凭 device_id 返回最近一条授权记录状态，未见 entitlement token 校验；与已记录的 P1 设备状态元数据暴露风险一致。
- `GET /api/app/groups` 对有效 entitlement 校验 token；但无有效 entitlement 时，若 device_id 有 `app_free_grants`，会返回免费分组节点列表，未见额外设备身份认证。
- 需 APK 侧核实 device_id 是否不可伪造、是否绑定 Android Keystore 设备密钥；服务端也应验证设备注册凭证，而不能将可复制的 device_id 当作身份凭证。

## 12. 本轮结论与后续验证

- 后台 VIP 卡密与 APP 用户卡密：代码路径分离，方向正确。
- APP 卡密三天宽限与按原因恢复：SQL 条件基本符合既定业务意图，但 Cron 运行与审计可靠性尚未证实。
- 体验/正式 VIP 到期后的操作权限：尚未落实到用户 APP 管理写接口，是当前最明确的权限缺口。
- 免费分组资格：设备历史 grant 与 V2.5 的 APP 用户身份 ID 规则存在口径差异，必须先核实 APK 身份模型。
- 尚未执行线上卡密激活、续费、失活、恢复或任何 D1 写操作；也未验证目标环境 Cron 配置。


## 13. 第四轮：APP 身份、设备授权、分组与本地清理

### 本轮核对范围与限制

- 已读取原始 Worker 中 `appRedeemRoute`、`appGroupsForDevice`、`appLinksForDevice`、`appFreeGroupRoute`、管理员分享编号及授权维护代码。
- 仓库根目录存在 `StarJump-6.00.47-source .zip` 和 `StarJump-6.00.48-source.zip`。本轮 GitHub 文件接口不能读取 ZIP 二进制内容；因此 APK 源码尚未解包审计，不能确认 Android 端 device_id 生成、Keystore 绑定、Token 保存、缓存清理和版本防回滚。
- 本轮未修改 APK、Worker 或 D1。

### P1-14 APP 设备身份目前主要依赖客户端提交的 device_id

- `POST /api/app/redeem` 从请求体读取 `device_id`，只校验字符格式，然后把它写入 `app_entitlements`。
- `GET /api/app/status` 只按 device_id 查询授权，不校验 entitlement token。
- `GET /api/app/nodes`、`GET /api/app/groups`、`GET /api/app/links` 会校验 entitlement token，但 Token 仍与客户端提交的 device_id 共同使用。
- 本轮未发现 Worker 端设备注册挑战、设备公钥登记、签名挑战或 Android Keystore 证明流程。
- 风险：若 APK 仅使用可复制的本地字符串作为 device_id，复制该值即可模拟设备身份；Token 能降低仅知道 device_id 时的冒用风险，但不能代替可靠设备身份和密钥保护。
- 处理方向：APK 侧应核对是否使用 Android Keystore 生成不可导出的设备密钥；服务端应采用设备注册/挑战签名机制，至少将 entitlement token 与设备密钥绑定。不能把 Android ID、随机 UUID 或 SharedPreferences 单独当成不可伪造身份。

### P1-15 授权 Token 存在默认固定密钥回退值

- `entToken` 使用 `env.SESSION_PEPPER || "starjump-app"` 作为 HMAC 密钥。
- 若部署环境漏配 SESSION_PEPPER，所有环境会退回同一个源码固定值，Token 可被知悉该默认值的人按 entitlement_id 与 device_id 计算。
- 这是配置安全缺口。正式环境应强制要求独立高熵密钥，缺失时拒绝启动或拒绝授权签发/验证；不得静默回退到固定常量。
- 需同时规划密钥轮换与旧 Token 过渡策略，避免直接换密钥导致所有已授权 APP 会话突然失效。

### P1-16 设备状态接口不验证 Token，授权元数据可被枚举查询

- `/api/app/status` 仅凭 device_id 返回最近授权记录的 id、expires_at、purge_at、status 和 active。
- 未看到对该查询执行 `verifyEntToken`。
- 应改为要求有效 entitlement token 或设备密钥签名，并限制响应仅返回当前设备必要字段；配合查询频率限制，避免设备授权状态探测。

### P1-17 APP 免费分组存在不经过有效授权 Token 的设备读取路径

- `appGroupsForDevice` 在设备没有有效 entitlement 时，查询 `app_free_grants`；只要 device_id 曾经有 grant，就返回对应管理员当前启用的 free 分组节点。
- 该分支没有执行 entitlement token 验证；`app_free_grants` 的键是 device_id + admin_user_id。
- 因此免费分组的访问能力依赖可提交的 device_id，而不是已验证的 APP 用户身份凭证。
- 这与 V2.5 “免费分组通过 APP 用户身份 ID 获取”的业务表述存在差距。应先确认 APK 的用户身份凭证定义，再设计设备/用户身份认证；不要直接将当前设备 grant 永久保留作为最终授权模型。

### P1-18 普通免费分组接口与 APP 专属分组授权链路分离

- `GET /api/app/free` 可通过管理员 ID 或 6 位分享编号解析管理员，再按 `free_group_enabled` 返回 free tier 节点；该接口没有 device_id、entitlement token 或用户身份认证参数。
- 这与 `/api/app/groups` 的 entitlement / app_free_grants 模型是两套不同的免费分组获取路径。
- 需要明确它们分别服务于“未绑定用户的公开免费体验”还是“已绑定 APP 用户的身份授权”，并在 V2.5 权限矩阵中规定是否允许匿名访问、可见数据范围和限流；不能将公开接口结果视为已完成身份授权。

### P1-19 24 小时本地节点保留规则尚未形成端到端证据

- Worker 核销时把 entitlement.expires_at 设置为当前时间 + 卡密天数，把 purge_at 设置为到期时间 + 24 小时。
- `runEntitlementMaintenance` 会将到期授权标记 expired，并在 purge_at 到达后标记 purged。
- 但 `/api/app/nodes` 只查询 status='active' 且 expires_at > now 的授权；授权到期后即停止节点下发，没有看到向 APK 下发明确的清理截止时间/清理任务状态。
- `/api/app/nodes` 返回的 `purge_at` 当前固定为 null；核销响应虽返回 `local_retention_hours: 24`，但这只是提示值，不是设备端清理确认协议。
- Worker 无法在设备离线时直接删除本地节点。要满足“分组删除/改型后 24 小时内清理”，需要 APK 保存服务端版本/撤销标记、联网拉取差异、执行本地删除，并回传 cleanup acknowledgement；离线设备还需定义下一次联网时的强制清理行为。
- 当前代码未见分组 generation/version、撤销墓碑、设备同步游标、cleanup ack 或确认超时告警的完整链路。不能仅凭 purge_at 字段认定 24 小时清理已实现。

### P2-09 entitlement 查询只取设备最近一条记录，需验证多授权场景

- `/api/app/nodes`、`/api/app/groups`、`/api/app/links` 都以 device_id 查询最近创建的一条有效 entitlement。
- 同一设备绑定多个管理员或同时存在多张授权时，接口只选择最近一条，可能导致其它有效授权对应的管理员分组/入口不可见。
- 需明确产品规则是“一台设备同一时刻只能绑定一个管理员授权”，还是允许多管理员并存；若允许并存，API 必须返回多授权集合并按 entitlement token 分别校验。

### P2-10 管理员分享编号是短码，需核实防枚举与滥用控制

- 分享编号为 6 位字符，使用排除易混淆字符的字符集生成；`/api/app/free` 可用编号查询管理员。
- 代码有随机生成和唯一约束冲突重试，但本轮未见该公开查询入口的专门速率限制、失败计数或异常枚举告警。
- 需补充 IP/设备维度限流、错误响应一致性和审计；短码只能用于发现/绑定入口，不能作为用户身份凭证或设备授权凭证。

### P2-11 管理员换绑设备后旧设备 Token 失效机制需验证

- 超管换绑接口更新 entitlement.device_id，并返回基于新 device_id 生成的 Token。
- 原设备的 Token 因 HMAC 输入包含 device_id，理论上无法对新 device_id 验证；但需结合 APK Token 更新/缓存机制验证换绑后旧设备是否立即停止使用，且换绑操作审计当前使用 catch 吞错。
- 需将换绑前后设备状态、Token 轮换、旧设备撤销结果纳入测试。

## 14. 本轮结论

1. Worker 对有 entitlement 的节点、分组和入口读取使用 HMAC Token 校验，这是正向实现；但状态查询和免费分组分支存在未认证访问面。
2. 固定默认 HMAC 密钥回退必须列为高优先级配置安全问题。
3. 当前 device_id 不能单独证明设备身份；必须结合 APK Keystore/签名挑战和服务端设备注册机制核验。
4. 24 小时本地清理目前只有授权时间字段与文字提示，缺少可验证的设备同步、清理确认和离线恢复闭环。
5. APK 源码 ZIP 尚未解包，本轮所有 Android 端实现状态均标记为“待源码核验”，不作已实现判断。


## 15. 当前仓库 HTML 1.4.61 与正式 Worker 的边界补充

另行抽查仓库根目录 `星跃模拟后台 1.4.61.html`（它不是原始 V1.0 HTML 文件，不能与前述 V1.0—Worker 接口审计混为一谈）：

- 页面中的注册/登录流程属于本地演示：登录通过本地管理员数组切换身份，代码注释明确说明“不校验密码”；注册数据写入浏览器本地 DB 状态并保存。
- 访客基础转换在浏览器端解析粘贴内容并生成结果，页面提示“未写入数据库，未调用生产转换接口”。
- 该 HTML 中未检索到 `/api/app/redeem`、`/api/app/groups`、`/api/app/nodes`、`/api/app/links`、`/api/app/status` 等 APP 授权 API 路径。
- 因此 1.4.61 当前应被视为前端模拟/演示版本，不能据此认定已经与正式 Worker、D1 或 APK 联通；其中的本地体验卡池、localStorage device ID 也不能作为正式防重复领取或设备身份方案。
- 后续正式联调必须明确指定实际要接入的 HTML 版本，并对登录、注册、VIP 状态、卡密激活、APP 分组、分享链接、转换归档逐项接真实 Worker API；演示态需醒目标识，避免误把本地模拟数据当成正式数据。
