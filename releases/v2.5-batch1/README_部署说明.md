# 星跃管理平台 V2.5｜第一批安全修复版部署说明

- 版本：V2.5 Batch 1
- Worker 版本：`1.0.1`
- Worker build：`2026-11-27-v2.5-batch1`
- 分支：`repair/v2.5-batch1-auth-vip-app`
- 本批以用户指定的 Cloudflare 两个文件为基准，生成完整更新副本；原始文件未覆盖。

## 1. 两个完整部署文件

- [Worker.js](./Worker.js)
- [index.html](./index.html)

必须配套使用，不是零散补丁。

## 2. 本批修复

1. 无 Authorization 时保留 L0 匿名基础转换；无效/过期 Bearer 返回 401，不再降级匿名。
2. 删除共享匿名归属键 `g:anonymous`；匿名管理必须提供独立 guest_key，缺失返回 400。
3. `SESSION_PEPPER` 缺失或少于 32 字符时，认证相关操作 fail closed。
4. VIP 状态按当前 starts_at/ends_at 生效窗口判断；保留 `is_formal` 历史语义，新增 `active_formal`。
5. APP 对接分组、APP 入口链接、APP 卡密的非 GET 管理操作加入有效 VIP 服务端门禁；VIP 查询不可用时拒绝写操作。
6. 转换过滤/重命名要求有效 VIP；L0 基础转换仍可用。
7. APP HMAC 不再使用公开固定字符串；优先 `APP_HMAC_SECRET`，未单独配置时兼容既有 `SESSION_PEPPER`，均要求至少 32 字符。
8. APP status 必须验证与设备匹配的 entitlement Token；nodes/groups/links 按 Token 匹配所有有效 entitlement，不再只取最新一条。
9. APP Token 支持 `X-App-Token` Header，并暂时兼容旧 query 参数 `token`。
10. 管理后台与转换页面统一使用同一个 API 地址输入框，消除两套地址分流。

## 3. 部署前必须核对

**不要跳过本节直接替换生产 Worker。**

### Worker Secrets
- `SESSION_PEPPER`：至少 32 字符，必须保留当前线上原值。更换会使既有 Session 和依赖该密钥生成的 APP Token 失效。
- `APP_HMAC_SECRET`：可选。首次兼容部署时，若已配置，其值必须与当前 `SESSION_PEPPER` 完全一致；若尚未配置，先保持未配置，让本版兼容使用现有 `SESSION_PEPPER`。不要擅自生成不同值。
- `ADMIN_TOKEN`、`ADMIN_ORIGIN`、`ALLOW_REGISTRATION`、`SESSION_TTL_HOURS` 等现有配置保持不变。
- 不要把任何 Secret 明文发到聊天、写入 GitHub 或截图公开。

### D1
- Worker 仍使用名为 `DB` 的 D1 binding。
- 保留当前 Cloudflare Worker 的正式 D1 绑定；不要改绑 staging，也不要改绑 `starjump-db`。
- 本批没有新增、删除或修改 D1 表/字段/索引，不需要运行 SQL。

### APK 兼容性
- `/api/app/status` 现在要求提供 entitlement Token，可通过 `X-App-Token` Header 或旧 query 参数 `token` 传入。
- 目前没有对已安装 APK 的请求源码做实证核查。必须确认 APK 调用 status 时是否带 Token；如果不带，status 将返回 401，需要先同步 APK 客户端，不能仅靠替换 Worker 修复。
- nodes/groups/links 仍兼容旧 query Token；新客户端建议使用 `X-App-Token`。

## 4. 上传顺序

1. 在 Cloudflare 记录当前 Worker 部署版本，确保可回滚。
2. 核对 D1 binding 名称仍为 `DB`，且保持现有正式数据库指向。
3. 核对 `SESSION_PEPPER` 长度及原值不变；确认 `APP_HMAC_SECRET` 未配置或与其一致。
4. 在测试环境验证登录、匿名转换、注册用户转换、VIP 门禁、APP redeem/status/nodes/groups/links。
5. 确认 APK status 请求带 Token 后，再将本文件 `Worker.js` 完整替换到当前 Worker。
6. 将本文件 `index.html` 完整替换到当前后台 HTML 托管位置。
7. 后台 API 地址输入框填写目标 Worker 根地址；管理后台与转换页面会使用同一地址。
8. 检查 `/health` 返回 build `2026-11-27-v2.5-batch1`，再逐项验收。

## 5. 回滚

- Worker：在 Cloudflare 部署记录中恢复部署前保存的 Worker 版本。
- HTML：恢复部署前保存的 HTML 文件。
- 本批无 D1 迁移；不需要回滚数据库。
- 不要为了回滚而修改或删除 Secrets。

## 6. 下一批继续处理

- APP 分组删除仍为物理删除/多条语句；generation、tombstone、APK 增量同步、24 小时本地清理与 cleanup acknowledgement 尚未闭环。
- APP 免费分组授权路径仍需统一凭证校验。
- APP 卡密事件接口需脱敏，激活事件审计失败需可靠化。
- 转换密文 `CONVERT_KEY` 固定回退和历史密文版本化尚未修复；未设计历史密文迁移前不能贸然换密钥。
- 转换幂等、原子限流、审计 outbox、资源生命周期和 Cron stale 节点物理清理仍需处理。
- 正式 D1 真实 schema、线上 Worker 运行版本、APK 请求字段尚未实测。

## 7. 本轮测试记录

- Worker JavaScript 语法解析：通过。
- HTML 内 3 个脚本块语法解析：通过。
- 静态断言：匿名路径保留、无效 Bearer 不降级、无共享匿名 owner、APP 管理写操作 VIP gate、APP status Token 验证、多 entitlement 匹配、HTML API 地址统一。
- 未执行 Cloudflare 真实部署、D1 SQL、API 集成测试或真实 APK 联调。

**当前状态：完整更新文件已生成，静态检查通过；生产部署前仍须完成 Secret 与 APK 兼容核对。**


## 8. 上线前复核补充（2026-11-28）

- 已修复 Cron 入口的一个流程缺陷：原先当没有已分配订阅来源时提前 return，会跳过 VIP 卡密、节点生命周期和 APP entitlement 维护；现在维护任务无论是否存在同步来源都会执行，只有来源同步本身在 sources 非空时运行。
- 已增加 `.github/workflows/v25-batch1-release-smoke.yml` 与 `scripts/release_smoke_v25.py`，在 GitHub Actions 中检查 Worker 语法、HTML 内联 JavaScript 语法及关键发布断言。**以 Actions 实际成功记录为准，不能把工作流存在视为测试通过。**
- `CONVERT_KEY` 仍有历史兼容回退 `starjump-convert`。这关系到历史转换密文可解密性，不能在本次部署时随意更换或删除；正式上线前必须另行完成历史密文版本与迁移方案。不得把本批描述成完成密钥轮换。
- APP 6.00.47 已知源码审计未证明其会调用本 Worker 的 status/token 接口；本批仍不能声称 APP 客户端已联调。部署前须确认当前已安装 APK 对相关 API 的实际使用情况。
- 本包是管理后台/Worker 第一阶段修复候选，不代表 APP entitlement、卡密多管理员组合、分组撤销 24 小时清理 ACK 等完整业务已上线。
