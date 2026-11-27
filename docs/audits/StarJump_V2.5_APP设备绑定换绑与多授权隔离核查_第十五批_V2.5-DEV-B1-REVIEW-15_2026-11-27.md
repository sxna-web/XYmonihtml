# 星跃管理平台 V2.5｜APP 设备绑定、换绑与多授权隔离核查

> 批次：第十五批  
> 版本标识：V2.5-DEV-B1-REVIEW-15  
> 日期：2026-11-27  
> 状态：DEV 静态源码审计；未修改业务代码  
> 核查分支：repair/v2.5-batch1-auth-vip-app  
> 核查文件：releases/v2.5-batch1/Worker.js  
> 依据：AGENTS.md、V2.5 功能基线、动作级权限门禁矩阵  
> 兼容性：不修改 Worker、HTML、D1、Secrets、Cron 或线上部署

## 1. 本批结论

候选 Worker 在 APP 卡密核销时将客户端提交的 `device_id` 写入授权记录，并使用 HMAC(secret, entitlementId|deviceId) 生成授权令牌。后续部分接口验证令牌与设备 ID 的绑定关系，不能仅凭猜到 device_id 就伪造有效令牌。

但当前实现没有发现完整的设备管理生命周期：没有可核实的设备列表、设备换绑、主动解绑、旧设备撤销、设备变更审计及并发换绑控制 API。设备 ID 由客户端在首次核销时提交，格式校验不能证明其为真实且不可复制的设备身份。

同一设备存在多份有效授权时，部分接口只选择与当前 Token 匹配的一条授权，并按该条授权所属管理员返回数据；这不是多授权合并。另有免费分组接口仅凭 device_id 查询历史 grant，不验证授权 Token，存在设备标识冒用风险。

**本批结论：设备令牌有一定绑定保护，但设备身份可信度、换绑/撤销闭环、免费授权验证和多授权一致性均不足，不能放行正式版。**

## 2. 已核实的实现

### 2.1 首次核销绑定

`POST /api/app/redeem`：
- 接收卡密 code 与客户端传入 device_id；
- 对 device_id 做长度和字符格式校验；
- 查询卡密状态、人工停用标志、是否已激活/使用及自身过期时间；
- 通过批处理更新卡密为 used，并插入 `app_entitlements`，保存 `admin_user_id`、`device_id`、开始/到期/本地清理时间；
- 同时写入 `app_free_grants(device_id, admin_user_id)`；
- 生成绑定 entitlement ID 与 device ID 的 HMAC Token 返回 APP。

卡密被标记为已使用后，普通再次核销会被拒绝。候选实现没有展示可将同一张已使用卡密迁移到另一设备的管理接口。

### 2.2 Token 绑定校验

- `entToken()` 使用 APP_HMAC_SECRET，缺失时回退 SESSION_PEPPER；两者不足 32 字符则抛出配置错误。
- HMAC 输入包含 entitlement ID 与 device ID。
- `verifyEntToken()` 对传入 Token 与计算值执行 timing-safe 比较。
- `/api/app/status` 要求 Token，并在该 device_id 的授权记录中逐条匹配。
- `/api/app/nodes`、`/api/app/groups`、`/api/app/links` 的授权路径会匹配有效授权列表中的 Token。

这能防止单纯伪造 device_id 即访问需要 HMAC Token 的授权接口，但不能证明客户端提交的 device_id 对应真实硬件，也不能阻止合法 Token 被复制到其他设备使用。

### 2.3 多授权查询

`listActiveEntitlements()` 按 device_id 查询未过期的 active 授权，按创建时间倒序返回多条。

`matchEntitlementToken()` 只返回与当前请求 Token 匹配的第一条授权。随后：
- `/api/app/groups` 按匹配授权的 admin_user_id 读取该管理员分组；
- `/api/app/links` 按匹配授权的 admin_user_id 读取该管理员链接；
- `/api/app/nodes` 按匹配授权的 admin_user_id 读取该管理员来源节点。

因此，单次请求并没有合并该设备的全部有效管理员授权。若设备有多个管理员的有效授权，APP 需分别保存并使用每个 entitlement Token，接口也分别返回授权对应的数据。

### 2.4 免费授权路径

`appFreeGroupRoute()` 接收 admin 参数或分享编号 code，然后按管理员设置检查免费分组开关并返回免费节点。该路径不要求 device_id 或 HMAC Token。

`appGroupsForDevice()` 在没有有效 entitlement 时，会按 device_id 查询 `app_free_grants`，再按 grant 对应的 admin_user_id 返回其 enabled free 分组；该分支不校验 APP Token。

这意味着只要攻击者能够猜测、获取或自行提交符合格式的 device_id，就可能查询该 device_id 已保存的免费授权分组。device_id 不是秘密，也不应当作为身份认证凭证。

## 3. 风险与差异

### P1-15-01｜客户端 device_id 不是可信设备身份

首次核销直接接受客户端传入的 device_id。格式校验只能验证字符串形态，不能证明：
- 该值由可信 APP 实例生成；
- 该值来自硬件/系统安全存储；
- 该值没有被复制；
- 同一用户没有在多个设备上伪造相同 ID。

HMAC Token 将授权绑定到该字符串，但如果 Token 与 device_id 一起被复制，服务端无法仅凭当前协议判断是否换了真实设备。

建议：由 APK 提供可验证的设备密钥/安装实例密钥，采用挑战应答或设备公钥注册机制；服务端保存公钥指纹，授权 Token 之外还要求设备持有私钥完成签名。具体采用 Android Keystore、硬件支持能力及兼容旧版本策略，需结合 APK 源码核实后设计，不能假设现有 APK 已支持。

### P1-15-02｜没有发现设备换绑、解绑与撤销 API

本批 Worker 路径中没有发现完整设备管理端点：
- 查询某管理员/用户的已绑定设备；
- 发起换绑申请；
- 验证换绑授权；
- 解除旧设备绑定；
- 撤销旧设备所有 entitlement Token；
- 对换绑执行频率限制、二次验证与审计。

当前授权与 device_id 绑定后，缺少正式的旧设备失效流程。卡密已核销不能直接重新核销到新设备；用户换手机时可能无法迁移授权，或只能等待旧授权到期。

建议：建立独立设备登记和撤销状态；换绑必须在服务端事务中完成，先确认新设备，再撤销旧设备凭证并使旧 Token 立即失效。是否允许自助换绑、管理员协助换绑、换绑冷却时间及次数上限，属于业务规则，需由用户确认后实现。

### P1-15-03｜免费 grant 读取缺少 Token 验证

`/api/app/groups` 无有效 entitlement 时，仅通过 device_id 查询 `app_free_grants`，没有校验该设备此前核销生成的 Token。

建议：免费 grant 查询必须要求有效的设备凭证，并校验 grant 与设备登记记录绑定；不能把 device_id 当成秘密。若免费授权本来就允许无卡密用户绑定管理员身份 ID，则也必须通过可信设备注册凭证证明“这是该 APP 用户”，并限制只能读取其明确绑定管理员的免费组。

### P1-15-04｜免费 grant 的永久授权与撤销规则不清晰

卡密核销时会永久插入 `app_free_grants`，代码注释表示卡密过期后仍保留免费分组资格。

需要确认：
- 管理员关闭免费分组后，历史 grant 是否立即失效；
- 管理员撤销某 APP 用户身份 ID 后，grant 是否可撤销；
- 用户解绑管理员后是否仍保留免费 grant；
- 管理员账号封禁/删除后如何处理 grant；
- 同一设备更换身份或换绑后，历史 grant 是否随旧设备撤销。

建议：grant 需要有明确的授权状态、创建来源、撤销原因、撤销时间和可审计生命周期；永久保留不等于永远不可撤销。

### P1-15-05｜同一设备的多管理员授权未统一合并

`matchEntitlementToken()` 每次只匹配一条授权。节点、分组、链接接口均按匹配 entitlement 的 admin_user_id 查询。

可能造成：
- 同一设备有多个管理员卡密授权，但 APP 只拿一个 Token 时只能读取该 Token 对应管理员的数据；
- 如果 APP 逐条调用，需自行维护多个 Token 和多组结果，服务端没有统一的合并响应；
- 分组 ID、来源名或链接 ID 跨管理员重复时，客户端若未按 admin_user_id/entitlement_id 做命名空间隔离，可能产生覆盖或误归属。

建议：多授权合并应以授权为独立边界，先逐条验证设备持有的每个 Token，再按 admin_user_id + entitlement_id 分组返回；绝不能把一个管理员授权扩展成另一个管理员的数据权限。客户端需要稳定的授权命名空间和冲突处理规则。

### P1-15-06｜Token 放在 URL query 参数

`/api/app/nodes` 读取 query 参数 token；通用 Token 解析也允许 query token。URL 容易进入访问日志、代理日志、调试记录或分析系统。

建议：正式版只允许 Authorization Bearer 或专用安全 Header；拒绝 query token，迁移期间如需兼容必须设置明确期限并做脱敏。

### P2-15-07｜授权 Token 只证明 entitlement，不提供设备撤销状态

HMAC Token 以 entitlement ID 和 device ID 计算。当前验证会查询 entitlement 状态和有效期，但没有独立设备登记状态供统一撤销。若未来只撤销设备绑定而未同步改变该设备的全部 entitlement 状态，旧 Token 仍可能在其他路径有效。

建议：验证流程必须同时检查 entitlement active、有效期、设备 active、设备归属、撤销版本/凭证版本；所有 APP 读取接口共用同一认证中间件。

### P2-15-08｜APP 状态接口与节点/分组接口的多授权语义不一致

`/api/app/status` 允许匹配当前设备最多 100 条授权中的任意一条，返回单条状态；节点、分组、链接同样匹配单条，但各接口没有统一的“设备所有授权状态汇总”响应。

建议：定义统一的设备授权状态接口，返回该设备全部授权的最小必要信息和每份授权状态；敏感字段不应因状态汇总而泄漏。

## 4. 与已确认业务规则对照

| 业务要求 | 当前静态核查 |
|---|---|
| APP 免费组通过 APP 用户身份 ID 授权 | 有 admin share code / free grant 路径，但免费读取部分未校验设备 Token |
| APP 卡密组通过对应卡密授权 | 核销生成独立 entitlement，并绑定 admin_user_id 与 device_id |
| 管理员卡密和 APP 用户卡密隔离 | 本批路径使用 app_cards/app_entitlements，与管理员 VIP 卡池分离 |
| 设备身份不能只靠客户端任意传值 | 当前仅格式校验 + HMAC 字符串绑定，尚无可信设备密钥证明 |
| 换绑后旧设备立即失效 | 未发现完整换绑/解绑/旧设备撤销闭环 |
| 多管理员授权互不越权 | 单 entitlement Token 按单管理员读取；未统一合并，客户端命名空间待核实 |
| 24 小时本地清理 | entitlement 到期后 purge_at 延后 24 小时；不等于设备换绑撤销协议，不能替代旧设备立即撤销 |
| 敏感 Token 不进入 URL | 当前允许 query token，需收紧 |

## 5. 修复前置计划（本批不实施）

1. 先解包并审计实际 APK 源码，确认当前 APP 的 device_id 生成、持久化、Token 存储、请求 Header、换机行为和版本兼容性。
2. 设计可信设备注册模型：device record、public key/fingerprint、状态、创建时间、最后验证时间、撤销时间、绑定用户身份。
3. 定义换绑业务规则：自助/人工流程、二次验证、冷却期、次数限制、旧设备是否立即失效、授权是否可迁移。
4. 设计统一设备授权校验中间件，覆盖 status/nodes/groups/free/links/download 等所有受保护端点。
5. 设计多授权返回协议：每个 entitlement 独立验证、独立授权范围、独立过期时间；按管理员命名空间合并显示，不扩大权限。
6. 为免费 grant 增加可信设备凭证、授权撤销和管理员状态校验。
7. 将 Token 从 URL query 移除，制定旧 APK 兼容过渡方案。
8. 只读核对真实 D1 schema 与索引后，才能设计兼容迁移；未经用户授权不执行生产 SQL。

## 6. 必须补充的测试矩阵

| 场景 | 预期 |
|---|---|
| 只知道合法格式 device_id，无 Token | 所有受保护授权数据接口拒绝 |
| device_id + 其他设备 Token | 拒绝 |
| Token 被复制到另一台未登记设备 | 设备密钥证明失败 |
| 合法设备正常查询状态/节点 | 只返回授权范围内数据 |
| 卡密首次核销并发重复请求 | 仅一个成功，其他请求安全拒绝 |
| 已核销卡密换手机再次核销 | 不允许绕过一次性规则 |
| 正式换绑完成 | 旧设备所有相关 Token 立即失效 |
| 换绑中途失败 | 不出现新旧设备均长期有效或两边都不可恢复的半完成状态 |
| 用户主动解绑 | 按确认规则撤销授权并留下审计 |
| 同设备两个管理员两份有效授权 | 分别验证、分别返回，不串管理员数据 |
| 一个管理员授权过期，另一个仍有效 | 仅过期授权停止下发 |
| 伪造免费 grant 的 device_id | 无有效设备凭证不得读取 |
| 管理员关闭免费组/撤销 grant | 按明确撤销规则生效 |
| URL query 带 token | 正式安全策略下拒绝 |
| 设备撤销后调用所有 APP 接口 | 全部拒绝旧设备凭证 |
| 24 小时清理与设备撤销同时发生 | 清理时间和立即撤销语义不混淆 |

## 7. 本批边界与结论

- 已完成：阅读仓库规则、动作级权限基线；静态追踪 Worker APP 核销、Token、状态、节点、分组、免费 grant 和链接路径。
- 未完成：APK 源码解包审计、真实 D1 schema 核验、设备实测、API 集成测试。
- 未修改：Worker、HTML、D1、Secrets、Cron、生产部署。
- 发布等级：仅 DEV 静态审计，不是 RC，不可部署。

**结论：** 当前 HMAC Token 是对 entitlement 与客户端 device_id 字符串的绑定，不等于可信硬件绑定。设备换绑和旧设备撤销闭环尚未建立；免费 grant 存在仅凭 device_id 读取的风险；多管理员授权尚未统一合并。正式修复前必须先核实 APK 实际实现，并冻结换绑业务规则。
