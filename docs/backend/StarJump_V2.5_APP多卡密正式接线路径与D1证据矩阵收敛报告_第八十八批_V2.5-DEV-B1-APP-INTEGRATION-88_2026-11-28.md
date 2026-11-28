# 星跃管理平台 V2.5｜APP 多卡密正式接线路径与 D1 证据矩阵收敛报告

- 批次：V2.5-DEV-B1-APP-INTEGRATION-88
- 日期：2026-11-28
- 分支：release/v2.5.0-rc1-converge
- 起始 head：e8479bcb2d7f4aef26bb48cce885aec3e1e1a4f2
- 状态：静态源代码核验完成 / 接线路径已收敛 / 真实 D1 证据缺失 / NOT DEPLOYABLE

## 1. 本批目标与边界

本批不再扩写离线 checkpoint 模型，而是核验现有 APP Protocol 64/65/66、Batch49 Worker 和 D1-001..034 的实际关系，确定最小集成路径。只读 GitHub 候选分支文件；未连接 Cloudflare/D1，未执行 SQL/DDL/DML，未读取 Secrets，未修改 Worker/HTML/APK，未部署。

## 2. D1-001..034 的权威来源与覆盖状态

权威案例清单位于 `backend/worker/V2.5-DEV-B1-APP-IDENTITY-80/D1-EVIDENCE-MAP.md`，其来源是 Batch76 `d1_validation_matrix.json`，并由 Batch77 admission/atomic assertion review、Batch78-79 operation contract 扩展。它不是 SQL statement inventory。

- D1-001..016：环境身份、断言/回滚、bind 类型、batch 结果、zero changes、RETURNING/meta.changes、唯一冲突、owner receipt、create 竞争/key conflict、revoke CAS、rotation CAS、timeout replay 等 identity 原子语义。
- D1-017..026：limiter 多维并发、event ID 去重、维度完整性、shared NAT、时钟边界、window/Retry-After、cleanup race、query plan/cost、HMAC key overlap、cleanup 幂等/范围。
- D1-027..031：create-existing、receipt type/fingerprint conflict、audit exact-match、revoke owner boundary、rotation side-effect policy（依赖 U80-05/06）。
- D1-032..034：HMAC cross-version union/dedupe、limiter cleanup vs union history、index migration coverage。

Batch82 已明确指出：D1-017..026 并未映射到 Batch81 八个 identity 方法；D1-025 是 HMAC overlap；D1-032..034 是 HMAC/limiter/index migration 级用例；D1-023/026 的 harness cleanup 不应混入生产 identity adapter。Batch81 八方法矩阵只是部分 case map，不是 statement-level SQL/bind manifest。

## 3. Batch85 manifest 与 Batch70/81 证据的准确关系

- Batch85 三类 manifest（identity_adapter、limiter_adapter、disposable_harness）状态均为 `DESIGN_ONLY_NO_SQL`，`statements=[]`，`production_sql_permitted=false`。
- Batch85 JSON schema 只约束未来 statement metadata；要求 `sql_state=NOT_FROZEN`、`sql_sha256=null`、`placeholders=[]`、`binds=[]`。因此不存在已冻结的具体 statement IDs、SQL hashes、placeholder ordinals 或 bind contracts。
- Batch81 `ADAPTER-STATEMENT-ASSERTION-MATRIX.json` 提供八个逻辑方法的 bind metadata 和部分 D1 case labels，但缺少每条 SQL 的 statement_id、SQL/hash、placeholder lexical mapping、每语句 bind ordinal 和 result index；Batch82 F82-M01/F82-M02 已明确指出这一缺陷。
- Batch70 `D1-STATEMENT-CONTRACT.md` 八方法 SQL 仅为逻辑设计示例，表名/列名不是已验证生产标识。它不能直接填充 Batch85 manifest。
- 因此 D1-001..034 是测试/证据案例编号，不是 statement IDs；不能把 D1-001 映射成一条 SQL，也不能声称 34 个 case 已有 34 条冻结 SQL。

## 4. 现有 APP 多卡密代码接入状态（按实际源码核验）

### Protocol 64

`backend/worker/V2.5-DEV-B1-APP-PROTOCOL-64/app-v2-read-handler.mjs` 与 `entitlement-token-adapter.mjs` 是独立 handler/adapter，依赖注入式实现；存在独立测试，但本批未发现 Batch49 Worker 对其注册正式路由的代码。不能宣称已集成。

### Protocol 65

`composed-groups-handler.mjs` 提供 `POST /api/app/v2/groups/composed`，校验 `x-app-device-id` 与 body.credentials（1..maxEntitlements），再调用注入的 `composeGroups`。本身没有 D1 读取实现，也没有在 Batch49 Worker.js 中发现该路径或 handler 注册。故它是可测试的协议 handler，不是生产接入。

### Protocol 66

`card-group-admin-handler.mjs` 提供 `GET/PUT /api/user/app-cards/:cardId/groups`，使用注入 service 与 session resolver；`card-group-admin-d1-adapter.mjs` 和 `card-group-admin-sql-plan.mjs` 存在候选 D1 SQL 及 isolated SQLite fixture。adapter 顶部明确注明 isolated harness、未接生产 Worker。Batch49 Worker.js 中未发现 `createCardGroupAdminHandler` 导入/注册。

### Batch49 Worker 路由现状

已读取 `backend/worker/V2.5-DEV-B1-CORE-AUTH-49/Worker.js`（SHA `68409961816d6d096c5990b164c658d6351d7bec`）：旧 `/api/app/groups`、`/api/app/free`、`/api/app/links`、`/api/app/nodes` 等路由仍调用 legacy handlers；未发现 `/api/app/v2/groups/composed`、`createComposedGroupsHandler` 或 `createCardGroupAdminHandler` 注册。`/api/user/app-cards/:cardId/groups` 也未作为 Protocol66 handler 路由注册。现有 `/api/user/app-cards/export` 是旧 CSV 导出路径，不是 Protocol66 分组接口。

## 5. 重要兼容冲突：card mode

Protocol66 `card-group-admin-sql-plan.mjs` 查询 `app_groups.mode = 'card'`，并依赖 `app_card_group_mappings`、`app_card_group_admin_requests` 等候选结构；但 Batch68 legacy schema 观察到的 APP group mode 只有旧 `public/assigned/free`，Batch66/其他旧 Worker 的合法 mode 也未证明包含 `card`。candidate fixture 不能证明真实 D1 支持 `card`。在 schema snapshot 与兼容决策前，不能将候选 SQL 接入生产，也不能擅自修改旧 mode 枚举或数据。

## 6. 最小真实集成路径（有先后依赖）

1. **Schema evidence first**：复用 Batch77 已存在的只读 SQL 文件 `docs/database/diagnostics/V2.5-DEV-B1-APP-SCHEMA-MANIFEST-77_READ_ONLY.sql`；操作者在明确选中的 staging D1 导出 schema-only metadata。记录环境名称、database ID 指纹、执行时间、SQL SHA-256、结果 SHA-256；不导出业务行、卡密 code、token 或 Secrets。staging 与 production 分开。

2. **Schema reconciliation**：使用现有 `tools/database_migrations/schema_manifest.py` 及 Batch78 compare 测试，对真实 schema 生成 manifest；重点核对 app_cards/app_groups/admin_vip_activations/admin_user_scopes/admin_audit_events/app_card_group_mappings/app_card_group_admin_requests 的列、PK、索引、FK、trigger 与 SQL hash。ABSENT 不等于允许创建。

3. **Business/API compatibility gate**：确认 `mode='card'` 方案与 legacy public/assigned/free 的兼容策略；确认 Protocol65 每个 credential token 的 APK 支持情况；不得把 APP 身份 ID 当作读取节点授权。

4. **Mapping persistence**：只有 schema 和业务规则确认后，才冻结 mapping/idempotency DDL 与真实 D1 adapter。先 staging 验证 owner/VIP/card status/group mode/enabled 的最终断言、replace 原子性、审计/receipt、重复请求、跨 owner 隔离和 rollback。

5. **Worker integration**：将 Protocol66 admin handler 绑定现有 session/effectiveId/actorId/scope resolver；将 Protocol65 composition service 绑定真实 entitlement/free-grant/group loader；以独立 v2 路由接入，不覆盖 legacy `/api/app/groups` 等接口。补充路由集成测试、权限矩阵、API contract 和错误兼容测试。

6. **HTML + APK**：后台 HTML 加入每张 APP 卡密的专属分组配置界面（读写权限依现有 VIP/体验/委托 scope）；APK 端必须保存同一管理员多张卡密的全部有效 entitlement credentials，免费组按 device+admin 去重，并验证同步/tombstone/24h cleanup ACK。没有 APK 可检查源码或可验证客户端协议时，不能宣称端到端完成。

7. **Release packaging**：完成 staging D1/Worker/HTML/APK 联调后，再生成用户要求的 Worker + HTML 两文件候选包、版本说明、SHA-256、部署前检查、健康检查与回滚步骤。PR #2 继续 Draft，未经明确授权不合并或部署。

## 7. 仍然阻塞的业务决策与证据

- U80-01..08 仍未冻结：create-existing 审计策略、actor mapping、outcome/reason enum、audit payload allow-list、share-code rotation 对现有绑定/session/challenge/free grants 的影响、旧 challenge 处理、exact retry event envelope、opaque identifiers 日志范围。
- Batch81 指出 APK source callsites 不可检查，旧/新客户端兼容未证明；当前不能假定 APK 支持 Protocol65 多凭据请求。
- 无经批准 staging D1 database ID/binding/isolated service 证明，无真实 schema snapshot，无 D1 runtime result vectors。Batch80 明确 `starjump-db`、`starjump-staging` 均不是自动批准目标。
- 真实多卡密聚合、mapping migration、正式路由、后台 UI、APK 多凭据持久化及端到端同步均未集成。

## 8. 本批结论

本批已把 D1 case inventory、statement manifest 和真实 SQL 三个概念分开，并通过源码核验确定 Protocol65/66 当前仍是隔离模块。现阶段可以推进 schema-independent 的路由适配准备，但不能安全提交真实 D1 adapter 或 migration。下一项需要外部证据：操作者按 Batch77 方案取得 staging schema-only metadata；在此之前继续改写 SQL 会是猜字段和猜约束。

## 9. 第八十九批接手卡

优先检查 Batch49 Worker 中现有 session/effectiveId/actorId/scope resolver 与 app route dispatcher 的精确接口，形成 Protocol66 handler 注入适配设计（不写入正式路由）；同时检查 Protocol65 composed service 的 resolver/classifier/loaders 输入输出与旧 API 响应差异。只有完成接口兼容分析且不依赖猜测 D1 schema，才实施隔离的 Worker route adapter tests。不得修改 legacy route 行为，不得部署。