# 星跃管理平台 V2.5｜APP 卡密分组授权关系与读取接口数据契约核查报告

- 批次：第五十四批
- 版本：`V2.5-DEV-B1-APP-SCHEMA-54`
- 日期：2026-11-27
- 状态：**仓库源码数据契约核查完成；卡密分组关联缺失已确认；实施受阻；未修改业务代码；不可部署**
- 仓库：`sxna-web/XYmonihtml` / `main`
- Worker 核查基线：`backend/worker/V2.5-DEV-B1-CORE-AUTH-49/Worker.js`
- Worker Blob SHA：`a4689380215e95c1c9f605fc974cc553b3e7037f`

## 1. 核查范围和证据边界

已重新读取：
- 根目录 `AGENTS.md`；
- 功能基线、API 权限校验规范、数据库结构保护规范、仓库目录规范；
- 工具可靠性总方案、开发进度；
- 第五十一、五十二、五十三批 APP 报告；
- 第四十九批 Worker 完整源码、第五十批 Worker.fetch 测试；
- 仓库现有迁移目录和本地迁移验证器说明。

仓库当前 main 的递归 Tree 未发现 APP 业务 DDL 专用 migration；第四十九批 Worker 内含 `ensureSchema` 的内嵌建表定义。该源码只能证明该 Worker 版本声明过这些字段，不能证明正式 D1 当前实际 schema、已执行迁移历史或线上 Worker 版本。

本批未连接 D1/Wrangler/Cloudflare，不读取生产 schema，不推断生产环境状态。

## 2. 已确认的 APP 数据表结构（仅第四十九批 Worker 内嵌 DDL）

| 表 | 源码定义字段 | 已证实的关系含义 |
|---|---|---|
| `app_cards` | id, code, admin_user_id, days, status, inactive_reason, inactive_at, restored_at, manual_disabled, expires_at, activated_at, used_at, created_at | 卡密归属管理员；无 group_id 或分组配置字段 |
| `app_entitlements` | id, admin_user_id, device_id, card_id, starts_at, expires_at, purge_at, status, created_at | 一次设备授权关联一张卡密，并保存管理员和设备 |
| `app_groups` | id, admin_user_id, name, mode, sort, enabled, created_at | 分组归属管理员，mode 为 public/assigned/free |
| `app_group_sources` | group_id, source_id | 分组关联订阅来源 |
| `app_group_members` | group_id, device_id | 分组按设备指定成员，不按卡密指定 |
| `app_free_grants` | device_id, admin_user_id, granted_at | 设备永久保留某管理员免费分组资格 |
| `admin_share_codes` | admin_user_id, code, created_at | 管理员身份分享编号 |
| `admin_app_perms` | admin_user_id, links_enabled, max_links, free_group_enabled, updated_at | 管理员 APP 功能开关 |

### 核心结论

在已检查的 Worker DDL 与全文件引用中：
- 没有发现 `app_card_groups`、`app_card_group_assignments` 或等价的 card_id → group_id 关联表；
- `app_cards` 本身没有分组配置字段；
- `app_group_members` 仅以 group_id + device_id 指定设备；
- `app_free_grants` 仅以 device_id + admin_user_id 保留免费分组资格；
- `app_entitlements.card_id` 是当前唯一可追溯到原始卡密的授权关联，但没有被连接到任何卡密分组映射。

因此，当前源码没有实现“管理员给某张 APP 卡密配置一组/多组专属节点分组”的数据关系。不能把 device-level assigned 或 admin-level public/free 误称为 card-specific assignment。

## 3. 当前读取接口真实行为

### 3.1 核销 `POST /api/app/redeem`

- 通过卡密 code 查找 app_cards；
- 校验卡密状态、人工停用和有效期；
- 创建 app_entitlements，写入 card_id/admin_user_id/device_id；
- 同时写入 app_free_grants(device_id, admin_user_id)；
- 返回 entitlement 与 HMAC Token。

核销流程没有读取或复制任何卡密专属 group assignment，因为源码中不存在该关联。卡密激活事件写入失败目前被 catch 忽略，属于另一个需纳入后续修复的审计可靠性风险。

### 3.2 `GET /api/app/status`

只按 device_id 取 created_at 最新 entitlement，没有 Token 校验；返回主体记录和独立 active 子查询，可能不是同一条 entitlement。

### 3.3 `GET /api/app/nodes`

按 device_id 取最新 active entitlement，再校验 query Token。节点 SQL 按 entitlement.admin_user_id 读取该管理员全部已分配、已批准、已启用来源，不使用 app_groups/app_group_sources/app_group_members，也不限制 card_id 对应的分组范围。

### 3.4 `GET /api/app/groups`

- 先按 device_id 取最新 active entitlement，再校验 Token；
- 没有有效 entitlement 时，只按 device_id 查 app_free_grants，进而返回管理员所有启用的 free 分组；
- 有 entitlement 时，按管理员返回 public、free 和该设备 assigned 的分组；
- 未按 entitlement.card_id 查询卡密专属分组；
- `groupNodeList` 只按 group_id 查 app_group_sources 与节点，没有在节点读取 SQL 内再次验证 app_groups.admin_user_id 与 entitlement.admin_user_id 一致，也没有在读取时重新验证 source_ownership 与该管理员的归属关系。

### 3.5 `GET /api/app/free` 与公开解析

- free route 可通过 admin ID 或 share code 解析管理员，检查 free_group_enabled 后直接返回该管理员免费 tier 节点；
- resolve route 仅解析编号并返回管理员身份、名称和 free_group_enabled 状态；
- resolve 可作为绑定/发现入口；free route 直接返回节点内容，不能继续被当成单纯绑定接口。

### 3.6 `GET /api/app/links`

按 device_id 取最新 active entitlement、校验 query Token，再按 entitlement.admin_user_id 读取管理员启用链接；未按明确 entitlement_id 精确解析。

## 4. 权限语义对照

| 分组模式 | 当前源码语义 | 不是何种授权 |
|---|---|---|
| public | 该管理员所有有效 entitlement 设备可见 | 不是某张卡密专属 |
| assigned | app_group_members 中明确列出的 device_id 可见 | 不是卡密 ID 绑定 |
| free | 激活过该管理员卡密并写入 app_free_grants 的设备永久可见 | 不是某张卡密专属组；是管理员维度免费资格 |

现有分组模式可作为保留的可见性规则，但无法替代用户已确认的“每张 APP 卡密可配置对应分组”能力。

## 5. 最小兼容设计建议（仅设计，未实施）

建议在获得用户对数据库变更的明确批准后，采用独立关联表，而不是把 group_id 塞进卡密文本或覆盖 app_cards 既有字段：

`app_card_groups`（建议名，尚未创建）：
- `card_id TEXT NOT NULL`
- `group_id TEXT NOT NULL`
- 唯一约束建议：`(card_id, group_id)`
- 可增加 created_at 及操作者审计字段（需结合现有审计模型决定）。

安全读取约束：
1. 先用第五十二批 resolver 按 entitlement_id + device_id + Token 精确解析授权；
2. 由 D1 entitlement 记录取得 admin_user_id 与 card_id，不接受客户端传入；
3. 通过 `app_card_groups` → `app_cards` → `app_groups` 联查，要求卡密管理员、entitlement 管理员、分组管理员三者一致；
4. 只返回显式分配给该 card_id 的分组；是否同时叠加 public/free/assigned 模式，必须保持现有模式兼容并在接口契约中明确，不能由实现者自行扩大授权；
5. 节点查询继续从允许的 group_id → app_group_sources 取数，并在查询中验证分组管理员与 source_ownership 归属，不能只靠先前 handler 检查；
6. free share code 解析只返回绑定信息，不直接下发节点；免费节点读取必须使用独立、可验证的设备/授权上下文，并受管理员免费开关控制；
7. `/api/app/nodes` 必须停止按管理员全来源下发，改为与 groups 相同的授权分组范围，且不能让节点接口绕过分组访问规则。

管理端后续还需要卡密创建/编辑时的分组选择和回显 API/UI；当前 app_cards 生成接口只接受 count/days，尚无分组参数。修改前必须搜索所有前端调用和 APK 调用方，保留旧响应结构并增加可选字段或采用明确版本兼容策略。

**此设计不是已批准 migration，也不是生产 schema 事实。** 当前不创建该表、不改 DDL、不写 Worker SQL。

## 6. 影响分析、风险、回滚与测试计划

- Worker：本批未修改；未来接入需在独立版本目录实施，不覆盖第四十九批。
- HTML：未修改；当前 HTML 版本的 APP 卡密/分组 UI 调用链需单独核对。
- D1：未连接、未读取、未修改；无迁移。
- APK：ZIP 未解包，不能确认其是否传递 entitlement_id、是否能展示多组授权、旧响应字段依赖。
- Secrets：未读取/修改。
- Cloudflare：未访问/部署。

未来实施前必须：
1. 由用户批准新增 card-group 关联模型及 migration；
2. 只读确认实际 D1 目标环境、schema、迁移历史和备份恢复证据；
3. 在隔离测试 D1/Worker mock 中覆盖卡密 A/B 分组隔离、跨管理员、跨设备、过期/撤销、免费分组、公开分组、assigned、节点来源归属、D1 异常；
4. 运行 Worker.fetch handler 集成测试和旧 API 响应兼容测试；
5. APK 解包审计后再确定请求字段/客户端协议；
6. 生产迁移与部署另行取得明确授权。

本批无业务代码修改，无代码测试可报告；静态核查结论基于指定 Worker Blob SHA。回滚不适用（仅新增核查报告与进度文档）。

## 7. 第五十五批唯一接手卡

**第五十五批：APP 卡密分组配置管理接口与管理端调用链只读盘点，形成端到端实施规格。**

1. 重读 AGENTS、功能基线、总方案、进度、API 契约和第五十一至五十四批报告。
2. 只读追踪管理端 HTML 中 APP 卡密创建/编辑/列表、APP 分组管理、分组来源配置、分享入口的页面和 API 调用。
3. 核对第四十九批 Worker 的 app_cards、app_groups、super/user APP group routes、权限门禁与审计路径。
4. 确认现有卡密创建流程如何生成卡密、是否支持批量、是否存在编辑卡密属性 API；不得擅自新增字段。
5. 设计卡密绑定多个分组的后台交互、服务端接口、审计、权限（有效 VIP 才能修改；过期只读规则按基线）和旧版兼容策略。
6. 列出新增关联表的 migration 草案与回滚/数据兼容方案，但不创建正式 migration、不连接 D1、不执行 SQL。
7. APK 仍标记 APK_PENDING；不修改客户端协议。
8. 完成后更新报告、进度、总方案和第五十六批接手卡。

