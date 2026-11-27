# 星跃管理平台 V2.5｜HMAC 维度别名注册表并发一致性证明与三类语句清单分离报告

- 批次：V2.5-DEV-B1-APP-IDENTITY-84
- 日期：2026-11-28
- 状态：OFFLINE_CI_PASS_29_OF_29 / HMAC_MODEL_ONLY / MANIFEST_SCHEMAS_DESIGN_ONLY / D1_NOT_TESTED / NOT_DEPLOYABLE
- GitHub Actions：46057517659
- Job：140703508367
- Tested commit：d595a08b72fc6e14e7f24dfaa6939a900403aa43

## 一、本批完成

1. 建立 HMAC dimension alias registry 并发参考模型，逻辑身份使用 opaque dimension_id，密钥版本指纹仅作为 alias，不进入 logical event tuple。
2. K1/K2 overlap 要求同一次服务端操作对全部 active key versions 派生别名，并原子绑定到同一 dimension_id。K1-only 或 K2-only first-seen 请求 fail closed。
3. 处理 aliases 指向多个 dimension_id、alias 重新分配、event_id tuple 冲突、事件别名冲突和精确重试。
4. 增加 legacy K1-only 事件桥接 K2 alias、backfill 高水位快照、快照后新增事件/迟到旧版本 retry catch-up、partial backfill、key retirement 与 cleanup horizon 反例。
5. 明确关键限制：HMAC 不可逆。若历史记录只保留 K1 fingerprint，且没有可信来源可重新取得原始规范化维度值，就无法计算 K2 fingerprint；不得伪造 backfill 完成或按时间/计数猜测合并，必须阻止 K1 retirement。
6. 建立 identity、limiter、disposable harness 三份独立 statement-manifest JSON skeleton、共用 JSON Schema 与静态校验器；SQL 文本/hash、placeholder、bind 数组保持空，生产 SQL 权限为 false。
7. 复核 GitHub 当前分支文件和 SHA，更新 README、报告、总进度与下一批接手卡。

## 二、CI 证据

- Run：46057517659，状态 completed/success。
- Job：140703508367，状态 completed/success。
- Python：3.13.18。
- 命令：python -m unittest -v test_alias_registry_model test_manifest_validator
- 实际结果：29 tests，全部 OK。
  - Alias registry model：20 项。
  - Manifest validator：9 项。
- 证据日志明确列出每项测试，覆盖并发 full alias resolve、K1/K2 单版本拒绝、alias split/conflict、event_id 幂等/冲突、legacy backfill、high-water catch-up、late retry、retirement horizon、cleanup race 与三类 manifest 边界。

CI 仅证明该 Python 合成模型与静态 manifest 校验在 GitHub runner 上通过，不证明 HMAC cryptography、真实 D1 UNIQUE/transaction/batch/locking/query plan、Worker 或生产限流行为。

## 三、主要设计结论与阻塞

### 3.1 Alias registry 候选不等于已批准生产实现

逻辑关系候选：
- (key_version, dimension_type, fingerprint) -> dimension_id
- event_id -> immutable logical event tuple
- (event_id, key_version, dimension_type) -> fingerprint

所有 key-version alias 必须指向同一 opaque dimension_id。生产实现仍需 D1 schema、唯一约束、原子写入和并发证据。

### 3.2 无原文的旧 HMAC 不能换算新 HMAC

HMAC 不可逆。如果只有 K1 digest/fingerprint，不能推导 K2 digest。只有在获授权、可信且受控的源中能短暂重新取得同一规范化输入时，才可以重算 K2 alias。没有此来源则保留旧 key 与旧记录，不能退役 K1。

### 3.3 回填退休门禁

必须覆盖 snapshot high-water 之前的所有相关事件，以及之后所有新增事件和迟到 retry；按 event_id/alias/dimension_id 对账。retry、活动窗口、cleanup、rollback、writer shutdown 任一 horizon 未闭合，不得退役旧 key。

### 3.4 用户决策继续阻塞

U80-01..08 仍未得到用户确认；nonce 表示/作用域、share-code digest 编码、审计 actor/outcome/reason/payload、rotation side effects 继续保持 unresolved。三类 manifest 只是设计骨架，不是生产 statement manifest。

## 四、交付文件

目录：backend/worker/V2.5-DEV-B1-APP-IDENTITY-84/

- alias_registry_model.py
- test_alias_registry_model.py
- identity_adapter-statement-manifest.json
- limiter_adapter-statement-manifest.json
- disposable_harness-statement-manifest.json
- statement-manifest.schema.json
- manifest_validator.py
- test_manifest_validator.py
- HMAC-DIMENSION-ALIAS-CONCURRENCY-PROOF.md
- README.md
- .github/workflows/worker-app-identity84-review.yml

报告：docs/backend/StarJump_V2.5_HMAC维度别名注册表并发一致性证明与三类语句清单分离报告_第八十四批_V2.5-DEV-B1-APP-IDENTITY-84_2026-11-28.md

## 五、数据库、部署与安全边界

本批只新增离线 Python 参考模型、测试、设计 JSON、JSON Schema、说明文档和 GitHub Actions workflow。没有真实 HMAC 密钥或用户维度写入 Git；未连接 D1、未执行 SQL、未创建 migration/DDL、未读取 Secrets、未修改 Worker/API/HTML/APK/Room/Cloudflare 配置、未部署。

状态：D1_NOT_TESTED / WORKER_NOT_INTEGRATED / APP_NOT_INTEGRATED / NOT_DEPLOYABLE。

## 六、第八十五批唯一接手卡

**HMAC alias registry 的生产前置约束审查与 D1 statement manifest 字段完整性审查（仍离线）。**

1. 重读 AGENTS、功能基线、API/DB 规范、总方案、进度及 82–84 批资料。
2. 独立负面复核 Batch 84 model：检查 active key-version set 漂移、跨 worker 并发、alias uniqueness、event_id 跨 owner scope、event/dimension cleanup 与 retention 的关系。
3. 明确 logical dimension_id 的唯一范围：owner/admin scope、dimension_type、tenant boundary；不得因不同管理员/不同维度类型的相同 fingerprint 发生串并。
4. 审查 backfill high-water 是否需持久化 cursor、catch-up watermark、writer epoch 和 snapshot consistency token；只形成字段契约，不写 SQL。
5. 为三类 statement manifest 增加 owner/method/result/error/receipt/audit/assertion dependency 元数据骨架；保留 SQL 与 binds 空白，阻止跨接口混入。
6. 继续审查旧 K1 fingerprint 是否存在可信重算源；没有证据就把旧 key retirement 标为不可执行。
7. 不连接 D1、不执行 SQL、不读取 Secrets、不改 Worker/APK/Room/Cloudflare、不部署。
8. 更新总进度、总方案和第八十六批唯一接手卡。
