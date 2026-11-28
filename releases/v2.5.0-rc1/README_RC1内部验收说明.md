# 星跃管理平台 V2.5.0 RC1｜内部上线候选说明

- 候选版本：`V2.5.0-rc1`
- 构建标识：`2026-11-28-v2.5.0-rc1`
- 分支：`release/v2.5.0-rc1-converge`
- 状态：`INTERNAL RC / NOT APPROVED FOR PRODUCTION`
- 文件：`Worker.js`（由 Batch47/49 helper bundle 成单文件）与 `index.html`
- 本说明不是生产部署授权，也不是 D1/Cloudflare/APK 实测报告。

## 本轮候选修正

1. Cron 即使没有已分配同步来源，也会执行 VIP 卡密维护、节点生命周期维护和 APP entitlement maintenance；仅 `runSync` 在来源非空时运行。
2. 保留 Batch49 的 APP 管理有效 VIP gate、owner-scoped 最终 SQL predicate 与过期正式 VIP 历史删除 cutoff。
3. 无效 Authorization 不再降级匿名；错误 Bearer 返回 401。
4. `SESSION_PEPPER` 最低长度提高到 32；缺失/过短时认证 fail closed。
5. 匿名转换必须提供独立有效 `guest_key`，移除共享 `g:anonymous` 归属。
6. APP HMAC 使用 `APP_HMAC_SECRET`（优先）或现有 `SESSION_PEPPER`，最低 32 字符；在消耗卡密/创建 entitlement 之前先验证 token secret，避免 secret 缺失时卡密已消费却未返回 token。
7. VIP 展示状态按 `starts_at <= now < ends_at` 计算，保留 `is_formal` 历史含义，另提供 `active_formal`。
8. 后台页面各处 API 请求统一读取登录页 API 地址输入框，并持久化用户主动修改的地址。
9. Worker 版本标识更新为 `2.5.0-rc1`，健康检查 build 标识为 `2026-11-28-v2.5.0-rc1`。
10. Batch47/49 helper 通过 esbuild 固定版本 bundle 为 Cloudflare 单文件 Worker；CI 另行解析 bundle 和 HTML 内联脚本。

## 自动化检查

- RC1 workflow：`V2.5 RC1 Convergence Checks`
- 最新已知成功 Run：见本分支 GitHub Actions 最新绿色记录；检查包含 Worker bundle、Cron no-source 回归、HTML 内联 JS 语法、Batch49 adapter tests、Worker handler integration tests。
- 最新代码回归：Run `46096896216`，SUCCESS（2026-11-28）；[查看 Actions](https://github.com/sxna-web/XYmonihtml/actions/runs/46096896216)。
- 数据库迁移安全复核：[查看报告](../../docs/release/V2.5.0_RC1数据库迁移安全复核与暂停记录_2026-11-28.md)。
- 这些检查是 GitHub runner 上的离线/模拟测试，不等于 Cloudflare Workers runtime、真实 D1 或 APK 联调。

## 数据库 40 张表名只读核验覆盖（本轮更新）

- 发现旧 schema-status 只检查 18 张核心表，而静态 Worker 依赖清单为 18 张历史 DDL 表 + 22 张 SQL 引用表，共 40 张。
- Worker 现分别返回 18 张核心表、22 张额外引用表的存在/缺失情况，并给出 40 张总状态。
- 后台数据库检查 UI 分开显示两类表数量、缺失项和总状态。
- 自动回归强制 Worker 两组表名与静态 JSON 清单逐项一致，且总数必须为 40。
- Push CI [46097884870](https://github.com/sxna-web/XYmonihtml/actions/runs/46097884870) SUCCESS。
- 最新文档整合后 Push CI [46097936683](https://github.com/sxna-web/XYmonihtml/actions/runs/46097936683) 与 PR CI [46097960031](https://github.com/sxna-web/XYmonihtml/actions/runs/46097960031) 均 SUCCESS。

- 仍然只核对表名；22 张 B 类表没有完整 DDL 证据，不生成猜测型 CREATE TABLE；迁移仍关闭。

## 本地数据库验证器回归（本轮更新）

- schema snapshot 增强：列扩展元数据、索引有序列/唯一性/索引定义、外键和对象 SQL。
- 本地 SQLite 测试套件新增索引与生成列元数据测试；当前 25 项。
- 已纳入 RC1 CI，push Run [46097127196](https://github.com/sxna-web/XYmonihtml/actions/runs/46097127196) 与 PR Run [46097121612](https://github.com/sxna-web/XYmonihtml/actions/runs/46097121612) 均通过。
- 该测试只验证本地临时 SQLite 工具，不连接 Cloudflare D1，不改变生产部署边界。

## 数据库静态清单（本轮更新）

- 已建立 40 张表的静态证据清单：18 张历史 CREATE TABLE（A 级）+ 22 张 Worker SQL 引用基础表（B 级）。
- 人工可读：[Worker 数据库表字段静态清单](../../docs/release/V2.5.0_RC1_Worker数据库表字段静态清单_2026-11-28.md)。
- 机器可读：[JSON inventory](../../docs/release/V2.5.0_RC1_Worker数据库表字段静态清单_2026-11-28.json)。
- CI 新增覆盖检查，防止 Worker SQL 引用的表名遗漏出清单。
- 此清单仍不是生产 D1 schema snapshot；B 级表的字段定义不完整，不能直接生成建表 SQL。

## 数据库迁移状态（本轮更新）

- RC1 数据库页现为只读检查；`POST /api/super/migrate` 暂时返回 `503 MIGRATION_REVIEW_REQUIRED`。
- 已移除旧版不具备完整结构验证的逐条 DDL 迁移实现。
- 数据库状态接口只检查候选业务表名，并明确返回 `verification=TABLE_NAMES_ONLY` 与 `required_tables_present`，不再返回泛化的 `ready` 字段；不能据此认定所有 Worker 业务表、字段和索引均就绪。
- 已拒绝 legacy `ADMIN_TOKEN` 与协助会话进入数据库检查/迁移路由。
- 详细原因见 `docs/release/V2.5.0_RC1数据库迁移安全复核与暂停记录_2026-11-28.md`。
- 这是上线阻断项；不能通过跳过数据库迁移或误报 ready 来绕过。

## 生产部署阻断项（必须解决）

### 1. Cloudflare 现有环境核对

- Worker 必须继续使用用户现有正式 D1 binding 名称 `DB` 和当前数据库指向。
- **禁止改绑 `starjump-db`，也禁止擅自改绑 staging。**
- 本候选没有连接、读取或修改任何线上 D1/Secrets。
- 需要在部署前由用户在 Cloudflare 确认当前 `DB` binding、现有 schema、备份和回滚版本。不能把仓库 DDL 当作生产 schema 证明。

### 1.1 HTML API 地址配置与防误发（第一百零二批更新）

- 候选 HTML 登录页 API 地址默认留空，不再内置 Staging URL，也不猜测生产 Worker 完整 HTTPS 根地址。
- 页面加载时会清除旧版本遗留在 `localStorage.sj-api` 中、主机名包含 `starjump-api-staging` 的已知 Staging 地址；其他已保存地址仍保留，用户可自行核实后修改。
- API 地址为空时，所有 API 请求会在客户端明确停止，并提示先填写已核实的 Worker 根地址；用户手动填写后仍按原行为保存。
- 源码中已知生产 Worker 主机名标识为 `blackstarjump-api-dawn-1242`，但仓库证据仍不足以确认完整生产 HTTPS 根 URL。不得自行拼接或猜测。
- 因此该 HTML **仍不能直接作为正式生产页面交付**；正式发布前必须由用户确认准确生产 Worker 根地址，并在最终交付候选中配置及复核。

### 2. Secrets 兼容

- `SESSION_PEPPER`：至少 32 字符。必须保留现有原值；本候选没有安排轮换。若现有值少于 32 字符，**不要部署**，先设计兼容迁移。
- `APP_HMAC_SECRET`：可选。若已配置，必须先核对是否与原先用于 APP HMAC 的 `SESSION_PEPPER` 一致；不一致可能使既有 APP token 失效。不能在聊天或 GitHub 中提供 Secret 值。
- `ADMIN_TOKEN`、`ADMIN_ORIGIN`、`ALLOW_REGISTRATION`、`SESSION_TTL_HOURS`、`IMPERSONATION_TTL_MINUTES` 等现有变量须按当前环境保持，不要凭本说明改值。
- 历史转换密钥 `CONVERT_KEY` 仍保留既有兼容 fallback `starjump-convert`。历史密文版本与迁移未完成前不得删除 fallback 或随意更换密钥。

### 3. APP 客户端尚未闭环

- APP 6.00.47 源码审计未证明客户端调用当前 Worker 的 entitlement/status/token API；6.00.48 尚未完成可读源码审计。
- 本候选暂未强制要求 `/api/app/status` 提供 token，以免在 APK 请求契约未知时贸然改变兼容行为。
- `/api/app/nodes` 当前仍是旧的单条最新授权路径，未完成用户要求的多卡密分组聚合、同名分组序列号展示、免费组管理员去重等完整服务端/客户端闭环。
- generation/tombstone、APK 增量同步、24 小时本地清理和 cleanup acknowledgement 尚未闭环。
- 因此不得宣传“APP 多卡密授权全功能已上线”，也不能把本候选描述为 APP 客户端已联调。

### 4. 数据库初始化与上线验收

- RC1 的 `schema-status` 仅是表名只读检查；`POST /api/super/migrate` 已 fail closed 返回 503，不是可用的一键初始化入口。
- 本候选没有可供生产使用的一键迁移器；完整结构 manifest、真实 D1 只读快照、迁移计划和隔离环境验证仍未完成。
- 未核对生产 schema 前，不得执行任何生产迁移；后续必须先确认当前正式 DB、备份、迁移差异和回滚方案。
- 必须在隔离测试环境验证登录、匿名转换、注册、VIP 体验/正式到期、历史删除 owner cutoff、卡密生成/核销、APP 管理门禁、Cron 无来源维护和回滚。
- 必须确认现有 APK 的实际请求契约后，才可确定 APP status/token 是否可启用。

## 本候选允许的用途

仅供代码审查、GitHub Actions 离线测试和内部验收。未完成以上阻断项并经明确授权前，不得上传 Cloudflare 或执行数据库迁移。


## 第一百零二批发布一致性核查补充

- HTML API 默认配置已改为留空；加载旧版页面时会清除已知 Staging 主机名的持久化地址，空地址不会发起 API 请求。
- RC1 workflow 在同一次 GitHub Actions checkout/commit 中构建 Worker bundle，并将该 Worker bundle、仓库内 HTML 与本 README 一起上传为同一个候选 artifact；三者由同一 workflow run/commit 绑定，不把工作区临时 Worker.js 误认为已提交源文件。
- 发布 artifact 是 CI 生成物，必须从同一最终成功 Run 下载；不能把旧 Run 的 Worker.js 与新 HEAD 的 HTML 拼成发布包。
- 当前仍未获得准确生产 Worker 根 URL、真实 D1 schema-only 快照，也未完成 APP 6.00.48 源码/API 调用审计。上述事项仍阻止正式生产批准。


## 第一百零四批初始化诊断环境白名单修复

- 初始化诊断按钮现仅允许 HTTPS + 精确 Staging hostname（starjump-api-staging.synahcooo.workers.dev），不再以“不是已知生产主机”作为放行条件。
- 初始化请求改用统一 apiUrl()，空 API 地址、非 HTTPS、带子路径或非 Staging 地址均阻止请求。
- 该保护只针对 Staging 初始化诊断；不代表正式生产 bootstrap 可用，也不替代 Worker 服务端权限验证。
- 详见 docs/backend/StarJump_V2.5_RC1初始化诊断Staging目标白名单与失败关闭修复报告_第一百零四批_V2.5-DEV-B1-STAGING-ALLOWLIST-104_2026-11-28.md。


## 第一百零五批前端 API 根地址统一校验

- APP 卡密 CSV 导出、访客转换、公告读取、访客历史分组/链接管理等原先直接拼接 apiBase() 的请求，现统一经 apiUrl() 校验 HTTPS 与 Worker 根地址。
- 卡密导出状态参数进行 URL 编码；静态回归禁止新增 fetch(base + ...) 直连绕过。
- 详见 docs/backend/StarJump_V2.5_RC1前端API请求统一根地址校验与直连绕过修复报告_第一百零五批_V2.5-DEV-B1-API-ROOT-GUARD-105_2026-11-28.md。
