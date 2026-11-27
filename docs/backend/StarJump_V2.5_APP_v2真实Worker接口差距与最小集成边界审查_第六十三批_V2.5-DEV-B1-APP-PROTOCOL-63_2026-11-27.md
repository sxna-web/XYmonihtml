# 星跃管理平台 V2.5｜APP v2 真实 Worker 接口差距与最小集成边界审查

- 批次：第六十三批
- 版本：`V2.5-DEV-B1-APP-PROTOCOL-63`
- 日期：2026-11-27
- 状态：只读源码差距矩阵 + 隔离测试；6/6 通过；未接入 Worker；D1_NOT_TESTED；APP_PENDING；不可部署。

## 1. 核查基线与证据

| 对象 | 仓库文件 | Blob SHA |
|---|---|---|
| 原始 Worker 基线 | `原始StarJump_V1点0_Final-zip-26-11-25-14:56/Worker.js` | `5da7aa3582558d9da2c2a0ad25a63c5e95e9fe63` |
| 模拟后台 HTML 1.4.61 | `星跃模拟后台 1.4.61.html` | `d046f71caa5af96b0c0978013771cb0a8f101739` |
| HTML/Worker 只读映射 | `docs/audits/StarJump_V2.5_HTML1.4.61_Worker_D1功能映射_2026-11-27.md` | `29c8e06883db294b33062555ad4861b70dcae5a0` |
| API 权限规范 | `docs/星跃管理平台V2.5_API接口与权限校验规范.md` | `6b6b15784dc95e142e352159530ab1b9f7c814c9` |
| D1 保护规范 | `docs/星跃管理平台V2.5_数据库结构与变更保护规范.md` | `f81a9eece3ca3f87f3493a47e7ff48344b9ed2c8` |

本批重新读取 AGENTS、功能基线、API 权限规范、D1 保护规范、总方案、进度及第五十七至六十二批相关报告。当前仓库原始 Worker/HTML 是版本化源码基线，不等同于 Cloudflare 线上正在运行的两个文件；没有线上读取证据，不对线上现状作判断。

HTML 1.4.61 源码静态计数：`/api/` 0、`fetch(` 0、`XMLHttpRequest` 0、`Authorization` 0、`Bearer ` 0；`localStorage` 19 处、`indexedDB` 8 处。结合既有映射报告，1.4.61 当前是本地模拟 UI，不是已接入 Worker 的生产前端。

## 2. 旧 APP 路由逐项差距

| 路由 | 旧认证/选择方式 | 旧数据范围 | 风险 | v2 处理边界 |
|---|---|---|---|---|
| POST `/api/app/redeem` | 卡密 + 客户端 device_id | 单卡创建一份 entitlement | 高 | 保留激活业务语义；增加卡密分组映射与原子设备名额；返回明确 entitlement |
| GET `/api/app/status` | 仅 device_id，无 Token 校验；取最新授权 | 设备级状态 | 严重 | 改为显式 entitlement ID + 绑定设备 ID + Token |
| GET `/api/app/nodes` | device_id + query Token；取最新 active entitlement | 管理员所有 enabled/approved 来源 | 严重 | 必须按该 entitlement 的 group allowlist 二次限制 source/node |
| GET `/api/app/groups` | device_id + query Token；取最新 entitlement；无 entitlement 时 free grant | 旧 public/assigned/free 模式；无 card_id 分组关系 | 严重 | 一次请求只读明确 entitlement；客户端合并多份 entitlement；免费组按管理员身份授权 |
| GET `/api/app/links` | device_id + query Token；取最新授权 | 该管理员全部 enabled links | 高 | 显式 entitlement 解析；管理员数据范围不得跨 entitlement 混用 |
| GET `/api/app/free` | 公开 admin ID/share code，无 device/Token | 直接返回免费节点 | 严重 | share code 只做绑定/发现，不授权读取节点 |
| GET `/api/app/resolve` | 公开 share code | 返回管理员 ID/name/free permission | 中 | 仅保留发现信息；加限流、防枚举和最小字段 |
| GET `/api/app/version` | 公开 | 发布元数据 | 低 | 保留 |
| GET `/api/app/download` | 公开 | 下载信息/链接 | 中 | 保留；单独验收文件完整性、版本归属和下载可用性 |
| GET `/api/user/app-cards` | 用户 Session | 当前用户卡密 | 高 | 历史查看按身份到期规则；写操作按 VIP 状态分动作鉴权 |
| POST `/api/user/app-cards` | 用户 Session + 通用 user scope | 创建本人卡密 | 严重 | 当前路由体未见有效 VIP 门禁；必须补有效 VIP 检查 |
| GET `/api/user/app-groups` | 用户 Session | 本人分组 | 中 | 只读可按普通用户规则；响应增加 card/free 关系时需契约版本 |
| POST/PUT/DELETE `/api/user/app-groups/*` | 用户 Session + owner 查询 | 本人分组/来源/成员 | 严重 | 当前路由体未见有效 VIP 门禁；必须补 VIP 写权限、generation 与原子性 |
| GET/POST/DELETE `/api/user/app-links/*` | 用户 Session | 本人入口链接 | 高 | 修改动作必须按确认的 VIP 权限边界鉴权 |
| `/api/super/app-groups/*` | 超管 Session | 跨管理员分组 | 高 | 保留超管边界；改成 owner/source 校验、原子写、审计和 generation |
| POST `/api/super/app-entitlements/:id/rebind` | 超管 Session | 直接更新 entitlement.device_id | 高 | 不能替代设备槽位解绑审批；应走可审计的释放/新设备预留流程 |

完整机器可读矩阵位于 `backend/worker/V2.5-DEV-B1-APP-PROTOCOL-63/integration-boundary.mjs`，共 16 项路由/路由族；每项都标记旧认证、授权选择、数据范围、风险、优先级和兼容策略。

## 3. 已确认的关键缺陷

### 3.1 授权选择错误

旧 `nodes/groups/links` 都通过 `device_id` 选择 `ORDER BY created_at DESC LIMIT 1` 的授权。一个 APP 用户使用同一管理员的多张有效卡密时，旧接口不能稳定表达每份 entitlement 的独立分组；不同管理员多授权也会出现最新授权遮蔽其他授权。

### 3.2 节点范围过宽

旧 `/api/app/nodes` 按 entitlement 的 `admin_user_id` 查询该管理员所有启用且审批通过的来源，并未先根据卡密分组映射形成 allowedGroupIds。因此它不能满足“卡密只读取该卡密配置分组”的已确认规则。

### 3.3 免费分享链路权限混淆

- `/api/app/resolve` 适合作为管理员身份发现/绑定入口，但不应作为数据授权凭据。
- `/api/app/free` 当前可只凭 admin ID/share code 返回免费节点，超出了“身份 ID 绑定免费组”的新授权边界。
- `/api/app/groups` 在无有效 entitlement 时可仅凭 device_id + app_free_grants 直接返回免费组节点。

新协议必须把管理员身份绑定与读取节点权限分开；免费组读取需要明确身份授权/设备绑定状态。

### 3.4 认证 Token 配置风险

旧 Worker 的 Token 是 HMAC-SHA256(entitlement_id|device_id)，但密钥使用 `env.SESSION_PEPPER || "starjump-app"` 固定回退。生产 v2 必须无密钥即 fail closed，不能使用公开固定默认值。

### 3.5 隔离 handler 的认证适配错误

第五十八批 `app-v2-handler.mjs` 先把 Bearer Token 交给 `resolveSession`，再把同一个值交给 entitlement resolver。第五十二批 resolver 所需的是 entitlement HMAC Token，而不是用户登录 Session Token。二者语义不同，因此该 handler 只能作为结构草案，不能直接接入。后续应由 adapter 直接调用 exact entitlement resolver，不应把 entitlement token 误判为登录 Session。

建议的新请求契约（待客户端支持/审计后冻结）：路径显式带 `entitlementId`，请求头带不透明 `X-App-Device-ID`，`Authorization: Bearer <entitlement-token>`；服务端用 secret-only key 验证该 entitlement/device 组合。客户端 device ID 仍是声明值，不是硬件证明。

## 4. 管理端权限与分组配置缺口

- 当前 `/api/user/app-cards` POST 创建卡密的函数体只检查 count/days/库存/总量；在该路由体中没有发现有效 VIP 状态检查。
- 当前 `/api/user/app-groups` 的 POST/PUT/DELETE 也没有发现有效 VIP 状态检查；源码注释明确普通注册用户可管理自己的分组，与已确认“接入星跃 APP/星链接分享修改仅有效 VIP 可做”的边界冲突。
- 旧 `APP_GROUP_MODES` 只有 public/assigned/free，没有 card 模式。
- 已检查的 DDL/Worker SQL 未发现 `app_card_groups` 或等价 `card_id -> group_id` 关联。
- 超管分组删除为多条独立 SQL；没有看到 generation/tombstone/客户端 ACK 写入。
- 超管 entitlement rebind 是直接改 device_id；不是设备解绑审批、旧槽位释放和新槽位原子预留。

## 5. 最小集成方案（建议分阶段实施）

### Stage 0：前置冻结

1. 读取并审计 6.00.48 源码及第三方授权/SDK/API/隐私；目前不可读取，保持 APK_PENDING。
2. 确认卡密过期/撤销后槽位释放时机、解绑审批人及释放后复用规则。
3. 提供明确隔离 D1；目前没有可确认隔离 D1，不做 SQL/D1 测试。
4. 核对真实 schema、迁移历史和实际 Worker binding；当前源码树不代表线上配置。

### Stage 1：新增隔离 v2 路由，不动旧路径

1. 以第五十二批 exact resolver 为唯一 entitlement 身份解析器。
2. 修正第五十八批 handler 的错误认证接法，新增 adapter 直接传入 entitlementId/deviceId/token 并调用 resolver。
3. 以第五十九批 loader 获取卡密组、管理员免费组、free grant 和权限；joined query 必须同时校验 card owner/group owner。
4. 以第六十批 composition 组合每份 entitlement 的卡密组；同管理员免费组按 group ID 去重；同管理员卡密同名组加序列号后缀。
5. slot adapter 只有在 migration 获批并通过隔离 D1 并发测试后才可启用。
6. 新路由使用独立 `/api/app/v2/*` namespace；默认 feature flag OFF；缺 Secret、schema 或 adapter 时 fail closed。

### Stage 2：客户端兼容

- 客户端为每张卡密保存独立 entitlement ID/token；管理员身份免费授权独立保存。
- 每个读取请求显式携带 entitlement，不再使用 latest entitlement。
- Room 增加 entitlement/group/generation/lease/cursor/ack 映射，先替换 destructive fallback 并通过非破坏性 migration 测试。
- 实现 generation/tombstone/ack、租约不超过 23 小时、启动/回前台/连接前检查租约。
- 在 6.00.48 源码未审计前，不宣称客户端兼容、不修改 APK。

### Stage 3：受控切换

- 只对已审计、支持 v2 协议的客户端开启 v2。
- 先隔离 D1/测试 APP 完成多卡密、多管理员、free 去重、同名序列号、设备占额、过期/撤销、24 小时清理、离线租约测试。
- 对旧客户端保留明确迁移窗口；不得将旧请求静默映射到“最新授权”。
- 生产部署必须另行获得用户明确授权。

## 6. Feature flag 与回滚

建议 flags（均默认 OFF）：
- `APP_V2_READS_ENABLED`
- `APP_V2_CARD_GROUPS_ENABLED`
- `APP_V2_DEVICE_SLOTS_ENABLED`
- `APP_V2_SYNC_ACK_ENABLED`

任一 flag 未开启或依赖缺失，v2 路由不得运行。初次接入只新增路由和 adapter，不重写旧接口。回滚时关闭 v2 flags 并 revert 新增 adapter/router；不删除 entitlement、设备记录、卡密或审计数据。数据库变更单独审批，不假设 DROP TABLE 是回滚方案。

## 7. 本批实现与测试

新增：
- `backend/worker/V2.5-DEV-B1-APP-PROTOCOL-63/integration-boundary.mjs`
- `backend/worker/V2.5-DEV-B1-APP-PROTOCOL-63/integration-boundary.test.mjs`
- `backend/worker/V2.5-DEV-B1-APP-PROTOCOL-63/README.md`
- `.github/workflows/worker-app-protocol63-tests.yml`

CI Run `45970083786` 首次运行发现测试预期计数写错（实际 critical routes 6 项，测试误写 5 项），保留失败记录；修正断言后 Run `45970232967` completed/success：
- Node.js 22 语法检查通过；
- 6/6 tests passed，0 failed；
- Job `140408574105`。
- 成功 Run：https://github.com/sxna-web/XYmonihtml/actions/runs/45970232967
- 首次失败 Run：https://github.com/sxna-web/XYmonihtml/actions/runs/45970083786

测试只验证路由矩阵完整性和风险标签，不是 Worker runtime、D1 或 Android 联调测试。

## 8. 数据库、兼容、回滚和部署状态

- D1：未连接、未查询、未执行 SQL、未创建 migration。
- Worker：只读审计；未修改原始 Worker；v2 helper 未接入。
- HTML：只读审计；未修改 1.4.61 HTML。
- APK：未修改、未构建、未安装；6.00.48 未审计，APK_PENDING。
- Secrets/Cloudflare：未读取/修改；未部署。
- 线上两份文件的实际版本与配置未由 Cloudflare 读取，本批结论仅适用于仓库源码。

## 9. 第六十四批唯一接手卡

**APP v2 entitlement Token 认证适配器与精确读取 Handler（隔离编码 + mock 测试，不接 Worker）。**

1. 重读 AGENTS、功能基线、API/D1 保护规范、总方案、进度及第五十一至六十三批报告。
2. 修正第五十八批 handler 的 Session/entitlement token 语义冲突；建立独立 adapter：显式 entitlementId + deviceId + HMAC Token -> 第五十二批 resolver。
3. adapter 对 Secret 缺失、Token 验证失败、entitlement 过期、device 绑定不匹配、D1 异常统一 fail closed。
4. 读取 groups/nodes/links/status 只允许使用解析出的 entitlement context；客户端传入 adminId 不得成为数据查询依据。
5. 加入精确 entitlement 请求、同设备多 entitlement、不允许 latest fallback、跨管理员隔离、空分组和异常状态测试。
6. 保留 legacy API 不变；不接入生产 Worker，不改 HTML/APK/D1/Secrets，不部署。
7. 若 6.00.48 或隔离 D1 仍不可用，继续记录 APK_PENDING/D1_NOT_TESTED，不虚报联调完成。
8. 更新进度、总方案和第六十五批接手卡。
