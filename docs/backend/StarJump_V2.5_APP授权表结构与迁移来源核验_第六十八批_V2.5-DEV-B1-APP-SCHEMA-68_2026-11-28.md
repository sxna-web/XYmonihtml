# V2.5.0 RC1 第六十八批：APP 授权表结构与迁移来源核验

- 版本：V2.5.0 RC1
- 批次：第六十八批 / `V2.5-DEV-B1-APP-SCHEMA-68`
- 日期：2026-11-28
- 基线：`cde35e90f6cf8ca869e1fdae64a1ed9e0eef059d`
- 范围：候选分支源码、Worker、迁移目录只读核验
- 未执行：生产 D1 查询/写入、迁移、部署、合并

## 一、重要结论

本轮逐项对照后，发现当前仓库并没有一份可作为生产 D1 APP 授权表结构权威依据的、完整且版本化的 migration DDL。

1. `tools/database_migrations/migrations/CORE-MIG-001.sql` 只有本地 verifier ledger 表 `schema_migrations`，文件注释明确说明不是生产 D1 migration。
2. Batch 49 正式候选 Worker 没有内嵌 APP 授权表的 CREATE TABLE DDL。
3. Batch 49 的 `/api/super/schema-status` 只检查 18 张核心表和 22 张 Worker 引用表是否存在，并明确返回 `verification: TABLE_NAMES_ONLY`、`migration_enabled: false`。
4. Batch 49 的 `POST /api/super/migrate` fail-closed 返回 503 `MIGRATION_REVIEW_REQUIRED`。
5. 旧版 Worker 文件仍保留历史 `MIGRATE_STATEMENTS` 与旧路由实现，但它不是当前 CI 打包的 Batch 49 Worker，不可把旧文件中的 DDL 当作当前候选版已执行的 schema，也不可据此推断生产 D1 的实际结构。

因此当前 schema 状态仍是“未完成字段级核验”，不只是“缺少卡密分组表”。任何新 migration 都必须先对照用户实际 D1 的 `sqlite_master`、`PRAGMA table_info`、`PRAGMA index_list` 与数据分布；不能只按历史 Worker 源码生成并直接执行。

## 二、旧版 Worker 中可确认的历史字段（仅作线索，不是生产实库证明）

旧文件：`原始StarJump_V1点0_Final-zip-26-11-25-14:56/Worker.js`

其历史内联 DDL 曾定义：

### `app_cards`
- `id TEXT PRIMARY KEY`
- `code TEXT NOT NULL UNIQUE`
- `admin_user_id TEXT NOT NULL`
- `days INTEGER NOT NULL`
- `status TEXT NOT NULL DEFAULT 'normal'`
- `inactive_reason TEXT NOT NULL DEFAULT ''`
- `inactive_at`, `restored_at`
- `manual_disabled INTEGER NOT NULL DEFAULT 0`
- `expires_at`, `activated_at`, `used_at`
- `created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP`
- 历史索引：`(admin_user_id, status)`、`(code)`

### `app_entitlements`
- `id TEXT PRIMARY KEY`
- `admin_user_id TEXT NOT NULL`
- `device_id TEXT NOT NULL`
- `card_id TEXT NOT NULL`
- `starts_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP`
- `expires_at TEXT NOT NULL`
- `purge_at TEXT`
- `status TEXT NOT NULL DEFAULT 'active'`
- `created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP`
- 历史索引：`(device_id, status)`、`(admin_user_id, status)`、`(expires_at)`

### `app_groups`
- `id TEXT PRIMARY KEY`
- `admin_user_id TEXT NOT NULL`
- `name TEXT NOT NULL`
- `mode TEXT NOT NULL DEFAULT 'assigned'`
- `sort INTEGER NOT NULL DEFAULT 100`
- `enabled INTEGER NOT NULL DEFAULT 1`
- `created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP`
- 历史索引：`(admin_user_id, sort)`

### 关系表
- `app_group_sources(group_id, source_id, PRIMARY KEY(group_id, source_id))`
- `app_group_members(group_id, device_id, PRIMARY KEY(group_id, device_id))`
- `app_free_grants(device_id, admin_user_id, granted_at, PRIMARY KEY(device_id, admin_user_id))`

### `app_card_events`
- 自增事件 ID、`card_id`、`admin_user_id`、`action`、`detail`、`device_id`、`created_at`
- 历史索引：`(card_id, created_at)`

以上历史 DDL 没有为卡密、管理员、分组之间建立可验证的复合外键。必须先核验目标 D1 的真实索引和约束。

## 三、发现的分组语义冲突

旧版 Worker 的 `APP_GROUP_MODES` 只有：
- `public`：该管理员所有有效卡密用户可见；
- `assigned`：仅设备成员可见；
- `free`：激活过该管理员卡密的设备长期可见。

但 Protocol 59/58/65 新契约使用 `card` 作为卡密专属分组类型，Protocol 65 的 `validGroup` 明确要求卡密组 `mode === "card"`。旧 Worker 的管理员分组 CRUD 只允许 `public / assigned / free`，没有 `card`。

因此即使直接新增 card-group mapping table，旧分组 CRUD 也无法产生满足新组合服务契约的卡密分组。必须统一并迁移 mode 语义：
- `card`：只属于指定卡密实例；
- `free`：同一管理员免费组，只按管理员去重一次；
- `public / assigned`：旧兼容语义需单独保留/映射，不能自动升级为卡密专属权限。

不得把旧 `public` 误解释为“卡密拥有的所有组”，也不得把 `assigned` 设备成员关系当作卡密授权。

## 四、候选关联模型（设计建议，尚未批准为 DDL）

建议新增独立关系表，至少保存：
- `card_id`
- `admin_user_id`
- `group_id`
- `created_at`
- 唯一约束 `(card_id, group_id)`
- 查询索引 `(card_id, admin_user_id)` 与 `(admin_user_id, group_id)`

写入和读取必须同时验证：
- 卡密存在且 `card.admin_user_id = mapping.admin_user_id)；
- 分组存在且 `group.admin_user_id = mapping.admin_user_id)；
- 分组为 `mode='card'`；
- 卡密状态允许当前操作；
- 管理员仍有可管理 APP 卡密/分组的有效权限；
- 每个 entitlement 的 `card_id` 必须与映射行 `card_id` 完全一致。

是否采用复合外键、级联删除或软删除，必须在拿到真实 D1 schema 和历史数据规模后决定。当前不能擅自选择 ON DELETE CASCADE，因为卡密事件、历史 entitlement 和到期后只读查看/删除历史数据均有保留规则。

## 五、下一阶段安全实施顺序

1. 先由后台只读诊断查询输出实际 D1 的目标表列、索引、外键、触发器和表行数；仅收集结构，不导出卡密 code、token、用户隐私数据。
2. 把真实结构与历史 DDL、Worker SQL 引用逐项对照，形成兼容矩阵。
3. 再确定卡密组 mapping schema、mode 迁移与历史数据回填策略。
4. 编写 additive migration 和独立 SQLite 测试：空库、旧结构、部分列缺失、重复映射、跨管理员映射、卡密停用/过期、分组删除、重复执行、回滚。
5. 为管理员 API 实现逐卡密读取/设置/删除关系，写操作与审计同批次，并加入最终 owner/state predicates。
6. 正式 Worker route 注册新 composed groups endpoint，接入真实 D1 loader；token 验证必须先于其他授权记录枚举。
7. 更新后台 HTML 卡密列表与编辑交互，逐张卡密配置分组；序列号展示只允许非敏感显示标签，不返回 redeem code。
8. 取得 APK 实际请求协议后再做兼容联调；完成节点 generation/tombstone、24 小时本地清理和 ACK。
9. 完成 staging D1 验证、备份与回滚演练后，才能评估 STABLE 大更新。

## 六、当前上线判定

- 数据库结构：未通过字段级核验。
- 卡密专属分组关系：未实现。
- 旧/新分组 mode 兼容：未解决。
- 多卡密组合：独立模块契约存在，但真实 D1 loader/正式路由未证实。
- 迁移：自动迁移安全暂停，当前只读检查。
- 生产部署：禁止。

本报告是审计和实施顺序冻结，不是可执行 SQL，也不是部署文件。
