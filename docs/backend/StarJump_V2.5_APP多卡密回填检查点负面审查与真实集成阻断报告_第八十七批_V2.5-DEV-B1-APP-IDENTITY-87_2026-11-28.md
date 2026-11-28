# 星跃管理平台 V2.5 APP 多卡密回填检查点负面审查与真实集成阻断报告

- 批次：V2.5-DEV-B1-APP-IDENTITY-87
- 日期：2026-11-28
- 基于分支：release/v2.5.0-rc1-converge
- 审查基线：PR #2 head 444d159ddb64ca6b86483ddd390b3fa093a87835
- 状态：负面审查完成；未接入生产 D1；不可部署

## 1. 本批核对

- PR #2 为 Draft / Open / Unmerged，base 为 main；本批不合并、不部署、不触碰 main。
- 第八十六批专用 workflow Run 46126002802 SUCCESS；RC1 convergence Run 46126002751 SUCCESS。两项均关联第八十六批代码 head；不将它们表述为 D1 实测。
- 已复核 Batch86 checkpoint 实现、19 项测试、README、批次报告和连续进度记录；未重复执行已有测试。

## 2. 第八十六批模型负面审查结果

### A87-01：游标排序规则没有与持久化查询绑定

模型直接使用 Python tuple/string 比较（<、<=、>）。这只能证明 Python Unicode 字符串字典序下的单调性，不能证明真实 D1 查询的 ORDER BY、WHERE 游标谓词及 collation 与之相同。若分页键包含大小写、变音字符、数字字符串或不同规范化形式，跨运行时排序差异可能导致漏页/重页。

要求：生产实现必须定义唯一 canonical key 编码、固定 SQLite/D1 BINARY collation（或经证明等价的排序规则）、唯一 tie-breaker，并确保 SELECT ORDER BY 与续页谓词逐列同序、同方向、同类型。上线前用真实 schema 和边界数据在 D1 staging 验证。

### A87-02：snapshot token 目前只是非空字符串

模型只验证 snapshot_consistency_token 非空，没有验证 token 由谁签发、是否绑定 source snapshot、是否固定读取视图、是否覆盖插入/删除/更新，以及 token 过期后的行为。因此模型本身不能证明扫描期间数据集稳定。

要求：snapshot provider 必须给出可验证的不可变快照/一致性读取契约，明确 token 生命周期、快照可见性、删除语义、分页稳定性和恢复语义。若 D1 不提供所需快照能力，应使用可审计的替代方案（例如明确的版本水位与变更日志重叠窗口），不能把普通时间戳或 max(id) 直接称为一致性快照。

### A87-03：coverage_total 未参与完整性判定

coverage_total 被存储但没有在 complete() 中与 alias_receipt_count 或独立源端覆盖统计核对。当前测试可在数量不足或过量时仍进入 COMPLETE。alias_receipt_count 只是模型累计写入行数，不是源端总量证明。

要求：真实实现必须定义 coverage_total 的权威来源、计数口径、删除/过滤处理、重试幂等口径，并在终态执行可复核的 coverage reconciliation。若源数据可能变化，需按 snapshot token 和 catch-up watermark 分阶段计算，不能简单要求两个不同时间点的裸计数相等。

### A87-04：零行页允许推进游标

commit_snapshot_page 与 commit_catch_up_page 接受 row_count=0，同时允许 end_cursor/next_cursor 前进。零行页可能是合法的过滤后扫描页，但当前契约没有区分空页、空结果集、被过滤页和 provider 分页错误，可能以空回执推进覆盖进度。

要求：明确空页合法性和 provider 的 has_more/terminal 语义。若允许空页推进，必须有源端分页证明和明确的页边界；若不允许，则拒绝 row_count=0 的推进页。不能只靠 cursor 增长推断覆盖成功。

### A87-05：snapshot/catch-up page identity 缺少显式阶段域

page_identity 仅对 catch-up 的 snapshot_id 拼接 ':catch-up'。阶段信息应是身份材料中的独立字段，而不是可碰撞的字符串后缀；否则特殊 snapshot_id 可使两种阶段生成相同身份输入。

要求：page identity canonical material 增加显式 phase/version 字段，并包含 migration ID、snapshot ID、cursor 编码版本及必要的页元数据。保留旧身份兼容策略，禁止无迁移地更换生产 receipt key。

### A87-06：reconcile_unknown 只查内存 receipt，缺少持久化证明边界

模型 reconcile_unknown() 按 unknown_page_id 查询当前字典并清除 unknown 状态；这只证明同一内存实例中的模型结果。持久化实现必须以同一 migration/snapshot/phase/page identity 查询权威 receipt，并确认 receipt 与 cursor/目标写入在同一事务提交单元中；缺失 receipt 也不能在未确认事务最终状态前直接重放。

要求：明确 COMMIT_OUTCOME_UNKNOWN 的 durable reconciliation protocol、事务结果可见性等待/重试策略、唯一约束和冲突分类；不得以进程内字典替代 D1 事务证据。

## 3. 已有模型边界中目前表现正确的部分

- lease renewal 返回新 expires_at，旧 lease 对象因 expires_at 不匹配而失效；模型中的 owner/epoch/fencing token/expiry 均参与校验。
- 相同 page identity 但 receipt 不同会 PageConflict；重复且完全相同的 receipt 不重复增加 alias_receipt_count。
- unknown outcome 会阻断后续页和 complete，直到显式 reconcile。
- writer_epoch、active_key_set_epoch、expected_key_versions 漂移会 fail closed。
- 以上均为模型内部行为，不构成 D1 多 Worker 原子性或并发串行化证明。

## 4. APP 多卡密真正集成阻断（未解除）

1. 缺少经用户确认的 staging/production D1 schema-only snapshot；七张 APP 核心/候选表的真实列、索引、FK、trigger 与历史数据兼容仍 NOT VERIFIED。
2. Batch85 三类 statement manifests 仍无可冻结 statements / D1-001..034 SQL 与 bind contract；不能据此生成正式 adapter SQL。
3. Protocol66 D1 adapter 仍是候选 harness，未绑定真实 schema、未注册 Batch49 Worker route；Protocol65 多 entitlement handler/service 也未接入正式路由。
4. 卡密实例到分组 mapping table 的生产 DDL 未获真实 schema 支持；旧 group mode public/assigned/free 与 card 兼容策略未定。
5. 后台 HTML 尚未完成卡密分组管理 UI 与接口联调；APK 多凭据保存、请求签名、错误兼容和增量清理 ACK 未端到端验证。
6. 当前 APP group/link 读取仍以最新 entitlement 为主，尚不满足多卡密聚合与同管理员 FREE 组去重要求。

## 5. 下一步唯一安全路径

1. 先取得目标环境明确标记的 schema-only metadata：staging 与 production 必须分开；只导出 sqlite_master、table_info、index_list/index_info、foreign_key_list、trigger/view 定义摘要，不导出卡密 code、token、业务行或 Secrets。
2. 将导出 JSON 输入既有 schema_manifest.py，生成带环境标签的 manifest 并 compare；结构缺失只报告，不自动创建表或生成 migration。
3. 对 Batch85 manifests 逐一定位源文件，确认 statement ID、SQL、bind 顺序、返回列和调用方是否真实存在；缺项保持 BLOCKED，不生成虚构 SQL。
4. schema 证据齐备后，先在隔离 staging 实现 mapping migration + Protocol66 adapter + route + HTML UI，再做真实 D1 batch rollback/并发/权限撤销验证。
5. APK 多 entitlement 协议与持久化测试通过后，才评估 Worker/HTML 两文件候选构建；仍需独立版本、SHA-256、健康检查和回滚说明。

## 6. 本批执行边界与结论

- 本批只读审查 GitHub 候选分支文件与既有 CI 元数据；没有连接 Cloudflare/D1，没有执行 SQL/DDL/DML，没有访问 Secrets，没有部署。
- 没有修改 Worker、HTML、数据库迁移或 APK 协议；没有将离线模型包装成生产实现。
- 第八十六批模型保留为参考模型，但其排序、快照一致性、coverage reconciliation、空页语义、阶段域身份和持久化 reconcile 契约均须在真实实现中补齐。
- PR #2 继续 Draft/Open/Unmerged；未经用户明确授权不合并、不部署。

## 7. 下一批接手卡

优先完成 Batch85 statement manifest 源文件定位与 SQL/bind 合同清点；并准备一份面向用户的 staging schema-only 导出步骤。不得再新增重复 checkpoint fixture。真实 schema 未取得前，不创建生产 DDL、不注册 Protocol65/66 正式路由。