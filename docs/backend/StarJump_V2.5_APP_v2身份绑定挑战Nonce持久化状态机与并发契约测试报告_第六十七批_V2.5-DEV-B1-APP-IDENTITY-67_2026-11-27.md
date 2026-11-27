# 星跃管理平台 V2.5｜APP v2 身份绑定 Challenge / Nonce 持久化状态机与并发契约测试报告

- 批次：第六十七批
- 版本：`V2.5-DEV-B1-APP-IDENTITY-67`
- 日期：2026-11-27
- 状态：**隔离 DEV 已编码；GitHub Actions 14/14 通过；未实现真实 D1 adapter；D1_NOT_TESTED；APP_PENDING；不可部署**
- 仓库：`sxna-web/XYmonihtml` / `main`
- 本批基线：第六十六批身份发现/绑定服务及其 README、原始 Worker 只读审计、功能基线、API/D1 保护规范、进度和总方案。

## 1. 影响分析、范围与回滚

本批只新增：
- `backend/worker/V2.5-DEV-B1-APP-IDENTITY-67/identity-durable-state-machine.mjs`
- `backend/worker/V2.5-DEV-B1-APP-IDENTITY-67/identity-durable-state-machine.test.mjs`
- `backend/worker/V2.5-DEV-B1-APP-IDENTITY-67/README.md`
- `.github/workflows/worker-app-identity67-tests.yml`

没有修改第六十六批历史文件、现有 Worker、HTML、APK、Room、D1、Secrets、Cloudflare 配置或线上数据。回滚为停止引用本隔离目录或 revert 本批新增文件，不涉及数据回滚。

## 2. 状态机与最小数据契约

| 对象 | 设计状态/唯一性 | 原子要求 |
|---|---|---|
| Bind challenge | pending → consumed；challenge_id 唯一 | 同一条件更新同时检查未消费、未过期、device/admin/codeVersion/key thumbprint |
| Request nonce | (binding_id, nonce) 唯一 | insert-if-absent；重复 nonce 必须拒绝 |
| Identity binding | (admin_user_id, device_id) 唯一 | 同管理员同设备幂等；设备公钥不匹配冲突；revoked 不自动复活 |
| Share code | 管理员单一当前版本；code_version 单调递增 | expectedVersion compare-and-swap；并发轮换只允许一个成功 |
| Cleanup | 仅清理过期 challenge/nonce | 幂等、有界；不得清理 binding 或审计历史 |

上述字段、表/唯一约束均为**新增设计契约**，不是现有 D1 schema 事实。第六十六批审计已确认原始旧 `admin_share_codes` DDL 未见版本/撤销字段，也未发现 identity binding/challenge/nonce 表。

## 3. 隔离实现

新状态机仅依赖注入式 store：
- `insertChallenge`
- `consumeChallengeAtomic`
- `consumeNonceAtomic`
- `upsertBindingAtomic`
- `revokeBindingAtomic`
- `rotateShareCodeAtomic`
- `getCurrentShareCode`
- `expireTransientRecords`

服务层不使用实例内存 Map 或单 Worker 锁来实现生产原子性。未来 D1 adapter 必须以条件 SQL、唯一约束和事务实现这些方法；不能采用 read-then-write 伪原子操作。当前 mock 只模拟接口契约，不能证明跨 Worker / 真实 D1 的原子性。

## 4. 测试证据

GitHub Actions：
- Run：`45978995116`
- Job：`140437815695`
- 状态：completed / success
- Node.js：22.23.5
- 语法检查：通过
- 测试：14 passed / 0 failed
- 链接：https://github.com/sxna-web/XYmonihtml/actions/runs/45978995116

覆盖：challenge 单次消费、上下文绑定、过期拒绝、nonce 并发重放、绑定幂等、跨管理员隔离、设备 key 冲突、撤销后不可复活、撤销 owner scope、share-code CAS 轮换、轮换不删除既有绑定、清理幂等、store 故障 fail closed、非法标识/未验证 proof 拒绝。

## 5. 重要限制与未完成事项

1. mock 的 Map 操作只在单 Node.js 进程中模拟原子接口；不能证明 D1 事务、唯一约束、SQLite 并发行为或多个 Worker 实例竞争。
2. 没有隔离 D1 binding/database ID 的可核实证据；未连接生产或 staging D1。
3. 未生成可执行 SQL/migration，未执行 SQL，未读取或写入 Cloudflare Secrets。
4. 第六十六批 challenge 签名、公钥注册、设备请求签名、durable rate limit 仍是注入 adapter；本批不实现密码学 proof。
5. Android Keystore、APP 6.00.48 协议兼容仍未审计，APP_PENDING。
6. 分享编号轮换后保留既有绑定是技术提案，不是已冻结生产规则。
7. 免费分组仍优先沿用管理员身份授权；特殊免费分组卡密只作为用户已确认的条件性备选，发生真实授权冲突时再评估，不在本批改变业务模型。
8. 未接入 Worker、未修改 HTML/APK/Room/D1/Secrets，未部署；不可作为部署包。

## 6. 第六十八批唯一接手卡

**APP v2 身份持久化 adapter 与真实 schema 前置差距核查（只读 + SQL 契约设计，不执行 SQL、不接 Worker）。**

1. 重读 AGENTS、功能基线、API/D1 保护规范、总方案、进度及第五十一至六十七批 APP 报告。
2. 复核第六十七批 CI Run `45978995116`、文件 SHA 和第六十六批依赖接口。
3. 再次只读检查仓库当前所有 Worker/D1 schema 来源、迁移目录、配置与绑定证据；不得把原始 Worker DDL 当成线上 schema。
4. 将本批 8 个 store 方法逐项映射到 SQLite/D1 条件更新、唯一约束、事务及冲突返回语义；区分已存在字段、未知字段、新设计字段。
5. 评估 D1 单语句条件写入/事务能否满足 challenge、nonce、binding、share-code CAS；如存在不确定性，列出需隔离 D1 验证项。
6. 不生成可执行 migration，不执行 SQL，不连接生产/staging，不修改 Worker/HTML/APK/Room/Secrets，不部署。
7. 将“免费分组特殊卡密”保持为条件性备选，不更改现有业务规则。
8. 更新进度、总方案和第六十九批接手卡。
