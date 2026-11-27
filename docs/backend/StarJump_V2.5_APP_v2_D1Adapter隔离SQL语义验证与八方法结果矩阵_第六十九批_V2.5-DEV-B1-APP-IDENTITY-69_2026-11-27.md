# 星跃管理平台 V2.5｜APP v2 D1 Adapter 隔离 SQL 语义验证与八方法结果矩阵

- 批次：第六十九批
- 版本：`V2.5-DEV-B1-APP-IDENTITY-69`
- 日期：2026-11-27
- 状态：**本地 disposable SQLite fixture 10/10 通过；D1_NOT_TESTED；未创建/执行 migration；未接 Worker；不可部署**
- 仓库：`sxna-web/XYmonihtml` / `main`

## 1. 范围与保护

依照根目录 `AGENTS.md`、功能基线、API 权限规范、数据库变更保护规范、总方案、进度、第六十七/六十八批状态机与 D1 adapter 契约完成本批。

本批仅新增隔离 SQL 语义测试夹具、CI workflow、README 与本报告/进度记录。未连接 Cloudflare；未连接 production 或 staging D1；未执行任何远端 SQL；未创建可执行 migration；未改 Worker、HTML、APK、Room、Secrets、Cloudflare 配置；未部署。

## 2. 新增文件

- `backend/worker/V2.5-DEV-B1-APP-IDENTITY-69/test_identity_sql_semantics.py`：合成 schema 的 disposable SQLite 测试。
- `backend/worker/V2.5-DEV-B1-APP-IDENTITY-69/README.md`：测试边界与未来隔离 D1 验证门槛。
- `.github/workflows/worker-app-identity69-sql-tests.yml`：Python 3.13 CI。

测试 schema 是临时 fixture，不是现有 D1 schema，也不是 migration。测试数据库由测试用例在 `starjump-migration-test-*` 临时目录创建并在结束时清理。

## 3. 八个 store 方法结果矩阵

| Store 方法 | SQLite 夹具验证 | 成功条件 | 冲突/过期/重试语义 | D1 实测 |
|---|---|---|---|---|
| insertChallenge | 通过 | challenge_id 首次插入 | 重复主键冲突；异常 fail closed | 未测 |
| consumeChallengeAtomic | 通过 | pending、未过期且 device/admin/version/key 全匹配，条件 UPDATE 影响 1 行 | 已消费、过期、任一上下文不匹配影响 0 行；重试不能二次消费 | 未测 |
| consumeNonceAtomic | 通过 | (binding_id, nonce) 唯一键首次插入 | 冲突 DO NOTHING，重复 nonce 不再消费；过期清理后是否允许 nonce 再用需结合 TTL/签名时间策略审查 | 未测 |
| upsertBindingAtomic | 通过 | (admin_user_id, device_id) 唯一约束插入 | 冲突 DO NOTHING 后必须 owner-scoped 读取并比较 status/key；不同 key 不得覆盖，revoked 不得复活 | 未测 |
| revokeBindingAtomic | 通过 | binding_id + admin_user_id + active 条件更新 | 错误 owner 影响 0 行；已撤销可在服务层设计幂等返回，但不得伪造更新成功 | 未测 |
| rotateShareCodeAtomic | 通过 | admin + active + expected version CAS 更新 1 行 | 同一 expected version 的后续请求更新 0 行；唯一 digest 冲突必须安全失败 | 未测 |
| getCurrentShareCode | 通过 | owner-scoped 查询当前 active 版本 | 不存在/非 active 返回空；客户端响应不得暴露 code_digest | 未测 |
| expireTransientRecords | 通过 | 按 expires_at 清理过期 challenge/nonce | 幂等；绝不删除 binding/audit；实际实现必须有限批量 | 未测 |

补充验证：事务中第二条语句失败后整体 rollback 的 SQLite 模拟；这仅是 SQLite 本地事务行为，不证明 D1.batch 的具体回滚行为。

## 4. 测试证据

GitHub Actions：
- Run ID：`45980988186`
- 结果：completed / success
- Job：`sqlite-semantic-fixture`
- Runner：Ubuntu 26.04.1
- Python：3.13.18
- 命令：`python -m unittest discover -s backend/worker/V2.5-DEV-B1-APP-IDENTITY-69 -p 'test_*.py' -v`
- 结果：10 tests / 10 passed / 0 failed，退出码 0
- 链接：https://github.com/sxna-web/XYmonihtml/actions/runs/45980988186

### 首次 CI 失败及修正记录

首次运行 Run `45980918539` 退出码 5，原因是 unittest 文件名含连字符，且发现模式未匹配，日志明确显示 `Ran 0 tests`，不是 SQL 断言失败。随后新增符合 Python 模块命名的 `test_identity_sql_semantics.py` 并修正 workflow 发现模式；Run `45980988186` 已实际发现并运行 10 项测试且全部通过。保留失败记录，不将首次失败隐藏或算作通过。

## 5. SQLite 结果不能替代的 D1 验收

以下仍必须在**明确授权的独立非生产 D1**验证：
1. 真实 D1 database ID 与 binding 名称、schema 和迁移历史。
2. D1 对目标 SQL 语法、参数绑定、唯一冲突与条件 UPDATE 的实际结果。
3. `RETURNING` 的结果形状及 `meta.changes` 的成功/零行语义。
4. `D1Database.batch()` 顺序执行和中途失败回滚。
5. 分别从独立请求/隔离执行上下文竞争 challenge 消费、nonce 插入、binding 唯一插入、share-code CAS，确认唯一胜者。
6. 真实限流表字段是否足够；旧 `rate_limits(bucket,count,updated_at)` 不得默认视为满足 APP identity 多维限流。
7. 绑定撤销/审计保留、清理有界性和错误处理。

仓库没有可核实的 APP v2 隔离 D1 database ID/binding。不得擅自将 `starjump-staging` 或生产绑定当作已批准测试环境；不得猜测 binding。

## 6. 风险与后续约束

- 10/10 只证明本地合成 SQLite fixture 的 SQL 语义用例通过。
- 没有真实数据库多连接/多 isolate 并发测试；CAS/唯一键只做了本地顺序冲突语义检查。
- D1 batch rollback、RETURNING、meta.changes 和 D1 执行队列均未实测。
- 第六十七批 mock CI 14/14 仍只证明服务层注入接口契约；不叠加为 D1 测试通过。
- Android 端设备密钥注册/签名协议和 APK 6.00.48 兼容仍未审计。
- 免费分组仍优先管理员身份授权；特殊免费分组卡密仍只作为真实冲突时的条件性备选，本批未改变规则。

## 7. 回滚与发布状态

本批只新增 DEV 测试/文档文件。回滚为停止使用本批目录/workflow 或 revert 本批文件；无 D1 数据回滚需求。当前 APP identity adapter 仍未实现，Worker 未接入，不能部署或作为正式更新包。

## 8. 第七十批唯一接手卡

**APP v2 D1 Adapter 的真实隔离环境准入门槛与 SQL/结果语义实现规格（不接生产）。**

1. 重读 AGENTS、功能基线、API/D1 保护规范、总方案、进度及第六十七至六十九批报告。
2. 重新核对第六十九批测试文件、workflow、Run 与 Blob SHA。
3. 将 8 个方法细化为可实现的 D1 statement contract：输入绑定、SQL 条件、RETURNING/meta.changes 判定、唯一冲突分类、owner-scoped follow-up read、重试边界。
4. 明确 upsertBinding 的多语句组合：不得把 batch 当 JS callback；设计可判定插入结果与 winner read 的方案，检查批次失败回滚和 key/status 语义。
5. 评估 nonce TTL 清理与重放安全的关系；不得仅凭删除 nonce 行就允许仍在有效签名窗口内的 nonce 被再次接受。
6. 建立 D1 隔离环境准入清单与只读 schema snapshot 模板；只有用户明确指定并批准独立非生产 D1 后，才进行连接和实测。
7. 无隔离 D1 授权时继续做 SQL/adapter 规格与 mock contract，不连接 staging/production。
8. 不创建/执行 migration，不接 Worker 路由，不改 HTML/APK/Room/Secrets，不部署。
9. 更新总进度、总方案与第七十一批接手卡。
