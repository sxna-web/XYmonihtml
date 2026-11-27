# 星跃管理平台 V2.5｜APP v2 D1 兼容准备与 6.00.48 源码审计状态报告

- 批次：第六十批
- 版本：V2.5-DEV-B1-APP-PROTOCOL-60
- 日期：2026-11-27
- 状态：代码复核与隔离回归测试完成；GitHub Actions 通过；无隔离 D1 实测；6.00.48 ZIP 未能读取；未接入 Worker；不可部署。

## 1. 本批执行边界

本批遵循仓库 AGENTS.md、功能基线、API 规范、数据库保护规范和总方案。只在新版本目录增加隔离代码、测试与文档；不修改原始 Worker、HTML、APK、Secrets；不连接生产或 staging D1；不创建正式 migration；不部署。

第五十九批目录与测试文件已恢复为原始 blob 内容（group-composition.mjs SHA 41b9fe230d8d16216714885d8dd9f3d60ab9c9cd；group-composition.test.mjs SHA d04a382fbd8b0f27439c12ad5b882c019414e40a），本批改进放入独立第六十批目录，避免覆盖历史版本。

## 2. 第五十九批代码复核与新增加固

新增 `backend/worker/V2.5-DEV-B1-APP-PROTOCOL-60/group-composition.mjs`：

- 拒绝重复 entitlement ID。
- 拒绝多余或不属于本次 entitlement 集合的 loader 结果。
- 同一 entitlement 内重复 card group row fail closed。
- 同名 card group 的序列号后缀仅在同一管理员范围内触发；不同管理员的同名分组不错误加上卡密序列号。
- 输出字段采用显式投影，不将数据库任意额外字段传播到 APP。
- 仍保留同管理员 free group 去重、不同管理员隔离、每张卡密独立 card group 的既定规则。

新增测试覆盖上述反例，以及第五十八/五十九批授权 handler、loader、同步状态和设备占额接口边界。

## 3. 设备占额与未来 schema 设计（非迁移）

候选设计：
- `app_cards.max_devices INTEGER NOT NULL DEFAULT 1`，正整数；有效 VIP 管理员可设 1–5，超管可设更高。
- `app_card_device_slots` 以 `(card_id, device_key)` 为唯一键，保存创建时间、释放时间和释放原因。
- device_key 应为服务端不透明标识或 keyed digest，不使用原始 IMEI/硬件序列号。
- 同一设备使用两张卡密时，两张卡密分别占用各自名额。
- 既有 active entitlement 回填必须幂等；如果历史 active 设备数超过新限制，先 grandfather 已有绑定并阻止新增，不得擅自撤销现有用户。
- 设备解绑/释放的授权条件尚未由用户确认，本批不自动释放，也不假定卡密过期即释放。
- 正式迁移前必须核实真实 schema、约束、索引、旧数据冲突，先输出冲突清单并获批。

**本批没有隔离 D1 可用凭据或独立数据库标识，因此没有运行 D1 测试。** SQLite 测试仅能证明本地模型，不等于 D1 runtime 证明。

## 4. 6.00.48 源码只读审计状态

- Library 当前列表只找到 `StarJump-6.00.47-source.zip`，没有 6.00.48。
- GitHub tree 确认 `StarJump-6.00.48-source.zip` 存在：2,323,467 bytes，blob SHA `2b8b6d105019fb90341c7178438b2d6b0473699f`。
- GitHub 文件接口无法读取二进制 ZIP；raw binary 下载也未成功。
- 因此没有解包 6.00.48，没有核实其许可证、第三方 SDK、授权服务器、远程停用、域名依赖、遥测或客户端 API。
- 不得用 6.00.47 审计结果替代 6.00.48 结论；APP 继续标记 APK_PENDING。

## 5. 测试与 CI

本批新增 19 项 Node 测试，复用第五十八/五十九批测试及 SQLite 并发测试。GitHub Actions Run 45965260408 completed/success：第五十八批 36/36、第五十九批 16/16、第六十批 19/19，SQLite 并发 3/3，语法检查通过，0 失败。\n\nRun：https://github.com/sxna-web/XYmonihtml/actions/runs/45965260408

## 6. 风险、兼容与回滚

- 无生产 schema 证据，所有未来表/字段仍为设计提案。
- 设备槽位回填、释放规则、设备标识隐私策略需继续核实。
- 6.00.48 第三方许可和客户端协议未知。
- 本批新增目录与 workflow 可独立 revert；不涉及线上数据，不需要数据库回滚。
- 不接入旧 Worker，不影响现有 API/HTML/APK。

## 7. 本批结论

完成了多卡密分组组合边界的额外加固与隔离回归测试准备；没有获得隔离 D1 或 6.00.48 二进制，故两项仍未认证。当前为 DEV / CI_PASSED / D1_NOT_TESTED / NOT_INTEGRATED / NOT_DEPLOYABLE。

## 8. 第六十一批唯一接手卡

**APP v2 卡密设备占额数据生命周期与客户端授权协议对照（继续隔离，不部署）。**

1. 检查第六十批 CI 完整日志；失败必须先修复。
2. 复核 batch60 的 group projection、重复组检测和多管理员显示范围。
3. 设计 slot backfill 冲突报告、设备解绑审批和卡密失效/续期时 slot 生命周期；不创建 migration。
4. 如用户后续提供 6.00.48 ZIP 到 Library/当前对话，执行只读授权/SDK/API/隐私审计；未提供则保持 APK_PENDING。
5. 依据 6.00.47 可读源码，整理客户端本地 Room group 映射与 Worker v2 字段差异，但不得宣称 6.00.48 兼容。
6. 不连接生产 D1，不改 Worker/HTML/APK/Secrets，不部署。
7. 更新总进度、总方案和第六十二批接手卡。
