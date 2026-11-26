# 星跃 V2.5 转换归档、匿名归属与幂等性补充审计（2026-11-27）

## 1. 审计基线

- 仓库：`sxna-web/XYmonihtml`
- 分支：`main`
- Worker：`原始StarJump_V1点0_Final-zip-26-11-25-14:56/Worker.js`
- Worker blob SHA：`5da7aa3582558d9da2c2a0ad25a63c5e95e9fe63`
- 只读静态审计；未发起线上转换、未读取生产订阅数据、未执行 D1 写入。

## 2. 当前转换成功路径

`convertRoute()` 对 `POST /api/convert`：
1. 尝试解析用户 Session，成功则归属 `u:<effectiveId>`。
2. 匿名请求读取 `x-guest-key` 或 body.guest_key，经 SHA-256 派生 `g:<hash>`。
3. 获取订阅、解析节点、过滤/生成目标格式。
4. 将 formats、meta、sources 通过 `sealJson()` 加密后写入 `convert_links`。
5. 返回转换链接及统计信息。

因此，当前该 Worker 路由每次成功转换都会写入 `convert_links`，并非仅在 local_only=false 时才保存。加密 payload 包含输出格式、来源信息和元数据；数据库列还保存 owner_user_id、owner_key、ip_hash、分组和到期时间。

## 3. P1-37：匿名请求缺少 guest key 时全部落入共享匿名归属

证据：`resolveOwnerKey(env, ownerId, guestKey)`：
- 有用户 ID：返回 `u:<id>`。
- guest key 格式有效：返回 `g:<sha256>`。
- 其他情况：固定返回 `g:anonymous`。

影响：
- 未注册用户如果没有提供合法 guest key，所有此类用户都会共享同一个 owner_key。
- `GET /api/convert/links`、`GET /api/convert/groups`、重命名和撤销等接口也按 owner_key 过滤；共享 key 会导致匿名记录归属混淆。
- 这与“未注册用户记录按 ID 分组、只能查看和复制自己的转换节点与批次”的规则冲突。
- 若客户端未可靠持久化 guest key，卸载/清缓存/换浏览器后也无法稳定找回自己的历史记录。

修复要求：
1. 匿名首次访问时由 Worker 签发随机访客身份凭证，或要求客户端先创建高熵 guest identity；不能静默回退到共享常量。
2. 服务端只保存 guest identity 的不可逆哈希，不记录明文凭证。
3. guest key 必须有长度、熵、格式、轮换、丢失恢复和限流策略。
4. 缺失/无效 guest key 时返回明确身份初始化响应，不得创建共享匿名归属。
5. 注册后如需迁移匿名历史，必须通过一次性验证的 claim 流程，不能仅凭客户端提交任意 guest key 就合并记录。

## 4. P1-38：转换归档缺少幂等键，重试可能产生重复历史批次

证据：
- 每次成功转换均生成新的 `id = newId().slice(0, 12)`。
- INSERT `convert_links` 没有 request_id/idempotency_key 字段或重复请求检查。
- 请求体没有看到服务端验证的幂等键。
- 网络超时后客户端重试相同转换，会再次抓取、解析、生成新 ID 并插入新行。

影响：
- 用户可能看到多个相同批次，重复占用存储和配额。
- 同一订阅、相同目标格式、相同节点内容的重复请求无法区分“用户主动再次转换”与“网络重试”。
- 违背“归档幂等可重试”的要求。

修复要求：
1. 客户端为一次用户主动转换生成唯一 idempotency_key；网络重试必须复用同一 key。
2. Worker 将 key 与 owner 身份绑定，并在 D1 建立唯一约束或等价原子去重机制。
3. 同 key、同请求摘要返回原批次结果；同 key、不同请求摘要返回 409。
4. 不允许只用订阅 URL 或内容哈希作为唯一键，因为用户主动重复转换也应能生成新批次。
5. 记录幂等状态：处理中、成功、可重试失败；对超时/并发请求做原子锁定。
6. 对失败且未完成归档的任务，不计成功配额；如果先占额度，必须提供可靠回滚/返还。

## 5. P2-17：转换过滤/重命名缺少明确的服务端 VIP 门禁

证据：
- `convertRoute()` 中注释为“过滤/重命名仅对登录用户开放（VIP 功能）”。
- 但代码直接调用 `applyNodeFilters(nodes, body.filters)`，未在该处看到对登录身份、有效 VIP 状态的显式判断。
- `/api/convert` 分发层按公开转换接口处理，允许匿名请求进入。

影响：
- 不能把注释当成实际授权检查。
- 若 applyNodeFilters 接受客户端传入的过滤条件，则匿名/L1 用户可能通过直接构造请求使用本应受 VIP 限制的能力。
- 即使 HTML 隐藏过滤 UI，也不能形成服务端安全边界。

修复要求：
1. 解析过滤/重命名参数前，服务端明确验证有效 VIP 身份。
2. 对匿名、注册非 VIP、体验 VIP 有效、体验 VIP 到期、正式 VIP 有效、正式 VIP 到期分别测试。
3. 免费基础转换仍允许，不因 VIP 过滤门禁而阻断基础节点转换。
4. 返回稳定权限错误码，并记录拒绝审计。

## 6. P2-18：转换归档保存原始来源 URL，必须验证加密和日志脱敏边界

证据：
- `sourceInfo` 保存 `{ url: rawUrl, nodes, error }`。
- 写入 `convert_links.payload` 前使用 `sealJson(env, ...)`。
- API 返回时对来源 URL 调用 `maskSubscriptionUrl()`。

正向点：归档 payload 使用封装加密函数，响应端对 URL 做遮罩。

仍需验证：
1. `sealJson/openJson` 在生产环境是否强制使用独立强密钥；缺密钥时是否 fail closed。
2. 订阅抓取失败时 `error` 是否可能包含完整 URL、用户名或 Token；当前响应会把 error 文本直接返回。
3. Worker 异常日志、D1 审计、调试日志不得输出完整订阅 URL、userinfo、查询参数或转换内容。
4. 密钥轮换必须支持旧归档解密迁移，不得因轮换使历史记录永久不可读。

## 7. 当前已符合的部分

| 规则 | 当前静态代码情况 |
|---|---|
| 成功转换归档 | 成功路径写入 convert_links |
| 不同用户数据隔离 | 登录用户按 u:id 隔离 |
| 匿名访客隔离 | 只有合法 guest key 时隔离；缺失时共享 g:anonymous |
| 同 URL 不覆盖历史 | 每次成功生成新 ID 并 INSERT，不覆盖旧行 |
| 敏感订阅内容加密 | payload 经 sealJson，仍需核实密钥配置和 fail-closed |
| 返回来源 URL 脱敏 | 正常 sources 返回使用 maskSubscriptionUrl |
| 归档重试幂等 | 未实现，重复请求会创建新批次 |
| L0 仅基础转换 | 过滤/重命名缺少明确 VIP 服务端门禁 |

## 8. 后续测试矩阵

1. 两个匿名访客无 guest key：必须分别初始化身份，不得共享批次。
2. 同一访客使用相同 guest key：能查看自己的历史，不得看到其他访客记录。
3. guest key 缺失、格式错误、猜测其他 key：拒绝或重新初始化，不能落入共享身份。
4. 注册用户 A/B：不能互相读取、重命名、撤销转换链接。
5. 同一次请求超时后使用相同幂等键重试：只产生一个批次。
6. 同幂等键更换请求内容：返回冲突，不覆盖历史。
7. 用户主动再次转换并使用新幂等键：新增一条历史记录。
8. L0/L1 使用 filters：服务端拒绝 VIP 专属过滤，但基础转换成功。
9. 订阅 URL 带用户名、密码、Token、查询参数：数据库 payload 加密，API、错误、审计、日志均脱敏。
10. local_only 模式（如前端仍提供）：必须仍按用户要求归档成功批次，并正确标记保存模式；不得把仅本地显示当成未归档。

## 9. 禁止事项

- 不得以 IP 地址作为匿名用户永久身份。
- 不得使用共享 `g:anonymous` 作为真实访客数据归属。
- 不得用“URL 相同”自动覆盖历史转换记录。
- 不得把幂等键设计成阻止用户主动重复转换。
- 不得仅靠前端隐藏 VIP 过滤功能。
- 不得在审计文档或普通日志记录真实订阅 URL、卡密、Token 或密钥。
- 不得未经审批对生产执行转换、清理或 D1 迁移。


## 10. P1-39：转换归档加密密钥存在固定默认值回退

证据：`convertKey(env)` 使用：
`String(env.CONVERT_KEY || env.SESSION_PEPPER || "starjump-convert")`

风险：
- `CONVERT_KEY` 未配置时回退到 Session Pepper；若 Session Pepper 也未配置，则使用源码固定字符串。
- 任何知道公开源码的人都能推导默认密钥，历史转换 payload 的机密性不能依赖该默认值。
- 直接更换 CONVERT_KEY 也会使旧 payload 无法用新密钥解密；当前密文没有显式 key version/key ID。

修复要求：
1. 转换归档使用独立强随机 `CONVERT_ENCRYPTION_KEY`，不得回退到 Session Pepper 或代码常量。
2. 缺少密钥时，归档写入和读取必须 fail closed，并明确告警。
3. 密文 envelope 保存 key_id/version；支持新旧密钥并存的轮换窗口。
4. 轮换前验证历史 payload 可解密、迁移覆盖率和回滚方案。
5. 生产密钥只放 Cloudflare Secrets，不进仓库、HTML、日志或 APK。

## 11. P1-40：全局限流在 D1 异常时 fail-open

证据：`checkGlobalLimit(db, env)`：
- 使用 `INSERT ... ON CONFLICT DO UPDATE SET count = count + 1` 做桶计数。
- 随后读取计数判断是否超限。
- 整个过程 catch 后直接返回 `{ ok: true }`，注释明确“表还没建时不影响转换”。

风险：
- 不仅表缺失，D1 暂时不可用、SQL 错误、连接异常或权限错误也会绕过全局限流。
- 当前没有把“限流不可用”与“未超限”区分。
- 与已确认的原子限流和异常保护要求不一致；流量突增时可能失去全局保护。

修复要求：
1. 区分表未迁移、限流超限、D1 暂时故障和其他 SQL 错误。
2. 生产环境限流表缺失应视为部署错误并告警；不能静默放行。
3. 对 D1 暂时故障采用明确策略：高风险写入/转换可返回 503 或受控降级，不得把失败伪装成通过。
4. 计数和阈值判断尽量在单条 SQL/原子操作中完成，避免并发读取窗口。
5. 429 必须返回稳定错误码和 `Retry-After`；当前该函数返回 429 文案和 scope，但未见 `Retry-After` 响应头。

## 12. P2-19：转换密钥轮换缺少版本化兼容

当前 AES-GCM payload 只保存 IV + ciphertext；未见 key ID、算法版本或 envelope version。
- 更换 CONVERT_KEY 后，旧 payload 的解密依赖保留旧密钥，但无法从每条记录自身判断应选择哪把密钥。
- 直接使用新密钥读取历史内容可能统一返回“内容无法解析”。

修复要求：
- 采用带 version/key_id 的密文封装格式。
- 读路径按 key_id 选择密钥；写路径只使用当前活动密钥。
- 迁移工具只在受控任务中逐条解密并重加密，记录成功/失败，不打印明文。
- 旧密钥仅在迁移和回滚窗口保留，完成验证后再按审批流程撤销。

## 13. 更新后的安全结论

转换成功归档本身已有 AES-GCM 加密调用和随机 IV，这是正向实现；但密钥回退、密钥版本、匿名共享归属、幂等重试与限流 fail-open 仍未达到正式 V2.5 的上线标准。当前不能把“代码调用了 AES-GCM”直接等同于“生产历史订阅凭证已安全加密”。
