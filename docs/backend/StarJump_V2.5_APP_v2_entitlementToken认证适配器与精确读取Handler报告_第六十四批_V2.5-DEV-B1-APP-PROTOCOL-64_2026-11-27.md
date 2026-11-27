# 星跃管理平台 V2.5｜APP v2 entitlement Token 认证适配器与精确读取 Handler 报告

- 批次：第六十四批
- 版本：`V2.5-DEV-B1-APP-PROTOCOL-64`
- 日期：2026-11-27
- 状态：**隔离 DEV 已编码；GitHub Actions 23/23 通过；未接入现有 Worker；D1_NOT_TESTED；APP_PENDING；不可部署**
- 仓库：`sxna-web/XYmonihtml` / `main`
- 依据：AGENTS、功能基线、API 权限规范、D1 保护规范、工具连续性总方案、进度日志及第五十一至六十三批 APP 报告。

## 1. 本批目标与范围

修正第五十八批 handler 把 APP entitlement Bearer Token 先交给用户 Session resolver 的认证语义错误。新建独立版本目录，使用显式 entitlementId + deviceId + HMAC Token 直接调用第五十二批精确 resolver；提供 groups/nodes/links/status 四类读取边界和 mock D1 测试。

本批未修改第五十八批历史文件，避免覆盖历史证据；第六十四批新 Handler 是后续隔离集成候选，明确取代第五十八批 handler 的错误认证接法。

## 2. 变更文件

新增：
- `backend/worker/V2.5-DEV-B1-APP-PROTOCOL-64/entitlement-token-adapter.mjs`
- `backend/worker/V2.5-DEV-B1-APP-PROTOCOL-64/app-v2-read-handler.mjs`
- `backend/worker/V2.5-DEV-B1-APP-PROTOCOL-64/app-v2-read-handler.test.mjs`
- `backend/worker/V2.5-DEV-B1-APP-PROTOCOL-64/README.md`
- `.github/workflows/worker-app-protocol64-tests.yml`

## 3. 认证与读取边界

### 3.1 Token adapter

- APP Bearer Token 只作为 entitlement Token，不调用 Session resolver。
- HMAC 输入按现有 Worker 静态源码观察到的格式：`entitlementId|deviceId`；SHA-256 HMAC 输出 base64url。
- 仅接受专用 `APP_ENTITLEMENT_SECRET`，长度至少 32 字符；缺失或过短直接 fail closed。
- 不使用 `SESSION_PEPPER`，不保留 `starjump-app` 固定默认回退。
- HMAC verifier 在 adapter 初始化时创建并缓存；比较使用固定长度处理的常量时间比较。
- adapter 将显式 entitlementId/deviceId/token 交给第五十二批 resolver；resolver 仍通过参数化查询同时匹配 entitlement ID 与 device ID，不取 latest，不接受客户端 admin ID。

### 3.2 Handler

请求契约（仅 DEV 设计，客户端尚未确认兼容）：
- 路径：`/api/app/v2/entitlements/:entitlementId/{groups|nodes|links|status}`
- Header：`X-App-Device-ID`
- Header：`Authorization: Bearer <entitlement-token>`

四类资源全部先经过精确 entitlement 解析：
- groups：校验组 ID 唯一、管理员归属一致、启用状态及 card/free 类型。
- nodes：只允许 scope 中的 allowedGroupIds；空 allowlist 直接返回空数组，不调用节点 loader；返回结果再次核对管理员和 groupId。
- links：使用同一 entitlement context 和 group allowlist，复核管理员归属及可选 groupId。
- status：只把已解析 entitlement 传给 status loader。
- 客户端附带的 adminId 不作为查询依据。
- 不匹配、过期、撤销、D1 异常、Secret 缺失和 loader 异常均拒绝或 fail closed，不泄露内部 SQL/密钥。

## 4. 测试计划与实际结果

GitHub Actions：
- 首次 Run `45972711669`：**失败，保留历史**。日志定位到 mock entitlement fixture 未包含 active 状态，以及缺失 Secret 测试错误使用了 JavaScript 默认参数（传 undefined 会触发默认值）。
- 修正 fixture 后 Run `45972878003`：23/23 通过。
- verifier 缓存优化后最终 Run `45973150016`：completed/success；Node.js 22 语法检查通过；23 tests passed / 0 failed。
- 最终运行链接：https://github.com/sxna-web/XYmonihtml/actions/runs/45973150016
- Job：`140418252877`。

覆盖内容：
1. 正确 HMAC 验证与精确 entitlement；
2. 同设备两份 entitlement 独立读取；
3. A Token 不能认证 B entitlement；
4. 专用 Secret 缺失/过短拒绝；
5. 不回退到 SESSION_PEPPER；
6. device header 缺失/错误、Bearer 格式错误拒绝；
7. D1 异常、entitlement 过期/撤销拒绝；
8. 客户端伪造 adminId 不改变服务端范围；
9. 空 allowlist 不触发节点查询；
10. 越组节点、跨管理员节点/分组/链接拒绝；
11. 重复 allowlist 拒绝；
12. status 仅使用精确 entitlement context；
13. 未知路径和非 GET 请求拒绝。

## 5. 影响、兼容和风险

- 原始 Worker、HTML、D1、Secrets、APK 均未修改。
- 第五十八批旧 handler 文件未覆盖；新目录仅提供修正后的隔离实现。
- 该 handler 的 injected loaders 仍必须实现参数化、owner-safe SQL；mock 测试不证明真实 D1 查询正确。
- 当前旧 Worker 的 legacy token 仍使用 SESSION_PEPPER/固定回退行为；本批没有改变旧客户端 Token，也没有让旧 API 自动切换到新协议。
- `APP_ENTITLEMENT_SECRET` 尚未在任何环境配置；本批没有读取或写入 Cloudflare Secrets。
- 6.00.48 APK 源码仍不可读取，Header Token / X-App-Device-ID / 多 entitlement 客户端兼容未验证，保持 APP_PENDING。
- 没有明确隔离 D1，未连接生产或 staging；保持 D1_NOT_TESTED。
- 不涉及数据库 schema、migration、slot 生命周期、设备解绑审批或 24 小时客户端清理实施。

## 6. 回滚方式

本批仅新增隔离文件。回滚时可停止引用第六十四批模块或 revert 本批新增提交；不删除任何数据库记录，不需要 SQL，不影响旧 Worker 路由。不要将本批模块接入线上作为回滚测试。

## 7. 结论

本批完成的是 **Node.js mock D1 + WebCrypto 隔离认证/Handler 测试**。它修正了 Session Token 与 entitlement Token 混用的代码结构问题，但没有接入 Worker、没有验证真实 D1、没有验证 APK 客户端、没有部署。当前不可部署。

## 8. 第六十五批唯一接手卡

**APP v2 group loader / card-free scope 与 Handler 组合集成测试（继续隔离，不接 Worker）。**

1. 重读 AGENTS、功能基线、API/D1 保护规范、总方案、进度及第五十一至六十四批报告。
2. 复核第六十四批最终 CI Run `45973150016` 和最终文件 SHA。
3. 对照第五十九/六十批 group loader、composition、projection helper，建立第六十五批 adapter，将每个 entitlement 的 card groups 与管理员 free group 精确组合。
4. 覆盖同一管理员多卡密免费组只一份、同名 card group 追加序列号、不同管理员免费组隔离、空卡密分组、重复 entitlement/group ID fail closed。
5. 读取接口继续显式 entitlement context；不得引入 latest fallback 或客户端 adminId 查询。
6. 若 loader 所需 schema 字段仍未在真实隔离 D1 核实，只做 mock contract 测试并标记 D1_NOT_TESTED；不得编造生产 SQL 或 migration。
7. 不修改 Worker/HTML/APK/D1/Secrets，不连接生产/ staging，不部署。
8. 更新进度、总方案和第六十六批接手卡。
