# V2.5.0 RC1 第六十九批：多卡密组合服务生产依赖与凭据协议审计

- 版本：V2.5.0 RC1
- 批次：第六十九批 / `V2.5-DEV-B1-APP-RUNTIME-69`
- 日期：2026-11-28
- 审计基线：`d2178b4dd03fc2394f56cb00ac5adc7e6bac88a2`
- 范围：Protocol 59/60/64/65 服务契约与正式 Worker 路由接入证据
- 性质：只读审计；未执行生产 D1 操作、部署或合并

## 一、结论

多卡密组合纯逻辑已经覆盖核心规则，但当前仓库尚缺少可运行在真实 Worker/D1 的依赖适配器和 APK 凭据交付协议。当前实现是 dependency-injected contract，不是可直接部署的完整 endpoint。

## 二、逐项核查

### 2.1 组合规则本身

`V2.5-DEV-B1-APP-PROTOCOL-60/group-composition.mjs` 已实现：
- 每个 entitlement 分别保留 CARD 分组；
- 同管理员 FREE 分组按 `adminUserId + groupId` 去重；
- 不同管理员免费组隔离；
- 同管理员同名卡密组附加对应非敏感序列号标签；
- 只投影允许字段，不输出额外内部字段；
- 错误 owner、重复 group、重复 entitlement、身份授权携带卡密组均 fail closed。

现有测试覆盖了这些纯逻辑行为。它们不验证数据库 adapter 是否真实正确。

### 2.2 Protocol 65 service 的真实依赖缺口

`composed-group-service.mjs` 构造时强制注入四个函数：
- `resolveEntitlement`
- `classifyEntitlement`
- `loadGroupsForEntitlement`
- `loadCardSerialLabel`

仓库中没有发现将这四个依赖绑定到 Cloudflare D1 的生产 adapter，也没有看到从实际 `app_cards`、`app_entitlements`、卡密-分组映射表和 `app_groups` 查询数据的实现。

Protocol 59 `group-loader.mjs` 仍是抽象 loader：
- `loadCardMappings` 由调用方注入；
- 注释明确表示不假设生产 schema；
- 需要调用方提供 joined owner-checked query；
- `loadGroups`、`hasFreeGrant`、`isFreeEnabled` 同样是注入依赖。

因此目前不能证明真实 D1 会按 `entitlement.card_id` 读取卡密分组，也不能证明免费授权开关、管理员归属、卡密有效状态与数据库行一致。

### 2.3 Handler 与正式 Worker 的关系

`composed-groups-handler.mjs` 只导出 `createComposedGroupsHandler` 工厂函数，并校验路径、POST、device header、body 大小及 credential 数量。

在 Batch 49 正式候选 Worker 中，未发现：
- 导入/调用 `createComposedGroupsHandler`；
- 创建真实 `composeGroups` service 实例；
- 注册 `POST /api/app/v2/groups/composed`；
- D1 adapter 初始化；
- 新 endpoint 的 Worker 主路由集成测试。

CI 虽然运行 Protocol 65 单元/契约测试，但打包步骤只 bundle Batch 49 的 `Worker.js`。所以通过测试不能证明 Protocol 65 进入部署 Worker bundle。

### 2.4 凭据协议缺口

Protocol 65 handler 要求请求体提供 `credentials[]`，每项包含 `entitlementId + token`，最多 20 项。它不会自动发现该设备所有有效 entitlement。

这意味着 APK 必须具备：
- 安全保存每张卡密激活后返回的 entitlement ID/token；
- 同一设备重启后仍能恢复全部有效授权凭据；
- 同一设备上的不同管理员/卡密凭据独立管理；
- 卡密过期/撤销/解绑后删除对应本地凭据；
- token 不进入日志、崩溃报告、剪贴板、备份或普通明文偏好存储；
- 仅将凭据发送到可信 API endpoint，并校验证书/TLS。

目前未发现 APK 端已实现该协议的证据。旧 APP 的单 token 查询协议不能自动满足多 credential 请求。

### 2.5 序列号隐私

Service 通过 `loadCardSerialLabel` 取得标签并输出 `cardSerialLabel` / `displayName`。服务层只检查标签是非空字符串，没有在自身强制检查它不是 redeem code、完整卡密 code 或其他秘密。

未来 D1 adapter 必须只生成脱敏/非敏感显示标签，例如卡密记录的稳定序号或掩码尾号；禁止直接返回 `app_cards.code`。应增加测试证明完整 code 不会出现在：
- 单个分组的 `displayName`；
- `cardSerialLabel`；
- API response JSON；
- Worker 日志和审计 detail。

## 三、必须完成的实施任务

1. 等待真实 D1 schema 核验与卡密-分组关联 migration 设计批准。
2. 编写 D1 entitlement resolver：按 entitlement ID、device ID、token verifier 精确校验，不能按 device ID 列举授权后再筛选。
3. 编写 server-side classifier：从已验证 entitlement/card row 判断 CARD/IDENTITY；不能信任客户端传来的 kind/cardId。
4. 编写 D1 group loader：joined query 同时校验 card/admin/group 三者归属；FREE grant 按 device + admin 精确判断；free_group_enabled 规则不得被绕过。
5. 编写非敏感序列号 label resolver，并测试 redeem code 不可泄露。
6. 在 Batch 49 Worker 主路由正式注册 handler；加入 route-level integration tests，验证真实 Worker bundle 确实包含该路由。
7. 设计 APK credential store 和 API request/response 版本协商；未有 APK 证据前不能宣布兼容。
8. 最后再联调 generation/tombstone、24h cleanup 与 ACK。

## 四、验收状态

| 项目 | 状态 |
|---|---|
| 多卡密纯组合规则 | 已有隔离模块和测试 |
| 每条 entitlement token 独立验证契约 | 已有 service contract |
| 真实 D1 entitlement resolver | 未发现 |
| 真实 D1 card-group mapping loader | 未发现 |
| 免费授权 D1 loader | 未发现 |
| 非敏感序列号 label adapter | 未发现；service 未强制脱敏 |
| Protocol 65 注册 Batch 49 Worker | 未发现 |
| 正式 Worker 路由集成测试 | 未发现 |
| APK 多凭据持久化/协议 | 未验证 |
| 端到端 24h cleanup ACK | 未完成 |

## 五、上线判定

该功能不能标记为已完成。需要把“组合算法通过”与“正式 API/数据库/APK 可用”严格区分。当前不生成可部署版，不调整旧 APP 路由，不执行生产 D1 写入。
