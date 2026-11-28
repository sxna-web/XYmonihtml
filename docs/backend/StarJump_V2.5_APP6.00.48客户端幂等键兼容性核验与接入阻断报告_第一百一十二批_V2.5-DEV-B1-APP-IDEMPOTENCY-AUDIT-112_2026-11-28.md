# 第一百一十二批｜APP 6.00.48 客户端幂等键兼容性核验与接入阻断报告

- 批次：`V2.5-DEV-B1-APP-IDEMPOTENCY-AUDIT-112`
- 日期：2026-11-28
- 分支：`release/v2.5.0-rc1-converge`
- 基线提交：`ea97ff6ef2495940f52cbd73f851bc301990a06d`
- PR #2：Open / Draft / Unmerged

## 1. 本批核验结果

仓库 Git tree 中存在 `StarJump-6.00.48-source.zip`，Git blob SHA：
`2b8b6d105019fb90341c7178438b2d6b0473699f`。

但本轮可用 GitHub 文件读取接口只支持 UTF-8 文本，读取 ZIP 时返回空内容；直接读取二进制 blob 也因非 UTF-8 解码失败。此前第六十批 APP 源码审计报告也记录了同一限制：ZIP 为 2,323,467 bytes，但未能解包，故没有核实 6.00.48 的客户端请求方法、URL、header、重试策略、第三方 SDK/许可或远程依赖。

因此，本批**不能给出 APP 6.00.48 已支持或不支持 `Idempotency-Key` 的结论**。未从 ZIP 中提取源码或客户端调用证据，不以 6.00.47 或旧 Worker 路由行为代替 6.00.48 事实。

## 2. 服务端当前契约与风险

Protocol66 PUT handler 当前强制要求请求头 `Idempotency-Key`（8–128 字符，限定字符集）；缺失时返回 `400 IDEMPOTENCY_KEY_REQUIRED`。服务端以 `(admin_user_id,idempotency_key)` 作为客户端重试幂等键，服务端 `requestId` 仍单独写入审计追踪字段。

此接口是管理后台 VIP 管理员为 APP 卡密配置分组的管理接口，不应把 APP 普通用户请求与后台管理员请求混为一谈。但正式路由接入仍须验证现有管理端页面/调用方是否会携带并在同一逻辑操作重试时复用该 header。

若客户端缺少该 header：
- 不可直接取消幂等键要求并接受无保护写入；
- 不可每次网络重试都生成新 key；
- 不可用服务端 requestId 冒充稳定客户端幂等键；
- 应先在真实调用方增加一次操作生成、重试复用的 key，并补齐成功/超时/重复提交/不同 payload 冲突测试；
- 在兼容性证明完成前，Protocol66 保持未接正式 Worker route。

## 3. 已确认的安全边界

- Batch 109：分离 client idempotency key 与 server trace requestId。
- Batch 110：幂等重放前重新核验委托 scope，撤销/过期不允许重放旧成功响应。
- Batch 111：隔离 SQLite 验证候选 schema/回滚；不等同 Cloudflare D1 证明。
- 当前真实 Staging schema 快照确认两张候选表尚不存在。
- 未执行 D1 DDL/DML、未接入正式 Worker route、未访问 Cloudflare Secrets、未部署、未合并。

## 4. 下一步最短路径

1. 需要取得可实际解包的 `StarJump-6.00.48-source.zip`（可直接在当前对话上传，或上传到可读取的文件库），再执行只读审计。
2. 逐一检索 OkHttp/Retrofit/Volley/Ktor 等网络层、所有卡密分组管理请求调用点，形成 method/path/header/body/response/retry 清单；不能只靠搜索字符串判断支持。
3. 如后台管理 UI 调用方在 HTML 中而非 APP APK 中，必须单独审计当前两文件中的实际调用代码，不能把 APP 客户端和后台管理 UI 混同。
4. 先补真实调用方兼容与契约测试，再考虑 Worker route 集成。
5. 只有在用户明确批准、备份恢复点确认后，才可安排真实 Staging DDL。

## 5. 当前判定

`APP_6.00.48_SOURCE_UNREADABLE` / `IDEMPOTENCY_HEADER_UNVERIFIED` / `ROUTE_NOT_INTEGRATED` / `NOT_DEPLOYABLE`。

本批没有修改业务代码，没有降低幂等安全要求，也没有执行线上操作。
