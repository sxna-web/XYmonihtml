# 星跃管理平台 V2.5 DEV：转换历史快照与节点身份映射核查（第十二批）

- 版本标识：`V2.5-DEV-B1-REVIEW-12`
- 日期：2026-11-27
- 阶段：DEV 静态源码复核
- 目标：转换历史、节点身份别名、节点覆盖与 stale 清理关联
- 候选 Worker：`releases/v2.5-batch1/Worker.js`
- Worker blob：`5a2739d981e1835e692a04b903052f268fed981a`
- 对照基线：原始 Worker blob `5da7aa3582558d9da2c2a0ad25a63c5e95e9fe63`

> 本批只读静态源码。没有执行 API、D1 SQL、Cron、数据修复或部署；未解包 APK ZIP。未读取真实 D1 的外键、索引和表定义，因此涉及真实约束的结论均标注为待核实。

## 一、核心结论

1. **转换链接保存的是转换时生成的配置文本快照，不是指向当前 node_records 的动态节点引用。** `convert_links.payload` 通过 `sealJson()` 加密保存已生成的各格式文本、元数据和来源摘要；访问 `/c/:id` 解密并返回保存的格式文本，不会重新查询当前节点表。因此，后续节点改名、覆盖或订阅更新，不会自动改写既有转换链接的输出。
2. **转换快照不等于完整节点级历史档案。** payload 保存格式化后的配置文本和来源 URL/节点数量等来源信息，但没有保存结构化节点 ID、fingerprint、identity_key、每个节点的原始字段快照或节点版本号。可以重放当时生成的文本，但不能可靠地按节点 ID 追溯每一条历史节点记录。
3. **节点身份键与 fingerprint 的口径不同。** fingerprint 是完整 URI 的 SHA-256；identity_key 是从解析出的协议、服务器、端口和认证材料生成的 SHA-256。节点 URI 的名称或部分传输参数变化可能导致 fingerprint 改变，但 identity_key 仍相同，Worker 会尝试复用旧节点 ID。
4. **node_identity_aliases 与 node_overrides 等表没有在当前候选 Worker 的建表迁移中创建。** 它们是运行时代码依赖，真实表结构、唯一约束、外键和索引必须以实际 D1 只读 schema 为准。
5. **stale 节点物理清理只删除 node_records 和 node_lifecycle。** 没有同步清理或归档用户节点覆盖、备注/收藏元数据、节点分组成员、身份别名等关联数据；若实际 D1 没有合适级联约束，可能留下悬空数据。当前源码没有显式声明这些外键，不能假设级联存在。

## 二、转换历史：快照还是动态引用

### 2.1 创建时保存什么

`convertRoute()` 在转换完成后：
- 生成目标格式文本：Clash、V2Ray、Sing-box、节点列表、Surge、Surfboard、Loon、Quantumult X 等；
- 构造 `meta`，包含文件名、订阅流量信息和 owner；
- 将 `{ formats, meta, sources }` 经 `sealJson(env, ...)` 加密后写入 `convert_links.payload`；
- 另存 targets、group_name、owner_user_id、owner_key、ip_hash、expires_at。

`sources` 记录来源 URL 和解析节点数量等摘要，不是逐节点结构化快照。代码没有将节点 ID、fingerprint、identity_key 或节点版本数组写入 payload。

### 2.2 访问时如何返回

`GET /c/:id`：
1. 读取 payload、expires_at、revoked_at；
2. 检查撤销与过期；
3. 解密 payload；
4. 直接取 `data.formats[target]` 返回文本。

没有重新读取 `node_records`，也没有按 node_id/fingerprint 动态重建配置。因此它属于“已生成文本快照”，而不是实时引用。

### 2.3 编辑与历史版本

候选 Worker 有修改分组名称、撤销链接、统计 hits/刷新过期时间等操作；本次全文件检索未发现 `UPDATE convert_links SET payload=...` 的写入路径。

因此当前代码没有看到后台直接编辑 payload 并保留旧 payload 快照的完整版本机制。若未来增加转换记录编辑，必须先写不可变版本/快照，再更新当前指针；不能原地覆盖唯一 payload，否则无法还原修改前内容。

### 2.4 结论边界

现有格式文本快照可以在 node_records 后续变化时保持旧输出，但它不具备节点级检索、节点身份追踪、逐节点差异、版本回滚和按节点撤销能力。不要把“保存了转换结果文本”宣传成“保存了完整节点历史档案”。

## 三、节点身份映射

### 3.1 两种哈希承担不同作用

- `fingerprint = SHA256(uri.trim())`：对完整 URI 计算，注释明确要求保持历史 fingerprint 兼容。
- `identity_key = SHA256(identityMaterial)`：只对解析得到的身份材料计算，不直接等于完整 URI 哈希。

当前身份材料：
- VLESS：协议 + 小写服务器 + 端口 + username/UUID；
- VMess：协议 + 小写服务器 + 端口 + UUID；
- Trojan：协议 + 小写服务器 + 端口 + username/密码；
- Shadowsocks：协议 + 小写服务器 + 端口 + method + password。

因此节点名称变化通常会改变完整 URI fingerprint，但不改变 identity_key。部分传输参数、路径、TLS、插件等变化也可能在 identity_key 中未体现，具体取决于协议 URI 解析内容。

### 3.2 同步时复用节点 ID 的路径

`syncSource()`：
1. 读取该来源现有 `node_records(id,fingerprint)`；
2. 读取 `node_identity_aliases(identity_key,fingerprint)`；
3. 优先按 fingerprint 找现有节点；
4. fingerprint 不匹配时，按 identity_key 找别名，再映射回现有 fingerprint 和 node ID；
5. 找到则复用旧 ID；找不到则生成新 ID；
6. 提交时按 `(source_id,fingerprint)` upsert 节点，并按 `(source_id,identity_key)` upsert 别名。

这能在部分 URI 变化时保持节点 ID 稳定，但不能证明它在所有协议配置变化下都正确。

### 3.3 需要重点验证的身份冲突

同一协议、服务器、端口和认证材料下，传输路径、TLS、SNI、Reality、插件或其他连接参数变化时，identity_key 可能仍相同。此时旧节点 ID 被复用，节点 URI 和连接字段会被新值覆盖。

这可能是产品想要的“同一节点更新配置”，也可能把实际不同的连接端点合并为同一身份。需要明确业务定义：
- 哪些字段变化属于同一节点的配置更新；
- 哪些变化必须产生新节点身份；
- 多条记录出现相同 identity_key 时如何处理；
- identity_key 变更、冲突和历史 alias 如何保留；
- 回滚时是否创建新节点版本，而不是覆盖旧字段。

不得仅凭“同服务器/端口/凭据”推断所有协议变体都是同一个可替换节点。

## 四、节点覆盖与用户元数据

当前用户节点列表通过 `node_records` 与 `node_overrides` 合成有效节点字段；覆盖字段包括名称、协议、服务器、端口、等级、启用状态等。覆盖按 `user_id + node_id + field_name` 读取、写入和删除，并写审计。

用户节点列表还会关联：
- `node_user_metadata`：备注、收藏、排序等；
- `node_group_members`：用户自定义分组成员；
- `node_identity_aliases`：来源级身份别名；
- `node_lifecycle`：节点生命周期状态。

这些记录不是转换快照的一部分。节点同步更新时，复用同一 node ID 可以让用户覆盖和元数据继续附着在该节点上；若身份误合并，用户覆盖也可能被带到不应合并的节点；若节点 ID 被重新生成，旧覆盖/备注/分组关系又可能成为孤儿数据。

## 五、stale 物理清理的关联风险

候选 Worker 的 `runNodeLifecycle()` 在 stale 超过 30 天后执行：
- `DELETE FROM node_records WHERE id = ?`
- `DELETE FROM node_lifecycle WHERE node_id = ?`

未看到同一清理流程处理：
- `node_identity_aliases`；
- `node_overrides`；
- `node_user_metadata`；
- `node_group_members) 中 `node_kind='subscription'` 的成员；
- 其他可能按 node_id 引用订阅节点的表。

当前候选 Worker 的迁移清单没有创建上述基础表，也没有声明 `FOREIGN KEY ... REFERENCES node_records`。所以不能从候选源码确认真实 D1 是否设置 ON DELETE CASCADE。若没有级联，节点删除后会留下关联记录；若存在级联，也必须验证是否会连带删除仍需保留的历史、审计或分组信息。

此外，stale purge 不检查 APP 分享授权、转换历史或待处理的 APP 撤销事件。转换链接虽然保留格式文本，但不会提供结构化 node_id 引用；APP 分组和来源共享节点的引用也必须独立检查。**stale 30 天清理不应在未完成引用盘点前扩大执行范围。**

## 六、数据保护与正式版本要求

### 6.1 转换历史必须分层保存

正式设计应区分：
- 转换结果快照：保存实际输出文本及格式、生成时间、输入来源摘要、生成规则版本；
- 节点级快照：保存每个节点的稳定身份、结构化字段、来源、节点版本和转换批次关联；
- 转换记录版本：编辑时创建新版本，旧版本只读；
- 撤销状态：撤销链接不等于删除历史快照。

敏感 URI、密码、订阅 URL 必须加密；日志和普通列表不得暴露原始凭据。

### 6.2 节点历史版本

建议为节点引入不可变版本或变更事件：
- node_id / identity_key / fingerprint；
- source_id；
- version；
- 字段差异；
- 变更来源（同步、用户覆盖、超管修复）；
- 操作者、时间、任务 generation；
- 变更前后安全快照或加密引用。

回滚应创建新版本，不覆盖旧版本。

### 6.3 安全清理

任何节点物理清理前必须检查：
1. 是否被其他来源、用户或分组引用；
2. 是否存在用户覆盖、备注、收藏、排序；
3. 是否存在 APP 授权或待 ACK 撤销事件；
4. 是否有转换历史/版本引用；
5. 是否有审计和合规保留要求。

建议先标记 archived/deleted_pending，经过只读 dry-run 和保留期后，再由受控清理流程处理。不可直接把孤儿表记录一并删除来掩盖引用问题。

## 七、后续只读核验与验收清单

真实 D1 只读 schema 核验应覆盖：
- `sqlite_master` 中上述表的 CREATE SQL；
- `PRAGMA table_info(...)`；
- `PRAGMA index_list(...)` 与 `index_info(...)`；
- `PRAGMA foreign_key_list(...)`；
- 节点 ID 与各引用表的孤儿记录统计（只读 SELECT）。

集成测试应覆盖：
- 仅名称变化：是否按设计复用 node_id；
- VLESS/Trojan 传输参数变化：是否应复用或新建；
- 凭据变化：identity_key 是否改变；
- identity_key 冲突：不得静默合并；
- 节点复用后用户覆盖、备注、收藏是否仍正确；
- 节点归档后历史转换链接输出不变；
- 转换记录编辑后旧版本仍可访问；
- stale 节点仍被用户分组或覆盖引用时不得物理删除；
- 节点清理后没有无主覆盖、备注、收藏或分组成员；
- APP 授权撤销与节点生命周期清理互不替代。

## 八、状态与下一步

- 本批只提交静态审计报告，没有修改业务代码。
- 原始 Worker 与 Batch 1 均未部署；本报告主要以 Batch 1 候选 Worker 为核查对象。
- 未访问生产 D1，无法确认真实外键、索引和现存数据关联。
- 未解包 APK，无法确认 APK 对节点 ID、fingerprint、缓存版本和本地历史的实际处理。
- Batch 1 仍为 DEV，不可部署。

下一批建议核查 APP 节点下发与普通用户节点列表之间的身份一致性、节点覆盖是否会意外泄漏到 APP、APP 节点分组是否真正按 app_group_sources 限定来源，以及免费授权/卡密授权的设备隔离和多授权合并规则。
