# 星跃管理平台 V2.5｜APP v2 身份审计/限流契约对抗性复核与隔离测试规格报告

- 批次：第七十三批
- 版本：`V2.5-DEV-B1-APP-IDENTITY-73`
- 日期：2026-11-27
- 状态：**对抗性静态复核与测试规格完成；无新增可执行测试；D1_NOT_TESTED / APP_PENDING / NOT_DEPLOYABLE**
- 仓库：`sxna-web/XYmonihtml`，分支 `main`
- 本批不连接任何 D1，不执行 SQL，不创建 migration，不修改 Worker/HTML/APK/Room/Secrets/Cloudflare 配置，不部署。

## 一、本批核查范围

已重新读取根目录 AGENTS、功能基线、API 权限规范、数据库变更保护规范、总方案、进度记录，以及第六十八至七十二批 APP v2 identity 资料；并静态核查：
- 原始 Worker.js（Blob SHA `5da7aa3582558d9da2c2a0ad25a63c5e95e9fe63`）；
- 原始 index.html（Blob SHA `ab98aecd4c8546eda197bbb4d5a9f5ec0db82613`）；
- 第六十七批 durable state machine；
- 第六十四批 APP v2 read handler；
- 第六十五批 composed-groups handler；
- 第七十至七十二批 D1/审计/限流规格。

原始 Worker/HTML 是仓库源码基线，不证明线上 Cloudflare 当前部署版本或真实 D1 schema。

## 二、核心复核结论

### 1. 关键原子性缺口

Cloudflare 官方 D1 文档明确：`batch()` 中语句顺序执行；语句执行错误会中止/回滚整个批次。D1 结果对象有 success 与 meta.changes。但条件 INSERT-SELECT 选中 0 行本身不会自动变成 SQL 错误。

因此，第七十二批“业务状态写入 + 条件审计 INSERT-SELECT”方案还缺少数据库内强制断言：如果业务写入成功但审计条件因不匹配而插入 0 行，批次可能仍成功提交。批处理返回后再检查 changes 已无法回滚。相同 event_key 的 `DO NOTHING` 也无法单独区分相同 payload 重试和不同 payload 冲突。

结论：在隔离 D1 验证出可靠的 in-batch assertion/constraint 前，不得把创建/撤销/轮换审计契约交给 Worker 实施。

官方资料：
- [D1 Database API / batch](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [D1 Return objects](https://developers.cloudflare.com/d1/worker-api/return-object/)

### 2. Challenge 消费与 Binding 创建需要合并原子边界

第六十七批接口分别调用 challenge consume 与 binding upsert。若 challenge 已提交消费，而后续 binding 写失败，challenge 会被烧掉，正常重试被拒绝。

必须将 challenge 条件消费、binding 插入/胜者读取、必要创建审计合并为同一原子逻辑单元。绑定写入必须依赖本次精确消费的 challenge；后续任一必需写入失败必须回滚 challenge 消费。不得通过 Worker 内存锁解决。

### 3. 超时处理

Cloudflare 官方 Debug D1 文档说明，Promise.race 的超时不会取消 D1 写入，超时后写操作仍可能提交。因此超时只能标记 outcome-unknown；同一逻辑重试必须复用 binding_id、operation_id、event_id/event_key，并通过 owner-scoped state + audit 查询核实，不能重新生成一套 ID。

参考：[Cloudflare Debug D1](https://developers.cloudflare.com/d1/observability/debug-d1/)

### 4. 零行与审计失败分类

- Revoke 条件 UPDATE 零行：不是 SQL 错误，需 owner-scoped 分类，不追加撤销事件。
- Share-code CAS 零行：冲突/无变更，不是成功轮换。
- 必需审计 INSERT-SELECT 零行：不可接受为成功，必须由数据库内断言使同批次失败。
- 相同 event_key + 相同 canonical payload：幂等重试。
- 相同 event_key + 不同 payload：完整性冲突，不能静默忽略。

### 5. 限流对抗性边界

逐项审查并列入隔离 D1 测试：
- 多 isolate 并发准入是否严格不超过阈值；
- 重复 event_id 同 payload 与不同 payload；
- 缺失维度 NULL 是否造成绕过；
- 共享 NAT 的误伤；
- 窗口左右边界与时钟前跳/后跳；
- Retry-After 在多维同时超限时是否取最晚释放点；
- 索引、rows_read、rows_written、查询时长；
- cleanup 与 admission 并发；
- HMAC key 轮换期间不能重置活动窗口；
- 限流存储故障 fail closed。

不设置最终阈值，不把转换额度建议值作为身份安全阈值。

## 三、Legacy share-code 源码调用方盘点

原始 Worker/HTML 可见依赖：
1. `admin_share_codes` DDL：`admin_user_id`、raw `code`、`created_at`。
2. `ensureShareCode()`：查询或懒创建旧编号。
3. `GET /api/user/share-code`：用户查看自己的编号。
4. `GET /api/super/admins/:id/share-code`：超管查看指定管理员编号。
5. `GET /api/app/resolve?code=...`：公开解析编号到管理员元数据。
6. `GET /api/app/free?code=...` 或 `?admin=...`：旧免费组读取。
7. `GET /api/app/download?code=...` 或 `?admin=...`：旧下载列表读取。
8. 原始 index.html 调用用户/超管编号展示接口。

APK ZIP、外部客户端和线上 Worker 调用情况未审计。当前不能宣称调用方清单完整。不得更改旧字段、旧路由或轮换后既有绑定策略。公开编号只用于发现，不是身份认证。

## 四、Nonce 与 APK 兼容

没有 APK 源码证据，无法确认 Android Keystore、签名 canonicalization、时间单位、nonce 持久化、Header 能力或协议降级行为。必须维持 APP_PENDING。新旧签名协议需分别版本化；旧 APK 未证明支持前，不可强制升级签名要求，不可在旧协议内直接扩大 skew。

## 五、交付文件

- 详细规格：`backend/worker/V2.5-DEV-B1-APP-IDENTITY-73/ADVERSARIAL-REVIEW-AND-ISOLATED-TESTS.md`
- README：`backend/worker/V2.5-DEV-B1-APP-IDENTITY-73/README.md`
- 本报告：`docs/backend/StarJump_V2.5_APP_v2身份审计限流契约对抗性复核与隔离测试规格报告_第七十三批_V2.5-DEV-B1-APP-IDENTITY-73_2026-11-27.md`

## 六、测试与环境声明

- 本批执行：仓库源码/文档静态读取、跨文件调用方检索、Cloudflare 官方公开文档核对。
- 本批未执行：Node/Python 自动化测试、SQLite fixture、D1 SQL、D1 batch、真实并发请求、APK/Android 联调。
- D1：未连接任何数据库；未执行 SQL；未创建 migration。
- Worker/HTML/APK/Room/Secrets/Cloudflare：未修改。
- 部署：未执行。
- 状态：**设计规格完成；没有本批测试通过项；D1_NOT_TESTED / APP_PENDING / NOT_DEPLOYABLE**。

## 七、下一批

第七十四批：APP v2 identity 原子操作重构设计与本地可执行对抗性 fixture。重点先修复 challenge consume + binding create 分离提交、必需审计零行无错误、相同事件键不同 payload 冲突，再扩展本地 SQLite 语义测试；仍不连接 D1。
