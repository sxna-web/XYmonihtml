# 星跃管理平台 V2.5｜APP v2 身份持久化 Adapter 与真实 D1 Schema 前置差距核查报告

- 批次：第六十八批
- 版本：`V2.5-DEV-B1-APP-IDENTITY-68`
- 日期：2026-11-27
- 状态：**只读核查与 D1 adapter 契约设计完成；未执行代码测试；未连接 D1；未生成 migration；未接 Worker；不可部署**
- 仓库：`sxna-web/XYmonihtml` / `main`

## 1. 本批执行范围

依照 AGENTS、功能基线、API 权限规范、D1 变更保护规范、总方案、进度及 APP v2 第五十一至六十七批报告，完成：
- 当前 main 仓库文件树、Worker schema 来源、迁移目录和本地迁移工具只读检查；
- 原始 Worker 与 CORE-AUTH-49 Worker 的 APP 核心 DDL 对照；
- 第六十六批 identity service 与第六十七批 8 个 store 方法接口复核；
- 将 8 个方法映射为 D1 条件写入/唯一约束/批处理契约；
- 明确真实 D1 环境核验和后续隔离测试门槛。

未修改 Worker/HTML/APK/Room/D1/Secrets/Cloudflare 配置；未连接生产或 staging D1；未执行 SQL；未创建可执行 migration；未部署。

## 2. 当前证据与环境边界

### 2.1 当前仓库内可见证据

- 原始 Worker：`原始StarJump_V1点0_Final-zip-26-11-25-14:56/Worker.js`，Blob SHA `5da7aa3582558d9da2c2a0ad25a63c5e95e9fe63`。
- CORE-AUTH-49 Worker：`backend/worker/V2.5-DEV-B1-CORE-AUTH-49/Worker.js`，Blob SHA `a4689380215e95c1c9f605fc974cc553b3e7037f`。
- 两份源码均有 `env.DB` 绑定使用和内嵌 `MIGRATE_STATEMENTS`，但源码头部注释提到的 D1 binding 名称不构成 Cloudflare 线上绑定证据。
- 当前递归树中未发现 `wrangler.toml`、`wrangler.json`、`wrangler.jsonc`，未发现 APP v2 专用隔离 D1 binding/database ID。
- `tools/database_migrations/README.md` 明确标注 LOCAL-ONLY / NOT A PRODUCTION MIGRATION RUNNER；runner 只允许系统临时目录下 `starjump-migration-test-*` disposable SQLite 数据库，拒绝网络/URI/生产路径。
- 仓库可见本地 migrations 为 `CORE-MIG-001.sql`、`NTF-001.sql`、`NTF-002.sql`；没有 APP identity migration。CORE/NTF 文件只供本地 SQLite verifier 使用，不是 D1 线上迁移证据。
- 未读取 Cloudflare Dashboard 当前 Worker 绑定或真实 D1 schema。因此“未发现仓库配置”不等于“Cloudflare 上不存在绑定”。

### 2.2 旧 APP schema 观察

原始 Worker 的内嵌 DDL 可见：
- `admin_share_codes`: `admin_user_id TEXT PRIMARY KEY`、`code TEXT NOT NULL UNIQUE`、`created_at`；没有 code_version、active/revoked、digest 或轮换历史字段。
- `app_free_grants`: `(device_id, admin_user_id)` 复合主键、granted_at；代表设备/管理员免费资格，不是 identity binding。
- `admin_app_perms`: admin_user_id 主键、links_enabled、max_links、free_group_enabled。
- `app_cards`、`app_entitlements`、`app_groups`、`app_group_sources`、`app_group_members` 均有旧版 DDL；没有 identity challenge、request nonce、identity binding 表。
- `rate_limits` 旧表只有 bucket/count/updated_at，不能未经评估就认定足以承载 identity v2 多维持久限流。

以上仅是仓库源码 DDL 证据，不代表真实 D1 当前 schema，也不能确认 DDL 曾在生产完整执行。

## 3. 第六十七批 8 个 store 方法到 D1 的映射

| 方法 | 推荐 D1 原子形态 | 必需约束 | 结果 |
|---|---|---|---|
| insertChallenge | 参数化 INSERT | challenge_id PK | 插入成功才 created；唯一冲突为 conflict |
| consumeChallengeAtomic | 单条条件 UPDATE，可用 RETURNING | challenge_id + pending + expires_at>now + device/admin/version/key 全匹配 | 仅一条更新成功才 consumed |
| consumeNonceAtomic | INSERT ... ON CONFLICT DO NOTHING | UNIQUE(binding_id, nonce) | 插入成功消费；冲突拒绝重放 |
| upsertBindingAtomic | INSERT ... ON CONFLICT DO NOTHING，再 owner-scoped SELECT；必要时置于 D1.batch | UNIQUE(admin_user_id, device_id) | 同 key active 幂等；不同 key/已撤销拒绝，禁止覆盖 |
| revokeBindingAtomic | 条件 UPDATE + owner-scoped read | binding_id + admin_user_id | 仅本人绑定可撤销；已撤销可设计幂等成功 |
| rotateShareCodeAtomic | 单条条件 UPDATE / CAS | admin_user_id + active + expected code_version | 仅一个并发轮换成功 |
| getCurrentShareCode | owner-scoped SELECT | 每管理员唯一当前版本 | 仅服务端最小必要字段 |
| expireTransientRecords | 有界 DELETE，可批处理 | expires_at 条件 | 仅清理过期 challenge/nonce，不清理 binding/audit |

完整字段建议、伪 SQL 形态、D1 事务注意事项和兼容边界见：
`backend/worker/V2.5-DEV-B1-APP-IDENTITY-68/D1-ADAPTER-CONTRACT.md`。

### 3.1 D1 能力结论（官方文档核对）

Cloudflare 官方 D1 文档说明：
- `prepare().bind()` 用于参数化 SQL；
- `D1Database.batch()` 顺序执行预先构造的 prepared statements，作为事务批次；其中语句失败会回滚整个批次；
- D1 不应被当作可跨 Worker JavaScript await 的手动 BEGIN/COMMIT callback transaction；
- 单个 D1 数据库的请求由其数据库执行队列处理；并发安全仍应依赖条件写入、唯一约束与事务，而不是 Worker isolate 内存锁。

来源：
- https://developers.cloudflare.com/d1/worker-api/d1-database/
- https://developers.cloudflare.com/d1/platform/limits/

注意：官方 API 能力不证明当前项目 D1 schema、binding、版本或线上状态；也不替代隔离环境实测。

## 4. 需要特别避免的实现错误

1. 不得使用 read-then-write 作为 challenge、nonce、binding 或 code rotation 的并发保护。
2. 不得对 identity binding 使用 `INSERT OR REPLACE`；这可能替换/删除旧行，破坏 revoked 保留语义。
3. 不得在单条 SQL 的条件检查之外再用 Worker 内存判断作为唯一防重放措施。
4. 不得把 D1.batch 误认为可在一组语句中间返回 JS 分支结果；所有语句需预先构造，按顺序执行。
5. 不得把 `app_free_grants` 当 identity binding；不得把 share code 当 entitlement Token。
6. 不得在未经旧路由调用方兼容审计前直接把 `admin_share_codes.code` 改成 digest 或删除旧列。
7. 不得把旧 `rate_limits` 表视为已经满足 identity discover/bind/resolve 的持久限流需求。
8. challenge 消费和 binding 创建分步失败时，可能留下已消费 challenge 但未完成绑定的状态；后续 adapter 应提供重新发挑战的可靠流程，或在已验证 D1.batch 语义下评估原子组合。
9. 清理任务必须有界并保留绑定撤销与审计历史。

## 5. 数据库设计分类

| 项目 | 当前仓库源码可见 | 真实 D1 已核实 | 结论 |
|---|---:|---:|---|
| admin_share_codes 基础列 | 是 | 否 | 旧 DDL 有 admin_user_id/code/created_at |
| app_free_grants | 是 | 否 | 设备/管理员免费 grant，不是 identity binding |
| app_cards / app_entitlements / app_groups | 是 | 否 | 旧版 APP 表，真实 schema 未核 |
| identity_bind_challenges | 否 | 否 | 新设计 |
| identity_request_nonces | 否 | 否 | 新设计 |
| identity_bindings | 否 | 否 | 新设计 |
| share-code version/digest/revocation | 否 | 否 | 新设计/兼容扩展待定 |
| identity binding audit | 否 | 否 | 新设计 |
| APP v2 专用 D1 binding/database ID | 未发现 | 否 | 需用户后续提供/授权核验环境 |

## 6. 风险、兼容与回滚

- **最高风险**：当前没有可核实的非生产 D1 binding/database ID 和真实 schema。此时直接编写 migration 或 D1 adapter 容易对错误 schema 作假设。
- **兼容风险**：旧 share code 以明文 code 唯一查询；新增 digest/version 必须规划旧路由与新 v2 路由并存期。
- **并发风险**：mock 14/14 不能证明 D1 的唯一冲突返回、batch rollback、RETURNING/meta 行数语义或多 Worker 竞争。
- **APP 风险**：6.00.48 ZIP 未审计，Android Keystore、公钥注册和请求签名协议未验证。
- **回滚**：本批仅新增文档；回滚为撤销本批文档提交，不涉及数据库恢复。

## 7. 测试与验收状态

- 本批为只读源码/目录审计和文档契约设计；没有运行 D1 测试，也没有声称代码测试通过。
- 第六十七批 Node mock CI 14/14 仍是上一批证据，不属于本批 D1 验收。
- D1_NOT_TESTED；APP_PENDING；Worker integration NOT_STARTED；不可部署。

## 8. 第六十九批唯一接手卡

**APP v2 D1 adapter 的隔离可执行性验证计划与 SQL 语义测试设计（不接生产、不部署）。**

1. 重读 AGENTS、功能基线、API/D1 保护规范、总方案、进度和第五十一至六十八批报告。
2. 对照本批 D1-ADAPTER-CONTRACT，细化 8 个方法的成功/冲突/过期/重试/并发结果矩阵。
3. 优先用本地 SQLite fixture 验证 SQL 语义（仅在 disposable temp 目录），明确标记 SQLite 结果不能代表 D1。
4. 形成 Cloudflare 隔离 D1 验证清单：需确认数据库 ID、binding 名、迁移历史、schema 快照、batch rollback、RETURNING/meta changes、并发唯一冲突、限流表适配。
5. 若无已批准隔离 D1 环境，继续停留在本地 SQL 语义验证与设计，不连接 staging/production，不猜 binding。
6. 不创建/执行 D1 migration，不接 Worker 路由，不改 HTML/APK/Room/Secrets，不部署。
7. 免费分组仍优先身份授权；特殊免费分组卡密保持冲突时条件性备选。
8. 更新进度、总方案和第七十批接手卡。
