# 星跃管理平台 V2.5｜真实 D1 Schema Manifest 只读诊断方案

- 批次：V2.5-DEV-B1-APP-SCHEMA-MANIFEST-77
- 日期：2026-11-28
- 分支：release/v2.5.0-rc1-converge
- 状态：只读诊断方案与人工 SQL 已提交；未连接真实 D1、未执行 SQL、未执行 DDL/DML、未部署。

## 1. 本批产物

- docs/database/diagnostics/V2.5-DEV-B1-APP-SCHEMA-MANIFEST-77_READ_ONLY.sql：schema-only 元数据查询。
- 本报告：人工执行步骤、字段清单、判定规则与安全边界。

## 2. 核验范围

必须分别核对以下 7 张表，不能把候选表的“缺失”误判成可直接创建：

| 表 | 核验目的 |
|---|---|
| app_cards | 卡密主键、owner、状态、激活/过期/禁用字段、默认值与索引 |
| app_groups | 分组主键、owner、mode、enabled、删除/排序字段与索引 |
| admin_vip_activations | VIP/体验授权有效期、状态和关联字段 |
| admin_user_scopes | 委托 actor/target、权限范围、撤销/过期字段 |
| admin_audit_events | 审计主键、操作者/目标、request id、结果和时间字段 |
| app_card_group_mappings | 候选卡密—分组映射表；只检查存在性与结构 |
| app_card_group_admin_requests | 候选幂等请求表；只检查存在性与结构 |

每张表至少记录：列名、声明类型、NOT NULL、默认值、PK 顺序；索引名称、唯一性、partial 标记及列顺序；外键目标/更新删除动作；关联 trigger/view 名称及 SQL。还需检查 sqlite_master 中表、索引和触发器的原始 SQL。不能由 SELECT * 的使用位置推断完整列集合。

## 3. 人工执行步骤

1. 操作者先在 Cloudflare 控制台确认当前选中的 D1 数据库名称、账户/环境和数据库 ID；不要把密钥或业务数据复制到聊天。
2. 先对 staging 执行本批 SQL 文件。只有明确选中目标数据库后才运行；不要依赖浏览器中上次选中的数据库。
3. 保存完整 schema metadata 输出到受控位置。输出只包含 schema 定义；若平台结果混入业务行或凭证，立即停止并删除该导出副本。
4. 对 PRAGMA index_list 返回的每个索引名，单独运行 PRAGMA index_info('<精确索引名>')；如需表达式/排序/partial 细节，再运行 PRAGMA index_xinfo('<精确索引名>') 并保留 sqlite_master 对应 SQL。
5. 逐表核对 PRAGMA foreign_key_list、触发器 SQL 和索引 SQL；对空结果标记 ABSENT 或 NO_DECLARED_ITEMS，不得自动标记为 PASS。
6. 对生产环境仅允许相同的只读 schema-only 查询；本批不要求生产执行任何业务数据诊断。先完成 staging 复核，再由项目负责人决定是否需要生产 schema-only snapshot。
7. 记录数据库环境标识、执行时间、操作者、SQL 文件 SHA-256、结果文件 SHA-256。哈希和环境记录可用于审计，不包含秘密。

## 4. 历史数据异常检查：本批明确暂缓

重复映射、孤儿关系、跨 owner 冲突必须在真实 schema manifest 核验后才能生成查询。当前没有已验证的映射表、列名、主外键及历史状态约定，因此本批不提供可直接执行的数据行检查 SQL，避免猜测列名或误扫敏感数据。

下一阶段只有在 schema 确认后，才允许增加严格限定的只读聚合查询，并且只返回脱敏计数：
- 活跃重复关系计数；
- 映射指向不存在卡密/分组的孤儿计数；
- mapping.owner 与 card.owner/group.owner 不一致计数；
- 幂等 request key 重复或 payload digest 冲突计数。

查询不得 SELECT 或导出 app_cards.code、session token、APP token、订阅 URL、用户个人资料或原始业务行。所有检查必须限定状态和关联条件，并在输出中明确 COUNT_ONLY。

## 5. 判定规则

- OBSERVED：只表示元数据查询返回了该结构。
- ABSENT：目标表/索引/触发器未发现；不代表可以创建。
- NOT_EVALUATED：尚无批准的基线或比较规则。
- MISMATCH：与经批准的 manifest 不一致。
- ERROR / PARTIAL_NOT_VERIFIED：元数据查询失败或结果不完整。

在没有经审查、版本化的 schema baseline 前，不允许输出“生产 schema 兼容 PASS”。Staging 和 production 必须分开保存 manifest，不能混用。

## 6. 禁止事项与上线边界

- 不执行 CREATE/ALTER/DROP、INSERT/UPDATE/DELETE、迁移 runner 或任何 DDL/DML。
- 不新增生产 migration，不改变 public/assigned/free 与候选 card/free mode 语义。
- 不注册 Protocol 65/66 正式 Worker route，不改变 HTML/APP 协议。
- 不访问/修改 Cloudflare Secrets，不部署 Worker/HTML，不操作生产数据。
- 不合并 PR #2；保持 Draft/Open/Unmerged。

## 7. 当前结论与下一步

本批建立了 schema-only 人工采集路径，但没有真实目标数据库快照，因此真实 D1 schema 状态仍为 NOT VERIFIED。卡密映射 DDL、D1 adapter、正式路由、管理 UI 和 APK 多 entitlement 联调仍然被阻断。

第七十八批唯一接手卡：在收到操作者通过 Cloudflare 控制台取得的脱敏 schema-only metadata 后，构建 staging/production 分离的版本化 manifest 对比器；根据真实字段与约束再设计只读异常计数查询。没有快照时继续保持暂停，不猜列、不生成生产迁移。
