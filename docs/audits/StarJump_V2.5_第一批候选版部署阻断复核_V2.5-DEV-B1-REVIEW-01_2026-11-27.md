# 星跃管理平台 V2.5｜第一批候选版部署阻断复核

- 记录编号：V2.5-DEV-B1-REVIEW-01
- 日期：2026-11-27
- 复核对象：`repair/v2.5-batch1-auth-vip-app` 分支 `releases/v2.5-batch1/Worker.js`、`index.html`、`README_部署说明.md`
- 状态：**DEV 候选版复核中；禁止作为生产部署指令**
- 本记录只做代码/文档静态复核；未连接 Cloudflare、未读取生产 D1、未改 Secrets、未部署。

## 1. 本轮核实结果

已重新从 GitHub 读取仓库协作规则、V2.5 功能基线、目录版本规范，以及原始 Worker/HTML 和 Batch 1 文件。

原始 Worker 文件头把 D1 binding 描述为 `DB -> starjump-db`；用户已明确 `starjump-db` 不再使用。不能照搬原始注释或候选版部署说明推断生产数据库。生产 Worker 的真实 D1 binding 尚未通过 Cloudflare 环境只读证据确认。

Batch 1 部署说明要求保留 `SESSION_PEPPER`，并对 `APP_HMAC_SECRET` 提出兼容约束；这属于部署前必须核实的密钥兼容事项，不能让用户凭猜测修改或生成 Secret。

Batch 1 将 `/api/app/status` 改为必须提供 entitlement Token。当前 APK 二进制 ZIP 尚未解包审计，不能证明现有 APK 会在该接口携带 Token。因此直接部署可能导致旧 APK 状态查询失败。

Batch 1 文档自述仅完成 Worker/HTML JavaScript 语法解析和静态断言；没有 Cloudflare 真实部署、D1 集成测试、API 集成测试或 APK 联调。故不能标记为 RC、正式版或已验收。

## 2. 部署阻断项

| 编号 | 阻断项 | 放行条件 |
|---|---|---|
| B1-01 | 生产 D1 binding 真实目标未核实；旧 Worker 注释中的 starjump-db 已被用户废弃 | 只读确认当前生产 Worker 的 DB binding 指向用户实际使用的正式 D1；不改绑定 |
| B1-02 | SESSION_PEPPER / APP_HMAC_SECRET 兼容性未实证 | 由部署环境安全核对现有配置；不要求用户把 Secret 明文提供给 AI，不生成替换值 |
| B1-03 | 现有 APK 对 /api/app/status 的 Token 请求行为未核实 | 解包并静态检查实际 APK 源码/请求封装，必要时在测试环境联调 |
| B1-04 | 未进行真实 API 与 D1 集成测试 | 使用隔离测试环境和脱敏测试数据完成验收 |
| B1-05 | Batch 1 HTML 与真实 Cloudflare 页面部署形态/线上 API 地址尚未实测 | 确认 HTML 部署目标和同源/跨域配置，再做端到端验证 |

## 3. 后续开发批次安排

继续在独立开发分支累计，不要求用户逐批部署：

- Batch 2：APP 分组 generation/tombstone、删除/改型的原子性、APK 增量同步与 cleanup acknowledgement 设计及兼容实现。
- Batch 3：免费授权凭证、APP 卡密事件脱敏/审计、entitlement 生命周期。
- Batch 4：转换密文版本化与密钥轮换兼容、幂等归档、原子限流及失败补偿。
- Batch 5：诊断开关、数据库只读差异检查和版本化幂等迁移。
- Final RC：完整 Worker + HTML + migrations + 测试报告 + 部署/回滚说明统一冻结。

批次编号仅代表开发进度，不代表可部署。每次候选构建必须带版本号、build ID、Git commit SHA、文件 SHA-256（可行时）、兼容性矩阵和测试结果。

## 4. 版本标识与部署门槛

版本通道：

- `DEV`：开发中，禁止生产部署。
- `RC`：候选冻结，仍需完成全部放行检查。
- `STABLE`：通过验收的大版本，才通知用户上传 Cloudflare。

每个可部署大版本必须包含：
1. 配套完整 Worker 和 HTML；
2. 数据库迁移文件及迁移前检查；无 schema 变更也要明确写明；
3. Secret/环境变量兼容清单（只列名称和约束，不写值）；
4. APK 兼容性说明；
5. 自动化/集成/权限/回归测试证据；
6. 部署顺序、健康检查、验收步骤和回滚版本；
7. 完整版本清单与校验值。

## 5. 安全边界

- 不把 `starjump-staging`、已废弃的 `starjump-db` 或任何未经用户确认的 D1 当成生产库。
- 不执行正式 D1 SQL，不创建/删除/迁移正式表。
- 不修改 Cloudflare Secrets、环境变量或部署。
- 不覆盖原始 Worker/HTML；不把模拟 HTML 或未经联调代码称为正式实现。
- 用户只在明确收到“大版本 STABLE，可上传部署”通知后才需要上传。

## 6. 本轮结论

Batch 1 当前只能标记为 **DEV 候选代码（静态检查级）**。保留在独立分支继续审查和累积；不得要求用户上传部署。下一步优先解决 B1-01 至 B1-05 的证据缺口，并继续完成 APP 24 小时清理闭环的下一批开发设计。
