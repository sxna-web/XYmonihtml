# 星跃管理平台 V2.5｜账号停用、VIP 到期、APP 卡密与设备换绑状态联动核查

> 批次：第二十三批  
> 版本标识：V2.5-DEV-B1-REVIEW-23  
> 日期：2026-11-27  
> 阶段：DEV 静态源码审计  
> 核查分支：repair/v2.5-batch1-auth-vip-app  
> 核查文件：releases/v2.5-batch1/Worker.js  
> 关联报告：第十四、十五、十八、十九、二十、二十二批  
> 本批范围：管理员账号状态、APP 卡密核销、entitlement 查询、状态接口、VIP 到期维护、卡密手动停用、设备换绑、免费 grant  
> 边界：未修改业务代码、D1、Secrets、Cron、APK 或生产部署

## 1. 结论摘要

当前实现将管理员网页 Session 状态、VIP 状态、APP 卡密状态、APP entitlement 状态和设备绑定分散处理，缺少统一的状态联动策略。

1. **P0：管理员账号停用/锁定未阻止 APP 卡密新核销。** `/api/app/redeem` 只检查卡密自身状态、手动停用和过期，没有查询卡密所属管理员 `app_users.status`。已停用/锁定管理员名下的未使用卡密仍可能核销并创建新 entitlement。
2. **P1：已有 entitlement 读取未检查管理员账号状态。** `listActiveEntitlements()` 只按 device_id、entitlement.status='active' 和 expires_at 过滤；/api/app/status、/api/app/nodes、/api/app/groups 均未统一检查管理员账号是否 disabled/locked。账号停用后既有 APP 授权仍可能继续使用。
3. **P1：超管换绑只更新 entitlement.device_id。** 不同步 app_free_grants、不写旧设备撤销事件、不生成 generation、不保存设备清理 ACK；旧设备的免费 grant 可能残留，新设备又没有对应免费 grant。
4. **P1：卡密手动停用与已创建 entitlement 没有联动。** disable 路由只更新 app_cards.manual_disabled/status；已核销卡密对应的 app_entitlements 不会同步失效，也不会生成撤销事件。必须由产品明确“已激活卡密是否允许管理员主动撤销其现存授权”；不能把卡密库存停用等同于撤销已生效 entitlement。
5. **P1：VIP 到期三天宽限维护只扫描 app_cards 中出现过的管理员。** 没有卡密记录的 VIP 管理员不会被扫描，但其不存在未激活卡密无需失活；更重要的是该维护依赖 Cron，而 Cron 在无启用来源时提前 return，导致维护整体跳过（第十九/二十二批已确认）。
6. **P1：entitlement 过期与 purged 只改状态，不处理设备端缓存或 ACK。** 代码把 purge_at 设为 expires_at + 1 天，并在到期后状态 expired、purge_at 到期后状态 purged；但没有清理事件、设备同步确认或 APK ACK。
7. **P2：卡密核销并发保护依赖 userBatch/assertStmt 的原子语义，仍需真实 D1 并发测试。** 需要验证同一卡密并发请求时只有一个 entitlement 创建、卡密只被核销一次。
8. **P2：换绑接口没有检查 entitlement 当前状态/期限、目标设备是否已有绑定冲突，也未限制重复换绑频率。** 已过期或已 purged 授权是否允许换绑未明确，接口目前只检查记录存在和 device_id 格式。

## 2. 管理员账号状态与 APP 授权

### 2.1 网页 Session 已检查账号状态

resolveSession() 查询 app_users.status，并拒绝 status !== 'active' 的用户网页 Session。这只保护使用该网页 Session 的管理 API。

### 2.2 APP 核销未检查管理员账号状态

/ api / app / redeem 核销流程读取 app_cards：
- card id / admin_user_id / days / status / manual_disabled / activated_at / used_at / expires_at；
- 检查卡密是否停用、使用、状态 normal、是否过期；
- 随后把卡密改为 used 并创建 app_entitlements；
- 同时写入 app_free_grants。

该流程未 JOIN app_users，也未查询 admin_user.status。

**影响：** 管理员账号被超管停用/锁定后，旧卡密仍可能发出新 APP entitlement。与网页 Session 已撤销形成绕过。

**修复建议：**
- 核销前读取管理员账号状态，要求 active；
- 在最终原子写入时再次将 active 条件纳入断言，防止读取与写入之间被停用；
- 账号停用阻止新核销、新建授权和新分享绑定；
- 账号停用对已有 entitlement 的处理必须采用独立、明确的状态策略，不能暗中混入 VIP 到期逻辑。

## 3. 已有 APP entitlement 与管理员账号停用

listActiveEntitlements() 当前只检查：
- device_id；
- status='active'；
- expires_at > now。

未连接 app_users.status。/api/app/status、/api/app/nodes、/api/app/groups 都通过该查询或相似查询取得授权。

**风险：** 即使管理员账号已 disabled/locked，设备仍可能使用已有 Token 访问 APP 节点、分组和状态接口。

**规则边界：**
- 用户已确认：管理员 VIP 到期不会让已激活 APP 卡密自动失效，已激活 entitlement 按自身期限继续有效。
- 但管理员账号被超管停用/锁定属于账号安全状态，不等同 VIP 到期。需要单独制定是否冻结已有 APP entitlement、是否只阻止新授权、是否允许恢复账号后继续使用。
- 在规则没有明确前，不应擅自把账号停用等同 VIP 到期，也不应默认完全忽略账号停用。

**建议安全默认：**
- 停用/锁定立即阻止该管理员新核销、新建分享和管理写入；
- 已激活 entitlement 是否继续服务设为独立策略字段/状态原因，需超管可审计操作；
- 任何冻结都保留授权记录与到期时间，不物理删除；
- 恢复账号时不能恢复被超管手动撤销、封禁或作废的授权。

## 4. 卡密手动停用与已激活授权

userAppCardsRoute() 的 disable 动作只执行：
- app_cards.manual_disabled = 1；
- normal 卡密改为 inactive；
- 写入 manual reason。

它不查询或更新关联 app_entitlements。对已使用卡密调用 disable 时，status 可能仍是 used，但 manual_disabled 会被设为 1。

**需要区分：**
- 未激活库存卡密：手动停用应立即阻止核销。
- 已激活卡密：库存状态已是 used；手动停用按钮不能让管理员误以为现存设备授权已被撤销。
- 若产品允许管理员撤销已激活授权，应增加独立“撤销设备授权”动作，明确选择 entitlement、原因、影响设备，并产生撤销事件和清理 ACK。
- 若产品不允许管理员撤销已激活授权，则对 used 卡密隐藏/拒绝库存停用动作，并提示“已激活授权按自身有效期执行”。

## 5. 设备换绑完整性

超管接口 /api/super/app-entitlements/:id/rebind 当前：
1. 读取 entitlement id 与旧 device_id；
2. 更新 app_entitlements.device_id；
3. 写审计；
4. 返回新 device_id 与新 Token。

未处理：
- 旧 device_id 对应的 app_free_grants；
- 新设备的免费 grant 资格迁移；
- 旧设备本地节点清理事件；
- 新设备 generation 初始化；
- 并发换绑竞争；
- entitlement status/expires_at/purge_at；
- 设备绑定历史账本；
- 旧 Token 立即失效的 API 测试；
- ACK 与离线重试。

**当前可见风险：**
- entitlement 绑定改到新设备后，旧设备因不再匹配 entitlement Token 应不能继续使用该 entitlement；
- 但旧设备的 app_free_grants 仍以 device_id 独立保存，旧设备可能继续通过无 entitlement 的免费分组路径读取节点；
- 新设备没有同步新增 app_free_grants，导致换绑后的免费资格不一致；
- 旧设备本地缓存没有服务端撤销消息，不能证明 24 小时内清理。

**修复要求：**
- 换绑必须是单一原子状态变更；
- 写入 old_device_id → new_device_id 绑定历史；
- 旧设备生成 revoke generation/tombstone；
- 旧设备免费 grant 处理必须按授权来源/规则迁移，不能简单全量复制或无条件删除；
- 新设备重新签发 Token；
- 旧 Token 立即失效；
- 旧设备清理完成后 ACK；
- 换绑重复请求幂等，并防止并发覆盖。

## 6. VIP 到期三天宽限与已激活卡密规则复核

当前 Worker 维护：
- vipExpiredOverGrace() 判断管理员最后有效 VIP 结束时间是否已超过三天；
- deactivateCardsForAdmin() 只停用未激活、未使用、未手动停用、卡密自身未过期的 normal 卡密；
- restoreCardsForAdmin() 只恢复 inactive_reason='admin_vip_expired' 且未激活/未使用、未手动停用、卡密自身未过期的卡密；
- 已激活 entitlement 不在上述失活/恢复 SQL 中。

与用户已确认规则相符的部分：
- 体验 VIP、正式 VIP 的未激活 APP 卡密都享受三天宽限；
- 满三天后才可按规则自动失活；
- 恢复只恢复因 admin_vip_expired 自动失活的未激活卡密；
- 已激活 APP 卡密不因管理员 VIP 到期自动失效。

仍需修复：
- Cron 维护任务与来源同步解耦，不能 sources.length===0 就跳过；
- 续费、到期、恢复的并发状态必须原子化；
- 维护审计不能静默丢失；
- active formal 与历史 formal 标记必须严格区分。

## 7. entitlement 24 小时保留与清理

核销时：
- expires_at = now + days；
- purge_at = now + days + 1 day；
- local_retention_hours = 24。

维护时：
- expires_at 到期后 status='expired'；
- purge_at 到期后 status='purged'。

但没有 APK ACK、设备清理状态或撤销事件账本。因此 `purged` 仅代表数据库状态更新，不代表 APK 已清理本地节点。

必须区分：
1. entitlement 到期：停止新节点下发；
2. 本地保留期：到期后 24 小时内允许设备保留已缓存节点；
3. 清理截止：设备必须清除本地节点；
4. cleanup ACK：设备确认已清理；
5. 服务端归档：保留撤销与审计历史，不因 ACK 而删除证据。

## 8. 数据库影响（未实施）

涉及既有表：
- app_users
- app_cards
- app_card_events
- app_entitlements
- app_free_grants
- app_groups
- app_group_members
- user_sessions
- admin_user_scopes

后续可能需要：
- app_entitlement_rebind_history
- app_revocation_events
- app_device_sync_state
- app_cleanup_ack
- app_admin_access_policy

上述仅为设计建议。必须先只读读取真实 D1 schema、索引、约束和历史数据，不能直接创建或迁移。

## 9. 测试验收矩阵

| 场景 | 预期 |
|---|---|
| 管理员 active，卡密 normal 且未过期 | 核销成功 |
| 管理员 disabled/locked，卡密仍 normal | 新核销拒绝 |
| 核销读取后管理员被并发停用 | 原子断言阻止 entitlement 创建 |
| 管理员 VIP 到期但账号 active，已激活卡密 | 按自身期限继续有效 |
| 管理员 VIP 到期满三天，未激活卡密 | 自动失活 |
| 体验 VIP 与正式 VIP 的未激活卡密 | 三天宽限相同 |
| VIP 恢复 | 只恢复 admin_vip_expired 原因且仍符合条件的未激活卡密 |
| 手动停用未激活卡密 | 不能核销 |
| 手动停用已使用卡密 | 不得误报为现存 entitlement 已撤销 |
| 超管明确撤销已激活 entitlement | 产生撤销事件并等待 APK ACK |
| 管理员账号停用时已有 entitlement | 按独立账号停用策略执行，不混同 VIP 到期 |
| 换绑后旧 Token 请求 | 立即失败 |
| 换绑后新 Token 请求 | 只允许新设备使用 |
| 换绑后旧设备 free grant | 按明确迁移/撤销规则处理，不得残留越权 |
| 换绑后新设备免费资格 | 与规则一致迁移，不丢失/扩大 |
| 换绑重复请求 | 幂等 |
| 两个换绑请求并发 | 不发生旧设备/新设备双有效 |
| entitlement 到期 | 停止新下发 |
| 24 小时截止后 APK 离线 | 事件保留，联网后强制清理并 ACK |
| ACK 重复提交 | 幂等且可审计 |
| Cron 没有启用来源 | VIP/entitlement 维护仍执行 |

## 10. 本批边界

- 已完成：Worker 静态检查 resolveSession、APP redeem/status/nodes、listActiveEntitlements、VIP 卡密维护、entitlement maintenance、超管 rebind、免费 grant。
- 未完成：APK ZIP 无法读取，客户端实际换绑、Token 保存、缓存清理和 ACK 未实证。
- 未完成：真实 D1/API/Cron 并发测试。
- 未修改：Worker、HTML、APK、D1、Secrets、Cron、Cloudflare 部署。
- 阶段：V2.5-DEV-B1-REVIEW-23，仅静态审计，不是 RC，不可部署。

**最终判断：** 现有代码可以在网页 Session 层识别管理员停用状态，但 APP 卡密核销和 entitlement 读取未统一纳入管理员账号状态；设备换绑也没有完整撤销旧设备和迁移免费 grant。下一轮修复必须先明确“账号停用”与“VIP 到期”是两套独立状态，再实现服务端统一授权判定与设备撤销账本。