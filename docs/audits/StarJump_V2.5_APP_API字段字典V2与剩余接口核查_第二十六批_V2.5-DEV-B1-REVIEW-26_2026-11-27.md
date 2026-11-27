# 星跃管理平台 V2.5：APP API 字段字典 V2 与剩余接口核查

- **批次**：第二十六批
- **版本标识**：V2.5-DEV-B1-REVIEW-26
- **日期**：2026-11-27
- **状态**：DEV 静态源码审计/契约草案；不可部署
- **仓库**：`sxna-web/XYmonihtml`，`main`
- **Worker 基线**：`原始StarJump_V1点0_Final-zip-26-11-25-14:56/Worker.js`
- **Worker Blob**：`5da7aa3582558d9da2c2a0ad25a63c5e95e9fe63`
- **HTML 基线**：同归档目录 `index.html`
- **依据**：`AGENTS.md`、V2.5 功能基线、API 权限契约、第二十五批报告、归档 Worker
- **范围**：补全 version/download/resolve/groups/free/links 的字段盘点；形成当前实现字段与目标字段分离的 V2 字典
- **限制**：静态源码阅读；未解包 APK ZIP，未调用线上 API，未读取生产 D1，未修改 Worker、HTML、D1、Secrets、Cron 或 Cloudflare 部署。

## 1. 本批结论

本批完成了上一批未展开的六个 handler 逐段静态核对，并形成 APP API 字段字典草案。

关键结论：
1. `GET /api/app/version` 的真实响应字段为 update、force、version_code、version_name、url、notes、min_version_code；无可用版本时只返回 update=false。
2. `GET /api/app/download` 以 admin 或 code 查询参数确定管理员，再返回该管理员和全局可用下载链接数组；响应字段来自 listDownloads：id、scope、title、url、sort。
3. `GET /api/app/resolve` 以 code 解析管理员，响应包含 code、admin_user_id、admin_name、free_group_enabled；管理员内部 ID/用户名被公开返回。
4. `GET /api/app/groups` 先找设备最近的一条 entitlement；没有有效 entitlement 时，裸 device_id 仍可查询历史 app_free_grants 并返回免费分组；有 entitlement 时要求 token。
5. `GET /api/app/free` 允许通过 admin 或 code 指定管理员，不要求 APP entitlement Token 或用户身份凭证；只检查管理员是否开启免费分组，再查询其免费 tier 节点。
6. `GET /api/app/links` 要求 device_id + token，但 Token 通过 URL query 传递；按设备最近的一条 entitlement 确定管理员链接。
7. 这些字段只证明当前归档 Worker 的服务端实现，不证明 APK 实际使用、保存、解析或兼容这些字段。

## 2. 当前实现字段字典（AS-IS）

### 2.1 GET /api/app/version

**请求 query**
| 字段 | 类型/规则 | 默认值 | 说明 |
|---|---|---|---|
| platform | string，最多 20 字符 | android | 传给 releases 平台筛选 |
| current | 数字解析 | 0 | 当前 version_code；无效值按 0 处理 |

**成功响应**
`{ ok: true, data: {...} }`

| data 字段 | 类型 | 出现条件/语义 |
|---|---|---|
| update | boolean | 无 active release 时 false；否则 current < latest.version_code |
| force | boolean | 有版本时为 update 且（release.force=1 或 current < min_version_code） |
| version_code | number | 最新 active release 版本码 |
| version_name | string | 最新版本名称 |
| url | string | 发布下载 URL |
| notes | string | 发布说明 |
| min_version_code | number | 最低版本码 |

**当前行为注意**
- 无发布记录时只返回 `data.update=false`，其余版本字段缺失。
- current 无效时默认为 0，可能把参数错误解释成非常旧的客户端。
- 仅按 version_code 比较；未见 APK 哈希、签名摘要、包名或证书校验字段。
- `force` 的计算是 update 为 true 时才可能 true；客户端已高于最新版本时 force=false。
- 平台参数未见本 handler 内严格 allowlist，只进行长度截断；需确认 releases.platform 的合法值。

### 2.2 GET /api/app/download

**请求 query**
| 字段 | 类型/规则 | 默认值 | 说明 |
|---|---|---|---|
| admin | string，最多 80 字符 | 空 | 直接指定管理员 ID |
| code | string，最多 12 字符，转大写 | 空 | 若未提供 admin，则查 admin_share_codes |

**解析优先级**
1. admin 非空时直接作为 resolved adminId；
2. 否则 code 非空时查 admin_share_codes；
3. 两者都为空则 resolved 为空，只返回全局 scope 下载入口。

**成功响应**
`{ ok: true, data: list }`

每项字段：
- id
- scope（global/admin）
- title
- url
- sort

数据筛选：
- enabled=1；
- scope=global，或 scope=admin 且 admin_user_id 等于 resolved；
- admin scope 排在 global 前面。

**风险/注意**
- 公开接口允许直接传 admin 内部 ID；code 不存在返回 404。
- URL 查询参数是普通下载入口，不是身份认证。
- listDownloads 没有在该路径内过滤管理员账号 status 或 VIP 状态；需明确公开下载入口是否应在管理员停用时继续展示。
- 下载入口 url 允许 HTTP 或 HTTPS（validDownloadUrl）；与发布 APK 的 releases URL 校验规则不同。不得混淆两类 URL。
- 用户已确认的“管理员购卡入口 VIP 到期三天后切换公共百度链接”不能未经业务区分直接套用到普通 APP 下载入口。

### 2.3 GET /api/app/resolve

**请求 query**
| 字段 | 类型/规则 | 说明 |
|---|---|---|
| code | string，转大写，正则 A-Z/0-9，4-12 位 | 管理员分享编号 |

**成功响应**
`{ ok: true, data: {...} }`

| data 字段 | 类型 | 说明 |
|---|---|---|
| code | string | 标准化后的编号 |
| admin_user_id | string | 管理员内部 ID |
| admin_name | string/null | app_users.username |
| free_group_enabled | boolean | admin_app_perms.free_group_enabled 是否为 1 |

**错误**
- 格式错误：400；
- 编号不存在：404。

**风险/注意**
- 公开返回管理员内部 ID 与用户名，违反最小公开字段建议。
- 只查询分享码与权限开关，未在该 handler 内检查管理员账号 active/disabled/locked。
- 此解析结果不能作为可信用户身份或 APP 授权凭证。
- code 是分享/发现标识，不是秘密 Token；不能因解析成功就允许调用管理接口。

### 2.4 GET /api/app/groups

**请求 query**
| 字段 | 类型/规则 | 说明 |
|---|---|---|
| device_id | string，8-80 位 A-Z/a-z/0-9/_/- | 设备标识 |
| token | string，最多 200 字符 | entitlement HMAC Token |

**有有效 entitlement**
- 通过 device_id 查找 active 且 expires_at > 当前时间的最近一条 entitlement；
- 验证 verifyEntToken(env, entitlement.id, device_id, token)；
- 返回 `data.entitled=true`、`data.admin_user_id`、`data.groups[]`。

每个 group：
- id
- name
- mode
- locked=true
- nodes：groupNodeList 的行，字段 source_name、id、name、protocol、server、port、uri、tier。

可见组范围：
- enabled=1；
- public/free 模式；
- assigned 模式且 app_group_members 存在对应 device_id；
- 组节点来自 app_group_sources，并过滤 source.enabled、node.enabled 及非 approved source_approvals。

**没有有效 entitlement**
- 仅凭 device_id 查询 app_free_grants；
- 每个 grant 对应管理员的 enabled free 分组；
- 返回 `data.entitled=false`、`data.groups[]`；
- 免费组字段含 id、name、mode、locked=true、free=true、nodes。

**风险/注意**
- free grant 分支没有验证 Token、APP 用户身份或可信设备证明；device_id 可伪造。
- 只取最近一条 entitlement，无法表达多管理员授权。
- assigned 成员关系只按 device_id，不能单独证明设备真实身份。
- groupNodeList 按来源和节点状态过滤，但不能替代 entitlement 的分组/来源授权检查。
- 分组删除/来源移除没有撤销 generation/ACK 机制，前序批次已登记。

### 2.5 GET /api/app/free

**请求 query**
| 字段 | 类型/规则 | 说明 |
|---|---|---|
| admin | string，最多 80 字符 | 管理员 ID |
| code | string，最多 12 字符，转大写 | 管理员分享编号；admin 优先 |

**成功响应**
`{ ok: true, data: { free: true, groups: [...] } }`

每个 group：
- name
- locked=true
- nodes[]

每个 node：
- id
- name
- protocol
- server
- port
- uri

查询条件：
- source_ownership.user_id = adminId；
- subscription_sources.enabled=1；
- node_records.enabled=1；
- node_records.tier='free'；
- 来源没有非 approved source_approvals；
- 最多 500 行。

**风险/注意**
- 不要求 Token、device_id、APP 用户身份 ID 或其他授权凭证。
- 只验证 adminId 格式及 adminPerms.free_group_enabled。
- 响应包含节点 uri，属于敏感订阅节点连接信息，应由可信 APP 授权边界保护。
- 管理员身份 ID 或分享编号只能定位管理员，不应作为认证凭证。
- 业务基线要求 APP 用户通过管理员身份 ID 获取免费分组，但这项业务入口要求不能替代服务端身份认证和授权校验。

### 2.6 GET /api/app/links

**请求 query**
| 字段 | 类型/规则 | 说明 |
|---|---|---|
| device_id | string，8-80 位 A-Z/a-z/0-9/_/- | 设备标识 |
| token | string，最多 200 字符 | entitlement HMAC Token |

**成功响应**
- 若管理员 links_enabled=false：`data=[]`；
- 若启用但没有自定义链接：返回默认项 `{id:"default", title:"购买卡密", url:"", default:true}`；
- 否则每项字段 id、title、url。

**授权流程**
- 查设备最近一条 active 且未过期 entitlement；
- 验证 entitlement Token；
- 根据 entitlement.admin_user_id 查询 admin_app_perms；
- 读取该管理员 enabled 的 app_links。

**风险/注意**
- Token 在 URL query，存在访问日志、代理日志和历史记录泄漏风险。
- 多 entitlement 时只取最近一条，不能自动合并多管理员入口。
- 管理员账号停用与 VIP 到期规则需分别检查；不能把 VIP 到期等同账号停用。
- 返回的 url 是管理员设置的外部入口，客户端应采用安全打开策略，并对 HTTPS/跳转域名按策略约束。

## 3. 相关接口对照表

| 接口 | 公开/凭证 | 主要输入 | 主要输出 | 当前核心问题 |
|---|---|---|---|---|
| version | 公开 | platform,current | update,force,version_code,version_name,url,notes,min_version_code | 缺完整性元数据 |
| download | 公开 | admin 或 code | 下载入口数组 | 裸 admin ID 查询；HTTP 可用 |
| resolve | 公开 | code | admin_user_id,admin_name,free_group_enabled | 暴露内部 ID/用户名 |
| redeem | 卡密核销 | code,device_id | entitlement,token,days,local_retention_hours,note | 幂等/客户端安全保存未验证 |
| status | 仅 device_id | device_id | entitlement,active | 缺 Token |
| groups | entitlement Token；免费分支裸 device_id | device_id,token | groups,nodes | 免费分支旁路 |
| free | 公开 | admin 或 code | 免费节点列表 | 无可信用户身份/授权 |
| nodes | entitlement Token | device_id,token | groups,nodes,total_nodes | 未严格按授权 APP 分组过滤 |
| links | entitlement Token | device_id,token | app_links 数组 | Token query；只取最近 entitlement |

## 4. 当前实现 vs 目标契约（TO-BE）

以下为设计建议，不是已实现字段，不可当成当前 APK 可用接口。

### 4.1 通用 envelope

保持旧响应 `{ok:true,data:...}` 向后兼容，逐步增加：
- meta.request_id
- meta.server_time
- meta.api_version

错误响应逐步标准化：
- error.code：稳定机器码
- error.message：不含敏感数据
- meta.request_id
- meta.server_time

不得立即删除旧 error 文本字段或改变 data 层级/类型。

### 4.2 授权凭证

- Token 从 URL query 迁移到 Authorization Header。
- status/groups/free/nodes/links 使用可信 entitlement/APP user 凭证；不能只凭 device_id、admin ID、share code。
- 每个请求明确 entitlement_id，避免按设备“最近一条”隐式选择。
- 多管理员授权逐实例返回，保持各管理员资源隔离。
- 换绑后旧设备绑定版本立即失效；旧设备撤销 generation 需客户端确认。
- free grant 应绑定可信 APP 用户身份/设备授权凭证，不再裸 device_id 查询。

### 4.3 版本发布完整性

目标新增字段建议：
- sha256
- package_name
- signing_cert_sha256
- min_supported_version
- published_at
- release_channel
- api_compat_min/api_compat_max

客户端下载前验证 SHA-256 和签名证书。发布端校验上传 APK 的包名、签名证书、version_code 与后台登记一致。字段命名须在实际 APK 客户端与发布流程确定后冻结。

### 4.4 公开发现信息最小化

resolve 建议只返回必要的公开展示字段：
- code（或脱敏显示）
- admin_display_name（用户明确选择公开时）
- free_group_available

不向普通 APP 客户端返回内部 admin_user_id；客户端若需后续授权，应由服务端签发不可猜测、有限用途的 opaque binding ticket，且必须绑定有效期、用途和防重放信息。

### 4.5 APP 分组授权

- 每个 entitlement 返回其允许的 group_id 集合和 generation。
- nodes 只能查询该 entitlement 允许的分组及来源。
- free/public/assigned 的可见性规则应转为显式授权策略，不得依赖客户端 device_id 自报。
- 所有来源需验证管理员归属、审核状态、enabled、stale/revoked 状态。
- 分组/来源/节点变更写撤销事件，APK 增量同步并 ACK。

## 5. 与用户已确认业务规则的边界

1. APP 免费分组可通过管理员身份 ID 作为业务发现入口，但身份 ID 不能证明 APP 用户身份。
2. APP 卡密分组必须来自对应管理员为该卡密配置的专用 APP 分享分组；不能拿普通网页链接替代。
3. APP 对接与星链接仅注册用户可查看；只有有效 VIP 管理员可管理；非 VIP/过期管理员只读。
4. VIP 到期三天宽限只作用于管理员未激活 APP 卡密；已激活 entitlement 不因管理员 VIP 到期失效。
5. 管理员账号 disabled/locked 与 VIP 到期是不同状态。账号停用的具体历史 entitlement 读取策略须按第二十三批提出的状态机单独设计，不能误伤“仅 VIP 到期”时已激活授权的规则。
6. 管理员个人购卡入口到期切换公共百度链接，不应未经确认套用到 APP 下载入口。
7. 分组删除/改型后的 24 小时本地清理，必须依赖撤销事件、generation、APK ACK，不能用 purge_at 注释或数据库状态代替。

## 6. 测试矩阵（全部待执行）

| ID | 场景 | 预期 |
|---|---|---|
| API26-01 | version 无 active release | update=false，客户端可处理缺少版本字段 |
| API26-02 | current 缺失/非数字/负数 | 参数校验或有明确定义的默认行为，不误触发强制升级 |
| API26-03 | platform 未知值 | 明确拒绝或返回无版本，不泄漏其他平台版本 |
| API26-04 | download 仅传 admin | 按公开下载策略返回，不授予管理权限 |
| API26-05 | download 仅传 code | 仅解析允许公开的管理员入口 |
| API26-06 | resolve 使用有效 code | 只返回必要公开字段 |
| API26-07 | resolve 管理员 disabled/locked | 按状态策略停止新绑定/授权 |
| API26-08 | groups 无 entitlement，仅伪造 device_id | 不返回免费授权节点 |
| API26-09 | groups 多 entitlement | 按明确 entitlement_id 分实例返回 |
| API26-10 | free 裸 admin/code 请求 | 不返回受保护节点，除非通过设计的可信身份/授权流程 |
| API26-11 | links Token 放 query | 新协议拒绝 query Token，Authorization Header 正常 |
| API26-12 | links 多管理员授权 | 不自动合并不同管理员链接 |
| API26-13 | APP 下载包 hash 不匹配 | 客户端拒绝安装 |
| API26-14 | APK 签名证书不匹配 | 客户端拒绝安装 |
| API26-15 | 未授权来源/非 approved 来源 | 不得出现在 groups/nodes/free 响应 |
| API26-16 | 分组删除后客户端离线 | 重连先处理撤销 generation，不能复活旧节点 |
| API26-17 | 新增未知可选字段 | 旧客户端安全忽略 |
| API26-18 | 缺少必需字段或字段类型变化 | 客户端安全失败并返回 request_id |

未执行任何测试；表格是验收计划，不是通过记录。

## 7. 数据库影响、风险与回滚

可能的后续 D1 变化（本批没有执行）：
- releases 增加包完整性与签名元数据；
- APP binding ticket / entitlement 设备绑定版本；
- entitlement-group 关联与 group generation；
- free grant 可信身份绑定；
- revoke events、delta cursor、cleanup ACK；
- API 幂等记录与审计字段。

前置条件：
1. 先在后台做生产 D1 只读 schema 核验；
2. 逐表比对真实字段/索引/约束；
3. 给每个 migration 分配 ID、checksum、依赖和 dry-run；
4. 兼容旧 Worker/旧 APK；
5. 旧数据缺失的身份/版本信息保持 unknown，不伪造回填。

回滚：
- 保留新增表和字段，不在回滚时 DROP；
- 新旧 API 版本并行一段兼容窗口；
- 旧 APK 未支持新授权协议前，不直接切断旧客户端；
- 任何撤销事件保留追加式历史，不通过删除事件恢复授权；
- 不改写旧 release 记录或旧转换/节点历史。

## 8. 验证边界

| 项目 | 状态 |
|---|---|
| AGENTS.md | 已读取 |
| V2.5 功能基线 | 已读取 |
| API 权限契约 | 已读取 |
| 第二十五批报告 | 已读取 |
| Worker 六个 handler | 已静态展开核查 |
| 当前实现字段字典 | 已形成草案 |
| 目标字段是否已实现 | 否，属于设计建议 |
| APK ZIP 解包/客户端调用 | 未完成，阻塞 |
| 生产 D1 schema | 未核实 |
| 当前 Cloudflare 线上版本 | 未核实 |
| API/D1/APK 联调 | 未执行 |
| 业务代码/D1/Secrets/部署 | 未修改、未操作 |

## 9. 下一批建议

第二十七批建议转向“APP 发布与升级安全完整性链路”，核查 release 写入/删除、版本排序、强制升级、下载链接跳转和 APK 文件完整性验证，尤其检查删除最高版本后旧版本是否重新成为最新版本，以及后台是否存在发布前包名/签名校验。APK 客户端验证仍标记阻塞，不能假定客户端已做 SHA/签名校验。

---
**结论：第二十六批完成的是 Worker APP API 剩余 handler 字段静态核查及 V2 契约草案，不代表 APK 兼容已验证，不代表漏洞已修复，不可部署。**
