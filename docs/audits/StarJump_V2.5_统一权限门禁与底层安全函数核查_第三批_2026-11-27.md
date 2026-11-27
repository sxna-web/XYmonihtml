# 星跃管理平台 V2.5｜统一权限门禁与底层安全函数核查（第三批）

- 日期：2026-11-27
- 仓库：`sxna-web/XYmonihtml`
- 分支：`main`
- 核查基线：`原始StarJump_V1点0_Final-zip-26-11-25-14:56/Worker.js`
- 核查方式：只读静态源码检查；未运行 Worker、未连接 D1、未发送 API 请求。
- 状态：**已完成本批静态核查；不是修复、测试或部署证明。**

## 1. 核查范围

本批按仓库 `AGENTS.md`、V2.5《功能基线与权限验收规范》及 API 契约 V1，检查：

1. Session 解析、签发、哈希和失效处理；
2. `resolveOwnerKey` 与转换身份归属；
3. `applyNodeFilters` 的功能门禁；
4. APP entitlement Token、设备标识与授权读取；
5. `sealJson/openJson` 加密密钥、密文格式与版本；
6. `/api/user/*` 路由总门禁和各业务 handler 的 VIP 门禁；
7. `loadSourceForCtx/loadSubscriptionNode` 的资源归属验证；
8. 与 L0/L1/L2、体验/正式 VIP 规则的动作级差异。

## 2. 关键结论

**当前 Worker 具备统一的 Session 登录门禁和协助会话 scope 门禁，但没有统一的有效 VIP 动作门禁。** 多个应受有效 VIP 限制的 APP 管理操作，在路由层只检查“已登录 + 协助 scope”，handler 内未检查 VIP 有效期。

**APP entitlement Token 使用 SESSION_PEPPER，但缺失时回退到公开源码中的固定字符串 `starjump-app`。** 转换数据加密也存在固定密钥回退 `starjump-convert`。两处都不符合密钥缺失时 fail closed 的要求。

**转换 API 的身份解析异常/无效凭证可能降级匿名；无 guest key 时使用共享 `g:anonymous`。** 这会造成身份归属混淆和匿名数据隔离失效。

**APP 设备身份目前由客户端提交的 device_id 决定。** HMAC Token 能证明调用者持有对应 entitlement/device 组合的 token，但不能证明 device_id 对应真实、不可伪造的设备；并且 status 路由没有校验 Token。

**转换过滤、重命名功能没有有效登录/VIP 门禁。** 目前任意访问转换 POST 的调用者都可以提交 filters，过滤逻辑不核验等级。

## 3. 逐项源码核查

### 3.1 Session 解析与签发

源码位置：
- `resolveSession`：约第 213 行；
- `sessionTokenHash`：约第 203 行；
- 登录/签发逻辑：`routeAuth`，约第 400 行附近；
- 总路由入口：约第 5369 行以后。

已确认：
- Session Token 为 32 字节随机值，数据库存 SHA-256 哈希，不直接存明文 Token。
- Bearer Token 查找 `user_sessions`，检查撤销时间、用户存在、用户 active 状态和 expires_at。
- 协助会话要求超管角色、有效 scope 记录，且每次解析重新核验授权是否撤销/过期。
- `/api/user/*` 无有效 ctx 返回 401；旧 ADMIN_TOKEN 不能进入用户态 API。
- Session 解析数据库异常在 Worker 顶层返回 500，不会直接继续执行受保护的 user API。

问题：
1. `sessionTokenHash` 将 `env.SESSION_PEPPER || ""` 用作 pepper；没有显式检查密钥存在或最小长度。缺 Secret 时不会主动拒绝签发/校验 Session。
2. `resolveSession` 对无效/过期/撤销 Token 返回 null，这是正常的认证失败语义；但公开转换接口的内部调用把 null 和异常都当匿名继续，导致凭证降级（见 3.2）。
3. `last_seen_at` 更新失败被 catch 忽略。它不是授权判定核心，但会造成会话活动审计/安全分析数据不完整。
4. 密码修改处需另行核查“协助会话 actor/effective”语义；本批不把它判为已证实漏洞。

### 3.2 转换 owner 身份与匿名降级

源码位置：`resolveOwnerKey` 约第 3104 行；`convertRoute` 约第 3117 行。

当前规则：
- 有效用户 Session → `u:<effectiveId>`；
- 无有效 Session、guest_key 格式正确 → `g:<peppered hash>`；
- 缺失/格式不正确的 guest_key → `g:anonymous`。

问题：
- `/api/convert`、`/api/convert/groups`、`/api/convert/links`、撤销和重命名分支在内部调用 `resolveSession` 时使用 catch 后继续匿名，部分路径也没有区分“没有 Authorization”与“提供了无效 Bearer Token”。
- 已登录用户的 Token 无效、过期或解析异常时，转换可能继续，并将结果归入访客身份，而不是明确返回 401。
- 缺失 guest_key 的多个访客共用 `g:anonymous`。匿名转换记录、分组、链接撤销边界因此无法可靠地按访客隔离。
- owner key 的 guest 哈希依赖 SESSION_PEPPER；缺少 pepper 时会使用空字符串，削弱部署隔离和密钥轮换能力。

建议修复方向（未实施）：
1. 区分完全没有 Authorization 的 L0 请求与带有无效 Bearer 的请求；后者返回 401，不得降级匿名。
2. 登录态转换必须由唯一一次 Session 解析结果确定 owner；不要在 handler 内重复解析并吞错。
3. L0 必须要求独立、稳定、不可共享的 guest credential；缺失时由服务端安全签发或拒绝创建个人归档，不能落入共享 owner。
4. 对 guest credential 设置签名/轮换/撤销及重放边界；不能把客户端随意提交的任意字符串当作强设备身份。

### 3.3 filters / applyNodeFilters 权限

源码位置：`applyNodeFilters` 约第 2843 行；调用处约第 3289-3291 行。

已确认：
- 注释写明“名称过滤与重命名（仅登录用户可用）”。
- 实际调用只执行 `applyNodeFilters(nodes, body.filters)`，没有检查 ctx、Session、VIP 状态或功能等级。
- 转换路由公开执行，filters 处理不因匿名用户而跳过。
- include/exclude/rename 的数组长度、单项长度和总规则数量没有在该函数内作完整边界限制。

结论：
- 注释与实际服务端行为不一致。
- 不能据此宣称“仅登录用户可用”或“VIP 功能已鉴权”。
- V2.5 只确认 L0 基础转换、L1 基础及经授权增强功能、L2 高级转换；多关键词、正则、重命名、排序、多源合并等逐项等级尚待最终矩阵确认。因此当前应先对所有高级 filters 做服务端拒绝/等级判定，具体 L1/L2 分配不得由开发者自行猜定。

### 3.4 APP entitlement Token 与设备身份

源码位置：`entToken/verifyEntToken` 约第 3848 行；`appRedeemRoute` 约第 3863 行。

已确认：
- Token 是 HMAC-SHA256(`entitlementId|deviceId`)。
- HMAC key 来自 `SESSION_PEPPER || "starjump-app"`。
- `/api/app/nodes`、`/api/app/groups`、`/api/app/links` 会核验 entitlement Token。
- Token 和 device_id 通过 URL query 参数传递，可能进入访问日志、代理日志、分析系统或截图；应改为 Authorization Header 或请求体中安全字段，避免 URL 暴露。
- device_id 完全由请求参数提供，格式校验不等于设备真实性验证。

问题：
1. SESSION_PEPPER 缺失时固定回退 `starjump-app`，所有未配置密钥的部署共享可预测 HMAC 密钥，属于严重 fail-open。
2. `/api/app/status` 只按 device_id 查最新 entitlement，没有读取或验证 token；知道/猜到 device_id 即可能读取授权状态。
3. `/api/app/nodes`、`/api/app/groups`、`/api/app/links` 通过 `ORDER BY created_at DESC LIMIT 1` 只选择最新一条有效 entitlement。一个设备同时持有多个管理员授权时，较早的有效授权可能被遮蔽。
4. redeem 只验证客户端 device_id 格式，无法证明设备绑定真实性；卡密泄露后可被其他客户端抢先兑换到其自选 device_id。
5. APP 免费分组路由 `/api/app/free` 通过 admin 或 share code 查询，不要求有效 entitlement Token；分组读取与已确认“通过管理员身份 ID 获取免费分组”的规则尚未形成可审计的身份凭证闭环。
6. `/api/app/groups` 在没有有效 entitlement 时，直接按 device_id 查 `app_free_grants` 并返回免费组，没有验证独立 free-grant token。该路径不能把裸 device_id 当成身份凭证。
7. redeem 后 `app_card_events` 写入失败被 catch 忽略；卡密状态、entitlement 已成功提交但激活事件可能缺失。
8. redeem 成功后创建永久 `app_free_grants`（注释明确为永久保留），这与免费授权是否应在卡密过期后持续有效的业务边界仍需以已确认规则核对；不能默认所有卡密兑换都永久授予免费组。

建议修复方向（未实施）：
- APP HMAC 密钥必须使用专用、强随机 Secret；缺失即拒绝启动相关授权接口，不回退常量。
- 设计设备注册/证明/凭证轮换与撤销；裸 device_id 仅作标识，不作认证。
- 所有授权状态/节点/分组/入口请求统一验证 Token、设备凭证、entitlement 状态和过期时间。
- 支持同设备多管理员 entitlement 的显式选择或合并；不能仅取最新一条。
- free grant 应有独立可验证的授权凭证和状态策略。
- 卡密状态、entitlement、事件及 free grant 必须在同一原子边界内成功，或使用可恢复 outbox；不得吞事件错误。

### 3.5 sealJson/openJson 加密

源码位置：`convertKey` 约第 3055 行；`sealJson/openJson` 约第 3063 行。

已确认：
- AES-256-GCM，12 字节随机 IV，密文保存为 IV + ciphertext/tag 的 Base64。
- 密钥派生使用 PBKDF2-SHA256，固定 salt `starjump-convert-v1`、100000 次迭代。
- 密钥来源为 `CONVERT_KEY || SESSION_PEPPER || "starjump-convert"`。

问题：
1. 两个 Secret 均缺失时回退固定字符串 `starjump-convert`，公开源码可得，历史转换 payload 可被解密/伪造，属于高危密钥管理缺陷。
2. 没有 key_id、envelope_version、算法标识或密钥版本，无法安全轮换和区分历史密文格式。
3. 没有 AAD 将密文绑定到记录 ID/用途；密文被复制到其他记录时，格式本身不提供业务上下文绑定。
4. 密钥轮换没有双读/单写、历史数据迁移和回滚流程。
5. `openJson` 只按当前派生密钥解密，密钥更换会导致旧记录不可读。

建议修复方向（未实施）：
- 只使用专用 `CONVERT_KEY` Secret；缺失或强度不足时 fail closed。
- 采用 envelope：版本、key_id、算法、iv、ciphertext；新写入只用当前 key_id，读取按受控 keyring 选择旧密钥。
- 将 record id、用途和版本纳入 AES-GCM AAD。
- 设计密钥轮换和旧密文迁移；旧数据无法解密时不得静默覆盖或删除。

### 3.6 用户态 API 的统一门禁与 VIP 缺口

路由入口约第 5424 行：
- 所有 `/api/user/*` 先要求有效 Session；
- 拒绝 legacy ADMIN_TOKEN；
- 协助会话按 GET=read、DELETE=manage、其他写操作=operate 检查 scope；
- 然后按路径分发至业务 handler。

**路由层没有统一的有效 VIP 检查。** 本批在 Worker 中没有发现 `requireVip` / `requireValidVip` 这类统一 helper。对照 handler，以下操作目前只有 Session + scope（以及各自的数据归属检查），未发现有效 VIP gate：

| API 模块 | 现有 handler 行为 | V2.5 规则 | 结论 |
|---|---|---|---|
| `/api/user/sources` | 登录后按 source_ownership 访问；创建/编辑/同步等路径未见统一 VIP 检查 | 需要按用户等级和有效 VIP 区分来源管理动作 | 缺动作级门禁，逐动作需按最终矩阵冻结 |
| `/api/user/nodes`、overrides、metadata | Session + 节点归属/手动节点 user_id | 普通用户基础操作与 VIP 管理动作需区分 | 不可仅凭登录放行所有写操作 |
| `/api/user/node-groups` | 创建、编辑、删除、成员管理按 user_id 隔离；未见 VIP 校验 | 普通分组按最低权限；APP 对接/星链接须有效 VIP 管理 | APP 相关不能套用普通分组权限 |
| `/api/user/app-groups` | GET/POST/PUT/DELETE、来源/设备成员关联只检查 Session 和 group owner | 仅注册用户可见；有效 VIP 才能管理；过期/非 VIP 只读 | **P1：所有写操作缺有效 VIP 门禁** |
| `/api/user/app-links` | GET/POST/DELETE 按管理员 ID 隔离；写操作无 VIP 校验 | 星链接/入口管理仅有效 VIP | **P1：写操作缺有效 VIP 门禁** |
| `/api/user/app-cards` | GET/POST/DELETE/disable/events；按 admin_user_id 隔离；未见 VIP 校验 | APP 卡密由有效 VIP 管理员管理，且与管理员 VIP 卡池隔离 | **P1：卡密生成/停用/删除缺有效 VIP 门禁** |
| `/api/user/vip` | 查询状态、激活管理员 VIP 卡密 | 注册用户可查询/激活 | 不属于 VIP 管理功能门禁 |
| `/api/user/stats`、sync-logs、stale-nodes、downloads、share-code | 登录后按 handler 逻辑访问 | 应按数据敏感度与角色矩阵确定 | 逐动作/逐字段复核，不应一刀切套 VIP |

注意：
- 上表中的“未见 VIP 校验”是静态搜索和 handler 阅读结论，不代表已通过 API 实测。
- 正式 VIP 到期后允许查看、删除本人历史数据；体验 VIP 到期严格只读。实现时必须区分动作（read/create/edit/delete/copy/share），不能用单一 `vip.active` 布尔值粗略处理所有操作。
- 普通用户注册后可能只有 L1，不能因拥有 Session 就被当成 VIP 管理员。

### 3.7 vipStatus 的语义不足

源码位置：`vipStatus` 约第 3352 行。

当前函数：
- 对用户所有 activation 取 `MAX(ends_at)`；
- 只返回 active、is_formal（历史上是否出现过 formal）、has_trial（历史上是否出现过 trial）；
- 查询异常时返回 active=false、unavailable=true。

问题：
- `is_formal` 代表“有过正式激活历史”，不是“当前生效的那条授权属于正式 VIP”。
- 如果同一用户有多条 trial/formal 记录，当前生效来源类型无法通过返回值准确判定。
- 仅凭 MAX(ends_at) 无法区分体验/正式的优先级、冲突状态、撤销状态或授权来源；当前表结构是否具备这些字段需正式 D1 schema 只读核实。
- 目前多个 handler 没有调用 vipStatus，导致其 fail-safe 结果也未成为动作门禁。

建议：设计统一的 `resolveMembership(ctx, action, resource)`，输出 L0/L1/L2、当前生效 entitlement kind、有效期、到期后允许动作、管理员身份和资源归属。先核对现有 D1 字段，不在本批擅自设计 ALTER。

### 3.8 资源归属二次校验

源码位置：
- `loadSourceForCtx` 约第 1294 行；
- `loadSubscriptionNode` 约第 1304 行；
- `loadManualNode` 约第 1313 行。

已确认：
- 普通用户/协助态通过 `source_ownership(source_id,user_id)` 校验来源归属。
- 手动节点查询同时要求 `id` 和 `user_id`。
- 超管本人非协助态可绕过 source_ownership 读取全局资源。
- 协助会话不会触发超管全局绕过，因为 actor 与 effective 不相等。

剩余风险：
1. 归属 helper 只证明 ownership 行存在；没有统一检查来源 enabled、approval、归档/转移状态。
2. `loadSubscriptionNode` 不检查 `node_lifecycle.state='stale'`，调用方若未单独过滤，可能允许编辑/分组 stale 节点。
3. 查询 node_records 后再单独查询 ownership 是两次读取；若来源归属在并发请求中变化，后续写入是否在同一 batch 中带 ownership guard，需逐 handler 核查，不能把 helper 的先查当作原子授权。
4. `loadSourceForCtx` 返回完整 source row；敏感订阅 URL 是否在所有响应中脱敏，仍需逐 handler 核实。
5. APP 分组的超管 handler 部分路径通过 group id/source id 直接操作，须继续核对管理员归属与跨用户边界。

## 4. P1/P2 新增登记（本批）

### P1
- **P1-47**：转换接口对无效/解析失败 Session 降级匿名，可能导致登录用户归档身份错误。
- **P1-48**：缺失 guest_key 回退共享 `g:anonymous`，访客数据隔离失效。
- **P1-49**：`applyNodeFilters` 无登录/VIP 服务端门禁，匿名也可使用高级过滤/重命名。
- **P1-50**：APP Token key 缺失回退固定 `starjump-app`。
- **P1-51**：`/api/app/status` 不验证 entitlement Token，仅凭 device_id 返回授权状态。
- **P1-52**：APP 设备身份仅由客户端 device_id 声明，缺设备凭证/证明/轮换/撤销。
- **P1-53**：转换加密 key 缺失回退固定 `starjump-convert`。
- **P1-54**：转换密文无 envelope version/key_id，无法安全轮换。
- **P1-55**：APP groups/nodes/links 仅取最新 entitlement，多管理员有效授权会被遮蔽。
- **P1-56**：`/api/user/app-groups` 写操作无有效 VIP gate。
- **P1-57**：`/api/user/app-links` 写操作无有效 VIP gate。
- **P1-58**：`/api/user/app-cards` 管理写操作无有效 VIP gate。
- **P1-59**：`/api/app/free` 与 groups 的免费授权回退只按 admin/share code/device_id/free_grant 识别，缺少统一可验证的 free grant 凭证链路。
- **P1-60**：Session pepper 未配置时没有显式 fail closed；会话哈希及 guest hash 使用空 pepper 继续工作。

### P2
- **P2-新增-第三批-01**：`vipStatus.is_formal` 仅表示历史曾有正式激活，不能表示当前生效类型。
- **P2-新增-第三批-02**：APP entitlement Token 及 device_id 放在 URL query，可能泄露到日志/代理链路。
- **P2-新增-第三批-03**：Session last_seen_at、APP card event、多个审计写入存在 catch 静默，导致审计/诊断不完整。
- **P2-新增-第三批-04**：归属 helper 不统一检查来源审批/启停、节点 stale/lifecycle 状态。
- **P2-新增-第三批-05**：转换过滤规则缺少规则数组/单项长度上限，可能造成不必要 CPU/内存开销。
- **P2-新增-第三批-06**：AES-GCM envelope 未绑定记录 ID/用途 AAD。

## 5. 建议修复顺序（本批未实施）

1. **先封堵身份降级**：无效 Bearer 不得匿名继续；移除共享 `g:anonymous`。
2. **密钥 fail closed**：Session pepper、APP HMAC key、CONVERT_KEY 缺失时拒绝相关功能；移除固定默认密钥。
3. **建立动作级权限中间件**：L0/L1/L2 + trial/formal + active/expired + action + resource ownership；把 APP groups/links/cards 写操作先纳入有效 VIP gate。
4. **修复 filters 授权**：按待确认的 L1/L2 功能矩阵明确哪些过滤允许谁使用，其他默认拒绝。
5. **统一 APP 授权验证**：status/nodes/groups/links/free 全部使用可验证凭证；支持多 entitlement。
6. **加密格式升级设计**：版本化 envelope、key_id、AAD、双读单写和密钥轮换演练。
7. **强化资源授权**：把 ownership、source status、approval、lifecycle 检查与写入条件绑定；核实 APP group source 管理归属。
8. **再做测试**：先在独立测试 Worker/D1 执行 AUTH/VIP/OWN/APP/CONV 测试；不能直接用生产库验证。

## 6. 需要后续确认但本批不阻塞核查的业务项

1. L1 与 L2 高级 filters 的逐项分配，继续沿用功能基线“未确认”状态。
2. 免费组授权是否在任意 APP 卡密过期后永久保留，还是只对特定管理员免费分享授权有效；不得由当前代码注释反向覆盖业务基线。
3. 同设备多管理员 entitlement 的前端展示方式：合并展示还是用户选择管理员；服务端必须支持多条授权，不得只取最新。
4. 设备绑定需要支持哪些设备迁移/重装场景，以及超管 rebind 的审批和旧 Token 撤销策略。

## 7. 本批边界与未完成项

- 只读检查仓库 Worker 基线源码；没有修改任何业务代码。
- 未读取/核验正式 Cloudflare D1 schema，不能判断现有字段是否已支持修复。
- 未解包 APK，不能确认客户端实际如何保存、传递 Token/device_id。
- 未对任何 API 发请求，未运行自动化测试。
- 未修改生产 Worker、Secrets、环境变量、D1 或部署。
- 本报告列出的修复方向是建议实施计划，不代表已经实现。

## 8. 变更记录

- 2026-11-27：第三批统一权限门禁与底层安全函数只读核查完成；新增 P1-47 至 P1-60、第三批 P2 项；后续需按影响分析、D1 只读核验、测试和回滚计划逐项实施。
