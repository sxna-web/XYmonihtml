# 星跃管理平台 V2.5｜Schema Manifest 对比器与脱敏输出加固报告

- 批次：V2.5-DEV-B1-APP-SCHEMA-MANIFEST-78
- 日期：2026-11-28
- 分支：release/v2.5.0-rc1-converge
- 范围：本地纯函数工具、JSON 输入输出、隔离测试；不连接数据库。
- 状态：实现已提交，等待 GitHub Actions 验证。

## 1. 本批实现

新增：
- tools/database_migrations/schema_manifest.py
- tools/database_migrations/tests/test_schema_manifest.py

更新：
- tools/database_migrations/README.md

工具只接受现有 schema_snapshot() 结构化 JSON，不直接打开 SQLite/D1 文件，不调用 Wrangler、Cloudflare API、Secrets 或生产绑定。固定覆盖 Batch 77 的 7 张表，并明确 staging、production、local-fixture 环境标签。

## 2. 输出与比较范围

每张存在的表记录：
- 列名、声明类型、NOT NULL、PK 顺序；
- 默认值是否存在及其 SHA-256（不回显默认值字面量）；
- 索引名称、unique、origin、partial、索引键列顺序；
- 外键目标、列映射、ON UPDATE/ON DELETE/MATCH；
- 表、索引、触发器、视图对象身份及 SQL SHA-256。

缺失表标记 ABSENT；跨环境存在性不一致标记 PRESENCE_MISMATCH。结构差异按 columns/indexes/foreign_keys/objects 分类。输出不包含原始 SQL 定义或默认值字面量，避免将可能嵌入 DDL 的常量复制到报告。

## 3. 13 项新增测试覆盖

1. 环境标签与固定 7 表范围；
2. 候选表缺失标记；
3. 两环境结构一致；
4. 跨环境缺表差异；
5. 列约束差异；
6. 索引键差异；
7. 外键动作差异；
8. 默认字面量不回显；
9. Trigger SQL 只保留 hash；
10. 非法环境拒绝；
11. 不完整列元数据拒绝；
12. scope 不一致拒绝；
13. 相同结构跨环境输出 MATCH。

本地 fixture 测试通过之前不得提升该工具状态；GitHub Actions 将执行整个 database_migrations unittest discovery。测试成功也只代表工具逻辑通过，不代表真实 D1 已验证。

## 4. 操作示例

先在受控环境通过已批准的只读 schema 查询导出 schema_snapshot JSON，再执行：

```bash
python tools/database_migrations/schema_manifest.py build --input staging.snapshot.json --environment staging --output staging.manifest.json
python tools/database_migrations/schema_manifest.py build --input production.snapshot.json --environment production --output production.manifest.json
python tools/database_migrations/schema_manifest.py compare --left staging.manifest.json --right production.manifest.json --output comparison.json
```

生产 snapshot 只有在项目负责人明确安排、操作者确认目标 D1 后才采集；本批没有要求或执行该步骤。输出 MATCH 只表示结构投影一致，不构成迁移批准或上线验收。

## 5. 安全与未完成事项

- 不执行 DDL/DML，不连接 staging/production D1。
- 不读取业务行、卡密 code、session/APP token、订阅 URL。
- 不生成生产 migration，不注册 Worker route，不修改 HTML/APK 协议。
- APP mapping migration/真实 D1 adapter/正式 route/UI/多 entitlement 客户端仍阻断。
- 真实 D1 schema 仍 NOT VERIFIED；没有真实快照，不可宣称 staging/production MATCH。
- PR #2 保持 Draft/Open/Unmerged；不部署、不合并。

## 6. 下一批接手

第七十九批先核查本批 CI 的真实 run/head，再针对 manifest utility 做静态边界审查：输入 JSON 结构异常、重复对象名、缺少 index_details、对象 SQL 缺失、默认值/trigger 内容不回显、manifest hash 稳定性。若真实 schema snapshot 尚未由操作者提供，继续只做工具可靠性和 APP 授权代码审计，不猜生产字段、不创建 migration。
