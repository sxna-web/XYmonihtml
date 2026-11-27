# 星跃 V2.5｜Worker Handler 请求字段与契约差异核实（第一批）

- 日期：2026-11-27
- Worker 基线：`原始StarJump_V1点0_Final-zip-26-11-25-14:56/Worker.js`
- Worker blob：`5da7aa3582558d9da2c2a0ad25a63c5e95e9fe63`
- 性质：对当前仓库 Worker 源码的静态 handler 核查；不是线上部署版本核实、运行测试或安全验收。
- 关联契约：`docs/backend/StarJump_V2.5_API接口契约与权限矩阵_V1_2026-11-27.md`

## 1. 本批核查范围

本批从 Worker 源码直接读取并定位：
- `routeAuth`（注册、登录、bootstrap）
- `userVipRoute`
- `userSourcesRoute`
- `userAppGroupsRoute`
- `userAppCardsRoute`
- `userAppLinksRoute`
- `appRedeemRoute`
- `appGroupsForDevice`
- `convertRoute`（已核对公开短链和分组/链接列表开头；转换 POST 完整字段仍需下一批继续）

## 2. 已从源码确认的实际请求字段与响应形状

### 2.1 注册与登录

**POST `/api/auth/register`**
- 请求读取：`username`（最多 32 字符，转小写）、`password`（10–200 字符）、`display_name`（最多 60 字符）。
- 注册开关：仅 `ALLOW_REGISTRATION=1` 开放。
- 当前成功响应：`{ok:true,data:{id,username,role:"user",trial_days:VIP_TRIAL_DAYS}}`，HTTP 201。
- 当前问题：注册后调用 `grantTrial(db,id).catch(()=>{})`，体验卡池为空/发放失败会被吞掉，但仍返回注册成功及 trial_days。与“体验卡来自超管卡池、不得静默失败”不符，P1。

**POST `/api/auth/login`**
- 请求读取：`username`、`password`。
- 用户名转小写；密码不回传。
- 成功响应：`data.token`、`expires_in_hours`、`user:{id,username,role}`。
- 失败尝试达到 5 次时锁定 15 分钟；账号不存在与密码错误使用相同错误文本。
- Session 依赖 `SESSION_PEPPER`；需结合已有密钥回退审计修复 fail-closed。

### 2.2 VIP 状态与激活

**GET `/api/user/vip`**
- 当前响应：`{ok:true,data:vipStatus(...)}`。
- 具体 `vipStatus` 返回字段必须结合函数实现冻结；当前已知逻辑无法可靠区分“当前有效体验/正式 VIP”，不能直接作为 V2.5 权限依据。

**POST `/api/user/vip/activate`**
- 请求读取：`code`（最多 40，转大写，最终格式 8–24 位大写字母/数字）。
- 天数由数据库卡密记录读取，不信任客户端传入。
- 激活时检查卡密 unused，写入激活记录、更新卡密状态和审计。
- 当前使用 `userBatch` 与条件断言保护并发，仍需真实测试验证 D1 batch 行为。

### 2.3 订阅来源

**GET `/api/user/sources`**
- 当前返回 `data[]` 字段：`id,name,url(脱敏),tier,enabled,priority,remark,created_at,updated_at,owner_user_id,approval_status`。
- 普通会话按 `source_ownership.user_id = ctx.effectiveId` 收窄；超管本人会话可查看全量来源。

**POST `/api/user/sources`**
- 请求字段：`name`（最多 120）、`url`（最多 2048）、`tier`（默认 free，格式字母/数字/_/-，最多 30）、`priority`（默认 100，整数 0–100000）、`remark`（最多 500）、可选 `enabled`。
- 普通用户创建默认 pending 且停用；超管本人直建可自动 approved。
- 创建同时写来源、所有权、审批和审计。
- 订阅 URL 可能含凭证；GET 只返回脱敏 URL，日志和错误不得输出原始 URL。

**PATCH `/api/user/sources/:id/enabled`**
- 请求字段：`enabled`，仅接受 true/false/1/0。
- 启用前检查审批状态。

**PUT `/api/user/sources/:id`**
- 请求字段：`name,url,tier,priority,remark)；脱敏 URL 原样回传时保留数据库原值。
- 普通用户变更订阅 URL 会重新进入 pending 审批并停用；超管本人直改另有处理。
- 其他 DELETE/关联/转移分支仍需继续提取完整契约。

### 2.4 APP 分组管理（当前最关键差异）

**GET `/api/user/app-groups`**
- 按 `admin_user_id = ctx.effectiveId` 返回分组列表。

**POST `/api/user/app-groups`**
- 请求字段：`name`（最多 40）、`mode`（默认 assigned，必须属于 `APP_GROUP_MODES`）、`sort`（数值，默认 100）。
- 当前直接插入 `app_groups`。

**PUT `/api/user/app-groups/:id`**
- 请求字段：可选 `name`、`mode`。
- 当前仅按 `id + admin_user_id` 查找并更新。

**DELETE `/api/user/app-groups/:id`**
- 当前先 DELETE app_groups，再分别 DELETE app_group_sources、app_group_members。
- 三条写操作分开执行，非原子；缺少 generation/tombstone/设备 cleanup ack；没有看到本 handler 内的业务审计。
- 这是已确认 P1：必须改为原子生命周期操作，不能直接物理删除后宣称 APP 24 小时清理完成。

**POST `/api/user/app-groups/:id/sources`**
- 请求字段：`source_id`。
- 当前检查来源归属后 INSERT OR IGNORE 关系。

**POST `/api/user/app-groups/:id/members`**
- 请求字段：`device_id`（8–80 位 [A-Za-z0-9_-]）。
- 设备 ID 由客户端提交，不能单独作为可信设备身份。

**VIP 门禁差异**
- 当前 fetch 分发层对 `/api/user/*` 只要求有效用户会话和协助会话 scope。
- 本 handler 可见逻辑未做“有效体验/正式 VIP”动作门禁。
- 与已确认“仅有效 VIP 管理员可管理 APP 对接分组”的规则冲突，P1；必须在服务端统一动作授权层修复，不能只隐藏按钮。

### 2.5 APP 卡密管理

**GET `/api/user/app-cards`**
- query：`status`、`from`、`to`。
- 返回字段含：`id,code,days,status,inactive_reason,inactive_at,restored_at,manual_disabled,activated_at,used_at,created_at`，并返回 stats。
- 风险：列表直接返回卡密 `code`，需确认是否有权展示明文及是否必须审计；默认应只展示脱敏值，完整 reveal 采用单独授权、限频和审计。

**POST `/api/user/app-cards`**
- 请求字段：`count`（默认 1，1–APP_CARD_BATCH_MAX）、`days`（默认 30，1–3650）。
- 当前生成随机 code，成功响应含 `codes[]` 明文。
- 有库存和总量上限；写入后审计。
- 仍缺本 handler 的有效 VIP 管理门禁（P1）。

**DELETE `/api/user/app-cards/:id`**
- 已激活/已使用拒绝删除；未激活记录改为 inactive，设置 manual_disabled 与 user_deleted 原因。
- 需要遵守正式 VIP 到期后可删除本人历史数据、体验 VIP 到期不可删除的差异；当前未见该身份历史规则。

**POST `/api/user/app-cards/:id/disable`**
- 请求字段：可选 `reason`（最多 200）。
- 记录审计；需要有效 VIP 门禁及原因值域校验。

**GET `/api/user/app-cards/events`**
- 当前返回事件 `action,detail,device_id,created_at`，并 JOIN 出 `c.code`。
- 应避免把卡密明文带入普通事件列表；改为卡密记录 ID/脱敏码。

### 2.6 APP 入口管理

**GET `/api/user/app-links`**
- 返回 `data` 与管理员权限配置 `perms`。

**POST `/api/user/app-links`**
- 传入 addAppLink 所需 JSON；字段需继续从 addAppLink 函数提取。
- 当前缺少可见的统一有效 VIP 写门禁。

**DELETE `/api/user/app-links/:id`**
- 按 `id + admin_user_id` 检查归属后物理删除。
- 当前未见独立业务审计；必须增加删除审计并执行有效 VIP 门禁。

### 2.7 APP 卡密兑换、授权状态与分组下发

**POST `/api/app/redeem`**
- 请求字段：`code`（8–24 位大写字母/数字）、`device_id`（8–80 位 [A-Za-z0-9_-]）。
- 成功响应：`entitlement`、`admin_user_id`、`token`、`days`、`local_retention_hours`、`note`。
- 当前卡密状态变更、entitlement 和 free grant 写入同一 userBatch；随后 `app_card_events` 事件单独写入，且 `.catch(()=>{})` 吞错。
- P1：事件写入失败可能造成授权成功但事件缺失；需将事件纳入原子边界或增加可靠 outbox/失败状态。

**GET `/api/app/status?device_id=...`**
- 当前仅校验 device_id 格式，未见读取/验证 entitlement Token。
- P1：设备可伪造 device_id 查询状态；必须要求并验证有效授权凭证。

**GET `/api/app/nodes?device_id=...&token=...`**
- 当前读取最新一条有效 entitlement，再校验 Token。
- 节点查询按管理员来源关联，但查询没有充分过滤 node_lifecycle stale 状态；并且只取最新 entitlement 会遮蔽同设备其他管理员的有效授权。
- P1：多 entitlement 合并规则、来源二次归属、stale 过滤和 generation 必须修复。

**GET `/api/app/groups?device_id=...&token=...`**
- 同样只取最新一条有效 entitlement。
- 无 entitlement 时按 app_free_grants 返回免费组；需统一验证 free grant 的凭证链路。
- Token 通过 query 参数传递存在访问日志泄露风险；APK 契约应优先使用 Authorization Header。

## 3. 转换接口当前已确认范围

**GET `/api/convert/groups`**
- 尝试从 Session 解析登录用户；匿名读取使用 query `guest_key`。
- 通过 `resolveOwnerKey` 形成 owner scope；返回分组统计 `group_name,links,hits,last_at`，以及 owner 前缀。
- 需要确保 guest key 不可猜测、不可共享，且登录态不能被降级成匿名归属。

**GET `/api/convert/links`**
- 同样使用登录用户或 guest_key 推导 owner key。
- 返回 `id,group_name,targets,hits,created_at,last_used_at,expires_at,revoked_at`。
- 查询限制 200 条。

**GET `/c/:id?t=...`**
- 公开订阅短链读取；格式参数 `t` 必须属于 `CONVERT_TARGETS`。
- 读取 payload 后输出订阅内容；访问时更新 hits/last_used_at/expiry，但当前更新错误被 catch 静默。
- 需要确保 payload 加密密钥 fail closed，订阅凭证不进入日志；短链撤销/过期返回 410。

**尚未在本批完整冻结的转换 POST 字段**
- `POST /api/convert` 请求体和 filters 的具体字段仍需下一批完整提取。
- `POST /api/convert/groups/rename` 与 `DELETE /api/convert/links/:id` 的字段、VIP 门禁和幂等需继续核实。
- 不得仅凭目标契约中的示意字段直接写正式前端。

## 4. 本批已确认 P1/P2 契约差异

| 编号 | 当前源码证据 | 差异/风险 | 修复要求 |
|---|---|---|---|
| H-01 | 注册后 `grantTrial().catch(()=>{})` | 体验卡发放失败静默 | 明确发放结果、事务/补偿、错误状态 |
| H-02 | app-groups handler 无有效 VIP 动作门禁 | 非 VIP 可尝试管理 APP 分组 | Worker 统一 VIP gate |
| H-03 | 分组 DELETE 分三条独立 SQL | 非原子，部分删除可能残留 | 事务化生命周期、tombstone、generation |
| H-04 | APP 卡密 GET/events 返回 code | 卡密明文暴露面过大 | 默认脱敏，单独 reveal + 审计 |
| H-05 | app-cards handler 无有效 VIP 动作门禁 | 非 VIP 可创建/管理卡密 | Worker 统一 VIP gate |
| H-06 | APP links handler 写操作无可见 VIP gate | 非 VIP 可新增/删除入口 | Worker 统一 VIP gate |
| H-07 | app-links DELETE 物理删除且未见独立审计 | 缺少业务删除追踪 | 审计 + 生命周期/软删除策略 |
| H-08 | redeem 后事件写入 catch 静默 | 授权成功但事件丢失 | 原子事件或 outbox |
| H-09 | app/status 不验证 Token | 仅 device_id 可查询 | 必须验证授权凭证 |
| H-10 | app/groups/nodes 只取最新 entitlement | 多管理员授权被遮蔽 | 完整 entitlement 集合与选择/合并规则 |
| H-11 | app/nodes 未完整过滤 stale 生命周期 | 旧节点可能继续下发 | 查询 join lifecycle 并过滤 stale/revoked |
| H-12 | 短链访问更新 hits 的错误被吞 | 访问统计与有效期状态可能不一致 | 失败可观测，明确是否允许内容读取继续 |
| H-13 | APP Token 放 query 参数 | 可能被 URL 日志记录 | APK 改用 Authorization Header，过渡期兼容 |
| H-14 | device_id 由请求传入 | 可伪造设备标识 | 设备凭证绑定、签名、撤销和重放保护 |

## 5. 下一批继续核查

1. 提取 `convertRoute` POST 创建、filters、rename、revoke 的完整参数/响应。
2. 提取 `userAppLinksRoute` 所调用的 `addAppLink` 字段和权限配置细节。
3. 提取来源 DELETE、所有权分配/转移、用户节点分组与覆盖路由。
4. 提取 `userAppCardsRoute` 的全部状态变更与超管管理路由。
5. 逐项检查 `userBatch`、`assertStmt`、`auditStmt` 原子性边界和失败语义。
6. 把确认后的实际字段同步回 API 契约 V1；不以建议字段覆盖实际旧契约。

## 6. 明确限制

- 以上仅为仓库当前 Worker 源码静态证据；不代表生产部署版本。
- 没有执行 API 请求、没有访问生产 D1、没有运行测试。
- 没有修改 Worker、HTML、D1、Secrets 或部署。
- 本报告中标注的修复要求尚未编码。
