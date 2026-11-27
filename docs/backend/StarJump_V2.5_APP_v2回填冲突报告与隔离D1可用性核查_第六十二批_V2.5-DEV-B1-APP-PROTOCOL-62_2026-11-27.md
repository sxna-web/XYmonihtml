# 星跃管理平台 V2.5｜APP v2 回填冲突报告与隔离 D1 可用性核查

- 批次：第六十二批
- 版本：`V2.5-DEV-B1-APP-PROTOCOL-62`
- 日期：2026-11-27
- 状态：隔离 dry-run 报告 helper 已编码；CI 5/5 通过；无隔离 D1；无 SQL 执行；APP_PENDING；不可部署。

## 1. 本批核查结论

- 重新读取当前 main 完整递归 tree：commit `4d7f93997f5195e8cc8bb00dc1085e3ed159d084`，180 entries，truncated=false。
- Tree 中没有 `wrangler.toml`、`wrangler.json` 或 `wrangler.jsonc`，没有可核实的 APP v2 专用隔离 D1 binding/database ID。仓库存在本地迁移工具和 SQLite 测试文件，但不能证明 Cloudflare D1 隔离环境存在。
- 不把生产 D1 或用户此前提到的 staging 数据库当作本批隔离目标；未连接任何 D1。
- Library 递归列表只返回 `StarJump-6.00.47-source.zip`（2,377,487 bytes）；未发现 6.00.48 可读取副本。6.00.48 继续 APK_PENDING。
- 第六十一批 CI Run `45966848333` 已通过；本批复核后未发现需要修复的失败项。

## 2. 新增 redacted dry-run 报告器

目录：`backend/worker/V2.5-DEV-B1-APP-PROTOCOL-62/`

- `backfill-report.mjs`：调用第六十一批纯函数 planner，输出扫描总数、活动候选数、去重数、计划槽位数、冲突分类及每卡容量摘要。
- `backfill-report.test.mjs`：5 项测试，覆盖统计、超额 grandfather、冲突分类、设备键/entitlement ID 脱敏、schema 未验证声明。
- `README.md`：记录环境核查结果和使用边界。
- Workflow：`.github/workflows/worker-app-protocol62-tests.yml`。

报告输出刻意不含 deviceKey、entitlementId 或卡密明文；只输出冲突编号与原因码。每份 dry-run 报告固定声明：
- `schemaStatus = UNVERIFIED`
- `sqlExecuted = false`
- `migrationCreated = false`
- `approvalRequired = true`

本工具仅接受已由人工/隔离 adapter 映射的规范化行，不自行猜测旧 D1 字段，不连接数据库，不执行 SQL。不能把本地报告器当作真实数据回填结果。

## 3. 回填冲突处理策略

- 同一卡密同一 deviceKey 多条有效 entitlement：归并为一个槽位，保留来源数量供审计。
- 同一设备出现在不同卡密：每张卡密各占一个槽位。
- 缺 cardId、缺 deviceKey、未知 entitlement 状态、无效 expiresAt：生成冲突原因，不自动修正、不猜测。
- 明确 inactive 或已过期的 entitlement：不计入活动候选；若生产真实状态值/到期字段未核实，则必须先标为 UNKNOWN，不能擅自映射成 inactive。
- 既有活动设备数超过目标限制：保留全部存量并 grandfather，禁止新增；不撤销已有设备。
- 任何 backfill migration 前仍必须先核实真实 D1 schema、索引、约束、迁移历史、时间语义和数据备份；输出 dry-run 冲突清单并单独审批。

## 4. 未冻结的业务决策

1. 卡密过期/撤销后，槽位是否立即释放，还是保留到审批/人工释放。
2. 设备解绑审批权限：卡密所属有效 VIP 管理员、超管，或分层审批。
3. 释放后的卡密能否再次绑定新设备，以及原设备是否可重新占额。
4. 用户换机时是否允许自助申请、是否要求旧设备在线确认或额外验证。

第六十一批的 HELD_EXPIRED / HELD_REVOKED 是安全保守提案，不是用户已经确认的正式规则；在确认前不得接入生产行为。

## 5. 测试证据

CI Run `45967697304` completed/success：
- Node.js 22 语法检查通过；
- 5/5 tests passed，0 failed；
- job `140400252073`。
- Run：https://github.com/sxna-web/XYmonihtml/actions/runs/45967697304

测试只证明脱敏报告纯函数，不证明 D1 schema、数据质量、D1 并发或迁移可用。

## 6. 安全与部署边界

- 未连接生产或 staging D1；未执行 SQL；未创建 migration。
- 未修改 Worker、HTML、APK、Secrets、Cloudflare 配置或线上环境。
- 未部署；当前 APP v2 仍为隔离开发状态。
- 6.00.48 第三方授权/SDK/API/远程停用/隐私审计仍受二进制不可读取阻塞。

## 7. 第六十三批唯一接手卡

**APP v2 真实 Worker 接入前置差距与最小集成边界审查（继续隔离，不部署）。**

1. 重读 AGENTS、功能基线、API、D1 保护规范、总方案、进度及第五十一至六十二批相关报告。
2. 复核第六十二批 CI Run 45967697304、脱敏输出与 backfill planner 组合边界。
3. 对照原始两份 Cloudflare 基准文件，绘制旧 APP 路由、鉴权、卡密/分组/节点查询与新 resolver/loader/composition/slot helper 的逐路由差距矩阵；只读，不改原始文件。
4. 明确哪些旧 API 需要立即 fail closed、哪些需要保留兼容窗口；不得在 6.00.48 未审计前宣称 Header Token / 多 entitlement 客户端兼容。
5. 形成最小 Worker 集成分支/文件布局、适配器接口、feature flag 与回滚顺序；不接入生产 Worker。
6. 设备槽位未确认的释放/审批策略继续作为待确认项；不擅自定规则。
7. 若无 6.00.48 ZIP 与隔离 D1，保持 APK_PENDING / D1_NOT_TESTED；不创建 migration、不操作 Secrets、不部署。
8. 更新总进度和第六十四批接手卡。
