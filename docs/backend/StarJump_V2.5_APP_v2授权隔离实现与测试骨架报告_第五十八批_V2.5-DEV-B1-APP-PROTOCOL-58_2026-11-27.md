# 星跃管理平台 V2.5｜APP v2 授权隔离实现与测试骨架报告

- 批次：第五十八批
- 版本：`V2.5-DEV-B1-APP-PROTOCOL-58`
- 日期：2026-11-27
- 状态：**隔离 DEV 模块已编码；GitHub Actions 测试通过；未接入现有 Worker；不可部署**
- 业务依据：第五十七批协议设计 + 用户本轮明确冻结的设备上限、空分组、激活后分组同步规则。
- 生产边界：未连接生产 D1/Cloudflare；未改现有 Worker/HTML/APK/Secrets；未创建正式 migration；未部署。

## 1. 本批实际交付文件

新增目录：`backend/worker/V2.5-DEV-B1-APP-PROTOCOL-58/`

1. `app-v2-policy.mjs`
   - 默认卡密设备上限 1。
   - 有效 VIP 管理员可设置 1–5；非 VIP 管理员拒绝修改；超过 5 要求超管。
   - 超管可设置大于 5 的安全整数（当前未引入未经确认的业务上限）。
   - 同设备重复激活幂等；新设备达到上限时拒绝。
   - 计算 identity/free 与 card/free allowlist。
   - 空 card mapping 合法，返回空 card 范围，不回退到 public/assigned/管理员全量组。
   - 分组行 owner、类型、enabled、allowedGroupIds 复核；任何越界行使整次结果 fail closed。

2. `sync-state.mjs`
   - generation 严格递增与旧版本拒绝。
   - tombstone 创建、应用和重复事件幂等。
   - tombstone 立即停止使用分组并要求删除本地节点。
   - ack 必须精确匹配 event、entitlement、group、generation；撤销 tombstone 只能以 removed 确认。
   - lease 时间异常/到期 fail closed。
   - 租约签发硬性限制最多 23 小时，即使调用方传入更长 TTL 也不会延长。

3. `app-v2-query-contract.mjs`
   - card 组 SQL 草案校验 card 与 group 的管理员归属一致。
   - free 组 SQL 草案要求管理员免费权限及 device free grant。
   - nodes scope predicate 必须显式提供 allowedGroupIds 和 entitlement owner；空 allowlist 不生成查询；owner 同样进入参数绑定。

4. `app-v2-handler.mjs`
   - 依赖注入式隔离 Worker v2 GET groups/nodes handler。
   - 仅接受 Authorization Bearer，不把 URL query token 当认证凭据。
   - 强制 entitlement_id 与会话 device_id 精确匹配。
   - groups/nodes 响应二次验证管理员归属与 allowlist。
   - 空 allowlist 直接返回空节点，不调用节点查询适配器。

5. `mock-d1-fixtures.mjs`
   - 确定性 mock D1 fixture，仅支持 entitlement_id + device_id 精确查询并记录绑定参数。

6. `app-v2-policy.test.mjs`
   - 36 项 Node.js 单测/契约测试。

7. `README.md`
   - 运行方法、接入限制和不可部署声明。

新增 CI：`.github/workflows/worker-app-protocol58-tests.yml`

## 2. 代码提交与测试证据

- 初始隔离模块提交：`63c208e47737927d19bc5d911676a75b2726af3a`
- 最终测试夹具修正提交：`2c271c742800799f5a81b0ca9607478fb6f69208`
- CI workflow 最终更新提交：`5c4f82d95fc9d7d84f25a418bbc993694b7f467b`
- 最终 GitHub Actions Run：`45960847230`
- CI 地址：https://github.com/sxna-web/XYmonihtml/actions/runs/45960847230
- Node.js：22
- 语法检查：所有本批 `.mjs` 文件通过。
- 单测/契约测试：**36 passed / 0 failed**。
- 最终 job：`isolated-tests` completed / success。

测试过程中曾发现 1 项 handler 测试夹具未返回 entitlement 的 device_id，导致预期 200 实际 403；已修正夹具并重新运行，最终 36/36 通过。失败运行：`45960751281`；最终成功运行：`45960847230`。不得把首次失败隐藏为成功，最终结论以修正后成功运行作为当前测试证据。

## 3. 本批测试覆盖范围

- 默认设备上限 1；VIP 1–5；VIP 超过 5 被拒绝；超管扩展。
- 同设备幂等、重复 device ID 去重、上限拒绝。
- 身份 ID 只取免费组；卡密取显式 card 组 + 合格 free 组。
- 空卡密分组可激活但不扩权。
- 跨管理员分组过滤；owner 不一致拒绝。
- 旧/重复 generation 拒绝；generation 溢出 fail closed。
- tombstone 立即撤销本地组；重复 tombstone 幂等。
- ack 的 entitlement/group/event/generation 精确匹配；撤销必须 removed ack。
- lease 到期 fail closed；签发 TTL 最大 23 小时。
- card/free SQL owner 条件；nodes 必须绑定 allowlist 和 owner；空 allowlist 不生成宽查询。
- mock D1 精确 entitlement + device 查询。
- handler 不接受 query token 替代 Header；精确 entitlement/device 匹配；空分组不读取 nodes；nodes adapter 收到显式 allowlist。

## 4. 仍未实现 / 未验证

1. 设备数量决策是纯函数；真实激活必须在 D1 中实现原子占额/事务或等效并发安全方案。本批没有证明并发数据库写入安全。
2. 第五十七批 card/free SQL 使用的 `app_card_groups` 等结构仍是草案；生产 D1 schema 未核实，不能执行。
3. `app-v2-handler.mjs` 是依赖注入 scaffold，没有接入真实 Worker 路由，也没有实际 Token/Session/D1 adapter。
4. tombstone、generation、lease、ack 尚无持久化事件表/队列，也未实现 Android 客户端端到端清理。
5. 23 小时租约仅纯函数验证，未做真机时钟回拨、重启、后台进程被杀、省电限制测试。
6. APK 仍为 **APP_PENDING**；6.00.48 ZIP 未解包，第三方源码授权、远程限制及客户端协议仍未核实。
7. 旧 Worker 既有风险未修复；本批 helper 不改变线上行为。

## 5. 影响、兼容与回滚

- 本批只新增版本化隔离目录和独立 CI workflow，不替换既有文件。
- 无数据库影响、无正式 migration。
- 无现有 API/HTML/APK 调用方变更。
- 若本批 CI 或模块有问题，可停止引用该 DEV 目录或回退对应提交；不会影响现有 Worker。
- 不能将本批代码直接复制进生产 Worker；必须先完成真实 D1 schema、API 调用方、Token/session、设备原子占额和 APK 兼容核查。

## 6. 下一批唯一接手卡

**第五十九批：APP v2 隔离集成测试与原子设备占额模型验证（不接生产、不部署）。**

1. 重读 AGENTS、功能基线、API 规范、数据库保护规范、总方案、进度、第五十七/五十八批报告。
2. 复核本批 handler 和 36 项测试，补充伪造 entitlement、跨设备、跨管理员、恶意 group rows、乱序 ack、lease 到期边界等反例。
3. 为设备占额设计 D1 原子更新/事务适配器；仅用 mock/本地隔离 SQLite 或兼容测试库验证并发语义，不触碰生产 D1。
4. 为 card/free group loader 设计依赖注入 adapter，并验证 owner/card/group 三方一致性和空组策略。
5. 验证节点查询绑定参数顺序、SQL owner 条件及来源审批字段；字段必须回到 Worker 版本源码和 schema 证据核对。
6. 评估将 resolver、read policy 与 v2 scaffold 组合的最小接入边界，但不修改现有 Worker handler。
7. 如能取得 6.00.48 ZIP 二进制，单独执行只读源码/第三方授权审计；不可将仓库中 ZIP 元数据当作已审计。
8. 不创建正式 migration、不连接生产 D1、不修改 Secrets、不部署。
9. 所有测试真实运行后更新进度、总方案和第六十批接手卡。
