# 星跃管理平台 V2.5｜最新 AI 接手卡

- 记录日期：2026-11-29
- 记录版本：HANDOFF-2026-11-29-APP-DIAGNOSTICS
- 仓库：sxna-web/XYmonihtml
- 分支：main
- 本文件性质：跨会话接手索引；不是实现或部署证明。

## 1. 下一位 AI 开始工作前必须执行

1. 读取根目录 `AGENTS.md`。
2. 读取本文件。
3. 读取 `docs/星跃管理平台V2.5_功能基线与权限验收规范.md`。
4. 读取 `docs/星跃管理平台V2.5_开发进度与测试验收记录.md` 的末尾最新记录。
5. 读取 `docs/audits/StarJump_V2.5_工具可靠性项目连续性与总进度控制总方案_V1_2026-11-27.md`。
6. 按任务模块继续读取最新设计、实施、测试、迁移文件；并检查当前 main 分支实际源码和提交 SHA。不得仅依赖聊天摘要或本接手卡。
7. 开始前先向用户简短确认已读取资料，并报告当前真实状态；若不能访问仓库，明确说明并请求用户提供仓库访问，不得假装已读取。

## 2. 本轮最新事实（2026-11-29）

- 原始 Worker 已从项目文件库恢复到本地工作路径 `/mnt/data/starjump_resume/StarJump_V2.5_Production_Worker.js`，大小 29,823 bytes；来源 file_id `file_0000000010348207a6a12f2d956420e7`。
- APP 授权 SQL 已恢复到 `/mnt/data/starjump_resume/StarJump_V2.5_APP_Authorization_Additive_v1.sql`，大小 11,862 bytes；来源 file_id `file_000000004bac820baf3043311682487f`。
- 原始 Worker 的 `digestHex()` 用于后台 SESSION token，算法为 SHA256(`SESSION_PEPPER:token`)。本次核对未发现 APP 卡密创建、激活、card_code_hash 写入或卡密诊断路由。
- 授权 SQL 定义 `app_access_cards.card_code_hash`，但未定义摘要算法。
- 历史摘要提及 APP 卡密管理 DEV v1.5，但本次 GitHub 仓库代码搜索和文件库检索均未找到其实际源码/报告；不得凭摘要臆测算法。下一步先恢复/定位真实 DEV v1.5 Worker 和报告，再追踪创建、激活、持久化、查询的完整算法链。
- 诊断查询优先卡密，APP user ID 辅助；VIP 只能查询自身租户，超管可跨租户但必须审计。卡密不得进入 URL 或日志；不能返回节点凭据。
- APP 用户 ID 辅助诊断曾有本地 DEV v1.2 候选记录，但在重新核对其源码/提交与测试证据前，不得将其认定为 GitHub 主分支实现或真实 API 已完成。
- 目标测试环境为 Cloudflare D1 `starjump-staging`；Worker `starjump-api-staging`。其他数据库名不得替代。Staging 曾记录 `DIAGNOSTICS=0`，启用前须检查 feature gate 与权限审计。
- 当前没有本轮 D1/API/APP/生产测试证据；没有部署生产环境；没有修改生产 Worker 或 D1。

## 3. 下一步执行顺序

1. 在 GitHub 全仓和历史提交中定位卡密管理 DEV v1.5 的 Worker、SQL、测试和报告。
2. 对比卡密创建/激活实际代码，确认唯一、兼容的 card hash 算法及密钥来源；若找不到，保持卡密查询关闭并提出最小兼容设计。
3. 将已验证的分组诊断方案与当前仓库 Worker/API 基线对照，做影响分析和独立版本实现；禁止覆盖原始基线。
4. 完成 VIP/超管租户隔离、审计、限流、敏感字段脱敏和拒绝路径测试。
5. 在 `starjump-staging` 先只读核对 D1 schema 与 Worker 绑定，再经用户授权进行 Staging 迁移/API 测试。
6. 管理后台页面、APP 客户端联调和真实第三方代理 APP 拉取诊断另行验收。
7. 同步接口继续 fail-closed，直到完整安全同步协议通过验证。
8. 每批更新总进度、批次报告和下一会话接手卡；生产部署必须单独取得用户明确批准。

## 4. 不可违反的状态标记

- 需求已确认 ≠ 已编码。
- 已编码 ≠ 已测试。
- 本地 SQLite ≠ Cloudflare D1。
- handler mock ≠ 真实 Worker API。
- 代码检查 ≠ APP 客户端联调。
- Staging 验证 ≠ 生产部署。
- 没有部署记录就不得写“已部署”。
- 不得把 SESSION token hash 擅自当作 APP 卡密 hash。
- 不得提交卡密明文、真实令牌、Secret、订阅 URL 或数据库凭证。

## 5. 每批必须更新

- 当前版本/批次/日期/提交 SHA
- 修改文件及路径
- API、数据库影响
- 测试命令、环境、结果与证据
- 未完成事项、阻塞、风险
- 回滚方法
- 下一步唯一优先接手任务
- 是否部署及部署环境（没有则明确未部署）
