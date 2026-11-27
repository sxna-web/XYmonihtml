# 星跃管理平台 V2.5｜正式 API 接口契约与权限矩阵 V1

- 日期：2026-11-27
- 仓库：`sxna-web/XYmonihtml`
- 分支：`main`
- 性质：接口设计与静态源码对照文件；不是已实现、已联调或已部署证明。
- 适用：正式管理后台 HTML、Cloudflare Worker、D1；APP 设备接口仅定义服务端边界，具体字段须待 APK 解包审计。
- 安全边界：本文件不授权生产 D1 写入、Worker 部署、Secrets 修改或生产迁移。

## 1. 本轮核查依据与结论

已重新读取：
- `AGENTS.md`
- `docs/星跃管理平台V2.5_功能基线与权限验收规范.md`
- `docs/星跃管理平台V2.5_API接口与权限校验规范.md`
- `docs/audits/StarJump_V2.5_Worker_API路由与前端接入盘点_2026-11-27.md`
- `docs/audits/StarJump_V2.5_HTML1.4.61_Worker_D1功能映射_2026-11-27.md`
- `docs/backend/d1/StarJump_V2.5_D1字段映射与正式修复优先级_2026-11-27.md`
- `docs/backend/StarJump_V2.5_手机端部署一键数据库初始化与诊断开关方案_2026-11-27.md`
- 原始 Worker：`原始StarJump_V1点0_Final-zip-26-11-25-14:56/Worker.js`

关键事实：
1. 当前模拟 HTML 1.4.61 没有正式 Worker API 调用；其数据保存在浏览器 localStorage/IndexedDB。
2. Worker 已有多组路由，但部分接口存在 VIP 门禁、资源归属、幂等、密钥 fail-closed、日志或生命周期缺口。
3. Worker 源码中的 DDL 和 SQL 字段不能证明正式 D1 实际结构；正式 D1 schema 仍待只读核验。
4. APK ZIP 尚未完成解包审计；设备 Token、缓存撤销和 cleanup acknowledgement 不能宣称已实现。
5. 本文中的“目标契约”需要在编码前再对照完整 handler、调用方和测试，不能把未核实字段当作现有字段。

## 2. 状态标记

| 标记 | 含义 |
|---|---|
| EXISTING | 仓库 Worker 分发层可见现有路由；不代表安全验收通过 |
| FIX_REQUIRED | 路由存在，但必须先修复已知安全/业务缺口 |
| NEW | 目标新增路由，当前不能视为已存在 |
| APK_PENDING | 需要 APK 源码审计和设备联调 |
| SCHEMA_PENDING | D1 真实 schema 未核实，表/字段仅为源码依赖或设计映射 |
| CONTRACT_PENDING | 当前 handler 的完整请求/响应字段尚未逐项核实 |

## 3. 统一认证、身份和授权规则

### 3.1 身份来源

- 用户会话由 Worker 验证后解析；用户 ID、角色、VIP 类型、VIP 有效期必须来自服务端会话和 D1。
- 不信任请求体、URL 参数或 Header 中客户端自行声明的 `user_id`、`owner_id`、`role`、`level`、`vip`。
- 匿名转换使用独立稳定 guest key；不得回退共享 `g:anonymous`。
- APP entitlement Token 与后台用户 Session 是不同凭证，禁止混用。
- 协助会话保留 actor（实际操作者）和 effective user（被协助用户）两个身份；审计必须同时记录。

### 3.2 角色与 VIP 动作矩阵

| 身份状态 | 读取本人数据 | 基础转换 | 高级转换 | VIP 管理新建/编辑 | 管理历史删除 | 备注 |
|---|---:|---:|---:|---:|---:|---|
| L0 未注册 | 是，仅本人 | 是 | 否 | 否 | 仅按基础规则 | 不得强制注册阻断基础转换 |
| L1 注册普通用户 | 是，仅本人 | 是 | 按最终功能矩阵 | 否 | 按资源类型规则 | 注册不自动等于 VIP 管理员 |
| L2 普通 VIP | 是，仅本人 | 是 | 是，按授权矩阵 | 不自动拥有 | 按资源类型规则 | VIP 转换权益不等于管理身份 |
| 有效体验 VIP 管理员 | 是，所属资源 | 是 | 是 | 是，核心功能 | 是 | 有效期内核心管理能力等同正式 VIP |
| 体验 VIP 已到期 | 是，历史只读 | 是 | 否/按 L1 | 否 | **禁止** | 历史复制待确认，默认只读 |
| 有效正式 VIP 管理员 | 是，所属资源 | 是 | 是 | 是 | 是 | 完整管理权限 |
| 正式 VIP 已到期 | 是，历史 | 是 | 按非有效 VIP | 否 | **允许删除本人历史数据** | 不允许编辑/新建需 VIP 的业务 |
| 超级管理员 | 按管理范围 | 是 | 是 | 管理权限 | 按敏感操作流程 | 跨用户敏感访问必须审计 |

补充：
- 超管是独立最高管理身份，不是 L3。
- 体验/正式是 VIP 管理身份类型，不是新的普通等级。
- 每个 API 必须同时做动作授权和资源归属校验；前端隐藏按钮不能代替。
- 正式 VIP 到期后允许删除的范围必须由服务端按 owner 和历史资源类型限制，不能扩展为删除其他用户或系统数据。
- 体验 VIP 到期后复制历史数据尚未获确认，暂按拒绝。

### 3.3 统一资源归属约束

所有查询必须先以服务端身份收窄范围，再加载对象：
- 用户资源：`owner_user_id = authenticated_user_id`。
- 管理员资源：`admin_user_id = effective_user_id`，并验证 actor/effective scope。
- 来源：同时验证 `source_ownership` 和来源状态。
- 节点：验证节点所属来源仍归当前管理员，且节点未 stale/撤销。
- APP 卡密：验证卡密所属管理员、卡密状态和操作权限。
- APP 分组：验证分组所属管理员、关联来源、分享/卡密关系。
- 转换批次/短链：验证 owner key、guest key 或用户会话映射；不可只按客户端传入 ID 查询。
- 批量操作：逐项验证所有 ID；混入一条越权资源时必须明确拒绝或返回逐项失败，不能整体越权执行。

## 4. 统一请求与响应约定（目标）

### 4.1 请求头

- 后台登录态：使用现有 Worker Session 认证方式；正式实现前从认证 handler 确认 Header/Cookie 具体格式，不在本文猜测。
- `Content-Type: application/json`：JSON 写请求。
- `X-Request-Id`：可选客户端请求追踪 ID；服务端校验格式，不把它作为身份凭证。
- `Idempotency-Key`：对转换创建、卡密激活、批量状态变更等可重试写操作使用。若现有系统使用 request_id 或 body 字段，先兼容旧调用方，再统一迁移。
- 不允许把真实 Token、卡密或 Secret 放在 URL query。

### 4.2 成功响应

现有 Worker 多数接口使用 `{ ok: true, data: ... }`。正式 API 应保持现有兼容结构，新增字段优先采用可选字段，不得无计划改变旧字段语义。

目标结构示例（字段仅示意）：

```json
{
  "ok": true,
  "data": {},
  "meta": {
    "request_id": "opaque-id"
  }
}
```

### 4.3 错误响应

统一保留 `ok:false`，并逐步补齐稳定机器码：

| HTTP | 错误码示例 | 含义 | 前端处理 |
|---|---|---|---|
| 400 | `VALIDATION_ERROR` | 参数格式/范围错误 | 标记字段，不自动重试 |
| 401 | `AUTH_REQUIRED` / `SESSION_EXPIRED` | 未登录或会话失效 | 引导重新登录 |
| 403 | `PERMISSION_DENIED` / `VIP_REQUIRED` | 身份或动作权限不足 | 展示对应权益/权限说明 |
| 404 | `RESOURCE_NOT_FOUND` | 不存在或不属于当前用户 | 不泄露他人资源是否存在 |
| 409 | `STATE_CONFLICT` / `IDEMPOTENCY_CONFLICT` | 状态或并发冲突 | 刷新状态后再操作 |
| 410 | `RESOURCE_REVOKED` / `RESOURCE_EXPIRED` | 已撤销/过期 | 展示不可用原因 |
| 413 | `PAYLOAD_TOO_LARGE` | 请求体超限 | 提示缩小内容 |
| 429 | `RATE_LIMITED` | 限流 | 返回 Retry-After |
| 500 | `INTERNAL_ERROR` | 内部错误 | 显示 request_id，避免堆栈泄露 |
| 503 | `DEPENDENCY_UNAVAILABLE` | D1/外部依赖不可用 | 不得 fail-open，不得谎报成功 |

约束：
- 错误不得返回 SQL、堆栈、完整订阅 URL、节点 URI、卡密、Token、Cookie 或密钥。
- 429 必须有 `Retry-After` 或等价恢复时间。
- D1 限流/授权关键查询失败时 fail closed；不得把数据库错误当成允许访问。
- 旧版前端兼容期间可保留原 `error` 文本字段，同时增加稳定 `code`。

## 5. 接口域 A：认证、用户与 VIP

以下为仓库当前路由族和目标契约摘要。精确字段须以对应 handler 为准。

| 方法/路径 | 状态 | 调用者 | 目标动作与约束 | D1 依赖（源码映射，待实库核实） |
|---|---|---|---|---|
| POST `/api/auth/login` | EXISTING / FIX_REQUIRED | 公开 | 登录；服务器校验密码、账号状态、锁定策略；成功创建 Session；不回显密码/哈希 | `app_users`, `user_sessions` |
| POST `/api/auth/register` | EXISTING / FIX_REQUIRED | 公开，受注册配置控制 | 注册；账号唯一性；首次体验 VIP 发放必须检查体验卡池；注册与发卡失败不能静默 | `app_users`, `admin_vip_cards`, `admin_vip_activations` |
| POST `/api/auth/logout`（若当前 handler 路径不同，以源码为准） | CONTRACT_PENDING | 登录用户 | 撤销当前 Session；重复注销幂等 | `user_sessions` |
| GET `/api/user/vip` | EXISTING / FIX_REQUIRED | L1/L2/VIP 管理员 | 返回当前有效 VIP 类型、起止时间、到期状态；不能只用历史 MAX(ends_at) 判有效 | `admin_vip_activations` |
| POST `/api/user/vip/activate` | EXISTING / FIX_REQUIRED | 已登录用户 | 激活管理员 VIP 卡；原子检查卡密状态、有效期、并发；不接受客户端声明天数/类型 | `admin_vip_cards`, `admin_vip_activations`, `admin_audit_events` |
| GET `/api/super/vip-cards...` | EXISTING / FIX_REQUIRED | 超管本人会话 | 创建/查询/作废体验或正式卡池；卡密明文仅在创建时按安全策略一次返回；任何 reveal 审计失败须拒绝 | `admin_vip_cards`, `admin_vip_activations`, 审计表 |

必须修复：
1. VIP 判定必须区分有效体验、体验到期、有效正式、正式到期、普通注册和超管。
2. 多条激活记录不能仅取最大 ends_at 就推断当前有效类型。
3. 注册与体验卡发放必须有明确事务/补偿机制；体验卡池空时不得虚报已发放。
4. 卡密激活要原子消费，防止并发重复激活。
5. 协助会话不得借用 actor 身份修改 actor 自己的密码；所有变更要明确 effective user。
6. Session Pepper 缺失时 fail closed，不得使用固定默认值。
7. 对外错误不能泄露账号是否存在等不必要信息。

## 6. 接口域 B：订阅来源、节点、分组和同步

| 方法/路径 | 状态 | 调用者 | 目标动作与权限 | D1 依赖 |
|---|---|---|---|---|
| GET/POST/PATCH/DELETE `/api/user/sources...` | EXISTING / FIX_REQUIRED | 登录用户；写操作需有效 VIP 管理权限（按业务动作） | 来源 CRUD；每次验证 owner；来源转移要撤销旧 owner 访问链 | `subscription_sources`, `source_ownership`, `source_approvals`, 审计表 |
| GET/POST/PATCH/DELETE `/api/user/nodes...` | EXISTING / FIX_REQUIRED | 登录用户 | 节点读取/管理；节点归属需经来源二次校验；stale 不得下发 APP | `node_records`, `node_lifecycle`, `source_ownership`, 覆盖表 |
| GET/POST/PATCH/DELETE `/api/user/node-groups...` | EXISTING / CONTRACT_PENDING | 登录用户；管理写入按 VIP/业务规则 | 分组 CRUD、成员管理；校验每个节点均属于管理员可访问来源 | `node_group_members` 等 |
| POST `/api/user/sources/:id/sync` | EXISTING? / CONTRACT_PENDING | 来源 owner | 只同步当前用户拥有且批准、启用的来源；禁止前端调用旧 `/api/admin/sync` 代替 | 来源、所有权、同步任务/日志表 |
| GET `/api/user/sync-logs` | EXISTING | 登录用户 | 仅返回当前用户来源同步日志；日志脱敏 | `node_sync_logs`, `sync_tasks` |
| GET `/api/user/stale-nodes` | EXISTING / CONTRACT_PENDING | 登录用户 | 只读列出本人可见的 stale 节点 | `node_lifecycle`, `node_records` |
| GET `/api/user/stats` | EXISTING | 登录用户 | 统计仅按当前 user scope 计算 | 用户业务表 |

必须修复：
- 用户同步入口应使用用户来源专属路由，不能误用管理员全局同步接口。
- 每个来源查询/节点读取都校验 `source_ownership`，不能只依赖前端传来的 source_id。
- 来源转移、停用、拒绝或归档后，旧管理员关联必须撤销；重新启用不能让历史授权无条件复活。
- APP 下发过滤 stale、disabled、已撤销节点。
- 同步任务需 fencing/generation；重复任务不能覆盖更新一代结果。
- Cron 维护不得依赖“来源列表非空”；0 个来源时也要执行 VIP 卡密维护、节点生命周期维护和 entitlement 维护。
- Cron 失败必须有独立任务状态与错误记录，不得静默 catch。
- D1 表字段/索引全部标记 SCHEMA_PENDING，正式 schema 核验前不生成 ALTER。

## 7. 接口域 C：转换、短链、归档和历史

| 方法/路径 | 状态 | 调用者 | 目标动作与权限 | D1 依赖 |
|---|---|---|---|---|
| POST `/api/convert` | EXISTING / FIX_REQUIRED | L0 匿名、L1/L2 登录 | 基础转换允许 L0；高级 filters/重命名等服务端验证等级；登录态必须携带用户 Session；匿名使用独立 guest key | `convert_links`、归档/限流相关表 |
| GET `/api/convert/groups` | EXISTING / FIX_REQUIRED | 当前 owner/guest | 仅列出本人转换分组 | `convert_links` |
| POST `/api/convert/groups/rename` | EXISTING / FIX_REQUIRED | 有权管理该批次的用户 | 需要 VIP 的重命名必须服务端门禁；校验 owner key | `convert_links` |
| GET/DELETE `/api/convert/links...` | EXISTING / FIX_REQUIRED | owner/guest 或超管受审计访问 | 查询/撤销本人短链；不能按任意 ID 越权 | `convert_links` |
| GET `/api/super/...` 转换历史管理目标 | NEW | 超管本人会话 | 多条件筛选、查看/复制/编辑/回收站/永久清理；敏感 reveal 需审计成功 | `convert_links` + 版本/回收站/审计结构待设计 |

转换请求目标字段（必须先与现有 handler 做兼容核对）：
- `sources`：来源列表；每项 URL/内容仅用于服务端处理，日志必须脱敏。
- `targets`：目标格式列表，必须是服务端允许枚举。
- `filters`：高级过滤对象；服务端逐项验证权限和长度。
- `group_name`：可选分组名称，长度受限。
- `save_mode`：目标枚举建议 `cloud` / `local_only`；其中 `local_only` 仅表示不参与用户云端同步，平台仍需后台归档。
- `idempotency_key`：一次用户动作唯一；网络重试复用，主动新转换使用新 key。
- `request_id`：追踪请求，不可替代幂等键，除非经核实现有系统已统一语义。

转换结果目标响应：
- `conversion_id` / `batch_id`：服务端生成。
- `status`：queued/running/succeeded/failed 等受控状态。
- `targets`：目标转换结果或短链引用。
- `archive_status`：归档成功/待重试/失败。
- `saved_mode`：服务端确认保存模式。
- 不返回不必要的明文订阅凭证。

强制约束：
1. 每次成功转换独立归档；相同 URL 不覆盖旧记录。
2. 幂等键和请求摘要需由服务端校验；同 key 不同请求体返回 409。
3. 登录态归档归属由 Session 推导；不能因为缺 Token 把注册用户写成匿名。
4. L0 可用基础转换，不可被注册弹窗/营销阻断。
5. 高级过滤、重命名、多源/多目标等权限逐项按最终功能矩阵；未确认项不能自行提高/降低等级。
6. 限流必须原子；D1 错误 fail closed；未执行失败任务按规则返还预占额度。
7. `local_only` 仍进入平台后台归档，但不得进入用户云端历史列表。
8. 编辑历史必须保存不可变快照；永久清理需审计与保留政策。
9. 超管查看完整订阅 URL 时，审计写入失败必须 fail closed。
10. 加密 envelope 应包含版本/key_id；缺密钥不得回退固定默认密钥。

## 8. 接口域 D：星跃 APP 对接、卡密、分组和设备授权

### 8.1 后台管理接口

| 方法/路径 | 状态 | 调用者 | 目标动作与权限 | D1 依赖 |
|---|---|---|---|---|
| GET/POST/PATCH/DELETE `/api/user/app-groups...` | EXISTING / FIX_REQUIRED | 注册用户；管理写操作仅有效 VIP 管理员 | 分组 CRUD；有效 VIP 才能创建/编辑/删除；过期管理员只读；删除/改型要创建撤销 generation | `app_groups`, `app_group_sources`, `app_group_members` |
| GET/POST/PATCH/DELETE `/api/user/app-links...` | EXISTING / FIX_REQUIRED | 注册用户；写操作仅有效 VIP 管理员 | 星链接/APP 入口管理；管理员隔离；删除审计 | `app_links`, `admin_app_perms` |
| GET/POST/PATCH/DELETE `/api/user/app-cards...` | EXISTING / FIX_REQUIRED | 管理员本人；写操作按有效 VIP/卡密状态 | APP 用户卡密创建、列表、停用、恢复；不能与管理员 VIP 卡池混用 | `app_cards`, `app_card_events` |
| GET `/api/user/app-cards/export` | EXISTING / FIX_REQUIRED | 有权管理员 | CSV 导出必须检查权限和响应；不得无意导出卡密明文 | `app_cards` |
| GET `/api/user/share-code` | EXISTING / CONTRACT_PENDING | 登录用户 | 返回当前用户自己的 APP 身份分享编号；防枚举、限流 | `admin_share_codes` |
| GET/POST/PATCH/DELETE `/api/super/app-groups...` | EXISTING / CONTRACT_PENDING | 超管 | 跨管理员管理需记录目标管理员和原因 | APP 分组表、审计 |
| GET/POST/PATCH `/api/super/app-links...`、`app-perms...` | EXISTING / CONTRACT_PENDING | 超管 | 管理平台级授权开关；不能用功能开关替代 VIP 身份判定 | `app_links`, `admin_app_perms` |

### 8.2 APP 客户端接口

| 方法/路径 | 状态 | 调用者 | 目标动作与权限 |
|---|---|---|---|
| GET `/api/app/version` | EXISTING | APP | 公开版本元数据；校验发布状态 |
| GET `/api/app/download` | EXISTING | APP/公开 | 返回经批准的下载信息；防止任意外链 |
| GET `/api/app/resolve` | FIX_REQUIRED | APP | 解析管理员身份/分享编号；强限流、防枚举、最小返回 |
| POST `/api/app/redeem` | FIX_REQUIRED | APP + 卡密 + 设备凭证 | 原子兑换 APP 卡密；验证管理员、卡密状态、设备身份；写入事件与 entitlement 必须一致 |
| GET `/api/app/status` | FIX_REQUIRED | APP entitlement Token | 必须验证 Token、签名、有效期、撤销状态；不能无 Token 读取授权 |
| GET `/api/app/nodes` | FIX_REQUIRED | APP entitlement Token | 验证每个 entitlement、管理员来源归属、节点状态；过滤 stale/disabled/revoked |
| GET `/api/app/groups` | FIX_REQUIRED | APP entitlement Token | 同设备多管理员有效 entitlement 不得只取最新一条；按已确认规则返回/选择 |
| GET `/api/app/free` | FIX_REQUIRED | APP 免费授权凭证 | 必须验证有效 free grant/身份凭证；不能与专属授权链路脱离 |
| GET `/api/app/links` | FIX_REQUIRED | APP entitlement Token | 仅返回授权管理员启用的入口 |

### 8.3 设备端生命周期（APK_PENDING）

目标闭环：
1. Worker 对 APP 分组删除/改型/撤销时，创建新 generation 和 tombstone。
2. APP 增量同步读取 generation，先应用撤销，再处理新节点。
3. APP 本地删除对应管理员/分组缓存，并持久化清理进度。
4. APP 上传 cleanup acknowledgement，至少包含设备凭证、group_id、generation、处理结果和时间。
5. Worker 验证设备凭证与 generation 后记录 ack；旧 generation ack 不得覆盖新 generation。
6. 未收到 ack 时后台显示 pending/overdue，不得谎报已清理。
7. 24 小时是用户已确认的本地清理时限要求；最终可执行承诺必须经 APK 后台任务机制和设备测试验证。

目标新增接口（路径仅为建议，需 APK 审计后冻结）：
- `GET /api/app/sync/changes?cursor=...`：增量授权/分组/节点变化。
- `POST /api/app/cleanup-ack`：设备清理确认。
- `POST /api/app/device/heartbeat`：设备凭证状态与同步游标（是否需要待 APK 审计）。

不得把客户端可伪造的裸 `device_id` 当成唯一可信设备身份。设备凭证需要安全存储、绑定、轮换、撤销和重放保护。

## 9. 接口域 E：系统维护、数据库一键升级与诊断日志

以下均为 NEW 目标接口，不能调用现有 `/api/super/migrate` 替代。

| 方法/路径 | 状态 | 权限 | 行为 | 写入影响 |
|---|---|---|---|---|
| GET `/api/super/maintenance/status` | NEW | 超管本人会话 | 返回环境标签、Worker 版本、schema 版本、迁移状态 | 无 |
| POST `/api/super/database/inspect` | NEW | 超管本人会话 | 只读读取 sqlite_master/PRAGMA，生成 schema diff | 无 |
| GET `/api/super/database/migrations` | NEW | 超管本人会话 | 返回仓库已审核 migration 清单与执行历史 | 无 |
| POST `/api/super/database/migrations/plan` | NEW | 超管本人会话 | 生成迁移计划、风险、依赖和 checksum，不执行 | 无 |
| POST `/api/super/database/migrations/apply` | NEW | 超管本人会话 + 二次确认 | 只执行指定审核 migration ID；禁止任意 SQL | 有，必须单独审批 |
| GET `/api/super/database/migrations/:id` | NEW | 超管本人会话 | 查看迁移步骤、结果和错误编号 | 无 |
| GET `/api/super/diagnostics/config` | NEW | 超管本人会话 | 查看模块开关与剩余 TTL | 无 |
| PATCH `/api/super/diagnostics/config` | NEW | 超管本人会话 + 原因 | 设置模块开关、TTL、原因；记录前后值 | 诊断配置表 |
| GET `/api/super/diagnostics/logs` | NEW | 超管本人会话 | 分页查看脱敏日志，支持模块/级别/request_id 过滤 | 无 |
| GET `/api/super/diagnostics/logs/:id` | NEW | 超管本人会话 | 查看单条脱敏日志 | 无 |

诊断模块 key：
- `AUTH_DEBUG`
- `VIP_DEBUG`
- `CONVERT_DEBUG`
- `SOURCE_SYNC_DEBUG`
- `APP_DEBUG`
- `CRON_DEBUG`
- `DB_DEBUG`

统一规则：
- 全部默认 0；开关只能影响日志详细程度，不能改变业务行为或授权结果。
- 设置开关必须提供原因、TTL（建议默认 30 分钟，最长 2 小时；上线前由用户确认）。
- TTL 到期服务端自动关闭；读配置时也应检查 expires_at，不能只依赖 Cron。
- 每次开关变更记录 actor、模块、旧值、新值、原因、时间和 request_id。
- 日志字段：时间、环境、版本、模块、级别、request_id、操作类型、结果、耗时、错误编号、阶段。
- 日志不得包含完整订阅 URL、节点 URI、卡密、Token、Cookie、Authorization、Secret、密文原文或 SQL 敏感参数。
- 日志查询必须分页、限流、审计访问并有保留期限。
- D1 不可用时诊断写入失败不得伪造成功；关键安全审计失败按 fail closed 策略处理。
- 数据库迁移只能从审核过的固定迁移包中选择；前端不能传 SQL。
- 迁移必须具备 ID、checksum、依赖、状态、执行者、时间、步骤、复核；checksum 不一致停止。
- 不自动 DROP/TRUNCATE/清空/重建正式业务表。
- 生产与测试环境必须明确标识；环境不明确或 binding 不匹配时拒绝执行。

## 10. D1 读写边界总表

> 下表仅是 Worker 源码依赖/目标设计映射，全部实际 schema 以正式 D1 只读核查为准。

| 模块 | 主要读取对象 | 主要写入对象 | 备注 |
|---|---|---|---|
| 认证 | `app_users`, `user_sessions` | `user_sessions`, 登录审计 | Session Token 仅存哈希 |
| VIP | `admin_vip_cards`, `admin_vip_activations` | 激活记录、卡状态、审计 | 体验/正式类型必须可判定 |
| 来源 | `subscription_sources`, `source_ownership`, `source_approvals` | 来源、所有权、审计 | 不能越权转移 |
| 节点 | `node_records`, `node_lifecycle`, overrides | 节点/覆盖/生命周期 | APP 下发过滤 stale |
| 同步 | `sync_tasks`, stage/manifest, `node_sync_logs` | 任务、阶段、日志 | fencing 与 Cron 解耦 |
| 转换 | `convert_links` | 转换归档、幂等记录、额度/限流 | 需要归档与转换状态一致性 |
| APP 卡密 | `app_cards`, `app_card_events`, `app_entitlements` | 卡密、事件、授权 | 事件与状态尽量原子 |
| APP 分组 | `app_groups`, `app_group_sources`, `app_group_members` | 分组关系、generation/tombstone、审计 | 24h 清理需 APK ack |
| 审计 | `admin_audit_events`, `admin_audit` | 审计事件 | 旧表兼容需保留 |
| 维护 | schema_migrations（目标）, 诊断配置/日志（目标） | migration ledger、诊断配置/日志 | 表名和字段须 schema diff 后定 |

严禁：
- 把源码迁移数组当作生产 schema 证据。
- 在未核实正式 D1 前生成针对生产现状的 ALTER。
- 把 `starjump-staging` 当成生产库。
- 将用户明确不要的 `starjump-db` 重新纳入目标。
- 导出真实订阅 URL、节点 URI、卡密、密码哈希、Session Token、密钥或用户隐私。

## 11. 审计、幂等和事务规范

敏感操作至少记录：
- actor_user_id、effective_user_id；
- action、target_type、target_id；
- request_id、结果、错误码；
- 操作前后差异（脱敏）；
- 原因、时间、环境；
- 适用时的 migration_id、generation、device_id 摘要。

必须具备幂等/并发保护的操作：
- 注册并发、体验卡领取；
- VIP 卡密激活；
- APP 卡密激活/兑换；
- 转换创建、归档和额度扣减；
- 来源转移；
- 分组创建/改型/删除；
- 分组 generation 撤销和 cleanup ack；
- 数据库迁移 apply；
- Cron 维护任务。

D1 batch/事务应尽可能把业务状态变更与审计/事件写入放在同一原子边界。若 Cloudflare D1 具体操作不能事务化，必须记录补偿步骤和中间状态，禁止吞错后返回成功。

## 12. 测试验收矩阵（编码后必须实际运行）

| ID | 场景 | 预期 |
|---|---|---|
| AUTH-01 | 未登录访问 user API | 401 |
| AUTH-02 | 客户端伪造 user_id/role/vip | 身份不变，不能越权 |
| AUTH-03 | 过期/撤销 Session | 401 |
| AUTH-04 | 协助会话越权访问超管 API | 403 + 拒绝审计 |
| VIP-01 | L0 调用高级转换 | 403 |
| VIP-02 | 有效体验 VIP 执行核心管理操作 | 允许 |
| VIP-03 | 体验 VIP 到期编辑/删除历史 | 403 |
| VIP-04 | 正式 VIP 到期删除本人历史 | 允许 |
| VIP-05 | 正式 VIP 到期编辑或创建 VIP 资源 | 403 |
| VIP-06 | 多条体验/正式激活记录并存 | 按服务端有效授权规则判定，不误判 |
| OWN-01 | 管理员 A 替换管理员 B 的资源 ID | 不泄露资源并拒绝 |
| OWN-02 | 节点 source_id 不属于当前 owner | 拒绝 |
| CONV-01 | L0 基础转换 | 成功 |
| CONV-02 | 登录用户转换请求未带会话 | 不得归档为匿名用户 |
| CONV-03 | 同幂等键、同请求体重试 | 返回原任务，不重复扣额度 |
| CONV-04 | 同幂等键、不同请求体 | 409 |
| CONV-05 | local_only 转换成功 | 后台归档，但不进入用户云端历史 |
| CONV-06 | 归档写入失败 | 不谎报成功，可安全恢复/重试 |
| RATE-01 | D1 限流存储故障 | fail closed |
| APP-01 | 非有效 VIP 修改 APP 分组 | 403 |
| APP-02 | APP status 缺失/伪造 Token | 401/403 |
| APP-03 | stale/disabled 节点下发 | 过滤 |
| APP-04 | 同设备多管理员 entitlement | 不因只取最新一条而丢授权 |
| APP-05 | 删除/改型分组 | 生成 tombstone/generation |
| APP-06 | 设备完成清理并 ack | 校验设备凭证与 generation 后记录 |
| CRON-01 | 来源数量为 0 | VIP/节点/entitlement 维护仍执行 |
| CRON-02 | 维护失败 | 有错误日志与任务状态，不静默 |
| DB-01 | inspect API | 只读，不改变 schema/data |
| DB-02 | apply 未确认 migration | 拒绝 |
| DB-03 | migration checksum 不匹配 | 停止执行 |
| DB-04 | 重复 apply 同一 migration | 安全返回已完成，不重复写入 |
| DB-05 | 生产/测试 binding 不匹配 | 阻止执行 |
| DIAG-01 | 所有诊断开关初始状态 | 全部 0 |
| DIAG-02 | 开关开启并设置 TTL | 到期自动关闭 |
| DIAG-03 | 诊断日志含敏感字段输入 | 脱敏后才持久化/输出 |
| DIAG-04 | 普通用户修改诊断开关 | 403 |
| COMPAT-01 | 旧版前端调用旧响应字段 | 保持兼容或按版本迁移计划处理 |

测试证据必须记录环境、Worker commit、D1 测试库标识、请求（脱敏）、预期、实际响应和结论。静态阅读不能标记测试通过。

## 13. 实施顺序与交付方式

### 阶段 1：契约冻结前核对
- 从 Worker handler 逐条提取真实参数、响应和 SQL。
- 从 HTML 提取所有按钮/表单/批量动作。
- APK 解包后补齐设备接口字段。
- 正式 D1 只读核查完成后更新表字段映射。
- 对不确定业务规则列为待确认，不擅自决定。

### 阶段 2：服务端安全修复
优先修复 P1：
1. VIP 状态与动作级门禁；
2. Session/APP Token/转换密钥 fail-closed；
3. 资源归属与来源转移撤销；
4. 转换身份归属、幂等归档、限流；
5. APP entitlement、stale 节点、generation/tombstone；
6. Cron 维护独立执行和错误可观测；
7. 敏感 reveal 审计 fail closed。

### 阶段 3：系统维护与诊断
- 先只读 inspect；
- 再 migration plan；
- 最后在测试 D1 验证 apply；
- 诊断开关和 TTL 在测试环境验证；
- 不调用旧 `/api/super/migrate`。

### 阶段 4：正式 HTML/API 接入
- 用冻结契约实现 API client；
- 页面展示权限状态，但最终权限仍由 Worker 决定；
- 对 401/403/409/429/5xx 提供可理解提示；
- 保留模拟 HTML 原始版本，正式版本另建版本目录。

### 阶段 5：完整交付包
AI 提供完整、互相匹配的 Worker、HTML、迁移、配置模板、操作说明、测试证据和回滚说明。用户通过手机上传/部署；部署后先做环境检查和只读数据库检查，再由用户明确批准任何生产迁移。

## 14. 本轮尚未完成与明确禁止事项

尚未完成：
- 未逐个读取所有 Worker handler 并冻结每个请求/响应字段；
- 未对 1.4.61 HTML 每个交互控件完成正式 API 绑定；
- 未解包审计 APK；
- 未取得正式 D1 schema；
- 未进行 Worker/D1 自动化测试或线上联调；
- 未实现本文 NEW 路由；
- 未部署任何版本。

明确禁止：
- 不调用 `POST /api/super/migrate`。
- 不对生产 D1 执行 CREATE/ALTER/DROP/DELETE/TRUNCATE。
- 不改生产 Worker、Secrets、环境变量或 binding。
- 不将 staging 或废弃库当成生产。
- 不将模拟 HTML 点击结果描述为正式联调。
- 不将本文的目标路由、示例字段或测试预期描述为当前已有功能。

## 15. 待确认事项（继续沿用功能基线）

1. 体验 VIP 到期后是否允许复制历史数据：未确认，默认严格只读。
2. 体验 VIP 管理员创建的未激活 APP 卡密是否有独立 3 天宽限期。
3. 同一用户是否严格限制只领取一次体验卡，以及超管重发流程。
4. L1/L2 高级转换功能逐项矩阵及最终限流值。
5. 分组回收站保留期限和永久清理规则。
6. 诊断开关默认 TTL 是否采用 30 分钟、最长 2 小时。
7. 当前正式 Worker 与正式 D1 binding 的真实名称/部署版本，需用户在方便时从 Cloudflare 面板确认；不要提供 Secret。

## 16. 变更记录

- 2026-11-27：建立 API 契约 V1；基于 V2.5 基线、Worker 路由盘点、D1 字段映射和手机端运维方案整理；标记现有/待修复/新增/待 APK/待 schema 项。


## 17. 第三批底层安全核查补充（2026-11-27）

第三批只读审计报告：
`docs/audits/StarJump_V2.5_统一权限门禁与底层安全函数核查_第三批_2026-11-27.md`

**本节为源码差异补充，不表示已修复或测试通过。** 核查基于当前仓库 Worker 基线文件，未连接正式 D1、未调用 API、未部署。

### 17.1 当前源码确认的安全差异

1. `/api/user/*` 路由层已有 Session + 协助 scope 门禁，但没有统一有效 VIP 动作门禁。
2. `/api/user/app-groups`、`/api/user/app-links`、`/api/user/app-cards` 的管理写操作未见有效 VIP 检查；必须按 V2.5 规则补齐。
3. 转换过滤函数 `applyNodeFilters` 没有服务端登录/VIP 等级检查，匿名请求也会执行 filters。
4. 转换 API 对内部 Session 解析异常/无效凭证可能降级匿名；缺 guest_key 时使用共享 `g:anonymous`。
5. APP HMAC Token 密钥缺失时回退固定 `starjump-app`；转换加密密钥缺失时回退固定 `starjump-convert`。
6. `/api/app/status` 只按 device_id 查询，不验证 entitlement Token。
7. APP groups/nodes/links 只选最新一条有效 entitlement，无法完整表达同设备多管理员授权。
8. APP 免费分组路径尚未形成统一、可验证的 free-grant 凭证闭环。
9. 转换密文无 envelope version/key_id；密钥轮换没有受控兼容机制。
10. `loadSourceForCtx/loadSubscriptionNode` 验证 ownership 关系，但没有统一涵盖 source approval/enabled、node lifecycle stale 等资源状态条件。

### 17.2 新增问题编号

- P1-47 至 P1-60：详见第三批审计报告第 4 节。
- 第三批 P2：详见第三批审计报告第 4 节。

### 17.3 动作级门禁实施约束

- 先实现统一身份/会员解析，再按 action 与 resource 决策；不能仅用“是否登录”替代 L0/L1/L2。
- 有效体验 VIP 和正式 VIP 在有效期内核心 VIP 功能相同。
- 体验 VIP 到期：只读历史，默认不允许复制/编辑/删除。
- 正式 VIP 到期：允许查看和删除本人历史数据；禁止创建、编辑和需要有效 VIP 的分享管理操作。
- APP 对接/星链接：注册用户可查看；只有有效 VIP 管理员可管理。
- 高级转换功能逐项 L1/L2 分配仍待确认；未确认前不得自行设定等级。
- 每个写操作必须同时验证 actor/effective scope、会员状态、资源归属和资源状态；敏感写入应把授权断言纳入同一原子边界。

### 17.4 密钥与 Token 的强制约束

- SESSION_PEPPER、APP 专用 HMAC Secret、CONVERT_KEY 缺失或强度不足时，相关功能 fail closed。
- 不得保留任何公开固定字符串作为生产密钥回退。
- APP Token 不得通过 URL query 传递；所有状态、节点、分组、入口和免费组读取均需统一凭证校验。
- 加密 envelope 必须具备版本和 key_id；密钥轮换需双读单写、旧密文兼容和可回滚方案。
- device_id 仅为设备标识，不是认证凭证；必须设计设备凭证绑定、轮换、撤销和重放保护。

### 17.5 状态说明

上述差异均为**静态源码核查发现**。没有任何一项被标记为已修复、已测试或已部署。实施前仍需完成正式 D1 只读 schema 核验、APK Token 存储/调用审计、影响分析、回滚计划和测试环境验证。
