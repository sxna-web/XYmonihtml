# 星跃管理平台 V2.5｜APP v2 身份 ID 免费组发现/绑定 Resolver 与多卡密组合边界审查

- 批次：第六十六批
- 版本：`V2.5-DEV-B1-APP-IDENTITY-66`
- 日期：2026-11-27
- 状态：**隔离 DEV 已编码；最终 CI 23/23 通过；未接入 Worker；D1_NOT_TESTED；APP_PENDING；不可部署**
- 仓库：`sxna-web/XYmonihtml` / `main`
- 原始 Worker 只读基线 Blob SHA：`5da7aa3582558d9da2c2a0ad25a63c5e95e9fe63`
- 依据：AGENTS、功能基线、API 权限规范、D1 保护规范、仓库目录规范、总方案、进度、第五十一至六十五批 APP 报告。

## 1. 本批任务与影响分析

任务：只读审计旧身份 ID/share-code 路径；在隔离目录实现身份发现、设备绑定、独立身份凭证验证、免费分组读取和与卡密分组组合边界；使用 mock adapter 测试，不接生产 Worker。

影响范围：
- 仅新增 `backend/worker/V2.5-DEV-B1-APP-IDENTITY-66/` 和对应 GitHub Actions。
- 不改原始 Worker、当前 Worker、HTML、APK、Room、D1、Secrets、Cloudflare 配置。
- 不新增数据库 SQL 或 migration。
- 回滚：停止引用本隔离目录或 revert 本批新增文件即可，不影响旧路由或数据。

## 2. 原始 Worker 只读审计结果

核查文件：`原始StarJump_V1点0_Final-zip-26-11-25-14:56/Worker.js`，Blob SHA 如上。

### 2.1 `GET /api/app/resolve`

原始函数 `appResolveRoute`：
- 读取 query 的 share code，格式校验后查询 `admin_share_codes`；
- 通过 `app_users` 读取管理员用户名；
- 读取 `admin_app_perms.free_group_enabled`；
- 返回 share code、admin_user_id、admin_name、free_group_enabled。
- 函数中未见设备 ID、设备密钥、challenge、签名证明、绑定关系或限流处理。
- 路由注册为公开 GET。全局 handler 虽尝试解析 session，但该路由不要求成功 session 才能执行。

结论：它只能算公开编号发现接口，不是可信设备绑定或身份授权凭证。

### 2.2 `GET /api/app/free`

原始函数 `appFreeGroupRoute`：
- 可直接接收客户端 query 的 `admin`；没有该参数时再通过 `code` 查询管理员；
- 只检查管理员 `free_group_enabled`；
- 随后按该管理员 `source_ownership`、已启用来源和 `tier='free'` 查询节点，直接返回节点 URI、服务器、端口等内容；
- 未要求先建立设备绑定或提交可验证 identity credential；
- 当前代码路径未见有效 VIP 状态二次校验或 durable rate-limit。

结论：该路由不是纯发现/绑定接口，而是公开节点数据读取边界。未来 v2 不应继续用公开 admin ID/share code 直接读取节点；必须先验证独立身份凭证，再用服务端绑定上下文读取管理员免费组。

### 2.3 相关表定义与实际写入

原始 Worker 内嵌 DDL：
- `admin_share_codes`：`admin_user_id`、`code`、`created_at`；未见 version、active/revoked、expires_at 或轮换历史字段。
- `app_free_grants`：`device_id`、`admin_user_id`、`granted_at`。
- `admin_app_perms`：`admin_user_id`、`links_enabled`、`max_links`、`free_group_enabled`、`updated_at`。
- 未发现专门的 identity binding/challenge/request nonce 表或等价记录。

原始 APP redeem 会插入 `app_free_grants(device_id, admin_user_id)`。该记录来自卡密激活，属于设备＋管理员维度免费资格，不包含 share code、设备公钥指纹、challenge、绑定状态或 identity token 证明。因此不能把它误当作身份 ID 已完成绑定。

分享编号生成使用随机字节生成短码；`ensureShareCode` 已存在编号时直接返回，没有发现用户侧轮换/撤销接口。原始 DDL 与代码只能证明该快照的行为，不能证明 Cloudflare 线上 Worker/D1 当前状态。

## 3. 本批隔离实现

新增文件：
- `backend/worker/V2.5-DEV-B1-APP-IDENTITY-66/identity-token.mjs`
- `backend/worker/V2.5-DEV-B1-APP-IDENTITY-66/identity-binding-service.mjs`
- `backend/worker/V2.5-DEV-B1-APP-IDENTITY-66/identity-binding-service.test.mjs`
- `backend/worker/V2.5-DEV-B1-APP-IDENTITY-66/README.md`
- `.github/workflows/worker-app-identity66-tests.yml`

### 3.1 发现

- 公开 share code 只返回最小展示名和 `freeGroupAvailable`。
- 不返回 admin_user_id、节点、分组、身份 token。
- 未知、撤销、过期、免费开关关闭或管理员不符合资格时，使用同一通用失败结果，降低编号枚举信息。
- 发现请求先经过注入式 durable rate limiter；不能用 Worker 单实例内存计数代替。

### 3.2 绑定

绑定必须经过一次性 challenge 和设备公钥持有证明：
- challenge 必须绑定 device ID、服务端解析出的 admin ID、share code version；
- challenge verifier 必须原子检查有效期、单次使用、签名、公钥指纹和 code version；
- binding repository 必须原子保证 `(admin_user_id, device_id)` 唯一；
- 同一管理员＋同一设备重复绑定幂等；同一设备绑定不同管理员时保留独立记录。

本批 challenge verifier 和 binding repository 是依赖注入接口，未实现真实 D1 存储，也没有伪称当前 APP 已能生成设备证明。

### 3.3 独立身份 Token

- 新增独立 `APP_IDENTITY_SECRET` HMAC-SHA256 Token adapter。
- 与 `APP_ENTITLEMENT_SECRET`、用户 Session Token 分离；缺少/过短 Secret 时 fail closed。
- Token claims 绑定 binding ID、管理员 ID、device ID、设备公钥指纹、签发时间和过期时间。
- TTL 默认 1 小时，硬上限 23 小时。
- 身份 Token 不是 entitlement ID，不复用 entitlement token 的 ID 语义。
- 每次受保护读取都必须重新核对 binding 行、管理员账号状态、有效 VIP 管理员身份、免费组开关。
- 每次读取还要求新的 server-issued request nonce 和设备私钥签名；注入式 `verifyDeviceRequestProof` 必须验证公钥持有证明并原子消费 nonce，防止仅复制 bearer token 和伪造 device ID。
- 绑定撤销、设备不符、公钥指纹不符、Token 过期、nonce 重放、签名错误、管理员不再有效或免费组关闭，全部 fail closed。

### 3.4 分享码轮换/撤销语义（技术提案，生产前需确认）

本批测试采用以下提案：
- 轮换/撤销旧 code 后，旧 code 不能创建新绑定。
- 仅轮换 code 不静默删除既有设备绑定；既有绑定继续受 binding revoke、VIP/账号状态和免费组开关控制。
- 管理员可单独撤销具体设备绑定；撤销后下一次服务端验证立即拒绝。
- 关闭免费组或管理员失去有效资格，会阻断新绑定及既有身份读取。

这是为了避免换码时无提示清空现有用户关系的技术建议，不是已批准的生产业务规则。实际 UI、旧 code 保留策略、是否轮换同时撤销既有绑定，需要后续确认。

### 3.5 身份免费组与卡密组合

- 身份凭证只解析成独立 `kind: IDENTITY` 上下文；不创建伪 entitlement。
- 免费组加载器只接收可信绑定记录中的 adminUserId，不接收客户端 adminId。
- 多份 identity credential 属于同一管理员时，管理员免费组只加载一份。
- 不同管理员免费组按 `(admin_user_id, group_id)` 隔离。
- `mergeIdentityFreeGroupsWithCardComposition` 将身份免费组与第六十五批卡密组合结果合并：同一管理员相同免费组只出现一次；不同管理员免费组独立；卡密专属组不被覆盖或合并。
- 分组读取仅返回分组元数据，不直接返回节点 URI；节点读取必须继续通过已验证身份上下文和 owner-safe group loader。

## 4. 测试证据

最终 GitHub Actions：
- Run `45978198685` completed/success
- Node.js 22 语法检查通过
- 23 tests passed / 0 failed
- Job：`140435174424`
- 链接：https://github.com/sxna-web/XYmonihtml/actions/runs/45978198685

23 项覆盖：
1. 公开发现不返回 admin ID/token/节点；
2. 未知、撤销和不符合资格编号使用统一错误；
3. 发现与绑定限流；
4. 设备 challenge proof 错误拒绝；
5. 同管理员同设备重复绑定幂等；
6. 同设备不同管理员独立绑定；
7. 同管理员多个 identity credential 只加载一份免费组；
8. 免费组关闭或 VIP 失效阻断既有身份读取；
9. 非有效 VIP 管理员不能绑定；
10. 轮换旧 code 不可新绑定，既有绑定按提案保留；
11. 绑定撤销立即拒绝；
12. Token 不能跨设备使用；
13. 客户端 admin ID 不改变签名上下文；
14. 伪造其他管理员 Token 因 binding mismatch 被拒绝；
15. group loader 跨管理员数据被拒绝；
16. 身份免费组与卡密 free group 按管理员＋group ID 去重；
17. 同 ID 冲突名称 fail closed；
18. 缺少 APP_IDENTITY_SECRET fail closed；
19. Token 篡改和过期拒绝；
20. challenge 绑定服务端管理员及 code version；
21. binding/eligibility 数据访问异常 fail closed；
22. 多 credential 混入无效凭证时不部分返回；
23. 每次读取必须提供设备私钥证明，缺失/错误证明拒绝。

开发过程中多个早期 Run 因测试 fixture 未同步新增依赖而失败，均保留历史记录；最终以 Run `45978198685` 为验收依据。

## 5. 当前明确阻塞与安全边界

- 原始 `admin_share_codes` schema 没有 code version/revocation 状态；本批 adapter 要求 codeVersion，真实 D1 adapter 无法直接从已观察旧表得到该值。
- 当前未发现 identity binding、challenge、request nonce 持久化结构；不能把内存 Map 作为生产方案。
- durable rate limiter、challenge 单次消费、binding upsert、nonce 消费都必须由后续参数化 D1/受控存储 adapter 原子实现。
- `APP_IDENTITY_SECRET` 未配置；没有读取或写入 Cloudflare Secrets。
- APP 6.00.48 未解包审计，无法确认 Android Keystore、公钥注册、挑战签名、每次请求签名和 nonce 协议是否能接入；APP_PENDING。
- 设备证明服务层 mock 不等于 Android 设备证明或硬件密钥保护已完成。
- 管理员有效 VIP/账号状态检查目前是注入 adapter；原始 `/api/app/free` 只看 free_group_enabled 的问题没有改动。
- D1_NOT_TESTED；未连接生产或 staging D1；未执行 SQL、未创建 migration。
- 未修改 Worker/HTML/APK/Room/Secrets；未注册任何路由；未部署。
- 本批 CI 只证明 Node.js mock/WebCrypto 单元测试，不证明 Cloudflare Workers runtime、真实 D1、客户端或生产安全性。

## 6. 第六十七批唯一接手卡

**APP v2 identity challenge / nonce / binding 持久化状态机与并发契约测试（隔离实现，不接 D1、不接 Worker）。**

1. 重读 AGENTS、功能基线、API/D1 保护规范、总方案、进度及第五十一至六十六批报告。
2. 为 bind challenge、每次 request nonce、identity binding 和 share-code version 设计状态机及最小数据契约；标明哪些字段是新增设计、哪些来自现有表。
3. 建立 mock durable-store adapter，验证 challenge 单次消费、nonce 防重放、绑定唯一约束、并发重复 bind 幂等、撤销与轮换竞态、过期清理。
4. 验证多个 Worker 并发/重试下不能重复消费 challenge/nonce 或创建重复绑定；不能只依赖单实例内存锁。
5. 对照第六十六批 service 的接口，输出后续 D1 adapter 所需契约和迁移前只读核查清单。
6. 真实 D1 schema 未核实前，不生成可执行 migration，不执行 SQL。
7. 不修改 Worker/HTML/APK/Room/D1/Secrets，不接生产路由、不部署。
8. 更新进度、总方案和第六十八批接手卡。
