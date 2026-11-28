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
- 最新代码回归：Run `46096192695`，SUCCESS（2026-11-28）；[查看 Actions](https://github.com/sxna-web/XYmonihtml/actions/runs/46096192695)。
- 数据库迁移安全复核：[查看报告](../../docs/release/V2.5.0_RC1数据库迁移安全复核与暂停记录_2026-11-28.md)。
- 这些检查是 GitHub runner 上的离线/模拟测试，不等于 Cloudflare Workers runtime、真实 D1 或 APK 联调。

## 数据库迁移状态（本轮更新）

- RC1 数据库页现为只读检查；`POST /api/super/migrate` 暂时返回 `503 MIGRATION_REVIEW_REQUIRED`。
- 已移除旧版不具备完整结构验证的逐条 DDL 迁移实现。
- 数据库状态接口只检查候选业务表名，并明确返回 `verification=TABLE_NAMES_ONLY`；不能据此认定所有 Worker 业务表、字段和索引均就绪。
- 已拒绝 legacy `ADMIN_TOKEN` 与协助会话进入数据库检查/迁移路由。
- 详细原因见 `docs/release/V2.5.0_RC1数据库迁移安全复核与暂停记录_2026-11-28.md`。
- 这是上线阻断项；不能通过跳过数据库迁移或误报 ready 来绕过。

## 生产部署阻断项（必须解决）

### 1. Cloudflare 现有环境核对

- Worker 必须继续使用用户现有正式 D1 binding 名称 `DB` 和当前数据库指向。
- **禁止改绑 `starjump-db`，也禁止擅自改绑 staging。**
- 本候选没有连接、读取或修改任何线上 D1/Secrets。
- 需要在部署前由用户在 Cloudflare 确认当前 `DB` binding、现有 schema、备份和回滚版本。不能把仓库 DDL 当作生产 schema 证明。

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

- 后台现有 schema-status / migrate 路由可作为一键初始化入口，但本候选未在真实 D1 执行它们。
- 未核对生产 schema 前，不得直接点击生产迁移；先确认当前正式 DB、备份、迁移差异和回滚方案。
- 必须在隔离测试环境验证登录、匿名转换、注册、VIP 体验/正式到期、历史删除 owner cutoff、卡密生成/核销、APP 管理门禁、Cron 无来源维护和回滚。
- 必须确认现有 APK 的实际请求契约后，才可确定 APP status/token 是否可启用。

## 本候选允许的用途

仅供代码审查、GitHub Actions 离线测试和内部验收。未完成以上阻断项并经明确授权前，不得上传 Cloudflare 或执行数据库迁移。
