# 星跃管理平台 V2.5｜APP v2 多卡密分组组合与精确授权 Handler 集成报告

- 批次：第六十五批
- 版本：`V2.5-DEV-B1-APP-PROTOCOL-65`
- 日期：2026-11-27
- 状态：**隔离 DEV 已编码；最终 CI 26/26 通过；未注册生产 Worker 路由；D1_NOT_TESTED；APP_PENDING；不可部署**
- 仓库：`sxna-web/XYmonihtml` / `main`
- 依据：根目录 AGENTS、功能基线、API 权限规范、D1 保护规范、连续性总方案、进度记录及第五十九、六十、六十四批实现与报告。

## 1. 本批目标

将每份 APP entitlement 的精确授权解析与多卡密分组组合串联，覆盖：
- 同一 APP 用户持有同一管理员多张有效卡密时，各卡密分组独立保留；
- 同一管理员免费分组只出现一份；
- 不同管理员免费分组独立；
- 同名卡密分组标注各自卡密序列号；
- 空卡密分组不扩大权限；
- 每份 entitlement 都必须独立认证，不能按设备取 latest；
- 批量请求中任一凭证无效或任一数据范围异常，整次组合 fail closed。

## 2. 新增文件

- `backend/worker/V2.5-DEV-B1-APP-PROTOCOL-65/composed-group-service.mjs`
- `backend/worker/V2.5-DEV-B1-APP-PROTOCOL-65/composed-groups-handler.mjs`
- `backend/worker/V2.5-DEV-B1-APP-PROTOCOL-65/composed-group-service.test.mjs`
- `backend/worker/V2.5-DEV-B1-APP-PROTOCOL-65/README.md`
- `.github/workflows/worker-app-protocol65-tests.yml`

复用：
- 第五十九批依赖注入式 `group-loader.mjs` 契约；
- 第六十批 hardened `group-composition.mjs` 投影和去重逻辑；
- 第六十四批精确 entitlement resolver/Token adapter 的接口契约。

## 3. 隔离 API 契约提案

本批只新增隔离 handler，尚未注册到生产 Worker：

`POST /api/app/v2/groups/composed`

Header：
- `X-App-Device-ID`

JSON body：
```json
{
  "credentials": [
    { "entitlementId": "entitlement-id-1", "token": "entitlement-token-1" },
    { "entitlementId": "entitlement-id-2", "token": "entitlement-token-2" }
  ]
}
```

安全约束：
- 每个 credential 分别调用精确 resolver，传入 entitlementId、同一个 deviceId 和对应 Token。
- 同一请求最多 20 份 credential；请求体最大 32 KiB；Token 不放 URL。
- entitlement ID 重复、device 不同、Token 错误、过期/撤销授权、解析器异常，整批拒绝。
- 不使用 latest entitlement，不接受客户端 adminId 作为授权范围。
- 响应 `cache-control: no-store`；错误不输出 SQL、堆栈、Token 或内部凭证。

## 4. 分组组合规则

1. 每份 CARD entitlement 只装载其自身 card_id 映射的 card groups。
2. 只有注入的 group loader 确认 grant 和管理员免费组开关时，该 entitlement 才能贡献免费组。
3. 同管理员免费组按 group ID 去重；不同管理员使用独立去重空间。
4. 同名卡密分组分别保留，追加服务端安全序列号标签，例如 `香港节点（1 序列号）`、`香港节点（2 序列号）`。
5. IDENTITY 分类仅允许免费组，不允许注入卡密组。
6. 空卡密分组保持空，不会回退成管理员全部分组。
7. 每个 entitlement 的 allowlist 必须与 cardGroups + freeGroups 的实际 ID 集合完全一致。
8. group owner、mode、enabled、ID 重复或 allowlist 不匹配均 fail closed。
9. 响应只投影业务需要的分组字段和安全序列号标签；不返回内部 cardId、entitlementId、卡密原文或任意数据库列。

## 5. 一个重要的数据模型边界

已读第五十四批 schema 静态核查记录：已观察的旧 Worker `app_entitlements` 字段含 `card_id`，但没有证据证明存在通用 `kind` 字段。因此本批没有把 kind 当成数据库既有字段，而是强制注入服务端 `classifyEntitlement`，由后续真实 schema/授权关联适配器从可信服务端数据分类，并校验 CARD 的 cardId 与已解析 entitlement.card_id 一致。不得从客户端请求传入 kind/cardId。

此外，管理员身份 ID 获取免费组的真实授权凭证路径仍需单独核对。当前批次对 IDENTITY 只测试了服务层抽象契约；第六十四批精确 entitlement resolver 本身并不能证明现有身份 ID/share-code 路径已经成为可验证的 IDENTITY Token。未完成身份发现/绑定专用 resolver 前，不得宣称 APP 身份 ID 免费组链路已接通。

## 6. 测试证据

最终 GitHub Actions：
- Run `45976476574` completed/success
- Node.js 22 语法检查通过
- 26 tests passed / 0 failed
- Job：`140429360630`
- 链接：https://github.com/sxna-web/XYmonihtml/actions/runs/45976476574

覆盖 26 项：
- 同管理员多卡密卡密组保留、免费组去重；
- 同名分组序列号标记；
- 不同管理员免费组隔离；
- IDENTITY 只贡献免费组的服务层契约；
- 空卡密组不扩大；
- 每个 Token 按精确 ID 独立解析；
- 混入无效 entitlement 整批拒绝；
- 重复凭证、跨设备拒绝；
- resolver/loader/序列号加载异常 fail closed；
- owner/mode/allowlist/重复 group 校验；
- 服务端分类器缺失、无效及卡密 ID 错配拒绝；
- HTTP Handler POST 契约、no-store、错误隐藏、请求大小与数量限制；
- 真实组合 service + HTTP handler 端到端 mock 集成；
- 最小响应投影不泄露内部 card/entitlement 标识。

首次 Run `45975792137` 因测试代码括号语法错误失败，保留失败记录；修正后 Run `45975922041` 通过，增加端到端用例后 Run `45976058572` 通过；加入服务端分类器和最小响应投影后，最终 Run `45976476574` 通过。以最终 Run 为验收依据。

## 7. 风险、兼容和未完成

- 本批 endpoint 只是隔离提案，没有注册进现有 Worker；旧 API/第六十四批 handler 均未修改。
- `resolveEntitlement`、`classifyEntitlement`、`loadGroupsForEntitlement`、`loadCardSerialLabel` 均为依赖注入；没有真实 D1 SQL adapter。
- 真实 D1 schema、卡密分组关联表、免费授权绑定表、管理员免费组开关与 card serial 字段均未在隔离 D1 核实；不创建 migration、不猜字段。
- IDENTITY 免费组实际认证/绑定路径未完成，仍需单独设计和测试。
- 同一用户多卡密跨管理员组合虽由服务层隔离测试覆盖，但 APK 6.00.48 客户端是否能保存并提交多份 Token 未知。
- 6.00.48 未读取/审计，APP_PENDING；D1_NOT_TESTED。
- 未修改 Worker、HTML、APK、Room、D1、Secrets；未连接生产/staging；未部署。
- 本批 26/26 仅代表 Node.js mock resolver/loader + HTTP handler 测试，不代表 Cloudflare Workers runtime、真实 D1 或 Android 联调。

## 8. 回滚

本批只新增隔离文件和 workflow。回滚时停止引用该目录或 revert 本批新增提交即可；不涉及 SQL、数据删除、旧路由切换或生产配置。

## 9. 第六十六批唯一接手卡

**APP v2 身份 ID 免费组发现/绑定 resolver 与卡密 entitlement 组合边界审查（隔离设计 + mock 测试，不接 Worker）。**

1. 重读 AGENTS、功能基线、API/D1 保护规范、总方案、进度及第五十一至六十五批报告。
2. 只读核对原始 Worker 中 `/api/app/resolve`、`/api/app/free`、`admin_share_codes`、`app_free_grants`、`admin_app_perms` 的实际调用链和数据边界。
3. 明确身份 ID/share code 只负责发现/绑定，不能仅凭公开 ID 读取节点/分组；必须有服务端绑定状态、设备绑定、限流/防枚举和管理员授权检查。
4. 设计独立 IDENTITY credential resolver；不把 identity ID 当 entitlement ID，不复用卡密 HMAC 语义，除非有可信的服务端签发凭证方案。
5. 将 identity 免费组和多张 CARD entitlement 的组合边界写成 mock tests：同管理员免费组只一份、不同管理员隔离、重复绑定幂等、禁用免费组拒绝、share code 轮换/撤销、跨设备/跨管理员拒绝。
6. 不读取或泄露真实 share code、卡密、Token；不执行 SQL、不创建 migration。
7. 不修改 Worker/HTML/APK/D1/Secrets，不接生产路由、不部署。
8. 更新进度、总方案和第六十七批接手卡。
