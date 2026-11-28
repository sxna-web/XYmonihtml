# 星跃管理平台 V2.5｜HMAC 作用域隔离、并发配置漂移与回填检查点契约报告

- 批次：V2.5-DEV-B1-APP-IDENTITY-85
- 日期：2026-11-28
- 状态：OFFLINE_REVIEW_AND_MODEL / MANIFEST_METADATA_DESIGN_ONLY / D1_NOT_TESTED / NOT_DEPLOYABLE

## 一、本批负面复核发现

1. 第八十四批 alias key 只有 key_version、dimension_type、fingerprint，缺少 tenant/owner scope；合成模型中的 event_id 也未按 owner 隔离。相同 fingerprint 在不同管理员或租户之间存在串并风险。第八十五批模型改为 tenant_id + owner_id + dimension_type 命名空间。
2. 第八十四批 RLock 仅保护单 Python 进程内线程，不证明多个 Worker isolate/实例之间的并发安全。生产必须由数据库唯一约束和原子写入边界共同保证；不能 read-then-write。
3. active key set 可在 Worker 读取配置后发生变化。新增 active_key_set/config_epoch 契约：同一写入必须验证完整 active set 与 epoch；陈旧 writer fail closed 并刷新重试。
4. event cleanup 不等于 dimension alias cleanup。删除事件前需满足已批准留存规则、活动窗口、retry 和 backfill 条件；dimension alias 必须独立退休，不能因事件清理立即释放或重新分配。
5. 没有发现可信证据证明旧 K1-only fingerprint 可从受控来源重取规范化原始输入并重算 K2。K1 retirement 标记为 NOT_EXECUTABLE / BLOCKED。

## 二、身份唯一作用域

逻辑 dimension_id 的唯一范围为 tenant_id、owner_id、dimension_type 的组合。指纹不是全局身份。owner/tenant 必须来自已认证服务端上下文，不能由请求体自行指定。实际标识是否允许持久化仍受隐私和 U80-01..08 待确认项约束；本批没有实现真实 ID 存储。

## 三、跨 Worker 并发要求

- Alias 唯一性：tenant + owner + dimension_type + key_version + fingerprint。
- Event 唯一性：tenant + owner + event_id。
- Event alias 唯一性：tenant + owner + event_id + key_version + dimension_type。
- 所有 active key aliases 必须指向同一个 opaque dimension_id。
- key-set/config epoch 必须在同一个原子写入边界验证。
- 任何 alias insert、receipt/audit/assertion 失败均不得留下部分提交。
- 需要真实 D1 并发首次建档、冲突竞争、回滚、零行断言和 writer fencing 证据；本批没有执行。

## 四、持久化回填检查点字段契约（仅设计）

至少需要 migration_id、source_snapshot_id、snapshot_consistency_token、snapshot_high_water（稳定复合排序键）、last_committed_cursor、catch_up_watermark、catch_up_cursor、writer_epoch、active_key_set_epoch、expected_key_versions、coverage_total、page_identity/checksum、lease_epoch、fencing_token、state、attempt、outcome_unknown、last_error_class。

游标只能与该页 alias 写入在同一原子边界提交。未知提交结果必须先核对再推进游标。快照必须有一致性 token；仅有时间戳或最大 event ID 不足以证明快照一致。回填任务需可幂等重放并通过 fencing 阻止旧 worker 提交。

## 五、三类 statement manifest

identity、limiter、disposable harness 的 schema 升级到 1.1，增加 owner、method、purpose、result_contract、error_contract、receipt_dependencies、audit_dependencies、assertion_dependencies。三个 manifest 仍为空骨架；SQL/hash/placeholders/binds 继续为空，production_sql_permitted=false。Harness 不得调用生产 identity/limiter 方法。

## 六、旧 K1 重算结论

HMAC 不可逆。现有审查材料没有提供可信 canonical-input 重算源，因此不能计算 K2、不能伪造覆盖证明、不能按时间/计数推测映射。旧 K1 必须保留；退役状态 BLOCKED，直到可信来源、授权、全量覆盖与回滚证明全部成立。

## 七、测试与边界

- 新增 scoped alias 合成模型与 8 项测试。
- 新增 manifest metadata validator 与 6 项测试。
- 本地/CI 运行证据需以实际 GitHub Actions 结果为准；模型不证明 D1、真实 HMAC、跨 Worker、Worker/APP 集成。
- 未连接 D1、未执行 SQL/DDL/migration、未读取 Secrets、未修改 Worker/API/HTML/APK/Room/Cloudflare 配置、未部署。

## 八、第八十六批唯一接手卡

1. 复读 AGENTS、功能基线、DB/API 规范、总方案、进度及 82–85 批资料。
2. 独立负面审查 scoped alias 唯一键是否会受软删除、租户迁移、owner 转移、事件重放和 dimension type 版本升级影响。
3. 为 durable backfill contract 建立纯 Python 状态机，覆盖 checkpoint 原子推进、crash/outcome-unknown、重复页、stale lease/fencing、catch-up watermark 漂移。
4. 将三类 manifest metadata 与八方法 statement matrix/D1-001..034 建立映射索引，但不填写 SQL/binds、不冻结 U80-01..08。
5. 继续查找旧 K1 canonical-input 的可信重算来源；无证据保持 K1 retirement blocked。
6. 继续离线；不连接 D1、不读取 Secrets、不执行 SQL/迁移、不修改 Worker/APK/Room/Cloudflare、不部署。
7. 更新总进度、总方案与第八十七批唯一接手卡。
