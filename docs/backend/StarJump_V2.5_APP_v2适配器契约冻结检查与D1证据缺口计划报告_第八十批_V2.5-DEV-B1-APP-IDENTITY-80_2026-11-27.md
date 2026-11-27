# 星跃管理平台 V2.5｜APP v2 Adapter 契约冻结检查与 D1 证据缺口计划报告（第八十批）

- 批次：`V2.5-DEV-B1-APP-IDENTITY-80`
- 日期：2026-11-27
- 状态：`PRE_IMPLEMENTATION_REVIEW / BUSINESS_FREEZE_BLOCKED / OFFLINE_CI_PENDING_FINAL / D1_NOT_TESTED / APP_PENDING / NOT_DEPLOYABLE`
- 范围：业务规则与技术提案分层、D1-001..034 证据映射、HMAC key-version union/dedupe 索引和迁移证明、legacy caller 兼容清单。

## 一、本批结论

本批没有进入 adapter 编码。原因不是实现困难，而是有若干业务决策尚未确认，且当前没有获批的专用 disposable D1 与可核实的线上 schema/binding。先把不应猜测的行为列明，避免将技术建议误写为正式业务规则。

### 已确认产品规则
- APP 用户可绑定多个 VIP 管理员；同一管理员只保留一条绑定关系；不同管理员授权隔离。
- 管理员身份 ID 只用于获取该管理员免费分组，不是读取节点数据的认证凭据。
- 卡密获取该卡密配置的卡密分组及符合规则的管理员免费分组；同管理员免费组去重；不同管理员分开。
- 同名卡密分组不合并，显示对应卡密序列号。
- 默认每张 APP 卡密一台设备；有效 VIP 管理员可调整，最多五台；超过五台需超管权限。
- APP 专用分组必须通过专用 APP 分享入口。

以上规则只约束产品行为，不自动批准数据库字段、事件 actor、reason code、canonical field order 或 D1 事务方案。

### 业务决策阻塞
- 是否每次 create-existing 都必须写 `binding.existing_resolved` 审计。
- 各路由 actor 映射。
- 每种操作的 outcome/reason_code 枚举及 reason nullability。
- 审计 payload allow-list、target ID 记录许可、时间戳重试语义。
- 分享编号轮换对既有 binding/session/challenge/free grant 的影响。
- 轮换后旧 challenge 是仅在消费时拒绝，还是另有明确失效策略。

以上逐项列为 U80-01..08，不擅自作业务决定。

## 二、交付文件

1. `backend/worker/V2.5-DEV-B1-APP-IDENTITY-80/ADAPTER-CONTRACT-FREEZE-CHECKLIST.md`
2. `backend/worker/V2.5-DEV-B1-APP-IDENTITY-80/D1-EVIDENCE-MAP.md`
3. `backend/worker/V2.5-DEV-B1-APP-IDENTITY-80/batch80_case_extension.json`
4. `backend/worker/V2.5-DEV-B1-APP-IDENTITY-80/HMAC-OVERLAP-INDEX-AND-MIGRATION-PLAN.md`
5. `backend/worker/V2.5-DEV-B1-APP-IDENTITY-80/LEGACY-CALLER-COMPATIBILITY-INVENTORY.md`
6. `backend/worker/V2.5-DEV-B1-APP-IDENTITY-80/test_batch80_freeze.py`
7. `backend/worker/V2.5-DEV-B1-APP-IDENTITY-80/README.md`
8. `.github/workflows/worker-app-identity80-freeze.yml`

## 三、D1 证据缺口

Batch 76 的 D1-001..026 全部逐项映射到必须观察的数据库行为；本批追加 D1-027..034：
- create-existing 保持既有 binding ID/created_by/created_at/generation 不变；
- receipt 同 operation ID 不同 type/fingerprint 冲突；
- 四类操作 audit exact-match 字段反例；
- revoke owner boundary 与非泄露语义；
- 经用户确认后的 rotation side-effect 验证；
- HMAC 跨版本 event_id union/dedupe；
- cleanup 与 union history 的并发保护；
- key-version migration/index coverage 无缺口证明。

新增矩阵是计划，不是 D1 实测。所有 D1 测试仍需独立数据库 ID、准确 Worker binding、环境隔离证据和分别授权的只读/写入/清理许可。

## 四、HMAC overlap 方案

明确把 `event_id` 作为跨 key-version 的逻辑事件身份。相同 event_id + 相同 tuple 只计一次；相同 event_id + 不同 tuple 是完整性冲突；K1-only 和 K2-only 的不同事件必须共同计入。不能简单求和（重复双写会双计），不能取最大桶（分散历史会漏计）。

候选存储策略包括 canonical logical event + version aliases、双写版本桶后按 event_id union、迁移到新权威 fingerprint namespace。未选择具体方案；需要 schema snapshot、D1 EXPLAIN、并发准入和迁移 high-water mark 证据。未设置任何生产阈值或保留期限。

## 五、Legacy 兼容性发现

历史 Worker 源码包含 `/api/app/resolve`、`/groups`、`/free`、`/links`、`/redeem`、`/status`、`/nodes` 及 user/super-admin share-code 路由。APP v2 的 Batch 64 read handler 是注入依赖的隔离模块，仓库未证明它已注册进历史 Worker 或被 APK 调用。APK 源码未能在本批取得可审计调用点，因此客户端调用清单仍不完整。不得删除/改写旧路由，也不得把旧 share-code 表当成已具备 version/revocation 能力。

## 六、CI 记录

- 首轮 Run `46000337282`：24 项结构测试中 4 项失败，均为测试断言文案与实际文档措辞不一致；不是 D1 或业务实现测试。
- 第二轮 Run `46000406826`：24 项中 1 项因大小写不一致失败；测试断言已修正。
- 最终修订 Run `46000471562`：等待最终日志确认；未确认前不标记通过。
- 测试只验证本批静态清单/矩阵/兼容文档结构，不连接网络或 D1，不执行 SQL，不验证 Worker/APP 行为。

## 七、影响、安全与回滚

- 仅新增 DEV 目录文档、JSON 证据矩阵扩展、离线 Python 检查与 workflow。
- 未连接 D1；未读取凭证；未执行 SQL；未创建 migration。
- 未修改 Worker、HTML、APK、Room、Secrets、Cloudflare 配置；未部署。
- 回滚仅需撤销本批文档/离线测试/workflow 提交；没有业务数据改动。
- 仍不可部署。

## 八、第八十一批唯一接手卡

**APP v2 adapter implementation readiness gap closure（继续不连接 D1，除非另获明确授权）。**

1. 重读 AGENTS、功能基线、数据库/API 保护规范、总方案、进度和第七十四至八十批相关资料及最新 CI。
2. 核查 U80-01..08 是否获得用户决定；没有决定的行为保持 fail-closed / 不实现，不用默认猜测填空。
3. 完成 legacy share-code 所有 Worker/HTML/APP 调用点的静态盘点；若 APK ZIP 仍不可读，明确列出缺失证据，不声称完成客户端审计。
4. 将每个 adapter method 形成 statement-level source/bind/result/receipt/audit assertion 清单，并关联 D1-001..034；不写生产 SQL。
5. 设计可执行但默认禁用的 disposable harness 实施审查稿；必须保留无凭证 CI、显式 DB ID/binding 核验、单独授权、run_id namespace 和 ledger-only cleanup。
6. 对 HMAC 方案比较三种候选架构，提出可验证的选择标准和 rollback proof；不设生产阈值。
7. 不连接 D1、不读取凭证、不执行 SQL/迁移、不修改 Worker/HTML/APK/Room/Secrets/Cloudflare 配置、不部署。
8. 更新总进度、总方案和第八十二批唯一接手卡。
