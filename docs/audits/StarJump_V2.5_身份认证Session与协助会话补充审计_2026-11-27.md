# 星跃 V2.5 身份认证、Session 与协助会话补充审计（2026-11-27）

## 1. 审计基线

- 仓库：`sxna-web/XYmonihtml`
- 分支：`main`
- Worker：`原始StarJump_V1点0_Final-zip-26-11-25-14:56/Worker.js`
- Worker blob SHA：`5da7aa3582558d9da2c2a0ad25a63c5e95e9fe63`
- 方式：只读静态代码审计；未登录真实账号、未请求生产接口、未修改 D1 或部署。

## 2. 正向实现

1. Session Token 使用 32 字节随机数（256 bit），数据库保存 token hash，不直接保存明文 Token。
2. resolveSession 同时验证 token 对应行、revoked_at、用户存在、用户 status=active、expires_at 未过期。
3. 协助会话额外验证发起者是 super_admin、scope_id 存在、scope 归属正确、授权未撤销且未过期。
4. 协助会话写操作通过 userBatch 将 scopeGuardStmt 与业务语句放进同一个 D1 batch，降低“检查后撤权”的竞态风险。
5. 普通用户密码修改后保留当前 Session，并撤销同一账号其他 Session。
6. 普通登出会撤销当前 Session；可撤销指定 Session 时检查其归属，超管可执行跨用户会话撤销并写审计。
7. 协助会话有独立时长上限（5 至 240 分钟，默认 30 分钟），且可单独结束。
8. 登录失败达到 5 次后锁定 15 分钟；错误用户名与错误密码使用相同通用提示。

## 3. P1-41：SESSION_PEPPER 缺失时没有 fail closed

证据：
- 文件头部署说明要求 Secret `SESSION_PEPPER` 至少 16 字符。
- `sessionTokenHash(token, env)` 实际使用 `String(env.SESSION_PEPPER || "")`。
- 没有在 Worker 启动或登录/Session 校验路径强制检查 Secret 是否存在、长度是否达标。

影响：
- Secret 缺失时系统仍会继续使用 SHA-256(token) 作为数据库 Token 摘要，而不是拒绝认证操作。
- 随机 Token 本身有 256 bit 熵，因此这不等同于 Token 可被直接猜出；但部署契约没有被执行，pepper 保护层失效，且不同环境可能出现不一致的认证哈希。
- Secret 更换会令所有旧 Session 的 token hash 不再匹配，造成全体用户会话失效；当前没有显示受控轮换方案。

修复要求：
1. 在生产环境强制要求 `SESSION_PEPPER` 非空且达到部署要求的最小长度；缺失或不合格时认证相关请求 fail closed 并产生运维告警。
2. 不要将 Pepper 写入仓库、前端或日志。
3. 设计 Pepper 轮换策略：可接受短期旧/新 Pepper 验证窗口，或明确全员重新登录与通知方案。
4. staging/production 分别检查 Secret 配置，不得以本地默认值掩盖缺失。

## 4. P1-42：注册成功与 7 天体验 VIP 发放不是原子闭环，发放失败被静默吞掉

证据：`POST /api/auth/register`：
1. 先将用户 INSERT 和注册审计放进一个 D1 batch。
2. 随后单独执行 `grantTrial(db, id).catch(() => {})`。
3. 不论体验授权是否成功，接口都返回 `trial_days: 7`。

影响：
- 用户账号可能已注册成功，但体验 VIP 发放失败；API 仍向客户端报告 7 天体验。
- 没有在此路径留下明确失败状态或可自动补偿的任务证据。
- 这与“新注册用户首次自动获得 7 天体验”规则不一致，且用户可能无法判断是系统未发放还是 VIP 页面读取异常。

修复要求：
1. 用户创建、体验授权创建、注册审计尽量放入同一个可原子提交的 D1 batch；若 grantTrial 涉及复杂逻辑，则建立可靠待处理状态和重试任务。
2. 只有确认体验授权成功后才返回 `trial_days: 7`；否则返回明确的待处理状态，不能谎报成功。
3. 增加唯一约束/幂等键，保证重复补偿不会重复叠加 7 天体验。
4. 监控注册成功但无 trial activation 的异常记录。

## 5. P2-20：协助会话中调用修改密码接口，修改的是操作者账号而非当前查看的目标账号

证据：
- `/api/auth/me` 在协助会话中返回 actor 用户资料、effective_user_id 和 impersonating 标记。
- `PUT /api/auth/password` 使用 `ctx.actorId` 查询并更新密码。
- 因此超管协助目标用户期间调用该接口，更新的是超管自己的密码，而不是目标用户密码。

影响：
- 若前端在协助模式仍展示“修改当前用户密码”，操作对象与页面上下文不一致。
- 超管可能误以为在修改目标用户密码，实际改变自己的登录凭证。

修复要求：
1. 协助会话期间直接拒绝自助修改密码，返回明确错误码（如 `PASSWORD_CHANGE_NOT_ALLOWED_IN_IMPERSONATION`）。
2. 超管如需重置目标用户密码，走独立的超管重置流程，明确输入目标用户、要求二次确认并写审计。
3. 前端协助模式隐藏普通密码修改入口；服务端仍必须执行上述拒绝。

## 6. P2-21：Session Pepper 轮换与旧 Session 处置没有形成可验证流程

当前 Token hash 直接依赖单一当前 `SESSION_PEPPER`。改变 Secret 后，旧 Token 计算出的摘要变化，旧 Session 无法继续匹配。此行为会造成整体登出，但没有发现版本字段或渐进迁移机制。

修复要求：
- 明确轮换是“全员强制重新登录”还是“短期双 Pepper 验证后迁移”。
- 若强制登出，应在发布说明中告知用户并安排重新登录提示。
- 若渐进迁移，需为 Session 记录 pepper/key version，不能尝试无限制的未知密钥回退。
- 轮换前统计活跃 Session 数量；轮换后监控认证失败率。

## 7. 当前暂未发现的典型问题

- 未发现 Session Token 明文写入 D1 的实现；代码保存 token_hash。
- 未发现仅凭客户端 user_id 就能直接覆盖普通用户 Session 身份的实现；resolveSession 从 Session 行读取 user_id。
- 协助会话不是仅靠前端标记；服务端每次 resolveSession 都重新验证 scope。
- 普通用户被停用后，resolveSession 会因 status 非 active 而拒绝其 Session。
- 当前协助授权的有效期与撤销状态会在每次请求重新检查。

## 8. 尚需真实 D1 / 联调确认

1. `app_users.username` 是否有数据库 UNIQUE 约束；注册路径先 SELECT 再 INSERT，必须由唯一约束兜底并发注册。
2. `grantTrial()` 使用的表、唯一约束和到期叠加逻辑，需对照真实 D1 schema 验证。
3. 密码哈希参数、历史格式迁移与 Worker 实际运行时限制需 staging 测试。
4. `ADMIN_TOKEN` 直通只应保留在旧版 `/api/admin/*` 与一次性 bootstrap；需要持续检查路由分流，确保不能进入普通用户数据接口。
5. Session 撤销后所有 API 的下一次请求必须立即返回 401；需真实 Worker 联测，不以 HTML 模拟结果替代。

## 9. 建议测试矩阵

- 正常登录、错误密码、未知用户名、停用用户、锁定中账号。
- 缺少 SESSION_PEPPER、短于 16 字符、正常 Secret、Secret 轮换。
- Session 过期、撤销、用户停用、账号密码修改后其他设备旧 Token。
- 登出当前会话后重放旧 Token。
- 两个并发同用户名注册，数据库最终只能有一个账号。
- 注册后强制模拟 grantTrial 失败，接口不能谎报体验已发放；重试不得重复增加体验期。
- 协助 scope 分别 read/operate/manage，验证读取、创建/编辑、删除边界。
- 协助 scope 到期或撤销后，旧协助 Token 下一次请求立即失效。
- 协助模式下调用修改密码，必须拒绝且不能更改 actor 或 target 的密码。
- 超管结束协助会话后，旧协助 Token 必须立即失效，普通超管原 Session 仍可用。

## 10. 禁止事项

- 不得将真实 Session Token、SESSION_PEPPER、ADMIN_TOKEN 写入 GitHub。
- 不得把客户端传入的 user_id 当作身份来源。
- 不得把协助会话当成目标用户本人登录；审计必须保留 actor 与 effective 两个身份。
- 不得在协助模式误用普通用户密码修改接口。
- 不得在体验授权发放失败时仍返回体验已成功发放。
- 未经审批不得撤销真实用户会话、修改密码或执行生产认证配置变更。
