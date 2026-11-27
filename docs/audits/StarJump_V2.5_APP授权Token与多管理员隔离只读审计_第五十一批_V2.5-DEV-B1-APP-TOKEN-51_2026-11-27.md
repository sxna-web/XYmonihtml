# 星跃管理平台 V2.5｜APP 授权 Token 与多管理员隔离只读审计

- 批次：第五十一批
- 版本：`V2.5-DEV-B1-APP-TOKEN-51`
- 日期：2026-11-27
- 状态：**静态源码审计完成；测试设计完成；未修改业务代码；不可部署**
- 仓库：`sxna-web/XYmonihtml` / `main`
- 核查 Worker：`backend/worker/V2.5-DEV-B1-CORE-AUTH-49/Worker.js`
- Worker Blob SHA：`a4689380215e95c1c9f605fc974cc553b3e7037f`
- 参照回归：第五十批 APP links/cards handler 测试报告
- 原始基线保护：原始 Worker、原始 HTML 均未修改

## 1. 本批范围与限制

本批按第五十批接手卡，对 APP entitlement Token、status/nodes/groups/free/links、device_id、query Token、多管理员授权选择路径做只读追踪，并形成后续 Handler/协议测试矩阵。

本批没有 APK ZIP 的可解包源码或设备抓包证据。因此：
- 不能确认 APK 当前是否保存多份 Token、是否逐管理员调用、是否读取 Authorization Header；
- 不能确认设备 ID 的生成/持久化是否绑定 Android Keystore；
- 不能确认 APK 的状态恢复、换机、缓存撤销和本地清理行为；
- 不得据此擅自改变旧 APK 请求协议。

未访问线上 Worker、生产 D1 或 Cloudflare；未修改 Worker、HTML、D1、Secrets、Cron；未执行迁移或部署。

## 2. 核查基线

| 对象 | 结果 |
|---|---|
| 当前 main Worker 副本 | 第四十九批版本，SHA `a4689380215e95c1c9f605fc974cc553b3e7037f` |
| 第五十批测试 | GitHub Actions Run `45954510215`，结论 success |
| 第五十批覆盖 | Worker.fetch + mock D1 的 links/cards handler 测试 12/12；第四十九批 adapter 12/12、group handler 12/12 |
| 原始 Worker | Blob SHA `5da7aa3582558d9da2c2a0ad25a63c5e95e9fe63`，未改 |
| 原始 HTML | Blob SHA `ab98aecd4c8546eda197bbb4d5a9f5ec0db82613`，未改 |
| APK 源码 | ZIP 尚未解包核验；客户端协议仍是 APK_PENDING |
| 生产 D1 | 未访问；真实 schema 未核实 |

第五十批 CI 链接：<https://github.com/sxna-web/XYmonihtml/actions/runs/45954510215>

## 3. Token 生成与校验现状

第四十九批 Worker 的静态代码显示：
1. `entToken(env, entitlementId, deviceId)` 使用 HMAC-SHA256，输入为 `entitlementId|deviceId`。
2. HMAC 密钥当前读取 `env.SESSION_PEPPER || "starjump-app"`，存在固定字符串回退。
3. 核销成功响应返回 `data.token`，并返回 entitlement id、admin_user_id、expires_at/purge_at/status 等字段。
4. `verifyEntToken` 计算期望值并做 timing-safe 比较。
5. nodes、groups、links 从 URL query 读取 `device_id` 和 `token`；未发现这些读取路径优先验证 Authorization Bearer 的实现。
6. status 只读取 `device_id`，没有调用 `verifyEntToken`。

**结论：** Token 是服务端 HMAC 凭证，但目前密钥回退削弱了部署隔离；Token 放在 URL 中有日志/代理/历史记录暴露风险；status 没有凭证验证。device_id 只是客户端提交的字符串，格式检查不等于可信设备证明。

## 4. 各 APP 读取接口的认证差异

| 接口 | 当前静态行为 | 主要问题 |
|---|---|---|
| `POST /api/app/redeem` | 卡密 + device_id 核销；成功返回 entitlement Token | device_id 由客户端提交；Token 密钥有固定回退；核销事件写入失败曾被 catch 忽略 |
| `GET /api/app/status` | 仅按 device_id 查询最近一条授权；active 子查询判断设备是否存在任一有效授权 | 无 Token；返回的主体授权与 active 布尔值可能不属于同一条授权 |
| `GET /api/app/nodes` | 按 device_id 取最近一条有效 entitlement，再校验 query Token | 多授权时只选最新一条；旧授权 Token 可能无法命中；节点查询范围是该管理员全部 enabled/approved source，而不是 APP 分组实际授权范围 |
| `GET /api/app/groups` | 先按 device_id 取最近一条有效 entitlement，再校验 query Token；无有效 entitlement 时按 device_id 查 app_free_grants | 免费 grant 分支无 Token；多授权仅按最新授权；免费 grant 可由可猜 device_id 触发 |
| `GET /api/app/free` | 通过 admin ID 或 share code 查询管理员开放的免费节点 | 不验证 APP 用户身份、设备凭证或 entitlement Token |
| `GET /api/app/links` | 按 device_id 取最近一条有效 entitlement，再校验 query Token | 多授权只选最新一条；Token 位于 URL query |

以上均为仓库第四十九批 Worker 的静态观察，不代表线上运行状态。

## 5. 多管理员授权的实际语义

核销流程为每张 APP 卡密创建独立 `app_entitlements`，记录管理员、设备和有效期，并返回与 entitlement ID + device_id 绑定的 Token。

但 nodes、groups、links 查询采用：
`WHERE device_id = ? AND status = 'active' AND expires_at > now ORDER BY created_at DESC LIMIT 1`

因此，当前接口不是“同一设备全部授权合并”，而是“先选最新一条，再校验该条 Token”。当同设备有多个管理员授权时：
- 只持有较早授权 Token 的客户端请求，可能因服务端先选中较新授权而被拒绝；
- 客户端无法从这些接口一次取得完整授权清单；
- 即使客户端逐管理员保存 Token，服务端当前 latest-only 选择仍会遮蔽较早授权；
- 不应通过简单合并所有管理员来源来修复，否则可能扩大授权范围。

**应保持的目标原则：** 每份 entitlement 独立认证、独立授权、独立到期和撤销；数据以 entitlement_id + admin_user_id 分区。APP 可以并列展示多个管理员授权，但不能把管理员 A 的 Token 用来读取管理员 B 的数据。

## 6. 免费授权与设备身份风险

已核实的路径：
- `app_free_grants` 在卡密核销时写入 device_id 与 admin_user_id。
- `/api/app/groups` 没有有效 entitlement 时，按 device_id 读取 grant 并返回管理员 free 分组，没有再验证 Token。
- `/api/app/free` 可按 admin 参数或 share code 直接读取 free tier 节点，不要求设备凭证。
- share code 是管理员绑定/分享入口标识，不应被当作 APP 用户身份凭证。
- device_id 的格式验证不能证明请求来自原设备；若 device_id 和 Token 一起被复制，当前服务端无法证明真实设备持有者。

免费分组业务规则本身仍保留：APP 用户可通过管理员身份 ID 获取免费节点；但应增加可信 APP 用户/设备身份验证，不能把管理员公开编号或 device_id 直接作为认证凭证。

## 7. 风险清单与优先级

| ID | 级别 | 风险 | 建议修复方向 |
|---|---|---|---|
| APP51-01 | P0 | status 仅凭 device_id 返回授权信息 | status 必须验证可信凭证；明确按 entitlement 返回或返回设备授权摘要 |
| APP51-02 | P0 | groups 无有效 entitlement 时仅凭 device_id 读取历史 free grant | free grant 读取纳入统一可信设备凭证验证 |
| APP51-03 | P0 | /free 仅凭管理员 ID/share code 返回节点 | 保留公开绑定入口与节点数据读取的边界；节点内容读取必须验证 APP 用户身份 |
| APP51-04 | P0 | Token HMAC Secret 缺失时回退固定字符串 | 新写入与新验证必须 fail closed；旧 Token 迁移/兼容需先设计，不能突然令所有旧 APP 掉线 |
| APP51-05 | P1 | latest-only entitlement 查询遮蔽较早授权 | 按明确 entitlement_id 选择并逐条验证，禁止隐式 LIMIT 1 |
| APP51-06 | P1 | Token 通过 URL query 传递 | 目标迁移到 Authorization Header；需 APK 源码/版本确认后设有限兼容窗口 |
| APP51-07 | P1 | device_id 是客户端自报标识，不是设备证明 | 先审计 APK；再评估安装密钥/公钥挑战应答与撤销版本 |
| APP51-08 | P0 | nodes 未按 APP 分组授权范围过滤 | 作为节点下发安全边界单独修复；只能下发当前 entitlement 可见组内节点 |
| APP51-09 | P1 | status 的返回主体和 active 汇总可能错配 | 定义每 entitlement 状态，避免混合不同授权记录 |
| APP51-10 | P1 | 设备换绑、解绑、旧 Token 撤销闭环未证实 | 核查并设计设备生命周期；不能只更新 device_id 而保留旧设备其他 grant |

P0/P1 是静态风险等级，不表示线上已发生利用或数据泄漏。

## 8. 兼容性约束

1. 不得在未检查 APK 的情况下直接把 query Token 改成 Header 并移除旧参数。
2. 不得把 status 从单条响应改为数组，除非先做版本化协议或新增可选字段并验证旧客户端解析。
3. 不得把多个管理员授权的节点简单拼成一个无管理员命名空间的列表。
4. 不得将 share code、admin_user_id 或 device_id 作为认证凭证。
5. 不得让已激活 APP 卡密因管理员 VIP 到期而失效；APP entitlement 生命周期与后台 VIP 管理权限分开。
6. 不得把 APP 分组 24 小时本地清理保留期误作设备撤销的宽限期；设备撤销与到期清理是不同事件。
7. 不得因修复 APP 认证而破坏公开版本检查/下载等真正公开的发布接口。

## 9. 第五十二批测试设计

下一批优先建立隔离的 APP entitlement resolver/handler 测试，不连接生产 D1，不改 APK 协议：

- 单授权：有效 Token 成功；缺失/错误 Token 拒绝。
- 多授权：较早授权 Token、较新授权 Token 均能分别命中各自 entitlement。
- 错配：A Token + B entitlement/device 拒绝。
- 状态：过期、撤销、设备不匹配、entitlement 查询异常均 fail closed。
- free grant：只知道 device_id 或 share code 不足以读取节点；合法 APP 用户凭证只返回其绑定管理员免费组。
- status：不得无 Token 暴露授权详情；多授权状态按 entitlement 隔离。
- links：每个 entitlement 只返回对应 admin_user_id 的 links。
- nodes/groups：每个 entitlement 只返回其管理员且在分组成员/来源范围内的节点。
- Secret：缺少 APP HMAC Secret 时拒绝新核销/验证；兼容策略先用测试专用 Secret 验证，不触碰生产 Secret。
- 每个拒绝用例断言未发生未授权业务数据写入。
- 若没有 APK 源码，query Token→Header 迁移保持设计状态，不宣称客户端兼容。

## 10. 回滚与生产保护

本批仅新增审计文档。没有业务代码改动，无需回滚 Worker；文档可通过 Git commit 历史回退。

- D1 schema/data：无影响，未访问。
- Worker/HTML：未修改。
- Secrets/环境变量：未读取、未修改。
- APK：未解包、未修改。
- Cloudflare：未访问、未部署。

## 11. 下一批唯一接手卡

**第五十二批：隔离 APP entitlement 精确选择与多授权 Handler 测试基础。**

1. 重新读取 AGENTS、功能基线、总方案、进度、本报告和第四十九/五十批代码。
2. 继续使用版本化 Worker 副本，不覆盖原始 Worker 或第四十九/五十批目录。
3. 优先建立 exact entitlement resolver：明确 entitlement_id + device_id + Token，校验状态、有效期和管理员归属；不再隐式取最新一条。
4. 用 Worker.fetch + mock D1 测试同设备两管理员两份授权，分别请求均只能取得自己的数据。
5. 补 status、groups、links、nodes 的 handler 测试；特别覆盖 status 缺 Token、free grant device_id 旁路、share code 直接取节点等拒绝分支。
6. 不擅自更改 APK 请求协议；query Token→Header 暂列待 APK 源码确认。
7. APP HMAC Secret 固定回退的处理先提供 fail-closed 兼容设计与测试，不得未经迁移方案直接令旧 Token 全失效。
8. 节点下发必须按 APP 分组实际授权范围过滤；与 entitlement 精确选择分开测试，避免扩大权限。
9. 不改 D1 schema、不调用生产 API、不操作 Secrets、不部署。
10. 完成后更新报告、开发进度、总方案与第五十三批接手卡。

