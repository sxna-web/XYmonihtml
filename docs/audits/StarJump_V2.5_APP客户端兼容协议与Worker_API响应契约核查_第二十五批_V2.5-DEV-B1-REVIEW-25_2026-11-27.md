# 星跃管理平台 V2.5：APP 客户端兼容协议与 Worker API 响应契约核查

- **批次**：第二十五批
- **版本标识**：V2.5-DEV-B1-REVIEW-25
- **日期**：2026-11-27
- **状态**：DEV 静态源码审计；不是修复版、RC 或可部署版本
- **仓库**：`sxna-web/XYmonihtml`，分支 `main`
- **Worker 基线**：`原始StarJump_V1点0_Final-zip-26-11-25-14:56/Worker.js`
- **Worker Blob**：`5da7aa3582558d9da2c2a0ad25a63c5e95e9fe63`
- **HTML 基线**：`原始StarJump_V1点0_Final-zip-26-11-25-14:56/index.html`
- **范围**：APP 版本、下载、解析、核销、状态、分组、免费分组、链接、节点接口；后台 HTML API 调用方式；请求/响应字段和旧客户端兼容风险
- **限制**：只读静态检查；未解包 APK ZIP，未调用线上 API，未读取生产 D1，未修改业务代码/数据库/Secrets/部署。

## 1. 总结

本批确认归档 Worker 暴露以下 APP 相关接口：
- 公开信息/发布：`GET /api/app/version`、`GET /api/app/download`、`GET /api/app/resolve`
- 卡密核销与授权：`POST /api/app/redeem`、`GET /api/app/status`
- 授权内容：`GET /api/app/nodes`、`GET /api/app/groups`、`GET /api/app/free`、`GET /api/app/links`

但这只是 Worker 路由存在证据，不能证明 APK 实际按这些字段调用，也不能证明客户端解析响应成功。

本批发现的重点不是单纯字段命名，而是接口认证策略不一致：核销接口由卡密执行一次性激活；nodes 使用 entitlement Token；status、groups、free、links 在当前归档实现中存在不同程度的 device_id 参数读取路径，其中部分路径未要求 entitlement Token。此前第二十至二十三批已经登记过相关授权边界问题，本批从协议契约角度再次确认其客户端兼容与安全影响，不将重复发现伪装成新修复。

## 2. APP API 契约盘点

> 下表只记录静态源码可见的请求/响应字段。未在函数完整上下文中确认的字段明确标记“需继续核对”，不猜测 APK 端字段。

### 2.1 版本检查：GET /api/app/version

- 路由：公开，无需 APP entitlement Token。
- 处理函数：`appVersionRoute(req, env, url)`。
- 用途：读取当前发布版本信息。
- 发布表字段来源：`releases`，可见字段包括 platform、version_code、version_name、min_version_code、url、notes、force、active、created_at。
- 响应字段的完整实际 JSON 结构：本批尚未逐字段展开函数返回体，列为后续源码复核项。
- 风险：当前发布元数据没有在已核实的表结构中看到 APK SHA-256、签名证书摘要或签名校验策略。版本号/下载 URL 本身不能证明安装包完整、可信。

### 2.2 下载：GET /api/app/download

- 路由：公开，无需 APP entitlement Token。
- 处理函数：`downloadRoute(req, env, url)`。
- 发布/下载数据来源：`releases` 与 `download_links` 相关数据。
- 本次静态盘点已确认 Worker 对该路径单独分派；完整 query 参数与响应字段仍需逐函数复核。
- 风险：此前第十六、十七批已登记下载 URL 可接受 HTTP 的风险；未看到下载完整性哈希/签名证书闭环。

### 2.3 外部解析：GET /api/app/resolve

- 路由：公开，无需 APP entitlement Token。
- 处理函数：`appResolveRoute(req, env, url)`。
- 作用：根据查询参数解析 APP 管理员/分享入口相关信息。
- 完整请求字段与响应字段仍需从函数体逐项冻结；不得仅根据函数名推断。
- 风险：此前第十六批已登记解析响应暴露管理员内部 ID/用户名的风险，后续应按最小公开字段原则收敛。

### 2.4 卡密核销：POST /api/app/redeem

已静态确认请求 JSON：
- `code`：卡密，转大写，格式限制为 8-24 位 A-Z/0-9；
- `device_id`：设备标识，格式限制为 8-80 位字母、数字、下划线、连字符。

核销前检查：
- 卡密存在；
- 未人工停用；
- 未激活/未使用；
- status 为 normal；
- expires_at 晚于服务器当前时间。

成功后写入：
- `app_cards` 状态改为 used，写入 activated_at / used_at；
- 新建 `app_entitlements`，包含 id、admin_user_id、device_id、card_id、starts_at、expires_at、purge_at、status；
- 写入 `app_free_grants(device_id, admin_user_id)`；
- 另写 `app_card_events`（该事件写入错误有 catch 忽略风险，见第二十批）。

成功响应静态可见字段：
- `data.entitlement`：授权行中的 id、expires_at、purge_at、status；
- `data.admin_user_id`；
- `data.token`：服务端生成的 entitlement HMAC Token；
- `data.days`；
- `data.local_retention_hours`；
- `data.note`：提示到期停止更新、本地节点保留 24 小时。

兼容风险：
- 这是一次性核销响应，客户端必须安全保存 Token；不能只保存 device_id。
- Token 生成与 entitlementId、deviceId 绑定；设备换绑后旧 Token 应失效，但当前换绑流程及旧设备清理仍有前序审计缺口。
- 客户端不得把 Token 写入 URL、普通日志或崩溃报告。
- 请求重复提交应明确返回 CARD_USED 等稳定错误码；客户端不能将超时后重试理解为一定未核销，必须支持通过可靠状态恢复授权。

### 2.5 状态：GET /api/app/status

静态确认请求：
- query `device_id`，长度/字符集校验 8-80 位。

静态确认响应：
- `data` 包含查询到的 entitlement 行字段 id、expires_at、purge_at、status；
- `active` 根据该设备是否存在任一 active 且未到期 entitlement 计算。

风险：
- 当前实现按 device_id 查询最近创建的一条 entitlement 作为返回主体，同时 active 子查询检查该设备是否存在任一有效 entitlement；当同设备有多个管理员授权时，返回主体与 active 可能不属于同一授权实例。
- 当前 status 路由没有验证 entitlement Token。device_id 不是秘密，也不是可信设备身份证明。
- 建议状态查询要求 entitlement Token 或其他服务端签发的可信凭证，并按 entitlement_id 精确返回授权状态；多管理员授权逐个返回，不能合并权限。

### 2.6 节点：GET /api/app/nodes

静态确认请求：
- query `device_id`；
- query `token`。

静态确认流程：
- 按 device_id 查询一条 active 且未过期 entitlement；
- 使用 entitlement id、device_id 验证 HMAC Token；
- 查询来源 ownership、已启用来源、已启用节点，并排除存在非 approved 审核状态的来源；
- 当前查询没有按设备获准 APP 分组的 app_group_sources / app_group_members 做严格过滤（第二十、二十二批已登记 P0）。

静态确认响应：
- `data.expires_at`；
- `data.purge_at` 当前固定返回 null；
- `data.groups[]`，每组含 name、locked、nodes；
- 节点字段 id、name、protocol、server、port、uri、tier；
- `data.total_nodes`。

风险：
- Token 作为 query 参数会进入部分代理、日志、历史记录系统，存在泄漏面。
- 设备可能得到超出实际授权 APP 分组的来源节点。
- `purge_at:null` 与“到期后本地保留 24 小时”的说明不构成撤销 generation/清理 ACK 协议。
- 查询只选最近一条 entitlement，无法表达同设备多个管理员授权实例的独立数据范围。

### 2.7 分组：GET /api/app/groups

- 路由：公开分派到 `appGroupsForDevice`。
- 先前第二十、二十二批已确认：在没有有效 entitlement 时，部分查询路径仍可能仅凭客户端 device_id 读取 app_free_grants。
- 本批不把该接口视为可信身份认证完成。
- 完整 query/response 字段需结合该函数体和 APK 调用核对。

### 2.8 免费分组：GET /api/app/free

- 路由：公开分派到 `appFreeGroupRoute`。
- 先前第二十、二十二批已确认：管理员 ID 或分享编号可成为查询入口，缺少 APP 用户身份 ID/可信设备授权凭证闭环。
- 用户已确认业务规则：APP 用户通过管理员身份 ID 获取免费分组；但“业务身份 ID”不能直接等同于可信身份认证。接口必须验证 APP 用户身份/授权证明。
- 普通网页分享链接不能替代 APP 专用分享链接。

### 2.9 链接：GET /api/app/links

- 路由：公开分派到 `appLinksForDevice`。
- 本批只确认路由分派，不推断其具体授权范围已经安全。
- 需逐函数核实 Token、device_id、管理员范围、账号停用、VIP 状态、链接 enabled 和到期策略。

## 3. 管理后台 HTML 调用方式

归档 HTML 的通用管理 API 函数：
- 要求本地已有 token；
- 使用 `Authorization: Bearer <token>`；
- JSON body 时设置 `content-type: application/json`；
- `cache: no-store`；
- `redirect: error`；
- 收到 401 时清空内存 token 并提示重新登录；
- 其他非成功响应按 JSON error 或 HTTP 状态抛错。

登录调用：
- `POST /api/auth/login`；
- JSON 字段 username、password；
- 成功读取 `data.token`，随后调用 `/api/auth/me`。

注册调用：
- `POST /api/auth/register`；
- JSON 字段 username、password；
- 注册成功后尝试登录。
- HTML 注册成功提示“已获得 7 天体验”，但此前第十九批已核实 Worker grantTrial 失败可能被 catch 忽略，响应/提示与真实赠送结果存在不一致风险。

后台数据库按钮：
- 先 GET `/api/super/schema-status`；
- 若 ready=true，直接提示无需操作；
- 若 ready=false，POST `/api/super/migrate`，JSON `{confirm:"yes"}`；
- 仅根据响应 ready/done/skipped/errors 显示结果。
- 第八、九批已确认 ready 判定过弱，不能作为真实 schema 完整性证明。

**重要环境风险：** 归档 HTML 的公开转换区域仍有 staging Worker 默认地址回退逻辑；登录后台 API 与公开转换 API 的 base 选择逻辑也需分别审查。不得把 HTML 当前默认地址当成生产环境配置。相关风险已在第六批报告登记。

## 4. 当前契约差异清单

| 编号 | 等级 | 契约问题 | 影响 |
|---|---|---|---|
| API25-01 | P0 | nodes Token 通过后仍未按设备获准 APP 分组严格过滤 | 授权范围扩大，跨分组节点暴露 |
| API25-02 | P0 | free/groups 等路径缺可信 APP 用户身份/设备授权凭证闭环 | 仅凭可猜参数读取免费授权内容 |
| API25-03 | P1 | status 仅凭 device_id 查询且未要求 Token | 设备标识被误当作身份凭证 |
| API25-04 | P1 | 同设备多 entitlement 时 status/nodes 只取最近一条 | 授权状态错配，客户端无法表达多管理员独立授权 |
| API25-05 | P1 | nodes Token 放在 URL query | Token 可能进入代理/访问日志 |
| API25-06 | P1 | nodes 响应 purge_at 固定 null | 客户端无法获得可信清理时间/撤销版本 |
| API25-07 | P1 | release 元数据缺 APK 哈希/签名校验闭环 | 下载包完整性与来源真实性不足 |
| API25-08 | P1 | resolve 公开响应需进一步最小化管理员内部信息 | 暴露不必要的管理员标识信息 |
| API25-09 | P1 | APP links/groups/free 的认证、授权和账号状态策略不统一 | 不同入口产生权限旁路 |
| API25-10 | P2 | 核销成功响应给 Token，但客户端安全持久化/恢复协议未证实 | 网络超时、重装、换机后可能出现授权恢复问题 |
| API25-11 | P2 | 注册成功 UI 宣称赠送体验 VIP，但赠送失败可能被吞 | 用户看到的权益与实际状态不一致 |
| API25-12 | P2 | 后台 schema ready 仅按表名判定 | 页面可能误报数据库已就绪 |

P0/P1 分级是静态风险评估；与第二十至二十三批重复的发现作为跨批次确认，不重复计数为新事件。

## 5. 建议冻结的下一版 API 契约

以下是设计建议，不能宣称已实现。需先取得 APK 源码或可验证的客户端协议资料，再冻结版本。

### 5.1 统一响应 envelope

建议所有 APP API 统一：
- `ok`：布尔；
- `data`：成功数据；
- `error.code`：稳定机器错误码；
- `error.message`：不含敏感数据的用户提示；
- `request_id`：可用于客服排障的请求标识；
- `server_time`：服务端时间；
- `api_version`：协议版本。

不能在新版本中直接改变旧响应字段类型/层级。先新增版本化接口或可选字段，再逐步迁移客户端。

### 5.2 认证与授权

- 核销仍使用一次性卡密 + device registration 流程，但应原子化并有幂等请求标识。
- 后续 status/groups/nodes/free/links 必须使用可信授权凭证，不接受裸 device_id 作为授权证明。
- Token 放 Authorization Header，不放 URL query。
- Token 绑定 entitlement_id、设备绑定版本和服务端签发版本；换绑后旧版本立即撤销。
- 多管理员授权按 entitlement 分开返回；客户端可以并列展示，不把不同管理员来源集合并成一个扩大权限的集合。
- 管理员账号停用、VIP 到期、已激活卡密继续有效、卡密自身到期等状态按已确认业务规则分别处理，不得合并成单一 enabled 布尔值。

### 5.3 节点和分组响应

建议每个授权实例响应：
- entitlement_id、admin_user_id（对客户端可用匿名化显示标识，避免暴露内部账号字段）；
- group_id、group_generation；
- nodes[] 与稳定 node_id；
- node_version / content_hash；
- revoked_generation / tombstone；
- server_time、expires_at、purge_after；
- delta_cursor；
- cleanup acknowledgement 所需 generation。

只有用户获准的 APP 专用分组成员及其来源节点可以下发。每条数据都由服务端重新验证管理员归属、分组状态、来源审批/启用、节点启用/撤销状态。

### 5.4 发布下载完整性

版本响应应包含：
- version_code、version_name、min_supported_version；
- HTTPS download URL；
- SHA-256；
- 签名证书摘要或可信签名验证信息；
- force_update、release notes；
- 发布时间与服务端时间。

客户端下载安装前校验哈希及签名；失败不得安装。服务端发布也应验证上传 APK 的包名、签名证书和版本号一致性。

## 6. 兼容策略与禁止事项

1. 不得直接删除旧字段或改变 JSON 类型。
2. 新协议优先通过新增字段或明确的 API version 兼容。
3. 旧 APK 未支持 generation/ACK 时，不启用会导致旧客户端误清理或权限扩大/缩小不透明的强制迁移。
4. 对不支持可信 Token 的旧接口，采用明确的 sunset/兼容窗口策略；安全风险严重时可以拒绝不安全请求，但需提前准备客户端升级路径。
5. 不能把 device_id、管理员 ID、分享码当作认证凭证。
6. 不得把 HMAC Token、卡密、订阅 URL 写入公开日志或 query。
7. 不得将 API 文档中建议字段误写成当前线上已支持字段。
8. APK ZIP 未解包前，所有“APK 已支持/已调用/已缓存/已 ACK”均属于未证实结论。

## 7. 待执行测试矩阵

| Test ID | 场景 | 预期 |
|---|---|---|
| API25-T01 | 缺失/伪造/过期 Token 请求 nodes | 401/403，绝不返回节点 |
| API25-T02 | 裸 device_id 请求 status/groups/free/links | 不泄露授权信息或节点 |
| API25-T03 | 同设备拥有多个管理员 entitlement | 分实例返回，权限范围不合并 |
| API25-T04 | 管理员账号 disabled/locked 后尝试新核销 | 按已确认规则拒绝新授权 |
| API25-T05 | 管理员 VIP 到期但 entitlement 已激活 | 不错误撤销既有有效 entitlement |
| API25-T06 | 卡密自身 expires_at 到期 | 拒绝核销/停止授权下发 |
| API25-T07 | APP 分组来源移除 | 产生撤销 generation，客户端清理并 ACK |
| API25-T08 | Token 通过但设备未获准某 APP 分组 | 不返回该分组节点 |
| API25-T09 | URL query 中传 Token | 新协议不接受，Header 正常 |
| API25-T10 | 核销请求超时后使用同幂等键重试 | 不重复消费卡密，不产生双 entitlement |
| API25-T11 | 下载包哈希不一致/签名不匹配 | 客户端拒绝安装 |
| API25-T12 | 旧 APK 使用旧协议 | 兼容窗口内行为明确，退出后给出升级错误码 |
| API25-T13 | server_time 与设备时间偏差 | 期限判断以服务端时间为准 |
| API25-T14 | API 返回未知新增字段 | 旧客户端忽略未知字段，不崩溃 |
| API25-T15 | API 缺少必需字段/字段类型变化 | 客户端安全失败并上报 request_id |

以上均为待执行，不标记通过。

## 8. 数据库、回滚和部署影响

- 本批不执行 SQL，不修改 D1。
- 后续可能需要授权设备绑定版本、API 请求幂等记录、节点 generation、撤销事件、APK cleanup ACK、release hash/signature metadata 等结构；真实 schema 未核验前不写迁移 SQL。
- 旧 Worker/旧 APK 兼容必须通过隔离环境验证；新增字段应先向后兼容。
- 回滚旧 Worker 时保留新字段/新表，不物理删除数据；旧客户端不应因回滚而获得已撤销授权。
- 不部署任何协议变更，直到 APK 源码审计、API 集成测试、D1 schema 只读核验及回滚演练完成。

## 9. 验证状态

| 项目 | 状态 |
|---|---|
| AGENTS.md | 已读取 |
| 功能基线/权限契约 | 已读取相关部分 |
| Worker APP 路由 | 已静态盘点 |
| 核销、status、nodes 请求/响应字段 | 已静态核对关键代码 |
| version/download/resolve 完整字段 | 待逐函数展开 |
| groups/free/links 完整字段 | 待逐函数展开 |
| HTML 管理 API 通用调用方式 | 已静态核对 |
| HTML 是否等同 APK 客户端 | 否 |
| APK 源码 ZIP | 未解包，客户端契约阻塞 |
| 生产 D1 schema | 未核实 |
| 当前 Cloudflare 线上 Worker | 未核实 |
| API/D1/设备集成测试 | 未执行 |
| 业务代码/D1/Secrets/部署 | 未修改、未操作 |

## 10. 下一批建议

第二十六批建议继续完成 APP API 其余三个处理函数的逐字段核查（version/download/resolve/groups/free/links），并整理一份“服务端 API 契约字段字典 V2 草案”。在 APK ZIP 无法读取的情况下，继续严格区分 Worker 已实现字段与客户端待证实字段。

---
**结论：第二十五批完成的是 API 路由与关键字段静态盘点，不代表客户端兼容已验证，不代表安全问题已修复，不可上传部署。**
