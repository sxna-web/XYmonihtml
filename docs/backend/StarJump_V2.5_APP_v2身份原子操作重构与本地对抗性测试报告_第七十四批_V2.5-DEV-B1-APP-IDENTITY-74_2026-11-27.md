# 星跃管理平台 V2.5｜APP v2 身份原子操作重构与本地对抗性测试报告

- 批次：第七十四批
- 版本：V2.5-DEV-B1-APP-IDENTITY-74
- 日期：2026-11-27
- 状态：**逻辑契约重构完成；本地 SQLite 12/12 通过；D1_NOT_TESTED / APP_PENDING / NOT_DEPLOYABLE**

## 一、本批完成
1. 重读 AGENTS、功能基线、API 权限规范、数据库保护规范、总方案、进度及第六十七至七十三批资料。
2. 将 challenge consume、binding insert/resolve、required audit、operation receipt 设计为同一原子逻辑单元。
3. 提出 operation receipt 最终 CHECK 断言：无条件插入 operation receipt，由数据库 CHECK(audit_assert=1) 保证必要状态和审计确实存在；缺失或不匹配时产生 SQL constraint error，使同批次回滚。
4. 明确同 operation ID 同 payload 重放、同 ID 不同 payload 冲突、同 event key 不同 payload 完整性冲突，以及 timeout-after-commit 恢复流程。
5. 建立仅使用内存 SQLite 和合成数据的本地 fixture。

## 二、关键设计
第六十七批把 challenge consume 与 binding create 分开调用，存在挑战已消费但绑定创建失败的风险。本批将条件消费、绑定创建/解析、必要审计和最终 operation receipt 放入同一原子逻辑单元。

普通条件 INSERT-SELECT 零行不会自动报错，因此不能用它单独承担必需审计断言。Cloudflare 官方 D1 文档说明 batch 语句按顺序执行，语句报错时整个批次回滚。<Cite refs={["turn392333search0","turn392333search2"]} />

operation receipt 表、CHECK 约束和相关 schema 都是候选设计，不是已验证生产表。必须先在用户批准的 disposable D1 中验证 CHECK、标量子查询、prepared binding、batch rollback 和返回结果；未经授权不得创建或迁移生产表。

## 三、本地测试证据
测试文件：backend/worker/V2.5-DEV-B1-APP-IDENTITY-74/test_identity_atomic_semantics.py

执行命令：
```bash
python -m unittest discover -s backend/worker/V2.5-DEV-B1-APP-IDENTITY-74 -p 'test_*.py' -v
```

结果：**12 tests / 12 passed / 0 failed**。

覆盖正常绑定、binding 约束失败回滚、audit zero-row CHECK 回滚、audit SQL error 回滚、幂等重放、不同 payload 冲突、commit 后模拟超时重试、既有 binding 去重、revoke generation CAS、share-code version CAS、限流窗口边界/Retry-After、event key 不同 payload 回滚。

测试只运行在 Python sqlite3 内存数据库，使用合成 schema 和数据。不能解释为 D1 测试通过或多 Worker isolate 并发通过。

## 四、交付文件
- 详细设计：backend/worker/V2.5-DEV-B1-APP-IDENTITY-74/ATOMIC-OPERATION-REDESIGN.md
- 本地测试：backend/worker/V2.5-DEV-B1-APP-IDENTITY-74/test_identity_atomic_semantics.py
- README：backend/worker/V2.5-DEV-B1-APP-IDENTITY-74/README.md
- 本报告：docs/backend/StarJump_V2.5_APP_v2身份原子操作重构与本地对抗性测试报告_第七十四批_V2.5-DEV-B1-APP-IDENTITY-74_2026-11-27.md

## 五、环境与部署边界
- 未连接 Cloudflare D1；未执行 D1 SQL；未创建/执行 migration。
- 未修改 Worker、HTML、APK、Room、Secrets、Cloudflare 配置或生产数据。
- 未执行真实 D1 batch、RETURNING、多 isolate 并发或 APK 联调。
- 未部署。
- 当前状态：本地 SQLite 12/12 通过；D1_NOT_TESTED / APP_PENDING / NOT_DEPLOYABLE。

## 六、第七十五批
扩展 create/revoke/rotation 共用的 operation receipt + audit assertion 规格；增加 revoke/rotation 审计缺失回滚、event key 同/异 payload、owner-scoped receipt、限流 event_id 幂等、多维 Retry-After、缺失维度及 cleanup 边界的本地测试。仍不连接 D1。


## GitHub Actions 复核证据
- Run: https://github.com/sxna-web/XYmonihtml/actions/runs/45993837077
- Job: 140488126131（atomic-sqlite-fixture）
- 状态：completed / success；Python 3.13.18；12 tests / 12 passed / 0 failed。
- 已核对运行日志，12 个测试方法均显示 ok，最终输出 Ran 12 tests / OK。
- 证据边界仍为 GitHub Actions 上的内存 SQLite 合成 fixture；不代表 Cloudflare D1 或 APK 通过。
