# 星跃管理平台 V2.5｜APP 卡密分组映射候选模型隔离 SQLite 验证报告（第七十二批）

- 批次：`V2.5-DEV-B1-APP-CARD-MAP-72`
- 日期：2026-11-28
- 状态：**候选关系模型已建立；隔离 SQLite 测试通过；不是生产 migration；未连接 D1**
- 分支：`release/v2.5.0-rc1-converge`
- 测试提交：`b6078a207ce036eb4f160b1e16db75da96f33a23`
- PR：#2 Draft/Open/Unmerged

## 1. 本批实际修改

新增：
`tools/database_migrations/tests/test_app_card_group_mapping_candidate.py`

这是独立 SQLite fixture 测试，未新增任何 `.sql` migration 文件，未加入 `runner.py` 的 migration catalog，也不会被 `apply-local` 自动当作迁移执行。fixture 使用内存 SQLite 数据库和历史结构字段的最小化模拟。

候选关系表字段：
- `id`
- `card_id`
- `admin_user_id`
- `group_id`
- `status`（active / removed）
- `created_at`
- `updated_at`
- `removed_at`

约束/索引候选：
- UNIQUE `(card_id, group_id)`，同一卡密与分组只保留一条关系记录；解绑后恢复原记录，不插入重复关系。
- FK 到 `app_cards(id)` 和 `app_groups(id)`，采用 RESTRICT，避免历史 entitlement/事件关联意外级联清除。
- 索引 `(card_id, admin_user_id, status)` 与 `(admin_user_id, group_id, status)`。
- INSERT/UPDATE trigger 校验卡密、分组属于同一管理员，且分组 `mode='card'`。
- 活跃映射存在时禁止分组直接降级离开 card mode；必须显式解除映射。
- 已有关联历史时禁止卡密/分组转移管理员，避免历史授权关系被重新归属。
- 软删除保留映射行和时间戳；不物理删除，不级联删除。

## 2. 测试覆盖

11 项隔离 SQLite 测试：
1. 同管理员卡密与 card 组允许绑定；
2. 跨管理员卡密拒绝；
3. 跨管理员分组拒绝；
4. free/assigned 分组拒绝作为卡密专属组；
5. 重复卡密-分组关系拒绝；
6. 软解绑后可恢复原关系并保留唯一历史行；
7. 存在 active mapping 时禁止 mode 降级；
8. 有映射历史时禁止 card/group owner 变更；
9. 删除父卡密或分组被 FK RESTRICT 阻止；
10. 重复安装候选 fixture DDL 幂等；
11. 映射表不复制 redeem code/token 字段或值。

## 3. CI 证据

测试 head：`b6078a207ce036eb4f160b1e16db75da96f33a23`

- Push Run `46113980630`：SUCCESS  
  https://github.com/sxna-web/XYmonihtml/actions/runs/46113980630
- PR Run `46113985475`：SUCCESS  
  https://github.com/sxna-web/XYmonihtml/actions/runs/46113985475
- workflow 中 Isolated local SQLite migration verifier、Batch 49 auth adapter、Worker handler integration、APP v2 entitlement/multi-card contract、Worker bundle、Cron/static checks、artifact upload 全部通过。
- Candidate Artifact：`StarJump-V2.5.0-RC1-candidate`，ID `15250429175`，134,139 bytes，expires 2026-12-12T05:51:44Z。

CI 通过证明 fixture 与当前本地测试套件通过，不代表 Cloudflare D1 的约束、触发器、事务或生产表结构已验证。

## 4. 明确未实施事项

- 没有创建生产 migration SQL；候选 DDL 仅保存在 Python 测试 fixture 中。
- 没有改动 Worker、HTML、APK、现有数据库表。
- 没有真实 D1 schema snapshot，不能确认目标环境是否存在父表唯一约束、字段类型/命名差异、既有脏数据或触发器冲突。
- 没有管理员卡密分组 API/UI，也没有将 Protocol 65 loader 接入真实 D1。
- 未解决旧 `public/assigned/free` 与新 `card/free` 的完整兼容/迁移策略。
- 未执行生产数据回填、迁移、Secrets 操作、Cloudflare 部署或 PR 合并。

## 5. 设计风险与待确认项

1. 当前候选模型使用单列父键 FK + trigger owner check，不依赖尚未确认的复合唯一索引；真实 D1 需确认触发器行为与约束兼容。
2. `UNIQUE(card_id, group_id)` 意味着解绑后恢复同一记录，不保留每次绑定/解绑的完整版本历史；完整操作审计应由独立 audit event 同批次记录。若未来要求多轮历史快照，需另行采用 mapping history/event model。
3. `status=removed` 软删除保留记录；删除卡密或分组将被 FK RESTRICT 阻止。后台删除流程需先明确显式解除映射/保留历史的顺序。
4. 数据库 trigger 仅做数据归属防护，不替代 API 对管理员 VIP 有效期、卡密状态、操作者权限、设备 entitlement 和 audit 的检查。
5. 候选 DDL 不应直接复制到生产；需要基于真实 schema manifest 生成版本化 migration，并在 staging D1 做事务/并发/回滚验证。

## 6. 下一批

第七十三批先实现管理员侧卡密-分组关系 API 的**纯 handler/SQL adapter contract fixture**，明确：
- 所有读写均按当前登录管理员 owner scope；
- 卡密与分组双重 owner 验证；
- VIP 过期只读；体验卡 7 天规则不被绕过；
- 卡密停用/撤销/作废状态不得通过映射恢复；
- 批量更新采用明确 replace semantics，缺失/重复 ID fail closed；
- 映射变更与 audit 同一 D1 batch；
- API 不返回 redeem code，仅返回非敏感展示 label；
- SQLite tests 验证 owner isolation、事务失败原子性、审计同批次、重复请求幂等。

在拿到真实 D1 schema snapshot 并批准 migration 前，仍不创建生产 migration SQL、不连接生产 D1、不部署。

---
**结论：** 第七十二批已完成候选映射关系模型的隔离 SQLite 约束验证，Push/PR CI 双通过。此成果是测试夹具，不是生产 DDL 或可部署功能。
