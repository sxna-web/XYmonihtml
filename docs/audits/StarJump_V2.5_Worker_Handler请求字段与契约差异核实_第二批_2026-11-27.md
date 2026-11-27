# 星跃 V2.5｜Worker Handler 请求字段与契约差异核实（第二批）

- 日期：2026-11-27
- Worker 基线：`原始StarJump_V1点0_Final-zip-26-11-25-14:56/Worker.js`
- Worker blob：`5da7aa3582558d9da2c2a0ad25a63c5e95e9fe63`
- 性质：静态源码核查，不是生产版本确认、API 测试或线上安全验收。
- 关联：`docs/backend/StarJump_V2.5_API接口契约与权限矩阵_V1_2026-11-27.md`、第一批 Handler 核查报告。

## 1. 本批范围

本批读取并核对：
- `convertRoute` 的 POST、rename、revoke、公开短链访问；
- `userSourcesRoute` 的创建、编辑、启停、同步、归档；
- `userNodesRoute`、`userOverridesRoute`、`userGroupsRoute`、`userMetadataRoute`；
- `userAppCardsRoute` 全部可见动作；
- `addAppLink`；
- `userBatch`、`assertStmt`、`auditStmt`；
- 节点生命周期 Cron 清理逻辑。

## 2. 转换接口真实字段

### POST `/api/convert`

源码读取字段：
- `sources`：字符串数组，最多 `CONVERT_MAX_SOURCES` 项；
- `nodes`：手动节点文本，最多 `CONVERT_MAX_TEXT` 字符；
- `targets`：格式数组，仅保留 `CONVERT_TARGETS` 中允许值；
- `filters`：传入 `applyNodeFilters`；本 handler 注释称过滤/重命名仅对登录用户开放，但没有在此处看到有效 VIP 动作门禁；
- `group`：最多 30 字符，默认“我的默认分组”；
- `filename`：最多 60 字符，默认 starjump；
- `guest_key`：最多 64 字符，也可通过 `X-Guest-Key` header 提交。

成功响应（HTTP 201）：
- `data.id`
- `data.links`：按目标格式生成的 `/c/:id?t=<target>` URL
- `data.expires_in_days`
- `data.group`
- `data.stats`：sources/nodes/skipped
- `data.sources[]`：来源结果，URL 脱敏，包含节点数量或错误文本。

已确认问题：
1. 登录态 Session 解析失败被 catch 后当匿名继续；若登录用户请求认证失效/Token 错误，不能静默降级为 guest。
2. 未登录且未提供 guest key 时，当前 `resolveOwnerKey` 路径存在共享匿名 owner 风险（此前审计标记 `g:anonymous`）；必须改为每访客不可猜测独立 key。
3. IP 限流先 SELECT count 再继续，没有看到原子预占/扣减；并发请求可穿透限制。
4. `checkGlobalLimit` 的失败处理需要确认是否 fail closed；此前审计已发现 D1 限流错误 fail-open 风险。
5. 过滤器只注释“登录用户可用”，没有服务端有效 VIP gate；L1 注册用户不应仅凭登录就获得 VIP 功能。
6. 没有 idempotency key；同一请求重试会创建新短链/重复归档。
7. 当前写入仅 INSERT `convert_links`；没有看到独立转换任务状态/归档 outbox/额度返还机制。
8. 订阅 URL 被封装进 payload 的 sources 元数据；必须核对 `sealJson/openJson` 的密钥 fail-closed、版本化与轮换。
9. `sourceInfo` 错误会把异常消息带回响应；需确保异常消息已脱敏，不能回传订阅凭证、内部网络地址或服务端堆栈。

### POST `/api/convert/groups/rename`

- 请求：`from`、`to`，均最多 30 字符；to 需符合中英文/数字/空格/下划线/连字符规则。
- owner 由 Session 或 guest key 推导。
- 执行：按 `owner_key + group_name` 批量更新 `convert_links.group_name`。
- 响应：`data:{from,to,links}`。
- 问题：没有有效 VIP gate、没有独立审计、没有幂等/版本保护；L0/L1 不能仅凭拥有 owner key 就执行 VIP 管理动作。

### POST `/api/convert/links/:id/revoke`

- Body 允许空；guest key 可来自 `X-Guest-Key` 或 body `guest_key`。
- URL 第 5 段取短链 ID，格式 6–40 位字母/数字。
- 通过 `owner_key` 检查归属；已撤销时幂等返回 `already:true`。
- 成功响应：`data:{id,revoked:true}`。
- 问题：更新语句仅按 id 执行，未将 owner_key 放入 UPDATE 条件；虽然此前有 SELECT 校验，但应使用条件更新防 TOCTOU。缺少审计和 request/idempotency 追踪。

### GET `/c/:id?t=<target>`

- 公开读取短链内容；target 缺省 v2ray，必须在允许目标列表。
- 撤销/过期分别返回 410。
- 读取成功后尝试增加 hits、刷新 last_used_at 并顺延有效期；更新失败被 catch 静默。
- 不应因为统计更新失败而返回错误订阅内容，但失败必须进入脱敏诊断日志，不能无声吞错。
- 订阅 payload 解密失败当前返回通用 500；生产密钥缺失/错误时不得回退固定默认密钥。

## 3. 来源接口真实字段与生命周期

### GET `/api/user/sources`

- 普通用户仅查询 `source_ownership.user_id = ctx.effectiveId` 的来源。
- 超管本人会话可看全量。
- 返回字段：`id,name,url(脱敏),tier,enabled,priority,remark,created_at,updated_at,owner_user_id,approval_status`。

### POST `/api/user/sources`

Body：
- `name`：必填，最多 120；
- `url`：必填，最多 2048，必须通过 subscription URL 校验；
- `tier`：默认 free，最多 30，字符白名单；
- `priority`：默认 100，整数 0–100000；
- `remark`：最多 500；
- `enabled`：当前仅超管本人直建时可按 body.enabled !== false 启用。

响应：`data:{id,approval_status,enabled}`，HTTP 201。
普通用户创建默认 pending 且 disabled；超管本人直建默认 approved。

### PUT `/api/user/sources/:id`

Body：`name,url,tier,priority,remark`。
- 前端回传脱敏 URL 时，服务端保留原始 URL；
- 普通用户更改 URL 会停用并重新进入 pending 审核；
- 超管本人直改地址会更新为 approved；
- 写入来源、审批变化和审计使用同一 `userBatch`。

### PATCH `/api/user/sources/:id/enabled`

Body：`enabled`，仅 true/false/1/0。
启用前验证审批状态 approved。

### POST `/api/user/sources/:id/sync`

- 当前源码存在该用户态专属路径；
- 需要 `requireScope(ctx,"operate")`；
- 必须有 owner、已批准、启用状态；
- 调用 `syncSource`；
- 响应 `{ok: result.status === "success", data: result}`。
- HTML 模拟版仍不能视为已接入该接口。

### DELETE `/api/user/sources/:id`

- 不物理删除 source/node；
- 将来源 disabled；
- 删除当前 effective user 的 `source_ownership`；
- 写 source.archive 审计；
- 返回 `archived:true,node_count`。

关键风险：
- 解除所有权后，必须同步撤销旧管理员的 APP 分组、APP 分享和设备 entitlement 关联；当前本 handler 只处理来源停用和 ownership 删除，未见完整联动撤销。
- 仅停用来源不能代替 APP 端撤销 generation/tombstone/cleanup ack。
- 对于协助会话，必须验证 scope 的 manage/operate 等级与资源归属；不能只依赖 effectiveId。
- 用户删除来源后，原始来源与节点作为超管备份保留是既定行为，不应误做物理删除。

## 4. 节点、覆盖、分组和备注接口

### GET `/api/user/nodes`

支持 query：
- 分页：由 `parsePaging` 解析；
- `source_id`、`protocol`、`tier`、`enabled`、`kind`、`q`、`group_id`、`favorite`、`sort`；
- sort 字段必须属于 `SORTABLE_COLUMNS`，方向只接受 asc，否则 desc。

返回：`data,total,limit,offset`。
查询使用 `source_ownership` 约束订阅节点，并合并当前用户 overrides；手动节点来自 `user_manual_nodes.user_id`。

风险：
- 查询 CTE 没有看到 JOIN `node_lifecycle` 并排除 stale；必须确保面向 APP 的查询和管理展示有明确 stale 状态。
- 管理列表是否显示 stale 可与 APP 下发策略不同；不能把“列表隐藏”当成“已清理本地缓存”。

### 手动节点

**POST `/api/user/nodes/manual`**
Body：`name,protocol,server,port,tier,uri,remark,enabled`。
- protocol 当前允许集由 `ALLOWED_PROTOCOLS` 决定；
- server 非空且不能含空白；
- port 1–65535；
- tier 1–30 位白名单；
- uri 最多 4000，当前 buildManualNode 校验协议前缀；
- 返回 `data:{id}`，HTTP 201。

**PUT `/api/user/nodes/manual/:id`**
- 先读取本人手动节点；
- body 部分字段与原值合并后重新校验；
- 更新并写审计；
- 返回 `data:{id}`。

**DELETE `/api/user/nodes/manual/:id`**
- 同批删除手动节点、本人 metadata、本人 group members，并写审计；
- 返回 `data:{id}`。

### 节点启用与字段覆盖

**PATCH `/api/user/nodes/:id/enabled`**
- Body：`enabled`，true/false/1/0；
- 订阅节点写入本人 `node_overrides`；
- 手动节点更新本人记录；
- 返回 `data:{id,enabled}`。

**GET/PUT/DELETE `/api/user/nodes/:id/overrides/:field`**
- field 必须在 `ALLOWED_OVERRIDE_FIELDS`；
- PUT Body：`value`（或同名 field）和可选 `reason`（最多 200）；
- 可覆盖字段：name/protocol/server/port/tier/enabled（以常量集为准）；
- DELETE 清除本人字段覆盖并返回恢复值；
- 操作写审计。

### 节点分组

**GET `/api/user/node-groups`**
- 返回本人分组及 member_count。

**POST `/api/user/node-groups`**
- Body：`name` 必填最多 60；`sort_order` 默认 0，整数绝对值 ≤ 1,000,000；`remark` 最多 200。
- 返回 `data:{id}`，HTTP 201。

**PUT `/api/user/node-groups/:id`**
- Body：可选 `name,sort_order,remark`；未传字段保留原值。
- 返回 `data:{id}`。

**DELETE `/api/user/node-groups/:id`**
- 当前通过 `userBatch` 删除 group、members 并写审计。
- 对普通网页节点分组可按既定回收规则评估；不得将此物理删除实现直接复用为 APP 分组删除，因为 APP 分组需要 tombstone/generation/设备确认。

**POST `/api/user/node-groups/:id/members`**
- Body：`node_kind`（subscription/manual）、`node_id`；
- 服务端再次验证节点真实归属；
- INSERT OR IGNORE，返回 group_id/node_kind/node_id。

**DELETE `/api/user/node-groups/:id/members?node_kind=...&node_id=...`**
- query：`node_kind,node_id`；
- 删除本人对应成员关系。

### PUT `/api/user/nodes/:id/metadata`

- Body：部分更新 `remark`（最多 500）、`favorite`（true/false/1/0）、`sort_order`（整数绝对值 ≤ 1,000,000）。
- 未传字段保留原值；
- 返回 `node_id,node_kind,remark,favorite,sort_order`。

## 5. APP 卡密与入口接口

### GET `/api/user/app-cards`

Query：
- `status`：normal/inactive/used/unactivated；
- `from`、`to`：创建时间筛选；
- 返回最多 500 条。

当前返回字段包含：`id,code,days,status,inactive_reason,inactive_at,restored_at,manual_disabled,activated_at,used_at,created_at`，另返回 `stats[]`。
风险：列表直接返回完整 code，应默认脱敏；完整 reveal 应是单独受控操作并审计。

### POST `/api/user/app-cards`

Body：
- `count)：默认 1，1–300；
- `days)：默认 30，1–3650。

库存检查：
- 总记录 ≤ 20000；
- 未激活 normal 库存 ≤ 5000；
- 生成 APP 用户卡密，过期时间当前设置为 max(days*2,365) 天。
响应：`data:{count,days,codes[]}`，HTTP 201。
风险：未见有效 VIP 写门禁；库存 SELECT 与 INSERT 并非同一条件原子断言，并发批次可能超上限；返回明文 codes 应限制仅创建时展示一次并避免日志。

### DELETE `/api/user/app-cards/:id`

- 仅按 `id + admin_user_id` 查本人卡密；
- 已激活/已使用拒绝删除；
- 未激活记录改为 inactive、manual_disabled=1、inactive_reason=user_deleted；
- 写审计；返回 `deleted:true`。
- 需要叠加体验 VIP 到期不可操作、正式 VIP 到期允许删除本人历史数据等已确认规则；当前 handler 没有动作级 VIP 检查。

### POST `/api/user/app-cards/:id/disable`

Body：可选 `reason`（最多 200）。
- 设置 manual_disabled=1；
- normal 改 inactive；
- 写审计；
- 返回 `disabled:true`。
- 必须加有效 VIP 门禁及状态转换规则，避免重复操作/对已使用卡密产生误导状态。

### GET `/api/user/app-cards/events`

- 返回最近 300 条事件；
- 当前 JOIN 并返回 `c.code` 明文；
- 应返回卡密 ID + 脱敏码，避免明文扩散。

### APP 入口 POST

`addAppLink(db,ctx,adminId,body)` 实际字段：
- `title)：必填，最大长度 APP_LINK_TITLE_MAX；
- `url)：必填，必须为 http(s)；
- `sort)：可选，默认 APP_LINK_SORT_DEFAULT。

同时检查管理员 `links_enabled` 和 max_links；创建后写审计，但审计执行当前使用单独 `.run().catch(()=>{})`，审计失败不阻断成功响应。必须改为与业务写入同一原子边界或可靠 outbox。
用户入口 DELETE 当前只按 owner 过滤，物理删除后没有看到独立审计；并且未见有效 VIP gate。

## 6. 批量写入与审计原子性

### `userBatch`

源码：
- 若协助会话存在 scope，则把 `scopeGuardStmt` 追加到同一个 `db.batch`；
- 否则直接执行 `db.batch(stmts)`。
- `assertStmt` 通过 SQL CASE + `json_extract('assert-failed','$')` 在条件不满足时触发错误，以期使 batch 回滚。
- 这是一种 D1 batch 原子边界设计，但必须通过 D1 测试确认约束错误时整个 batch 的回滚语义，不能只凭静态源码宣称测试通过。

### `auditStmt`

- 写 `admin_audit_events`；
- 字段：actor_user_id、effective_user_id、action、target_type、target_id、request_id、before_json、after_json、result、reason、detail；
- JSON 截断 4000 字符；detail 最多 1000。
- 使用 `userBatch` 的调用点可与业务写入同批；但部分代码仍使用单独 `.run().catch(()=>{})`，会造成审计丢失。
- `auditDenied` 的设计注释明确拒绝审计失败不阻断 403；需要与高风险成功操作审计失败必须 fail closed 的规则区分。

### 本批确认的非原子/吞错位置

- APP 卡密 redeem 后 `app_card_events` 单独写入且 catch 静默（第一批已记录）。
- `addAppLink` 创建后审计单独写入且 catch 静默。
- APP 分组删除分三条独立 DELETE（第一批已记录）。
- 节点 lifecycle stale/purge 的审计失败 catch 静默。
- 节点 stale 超过 30 天后物理删除 node_records 与 node_lifecycle；与此前“stale 只标记不删除”的注释和长期数据保留要求存在冲突，需要用户确认并修订实现，不能自动物理清理正式节点历史。
- 公开短链访问 hits/expiry 更新失败 catch 静默。
- 超管创建普通用户后 grantTrial 失败 catch 静默（第一批已记录）。

## 7. 本批新增差异编号

| 编号 | 证据 | 风险 | 目标修复 |
|---|---|---|---|
| H2-01 | convert POST 缺幂等键 | 重试重复生成短链/归档 | 服务端 idempotency ledger |
| H2-02 | Session 解析异常 catch 后匿名继续 | 登录用户可能归入 guest | 有认证凭证但无效时 401；不允许降级 |
| H2-03 | guest key 缺失存在共享匿名 owner 路径 | 用户数据混合/互见 | 每访客随机 key + 服务端哈希绑定 |
| H2-04 | filters 无有效 VIP gate | L1 可调用 VIP 功能 | 服务端按动作授权 |
| H2-05 | 转换限流 SELECT count 后再写 | 并发绕过 | 原子 rate-limit reservation |
| H2-06 | rename 缺 VIP gate/审计 | 普通用户执行管理操作且不可追踪 | VIP gate + audit + 幂等 |
| H2-07 | revoke UPDATE 未带 owner_key 条件 | SELECT/UPDATE 之间竞态 | 条件 UPDATE owner_key + revoked_at IS NULL |
| H2-08 | 来源归档仅停用+解除 ownership | APP 旧关联可能残留 | 同事务生成来源撤销事件并触发 APP generation |
| H2-09 | APP 卡密库存先查后插 | 并发超库存 | 原子条件/计数锁或事务式库存 reservation |
| H2-10 | APP 卡密 GET/events 暴露完整 code | 卡密凭证泄露 | 默认脱敏、单次 reveal 审计 |
| H2-11 | APP 卡密管理无 VIP 动作门禁 | 非有效 VIP 可写 | 统一服务端门禁 |
| H2-12 | APP 入口审计单独写入且 catch | 审计缺失但创建成功 | 业务+审计原子化/outbox |
| H2-13 | APP 入口 DELETE 未见审计 | 删除不可追踪 | 软删除/审计 |
| H2-14 | lifecycle purge 删除 stale 节点物理记录 | 历史被自动清除 | 默认只标记；永久清理需回收站/审批 |
| H2-15 | 多处审计 catch 静默 | 运维无法证明敏感操作记录完整 | 区分普通拒绝审计与高风险成功审计策略 |
| H2-16 | 短链 hits/expiry 更新 catch | 统计与状态错误不可见 | 脱敏诊断事件与重试策略 |

## 8. 下一步核查清单

1. 检查所有 Worker 路由分发的身份门禁：哪些 /api/user 路由仅验证 Session，哪些已统一 VIP gate。
2. 逐项读取 `applyNodeFilters`、`resolveOwnerKey`、`sealJson/openJson`、`loadSubscriptionNode`、`loadSourceForCtx` 的完整实现。
3. 继续核实 APP groups、APP links、APP redeem/status/nodes/groups 的完整响应和 Token 读取位置。
4. 对照用户已确认的 L0/L1/L2、体验/正式 VIP 规则，形成动作级门禁表。
5. 将已核实字段和差异同步回 API 契约 V1；待 APK/D1 的内容继续标 pending。

## 9. 明确限制

- 本批仅静态读取仓库 Worker 源码。
- 未运行 Worker、未请求 API、未运行 D1 测试。
- 未访问或修改正式 D1。
- 未修改 Worker/HTML/Secrets/环境变量，未部署。
- 所有修复均为待实施事项，不能标记为已完成。
