# 星跃管理平台 V2.5｜APP 多卡密映射迁移前置设计与数据库只读诊断方案（第七十批）

> 批次：V2.5-DEV-B1-APP-CARD-MAP-70  
> 日期：2026-11-28  
> 状态：**已完成源码核查与候选设计；未编码、未执行迁移、未部署**  
> 基线分支：`release/v2.5.0-rc1-converge`  
> 基线 HEAD：`1f2f546b136c37caecbf7de66023c056b24d1bfb`  
> 关联 PR：#2（Draft/Open/Unmerged）

## 1. 本批目标

在第六十七至六十九批确认 APP 多卡密生产链路缺口后，继续推进上线阻塞项，但不在缺少真实 D1 schema 快照时猜测生产结构。本批完成：
1. 复核正式候选 Worker 的数据库只读状态接口；
2. 明确卡密-分组关联表设计前必须满足的结构证据；
3. 给出候选关系模型、迁移前置校验、回滚边界；
4. 规划下一步只读结构诊断和隔离 SQLite 验收；
5. 保持原 APP API 与 APK 兼容边界，不注册尚未具备 D1 adapter 的 Protocol 65 路由。

## 2. 本批重新核对的当前代码事实

### 2.1 当前 PR 与基线
- PR #2：Draft/Open，未合并；head 为 `1f2f546b136c37caecbf7de66023c056b24d1bfb`。
- 不修改 main，不合并，不部署。
- 正式候选 Worker 文件：`backend/worker/V2.5-DEV-B1-CORE-AUTH-49/Worker.js`。
- 双文件前端：`releases/v2.5.0-rc1/index.html`。

### 2.2 当前 schema-status 实际能力
Worker 的 `GET /api/super/schema-status`：
- 只查询 `sqlite_master` 中 18 张历史核心表和 22 张 Worker SQL 引用表是否存在；
- 返回 `verification: TABLE_NAMES_ONLY`；
- 不核对列名、列类型、默认值、主键、唯一约束、索引列顺序、外键、触发器及表定义；
- `migration_enabled: false`；
- `POST /api/super/migrate` 明确 fail-closed，返回 503 `MIGRATION_REVIEW_REQUIRED`。
前端数据库检查也明确提示“只检查表名”，未提供结构核对。

### 2.3 APP 分组既有模型
当前正式候选 Worker 的 APP 分组模式集合为 `public / assigned / free`，并非 Protocol 65 组合服务所要求的 `card / free`。当前 `app_group_members` 是 `group_id + device_id` 设备级成员关系，不是卡密级分配关系。旧版 APP 读取路径仍存在“最新有效 entitlement”单条选择逻辑。

### 2.4 Protocol 65 尚未形成生产闭环
Protocol 65 handler 仍是工厂函数；组合服务依赖外部注入 entitlement resolver、分类器、分组 loader 和卡密标签 loader。当前没有证据证明它们已由真实 D1 adapter 实现并注册进 Batch 49 Worker 正式路由。客户端也必须提供每张卡密的 entitlement ID/token；APK 持久化与兼容性尚未验证。

## 3. 候选卡密-分组关系模型（仅设计，不是批准的生产 DDL）

候选逻辑实体：`app_card_group_mappings`

| 字段 | 候选类型 | 目的 | 约束方向 |
|---|---|---|---|
| id | TEXT | 映射记录标识 | 主键，生成规则待定 |
| card_id | TEXT | 指向 APP 卡密实例 | 必填 |
| admin_user_id | TEXT | 冗余租户归属，便于 owner fence | 必填 |
| group_id | TEXT | 指向 APP 分组 | 必填 |
| created_at | TEXT | 建立时间 | 必填，UTC |
| created_by | TEXT | 操作者身份 | 可选/待结合现有审计模型 |

候选唯一性：`UNIQUE(card_id, group_id)`。  
候选查询索引：`(admin_user_id, card_id)`、`(admin_user_id, group_id)`。  
以上仅为逻辑模型，不可直接作为生产 DDL。

### 3.1 必须先解决的兼容冲突
1. 旧 Worker 只允许 `public / assigned / free`；Protocol 65 只接受 `card / free`。不能直接将旧模式全部改名，否则会影响现有 APK、管理页面和既有读取。
2. 需要确认“卡密分组”是新模式，还是以独立映射表标识；推荐优先使用映射关系识别卡密分组，不改变旧 `mode` 值，直到所有旧 API 和 APK 客户端兼容性完成验证。
3. 对一个卡密只能映射其管理员名下分组；跨管理员映射必须 fail closed。
4. 卡密撤销、删除、过期、管理员 VIP 到期时的映射保留/冻结/删除策略必须按既定卡密生命周期核验，不能以级联删除历史数据。
5. 卡密多张同时有效时，各卡密映射组分别保留；同管理员免费组只去重一份；同名卡密分组使用脱敏序列号标签，不得暴露 redeem code。
6. 设备级 `app_group_members` 不可被误当成卡密授权关系，也不可因新映射表上线而被直接清空或重写。

## 4. 迁移前必须取得的证据

在提出正式 DDL 前，至少取得目标 D1（必须由用户确认具体环境）以下只读证据：
- 7 张 APP 相关表的完整 CREATE TABLE SQL：`app_cards`、`app_entitlements`、`app_groups`、`app_group_sources`、`app_group_members`、`app_free_grants`、`app_card_events`；
- 每张表列信息（名称、类型、not-null、默认值、主键序号）；
- 全部索引定义及唯一性、索引列顺序；
- 外键、触发器和视图定义；
- `app_cards` 与 `app_entitlements` 的真实关联完整性统计（仅计数，不输出卡密/令牌/用户隐私）；
- 现存重复、孤儿映射候选数据的只读统计；
- D1 数据库标识、环境名称、导出时间与快照 SHA-256（不得把凭据写入仓库）。

目前没有上述生产 D1 快照，故不能宣称字段、约束、索引或历史数据兼容。

## 5. 下一步只读诊断接口设计

建议在既有 `/api/super/schema-status` 扩展一个结构诊断区，仍然只读、仅限超管、只针对固定白名单表：
- 保留现有 `TABLE_NAMES_ONLY` 字段，确保旧前端兼容；
- 新增 `structure_verification`，每张表报告 columns/indexes/foreign_keys/objects 的检查状态；
- 只返回 schema 元数据，不返回任何业务表行、卡密 code、token、订阅 URL、用户资料或审计内容；
- 对不支持的元数据语句返回 `unsupported` / `not_verified`，不可把失败解释为“结构正确”；
- 对预期结构必须使用版本化 manifest，逐项比对列、索引和约束；没有可信 D1 schema 基线时只展示实际结构，不做 PASS 判定；
- 设置响应大小上限、固定表数上限和超时/异常处理；
- 前端显示“表存在性”和“结构检查”两个独立状态，禁止以一个绿色“通过”概括；
- 迁移按钮继续禁用，不增加任何生产写入入口。

**重要：** 在确认 Cloudflare D1 对候选元数据查询语法的支持情况、完成 mock/SQLite 测试和 Worker 集成测试前，不直接修改接口。SQLite PRAGMA 在本地可用不等于 D1 运行时一定支持相同语法。

## 6. 隔离 SQLite 验收计划

取得结构设计批准后，在独立临时 SQLite fixture 中验证：
1. 首次迁移创建映射表；
2. 重复迁移幂等，不重复创建、不改变 checksum；
3. 唯一约束拒绝同卡密重复映射同一分组；
4. 同卡密可映射多个分组；
5. 不同管理员相同 group ID/伪造 owner 被拒绝；
6. 目标卡密不存在、目标分组不存在、owner 不一致时失败；
7. 同管理员多卡密映射独立保留；
8. free group 仍按管理员+分组去重；
9. 软删除/撤销后映射按批准策略保留，不发生意外级联；
10. 失败回滚和 checksum 漂移拒绝；
11. 标签脱敏器不输出 redeem code；
12. 迁移前后旧表记录数量与内容不变。

SQLite 结果只能证明隔离测试行为，不证明 D1 语法、事务、并发或生产数据兼容。

## 7. 影响分析、回滚与兼容

- 本批无代码、HTML、D1、Secrets 或 APK 改动。
- 未来新增映射表属于 additive schema change，但仍可能影响卡密分组授权语义；必须先备份、快照、审批、dry-run 和 postcondition。
- 回滚优先停用新 API/功能开关，保留新增映射数据；不得在未经审批时 DROP 表或删除映射记录。
- 旧 API 保持原响应和权限语义，待 APK 版本/协议矩阵确认后再切换读取路径。
- 不将 Protocol 65 接入正式 Worker，直到真实 D1 adapter、route auth、redacted card label、APK 多凭据保存与端到端兼容测试齐备。

## 8. 本批状态与测试

| 项目 | 状态 |
|---|---|
| PR/分支/head 复核 | 已完成，只读 |
| Worker schema-status 核查 | 已完成，源码静态核对 |
| HTML 数据库检查核查 | 已完成，源码静态核对 |
| APP 多卡密模式/关系冲突核查 | 已完成，源码静态核对 |
| 生产 D1 schema 读取 | 未执行、未授权 |
| 候选 DDL | 未生成、未执行 |
| SQLite migration tests | 本批未运行 |
| Worker CI | 本批未触发（仅新增设计文档） |
| Cloudflare 部署/Secrets | 未执行 |

## 9. 下一批建议

第七十一批按以下顺序执行：
1. 先核对仓库现有部署配置、Worker 构建入口和 schema-status 权限中间件，确认诊断接口是否确实只允许超管；
2. 从官方 D1 支持范围确认元数据查询语法，不能仅凭 SQLite 经验；
3. 为只读 schema manifest 设计固定、可版本化的字段/索引期望清单；
4. 在隔离 SQLite fixture 加入诊断输出与不支持语法测试；
5. 在 Worker handler integration 中覆盖非超管拒绝、元数据异常 fail-closed、无业务数据泄漏；
6. 只有测试通过后再改 Worker 与 HTML；继续保持 migrate 503；
7. APP mapping migration 仍等待用户确认目标 D1 环境和结构快照，不做生产迁移。

---
**结论：** 第七十批完成了迁移前置设计和 schema-status 能力差距核实。APP 多卡密映射关系仍是正式上线阻塞项；本批没有把候选设计伪装成已实现，也没有执行任何生产操作。
