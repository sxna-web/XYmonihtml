# 星跃管理平台 V2.5｜APP v2 多卡密分组组合与原子设备占额隔离验证报告

- 批次：第五十九批
- 版本：V2.5-DEV-B1-APP-PROTOCOL-59
- 日期：2026-11-27
- 状态：隔离 DEV helper 已编码；本地 Node/SQLite 测试通过；GitHub Actions 待验证；未接入现有 Worker；不可部署。

## 1. 本批执行范围

依据第五十九批接手卡，复核第五十八批授权策略、同步状态和 handler scaffold，并补充多卡密组合、card/free group loader、设备占额 SQL adapter、跨设备/恶意数据/乱序 ack/lease 边界测试。

本批没有接入现有 Worker 路由，没有修改原始 Worker、HTML、D1、Secrets 或 APK；没有连接 Cloudflare；没有创建正式 migration；没有部署。

## 2. 新确认并落实的多卡密显示规则

用户在本批新增确认：

1. 同一 APP 用户同时使用同一 VIP 管理员的多张有效卡密时，每张卡密均获取其自身配置的 card 分组。
2. 同一 VIP 管理员的 free 分组只展示一份，不因卡密数量重复附带。
3. 不同 VIP 管理员的 free 分组按管理员分别保留，不跨管理员合并。
4. 不同卡密的 card 分组即使名称相同也不合并、不覆盖；同名时每一份均追加其所属卡密序列号，例如“香港节点（序列号-001）”和“香港节点（序列号-002）”。
5. 卡密序列号仅作显示标识，不得使用可核销卡密明文或完整兑换凭证。

该组合模型以 entitlement 为卡密分组来源边界，以 admin_user_id 为 free 分组去重边界。某张卡密失效时，仅移除该 entitlement 的 card 分组；其他卡密仍独立有效。free 分组根据管理员 grant/权限条件独立决定，不由每张卡密重复生成。

## 3. 新增隔离代码

目录：backend/worker/V2.5-DEV-B1-APP-PROTOCOL-59/

- group-composition.mjs：组合多份 entitlement；保留各卡密 card groups；同管理员 free groups 按 group ID 去重；重名 card group 添加安全序列号标签；跨管理员、错误类型、禁用分组拒绝。
- group-loader.mjs：依赖注入加载器；校验 card ID、卡密 owner、group owner、分组类型、enabled、free grant 与管理员免费权限；依赖失败 fail closed。
- device-slot-adapter.mjs：单条条件 INSERT...SELECT 设备占额 SQL；参数绑定顺序固定；重复设备通过唯一键幂等识别；不含正式 schema/migration。
- group-composition.test.mjs：覆盖多卡密组合、免费组去重、同名标签、跨管理员隔离、空组、loader owner 检查、handler 错配、恶意 group rows、乱序 ack、租约到期和 SQL 参数顺序。
- device_slots_sqlite_test.py：独立 SQLite 并发模型测试。
- README.md：运行方法、数据契约、限制和不可部署声明。
- .github/workflows/worker-app-protocol59-tests.yml：Node 22 + Python 3.12 CI，串行执行第五十八批与第五十九批测试。

## 4. 设备占额模型与边界

隔离模型使用 app_card_device_slots 的复合主键 (card_id, device_id)，单条条件插入在 SQLite 写语句内检查当前卡密占用数量，并以唯一键保证同一设备重复请求幂等。

本地 SQLite 并发测试覆盖：
- 12 个不同设备并发争抢 3 个名额，最终最多 3 个成功；
- 8 个相同设备并发重试，只创建 1 条占额记录；
- 不同卡密各自计算设备上限，互不占用名额。

当前仅验证本地 SQLite 语句语义。不能把它等同于 Cloudflare D1 真实并发验证。未来生产接入前必须：
- 取得并核实真实 D1 schema；
- 设计既有 active entitlement 的安全回填；
- 明确设备解绑/撤销后是否释放占额，以及释放的授权条件；
- 在隔离 D1 中执行并发压力测试；
- 完成独立审核、迁移备份和回滚方案。

本批不创建表、不假设正式 D1 已存在 app_card_device_slots。

## 5. 本地测试证据

本地运行环境：Node.js v22.16.0；Python SQLite 标准库。

- Node：group-composition.test.mjs，16 passed / 0 failed。
- SQLite：device_slots_sqlite_test.py，3 passed / 0 failed。
- 语法检查：group-composition.mjs、group-loader.mjs、device-slot-adapter.mjs 通过。
- GitHub Actions：待本报告提交后运行；未取得 CI 结果前不得标记 CI 通过。

## 6. 与第五十八批的接入关系

最小边界建议：
1. entitlement resolver 负责精确解析 entitlement/device/token，并从可信数据库记录返回 admin_user_id、card_id。
2. group loader 负责按该 entitlement 加载 card mappings、管理员分组、free grant 和 free permission。
3. group composition 负责把同一用户多份 entitlement 的返回内容组合为 UI 列表，并做 free 去重/同名显示。
4. read handler 只接收可信 loader 输出，继续验证 entitlement/device/owner/allowlist；nodes 查询只能按对应 entitlement allowlist。
5. 任何一个 entitlement 的撤销/过期只影响该 entitlement 的 card groups；同管理员 free groups 应重新按管理员级 grant 状态计算。

本批没有修改第五十八批 helper，也没有接入真实 Worker。以上是隔离组件边界，不是线上现状。

## 7. 数据库、兼容、回滚与风险

- D1：无连接、无 schema 读取、无 SQL 执行、无 migration。
- Worker/API：无路由接入、无原始 Worker 修改。
- HTML：无修改。
- APK：无修改；仍为 APK_PENDING。
- Secrets/Cloudflare：未读取、未修改、未部署。
- 回滚：本批为新增版本目录、CI workflow 与文档；可通过 Git commit revert 本批新增文件/文档更新，不触碰历史目录。
- 主要风险：生产 schema 未核实；card-group mapping 表仍为待批准数据模型；设备 slot 回填和释放政策未冻结；D1 并发未实测；客户端如何显示 serial label 未审计。

## 8. 本批结论

多卡密组合规则已形成隔离实现和本地测试证据。设备占额单条 SQL 在本地 SQLite 并发模型中通过，但仍需隔离 D1 验证。当前状态不是生产集成，不可部署。

## 9. 第六十批唯一接手卡

**APP v2 D1 兼容验证准备与 6.00.48 源码只读审计（不接生产、不部署）。**

1. 重读 AGENTS、功能基线、API、数据库保护规范、总方案、进度和第五十七至五十九批报告。
2. 检查第五十九批 GitHub Actions 最终结果；若失败，先读取完整日志并修复，不得跳过失败。
3. 审核本批 group composition 的重复 entitlement、相同 group ID、多卡密重名和 free group 去重边界。
4. 明确 app_card_device_slots 未来 migration/backfill/release 设计，不创建正式 migration；在隔离 D1（若可用且明确非生产）验证单条条件 INSERT 并发行为。
5. 重新核对真实 schema 字段来源，禁止将草案字段当作现存列。
6. 若 6.00.48 ZIP 可从 Library 解包，执行只读源码、许可证、第三方服务依赖和客户端协议审计；否则明确 APK_PENDING。
7. 不接入现有 Worker，不改 HTML/APK/Secrets，不连接生产 D1，不部署。
8. 更新进度、总方案和第六十一批接手卡。
