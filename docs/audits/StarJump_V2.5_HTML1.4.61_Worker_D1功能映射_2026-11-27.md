# 星跃 V2.5｜模拟后台 1.4.61 → Worker API → D1 功能映射（只读核查版）

- 日期：2026-11-27
- 仓库：`sxna-web/XYmonihtml`，分支 `main`
- HTML：`星跃模拟后台 1.4.61.html`，blob `d046f71caa5af96b0c0978013771cb0a8f101739`
- Worker：`原始StarJump_V1点0_Final-zip-26-11-25-14:56/Worker.js`，blob `5da7aa3582558d9da2c2a0ad25a63c5e95e9fe63`
- 参考基线：`docs/星跃管理平台V2.5_功能基线与权限验收规范.md`、`docs/星跃管理平台V2.5_API接口与权限校验规范.md`、既有 Worker 路由盘点和 D1 字段映射报告。
- 性质：静态源码映射，不是联调或生产验收报告。

## 1. 总结结论

1. 当前 1.4.61 HTML 明确是浏览器本地模拟版。源码未检出 `/api/`、`fetch(`、`XMLHttpRequest`、`Authorization` 或 `Bearer `；业务数据由本地 `saveDB/loadDB` 与 localStorage 管理，图片另用 IndexedDB。
2. Worker 已有一组可复用的认证、来源、节点、分组、VIP、APP 卡密、APP 分组/分享、转换、统计、下载与公告接口，但这些接口并不等于 HTML 已接入。
3. HTML 有若干明显属于纯前端演示/配置的功能（主题、菜单收藏、最近访问、模板/方案等）；不能把它们直接写入正式 D1，也不能臆造 API。
4. Worker 存在此前审计确认的 VIP 门禁、密钥 fail-closed、匿名归属、幂等、限流、Cron、APP 撤销闭环等 P1 风险。正式接入必须先修复并通过服务端测试，不能先把按钮接上就视为完成。
5. APK 源码 ZIP 尚未解包审计；所有设备缓存、设备身份、同步确认、24 小时清理只能列为“需 APK 联调”，不得标记已完成。

## 2. 分类定义

- **A｜已有接口可作为接入基础**：Worker 路由及业务处理函数存在；仍需核对请求/响应契约和安全问题。
- **B｜接口存在但需先修复**：路由存在，但权限、数据归属、原子性、幂等或业务规则不满足 V2.5。
- **C｜缺接口/缺数据能力**：当前 Worker 未发现足够接口，需先设计契约。
- **D｜纯前端本地功能**：只影响当前浏览器外观或本地工作流，不应默认写入 D1。
- **E｜需 APK 配合**：服务端与客户端共同完成，HTML 本身无法验收。

## 3. 菜单级总映射

| HTML 菜单 / 页面 | 目标 Worker API（现有路径） | D1 主要对象（按源码 SQL） | 分类与结论 |
|---|---|---|---|
| 工作台：首页概览、快捷操作、最近操作 | `GET /api/user/stats`、`GET /api/super/stats`；最近操作暂无完整独立接口 | `app_users`、`subscription_sources`、`node_records`、`convert_links`、审计表 | A/C/D：统计可接；最近访问属于本地 UI，后台审计活动需单独定义 |
| 转换工作区 | `POST /api/convert` | `convert_links`、来源/节点相关表、`rate_limits` | B：现有转换入口；高级过滤 VIP 门禁、匿名 guest key、密钥、限流 fail-open、幂等及成功归档均需先修复 |
| 转换任务 | 当前未发现完整任务生命周期 API | 现有 `convert_links`；任务表需核实 | C：不能把一次同步/转换请求伪装成异步任务中心 |
| 转换历史 | `GET /api/convert/links`、`POST /api/convert/links/:id/revoke`；分组 `GET /api/convert/groups` | `convert_links` | B/C：读取/撤销基础存在；按用户、URL、批次、时间、保存模式筛选，编辑快照、回收站、恢复、永久清理需补齐 |
| 转换方案、过滤规则、模板 | 当前未发现对应完整 CRUD API | 暂无可确认专用表 | C/D：若属于用户云端资产需设计接口/表；仅浏览器本地偏好则保持本地并明确设备范围；高级过滤必须服务端 VIP 鉴权 |
| 转换分组 | `GET /api/user/convert-groups`；另有 `GET /api/convert/groups`、`POST /api/convert/groups/rename` | `convert_links` 及 owner key 关联 | A/B：需统一用户 Session/owner key，修复重命名与审计原子性及跨用户隔离 |
| 订阅源管理 | `GET/POST /api/user/sources`；`PATCH /api/user/sources/:id/enabled`；同步 `POST /api/user/sources/:id/sync`（以路由实际分支为准） | `subscription_sources`、`source_ownership`、`source_approvals`、`subscription_sync_state`、`sync_tasks` | B：来源归属、重新分配后的旧 APP 关系撤销、启停与生命周期需修复 |
| 节点管理 | `GET /api/user/nodes`；手动节点 `POST/PUT/DELETE /api/user/nodes/manual...`；节点详情/有效值/覆盖字段子路由 | `node_records`、`user_manual_nodes`、`node_overrides`、`node_user_metadata`、`node_identity_aliases` | A/B：接口基础存在；逐项确认覆盖字段权限、来源归属、stale 节点过滤和节点删除语义 |
| 节点分组 | `GET/POST /api/user/node-groups`；`PUT/DELETE /api/user/node-groups/:id`；成员 `POST/DELETE /api/user/node-groups/:id/members` | `node_groups`、`node_group_members` | A/B：基础 CRUD 存在；删除多语句原子性、APP 分组与普通分组边界需处理 |
| 同步记录 | `GET /api/user/sync-logs`、`GET /api/user/stale-nodes` | `node_sync_logs`、`sync_tasks`、`sync_task_stage`、`sync_task_manifests`、`node_lifecycle` | B：需要 generation/fencing、防旧任务覆盖、缺失节点策略和失败可观测 |
| 外部订阅分享 | 转换链接 `GET /api/convert/links`、撤销 `POST /api/convert/links/:id/revoke`；普通网页分享需按 HTML 具体业务确认 | `convert_links` | B/C：不可将普通转换链接误作 APP 专用授权链接；缺分享管理能力时补契约 |
| APP 授权分享 | `GET /api/user/share-code`、`GET /api/app/resolve`、`GET /api/app/free`、`GET /api/app/groups`、`GET /api/app/links` | `admin_share_codes`、`admin_app_perms`、`app_groups`、`app_group_sources`、`app_group_members`、`app_free_grants`、`app_entitlements`、`app_links` | B/E：专用 APP 链路存在，但授权校验、限流、防枚举、来源所有权和撤销清理闭环未达标 |
| 分享记录 | 暂无确认的完整用户端审计查询接口 | `admin_audit_events`、APP 相关事件表 | C：需明确记录范围、管理员数据边界、分页筛选与敏感字段遮罩 |
| APP 概览 | `GET /api/app/version`、`GET /api/app/status`、`GET /api/app/nodes`、`GET /api/app/groups` | `app_entitlements`、`app_groups`、`node_records`、`node_lifecycle` | B/E：status Token 口径不一致；nodes/groups 必须验证 entitlement、generation、来源归属与 stale 状态 |
| APP 卡密 | 用户端 `GET/POST /api/user/app-cards`、删除/停用子路由；APP 激活 `POST /api/app/redeem` | `app_cards`、`app_card_events`、`app_entitlements` | B/E：生成/停用缺统一有效 VIP 门禁；激活必须原子、设备绑定不能只信客户端 ID；宽限恢复原因需区分 |
| APP 用户、设备管理 | `GET /api/app/status`、`GET /api/app/groups`、`GET /api/app/nodes`；管理端部分信息在 APP entitlement/分组路由 | `app_entitlements`、`app_free_grants`、`app_card_events`、`app_group_members` | B/E/C：设备身份管理和解绑/多管理员身份选择需 APK 联调；当前设备 ID 不等于可信设备证明 |
| APP 版本管理、更新配置 | 超管 releases 路由；公开 `GET /api/app/version`、`GET /api/app/download` | `releases`、`download_links` | A/B：基础发布/查询存在；需要版本回滚、发布状态、强制更新策略及下载可用性验收 |
| 用户/激活/设备/节点/转换统计 | `GET /api/user/stats`、`GET /api/super/stats` | 用户、卡密、节点、转换和同步业务表 | A/B：已有汇总接口；需确认统计口径、时间范围和权限隔离，不把前端本地模拟数作为真实统计 |
| 管理员管理、总后台、权限管理 | 超管 `/api/super/*` 路由族 | `app_users`、`admin_user_scopes`、`admin_audit_events` 等 | B：需逐个动作核对 actor/effective 身份、协助会话 scope 和资源归属 |
| 后台 VIP | 用户 `GET /api/user/vip`、`POST /api/user/vip/activate`；超管 `/api/super/vip-cards` | `admin_vip_cards`、`admin_vip_activations`、授权/用户表 | B：当前 vipStatus 聚合不能可靠区分有效体验/正式 VIP；体验到期只读与正式到期可删除历史需分动作执行 |
| 操作日志 | 当前有审计写入；完整分页筛选 API 需核实 | `admin_audit_events`、`admin_audit`、`app_card_events` | B/C：需统一审计事件、敏感访问审计 fail closed、按用户/操作者/目标/时间筛选 |
| 任务中心、故障诊断 | `GET /api/user/sync-logs`、`GET /api/user/stale-nodes`、`GET /api/super/alerts` | `sync_tasks`、`node_sync_logs`、`node_lifecycle`、告警相关表 | B/C：现有数据可用于部分监控；缺统一任务状态、错误追踪、重试、运行健康和告警确认接口 |
| 系统设置 | 旧版 `/api/admin/settings`（legacy）；其他配置需核实 | `app_settings` 等 | B/C：不得让正式用户 HTML 默认使用 legacy ADMIN_TOKEN；配置修改需超管门禁、审计、校验与回滚 |
| 主题与外观 | 无需 Worker API | 浏览器本地配置 | D：主题、背景、布局、侧栏宽度等保持本地设置；如需跨设备同步再单独设计 |
| 身份与生命周期（1.4.61 新增） | 超管 VIP/APP 分组/生命周期路由族；没有完整统一清理确认闭环 | `admin_vip_cards`、`app_cards`、`app_entitlements`、`app_groups`、`node_lifecycle`、审计表 | B/E：HTML 的清理只是本地模拟；Worker Cron 与 APK cleanup acknowledgement 必须补齐 |

## 4. 关键页面操作的接口契约要求

### 4.1 登录、注册和会话
- 现有：`POST /api/auth/register`、`POST /api/auth/login`、`GET /api/auth/me`、`PUT /api/auth/password`、`POST /api/auth/logout`。
- 接入要求：用户态请求使用服务端签发 Session；匿名 guest key 只用于匿名数据归属，不可充当 Token。
- 注册后发放 7 天体验 VIP 目前存在 grantTrial 失败静默风险；必须改成可核验的原子/补偿流程，不能接口返回成功却没有体验授权。
- 协助会话修改密码目标对象错误风险必须先修复并明确提示。

### 4.2 转换与归档
- 现有入口：`POST /api/convert`；公开读取短链接 `GET /c/:id`；转换链接读取/撤销和分组路由存在。
- 每次成功转换必须归档独立批次；相同 URL 不覆盖历史；`local_only` 仍归档到平台后台，但不进入用户云端历史同步。
- 请求必须携带幂等键；重复请求返回同一结果，不重复创建归档、不重复扣额度。
- L0 只能使用基础转换；高级过滤/重命名等必须由 Worker 检查有效授权，不能依赖 HTML 隐藏按钮。
- 完整订阅 URL 加密密钥缺失必须 fail closed；超管 reveal 的审计失败必须拒绝返回明文。
- 限流 D1 错误不能 fail-open；429 需有 Retry-After。

### 4.3 来源、节点、同步
- 用户来源读取/管理以 `/api/user/sources` 为入口；同步必须使用用户态来源同步接口，不可误用 `/api/admin/sync`。
- 节点、覆盖、收藏、备注、排序和分组成员分别落到 Worker 已有节点/元数据接口。
- 来源重新分配、停用、归档、重新启用时，必须重新验证来源 owner；旧管理员 APP 组不得继续读取。
- stale 节点必须从 APP 下发过滤；同步 fencing 需要 generation/version 条件写，防止旧任务覆盖新任务。
- 同步缺失节点的默认停用策略、恢复通知和 Cron 可观测必须明确；不能假设环境开关已开启。

### 4.4 APP 授权与清理
- 免费组：通过管理员身份 ID 对应的专用授权链路；卡密组：通过 APP 用户卡密 entitlement；不能使用普通网页链接替代。
- 只有有效 VIP 管理员可新增/编辑/关联/生成卡密；正式 VIP 到期可查看和删除本人历史数据但不可新建；体验 VIP 到期严格只读。
- 已激活 APP 卡密不因管理员 VIP 到期而失效；未激活卡密的宽限、自动停用和续费恢复必须记录原因，不能恢复人工停用/超管撤销/自身过期卡。
- 分组删除/改型/来源转移应立即停止新下发并生成 generation 增量或撤销墓碑；APK 同步后清理本地缓存并回传 cleanup acknowledgement。
- Worker 定时维护不得因来源数为 0 而提前退出；维护失败必须可观测，不能 catch 后静默。
- 设备 ID 是客户端声明值，不能作为唯一安全身份凭证；需要设备绑定、Token、撤销和多管理员身份切换的端到端测试。

## 5. 关键 D1 数据对象映射（非生产 schema 证明）

| 业务域 | Worker 源码中出现的表 | 主要用途 | 注意事项 |
|---|---|---|---|
| 身份会话 | `app_users`、`user_sessions`、`admin_user_scopes` | 用户、Session、协助会话权限 | 实际生产表结构尚未核实；不得执行迁移 |
| 来源同步 | `subscription_sources`、`source_ownership`、`source_approvals`、`subscription_sync_state`、`sync_tasks`、`sync_task_stage`、`sync_task_manifests`、`node_sync_logs`、`source_quota` | 来源归属、同步任务、阶段、清单、日志与额度 | fencing/generation 与恢复机制仍有缺口 |
| 节点分组 | `node_records`、`node_identity_aliases`、`node_groups`、`node_group_members`、`user_manual_nodes`、`node_overrides`、`node_user_metadata`、`node_lifecycle` | 节点实体、手动节点、分组、覆盖、用户元数据和生命周期 | APP 缓存不是这些表的直接等价物；设备侧清理需 APK 确认 |
| 转换归档 | `convert_links`、`rate_limits` | 转换链接、归属、限流 | 批次/快照/编辑历史/回收站等需求可能需要新增设计，先做 schema diff |
| 管理员 VIP | `admin_vip_cards`、`admin_vip_activations` | 管理员 VIP 卡密与激活 | 与 APP 用户卡密完全隔离 |
| APP 卡密授权 | `app_cards`、`app_card_events`、`app_entitlements`、`app_free_grants` | APP 卡密、事件、授权、免费授权 | 多 entitlement 合并与 owner VIP 失效原因要统一 |
| APP 分组分享 | `app_groups`、`app_group_sources`、`app_group_members`、`app_links`、`admin_share_codes`、`admin_app_perms` | APP 分组、来源、节点成员、入口、身份分享码和权限开关 | 版本快照、墓碑、cleanup ack 与业务审计需补齐 |
| 运营发布 | `releases`、`announcements`、`download_links` | APP 版本、公告、下载 | 需核实正式 HTML 页面字段与接口契约 |
| 审计配置 | `admin_audit_events`、`admin_audit`、`app_settings` | 审计与设置 | 多套审计表并存需梳理，不可盲目合并或迁移 |

> 表名仅表示当前 Worker 源码 SQL 中出现，不代表生产 D1 已有同名表、字段或索引。正式 D1 schema 未完成只读核验前，不得执行 DDL。

## 6. 接入前置阻断项（必须先解决）

| 优先级 | 阻断问题 | 影响模块 | 放行条件 |
|---|---|---|---|
| P1 | 用户态 APP 管理写接口缺统一有效 VIP 门禁 | APP 分组、入口、卡密 | 服务端按体验/正式 VIP 与动作类型逐项门禁，并通过直调 API 越权测试 |
| P1 | 转换高级 filters 无服务端 VIP 检查 | 转换工作区 | L0/L1/L2/体验/正式权限矩阵在 Worker 执行并测试 |
| P1 | VIP 状态聚合不能区分体验与正式有效授权 | 全部会员权限 | 服务端统一 entitlement 判定，处理多授权与时间边界 |
| P1 | Session Pepper、APP Token、转换加密密钥存在默认回退 | 登录、APP、转换 | 必需密钥缺失时 fail closed；部署配置核验与轮换方案 |
| P1 | 限流 D1 错误 fail-open、匿名 guest key 缺失会共享身份 | 转换 | 原子限流、稳定匿名身份、故障拒绝或安全降级策略 |
| P1 | 转换归档缺幂等键与完整批次模型 | 转换历史 | 幂等键、归档状态、重试与不丢档测试 |
| P1 | Cron 来源为空时跳过维护，维护异常静默 | VIP/APP 生命周期 | 定时任务独立执行、任务结果持久化、告警与重试 |
| P1 | APP 分组 generation/墓碑/cleanup ack 不闭环 | APP 节点下发 | Worker→APK→本地清理→ack 全链路通过 |
| P1 | APP 节点查询来源 owner 与 stale 过滤不足 | APP 节点 | 查询时二次校验 owner、enabled、approval、lifecycle |
| P1 | APP 分组删除多条 D1 写操作不原子 | APP 管理 | 使用受控原子 batch/事务并做故障注入测试 |
| P1 | 超管敏感 URL reveal 审计失败仍返回明文 | 转换历史 | 审计先成功，失败时不返回敏感内容 |
| P1 | 注册成功与体验 VIP 发放非原子且静默吞错 | 注册 | 授权结果可验证，失败能补偿/重试且不虚报成功 |

以上 P1 来自当前仓库已提交的专项静态审计。修复后仍需测试，不代表本报告已复测通过。

## 7. 纯前端与待新增功能边界

以下页面/功能不能仅凭当前 HTML 就认定应新增 D1 表：
- 主题、背景、布局、侧栏折叠、菜单收藏、最近访问：默认浏览器本地偏好。
- 转换方案、模板、过滤规则：先确认是否需要跨设备共享、是否属于会员云端资产；若需要，设计 owner scope、版本和 CRUD API。
- 任务中心：必须区分真实 Worker 后台任务与前端“最近操作”列表；任务需要状态机、错误、重试、取消、幂等和审计。
- 分享记录、操作日志：必须区分业务分享事件、管理员审计和普通浏览历史，不能混成一个表。
- 诊断/健康页：展示 Worker/D1/cron 的真实探测结果；不能用本地模拟状态冒充线上健康。
- 设备管理：必须有 APK 侧真实设备标识、授权 Token、解绑撤销、最近心跳和清理回执；HTML 模拟设备记录不构成真实设备。

## 8. 推荐正式接入顺序

1. **先完成接口契约**：冻结每个页面动作的 method/path、请求/响应、错误码、身份门禁、资源归属、幂等和审计字段。
2. **先修 P1 安全阻断项**：身份/VIP 门禁、密钥 fail-closed、匿名归属、限流、归档幂等、Cron、APP generation/cleanup ack。
3. **基础账号与来源节点**：登录/注册/Session → 来源 → 节点 → 分组 → 同步日志。
4. **转换核心**：基础转换 → 用户归属 → 批次归档 → 历史查询/撤销 → 高级功能权限 → 快照/回收站。
5. **APP 授权**：APP 分组/入口/卡密/entitlement → APK 设备授权 → 增量同步/撤销/清理 ack。
6. **超管和运营**：用户/VIP/卡池、发布、公告、统计、审计、告警和设置。
7. **最后接 UI**：每个按钮按契约接入；逐页替换 localStorage 模拟数据；保留主题等纯本地偏好。
8. **回归验收**：L0/L1/L2、体验/正式 VIP 到期、管理员 A/B 越权、匿名与登录归属、幂等重试、Cron 空来源、APK 离线清理等场景。

## 9. 本轮范围与未完成事项

- 已完成：读取 AGENTS、功能基线、API 权限规范、1.4.61 HTML、Worker.js；静态提取页面菜单、注册页面、路由函数、SQL 表名并形成映射。
- 未完成：生产 D1 schema 对照、生产 Worker 部署版本对照、APK ZIP 解包审计、真实 API 请求/响应联调、自动化测试。
- 未执行：任何生产 API 请求、D1 查询/写入、迁移、密钥操作、部署或 HTML/Worker 源码修改。
- 当前结论状态：**需求映射 / 静态源码核查已完成；尚未联调、未测试、未部署。**

## 10. 变更记录

- 2026-11-27：新增 1.4.61 页面 → Worker API → D1 功能映射，只读核查版。
