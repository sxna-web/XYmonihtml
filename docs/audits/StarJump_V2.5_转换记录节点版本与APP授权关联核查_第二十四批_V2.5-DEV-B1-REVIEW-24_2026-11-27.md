# 星跃管理平台 V2.5：转换记录、节点版本与 APP 授权关联核查

- **批次**：第二十四批
- **版本标识**：V2.5-DEV-B1-REVIEW-24
- **日期**：2026-11-27
- **状态**：DEV 静态源码审计；不是修复版、RC 或可部署版本
- **核查基线**：仓库归档 `原始StarJump_V1点0_Final-zip-26-11-25-14:56/Worker.js`
- **基线 Blob**：`5da7aa3582558d9da2c2a0ad25a63c5e95e9fe63`
- **范围**：转换链接快照、节点同步 upsert、节点身份别名、节点生命周期、APP 分组来源关联及 entitlement 关联边界
- **限制**：仅静态阅读归档 Worker 和已确认项目规范；未读取生产 D1、未解包 APK、未调用线上 API、未修改业务代码或执行 SQL。

## 1. 结论摘要

本批确认：当前归档 Worker 的转换链接确实把转换后的格式文本与来源信息加密写入 `convert_links.payload`。这为历史链接提供了内容快照基础，节点后续同步更新不会直接重算既有 payload。但该快照仍是整体文本/JSON 快照，并非完整的结构化节点版本快照；它没有在转换记录中建立可验证的 node_id、fingerprint、identity_key、节点版本号及版本差异关联。

同时，节点同步采用 `(source_id, fingerprint)` 冲突键原位 upsert，节点当前状态会被更新；`node_identity_aliases` 则按 `(source_id, identity_key)` 更新其 fingerprint 映射。由此可见，当前系统保留了部分身份映射，但没有在本次核查到的转换快照路径中建立“历史转换使用了哪个节点身份/哪一版节点”的闭环。

APP 分组来源关系目前由 `app_group_sources(group_id, source_id)` 表示；APP entitlement 记录管理员、设备、卡密及期限，但没有在 entitlement 本身固定授权时的分组版本或节点清单。节点/来源变化后，若没有独立的授权快照与撤销事件协议，无法仅凭现有字段证明某设备在某时刻获准获取的精确节点集合。

**核心判断：**
- 历史转换链接的输出内容有快照保护，但缺少可审计的结构化节点来源版本。
- 节点当前记录是原位更新，不是逐版本留档。
- 节点身份 alias 是映射表，不等同于节点版本历史；映射变更可能使当前身份指向变化。
- APP entitlement 是期限/设备/管理员级授权记录，不是分组成员与节点内容的不可变授权快照。
- 现有生命周期状态与 APP 24 小时本地清理 ACK 不是同一机制，不能互相替代。

## 2. 已核实实现

### 2.1 转换结果快照

`convertRoute()` 在转换成功后生成格式输出，将 `formats`、`meta`、`sources` 组成对象，经 `sealJson(env, ...)` 加密后写入 `convert_links.payload`。链接访问 `/c/:id` 时读取并解密该 payload，再直接返回其中指定格式文本。

因此，后续节点记录变化不会自动改写已保存 payload。该行为可视为“转换结果内容快照”，但不是节点级版本快照。

### 2.2 转换记录结构缺少节点级关联字段

归档 Worker 的迁移定义中，`convert_links` 包含：
- `id`、`payload`、`targets`、`group_name`
- `owner_user_id`、`ip_hash`、`hits`
- `created_at`、`last_used_at`、`expires_at`、`revoked_at`

转换写入代码另外使用 `owner_key`，但迁移定义未在该 CREATE TABLE 片段中声明该字段，后续兼容性依赖另处 ALTER/既有 schema；真实 D1 字段状态尚未核验。

本次检索未发现转换记录保存以下结构化关联：
- 节点 ID 列表及其顺序；
- 每个节点的 fingerprint / identity_key；
- 节点版本号或版本事件 ID；
- 转换时来源审核状态、来源版本；
- 转换快照 schema/envelope 版本及 key_id；
- 可用于重建转换输入的规范化节点 JSON 清单。

注意：payload 内的格式文本和 sources 信息仍然有历史内容价值；本结论不是说历史链接没有保存内容，而是说无法可靠回答“该链接具体由哪一批节点版本构成”。

### 2.3 节点同步原位更新

同步提交使用 `INSERT INTO node_records ... ON CONFLICT(source_id, fingerprint) DO UPDATE`。冲突时更新来源名称、节点名称、协议、服务器、端口、URI、等级、启用状态及时间戳。

因此同一 fingerprint 对应节点的字段变化会覆盖当前行，不会自动产生一条独立的历史版本记录。当前代码中的 `node_records` 更接近节点当前态表，而非完整版本表。

### 2.4 identity alias 不能代替版本记录

同步阶段另写 `node_identity_aliases`，以 `(source_id, identity_key)` 为冲突键，冲突时更新 fingerprint。

这说明系统尝试维持 identity_key 到 fingerprint 的当前映射，但本次核查未发现该映射本身保留完整历史映射区间、变更原因、操作者或节点内容版本。identity_key 与 fingerprint 也不是同一个概念，不应将二者直接互换作为永久节点主键。

如果某次解析规则或节点身份计算变化，alias 指向更新并不意味着旧转换链接或 APP 客户端已经安全完成节点迁移；需要明确的身份变更事件和兼容策略。

### 2.5 APP 分组与 entitlement 关联边界

归档迁移定义中：
- `app_groups` 保存管理员、分组名称、mode、排序及启用状态；
- `app_group_sources` 保存 `group_id` 与 `source_id`；
- `app_group_members` 保存分组与 device_id；
- `app_entitlements` 保存管理员、设备、卡密、开始/到期时间、purge_at 和 status；
- `app_free_grants` 保存 device_id 与管理员的免费授权关系。

本次核查未发现 entitlement 固定保存核销时的 app_group_sources 版本、分组 generation 或节点清单哈希。分组来源关系变化后，现有 entitlement 字段本身不足以证明此前已下发节点集合的精确内容。

## 3. 风险分级

| 编号 | 等级 | 发现 | 可能影响 |
|---|---|---|---|
| R24-01 | P1 | 转换记录只有整体加密 payload，缺结构化节点身份/版本清单 | 历史记录难以精确审计节点来源及版本差异 |
| R24-02 | P1 | node_records 以 fingerprint 冲突后原位更新 | 当前态覆盖旧节点字段，缺少可查询的逐版本历史 |
| R24-03 | P1 | identity_alias 按 identity_key 更新 fingerprint，未见完整历史映射区间 | 节点身份迁移时可能无法还原旧映射 |
| R24-04 | P1 | APP entitlement 未固定授权时的分组 generation/节点清单 | 无法单靠 entitlement 证明当时具体获准节点范围 |
| R24-05 | P1 | APP 分组来源关系与 entitlement/节点版本之间缺少统一事件链 | 来源移除、节点变更或分组调整后，撤销和本地清理状态难以审计 |
| R24-06 | P2 | 转换链接访问时 hits/last_used_at/expires_at 更新失败被 catch 忽略 | 返回内容成功但访问统计和续期信息可能未更新 |
| R24-07 | P2 | 当前转换 payload 未见显式 snapshot schema version / key_id 字段约定 | 后续格式升级、密钥轮换时历史读取兼容性治理较困难 |

风险等级是基于静态代码结构的工程评估，不代表已经发生数据丢失或授权越权。

## 4. 需求基线与设计建议

以下沿用已确认要求：转换成功后后台归档；相同 URL 不覆盖历史；编辑应保留快照；节点版本和操作者/时间/差异可追踪；回滚应创建新版本而非覆盖历史；APP 分组撤销采用服务端撤销事件/generation、APK 增量同步、本地清理、ACK 的闭环。

### 4.1 转换快照增强

建议新增独立、版本化的转换快照结构（具体表名/字段待 schema 核验），至少包含：
- snapshot_id、convert_link_id、snapshot_version；
- owner identity、created_at、actor/effective_user；
- source_id 与 source revision / sync task ID；
- 节点有序清单：node_id、fingerprint、identity_key、node_version_id；
- 规范化节点内容哈希及转换输出哈希；
- parser/canonical version、目标格式、生成器版本；
- payload envelope version、key_id（不保存密钥本身）。

快照必须在转换成功的业务事务/可靠 outbox 边界内落账。旧链接继续使用既有 payload 读取，迁移后新记录写新快照；不要尝试从旧文本快照伪造历史 node_id 或版本号。

### 4.2 节点版本事件

建议采用追加式节点版本模型：
- 节点当前态表继续服务现有列表和同步流程；
- 每次字段变化写入 node version/event，记录前后内容哈希、变更字段、source sync task、时间；
- fingerprint 与 identity_key 分开存储；
- identity alias 变化写独立 alias event，保留旧值、新值、原因及关联 sync task；
- 删除、停用、来源撤销使用 tombstone/event，不以物理删除代替业务撤销；
- 回滚写入一个新版本，不能覆盖旧版本。

是否需要全量保存每版完整节点 JSON，还是只保存差异+定期快照，应在估算 D1 容量、查询成本和恢复需求后确定。

### 4.3 APP 授权快照与撤销事件

建议在 entitlement 与 APP 分组之间建立可验证的授权版本关系：
- entitlement_id、group_id、group_generation；
- 授权时来源集合/节点集合版本哈希；
- revoke_generation、revoked_at、purge_after；
- 设备凭证标识、旧设备撤销状态；
- APK cleanup ACK 的 generation、客户端版本、ack 时间及结果。

每次来源移除、分组改型/删除、节点撤销、卡密作废、设备换绑，应形成追加式授权变更事件。APK 增量同步以 generation 游标拉取；客户端确认本地清理后提交 ACK。重复拉取和重复 ACK 必须幂等；离线设备保留待处理撤销事件，不能因服务端标记 purged 就推断本地已清理。

### 4.4 历史数据兼容

- 旧 convert_links.payload 保持只读可访问，不做批量重写。
- 对旧转换记录标注 snapshot_level = legacy_payload_only（若采用该字段/视图），不能声称拥有节点版本证据。
- 新快照只对新转换生效；历史回填只能使用可证明的数据，无法证明的字段保持 NULL/unknown。
- 新旧 Worker 应在迁移过渡期同时兼容旧表字段；任何新字段/表均须先通过真实 D1 只读 schema 检查。
- APP 旧 APK 未支持 generation/ACK 前，不得直接启用会导致旧客户端无法获取节点或误清理节点的强制协议。

## 5. 数据库影响与迁移前置条件

本报告不生成可直接执行的生产 SQL。可能涉及新增节点版本事件、转换快照关联、APP 授权变更事件及 ACK 记录，但：
1. 生产 D1 表、字段、索引、触发器和已执行迁移版本仍未核实；
2. 不能依据 Worker 内置 MIGRATE_STATEMENTS 推断生产 schema；
3. 不能把 staging 或已废弃的 starjump-db 当作生产；
4. 必须先通过后台只读 schema 检查确认现状，再制定 migration ID、checksum、依赖、前置条件、dry-run、执行记录和回滚/前滚方案；
5. 禁止 DROP/TRUNCATE、重建业务表或覆盖历史 payload；
6. 迁移需保留旧字段/旧读取路径，直到新旧 Worker 与 APK 兼容验收完成。

## 6. 测试矩阵（待隔离环境执行）

| Test ID | 场景 | 预期 |
|---|---|---|
| CV24-01 | 创建转换链接后更新同一 fingerprint 节点 | 旧链接输出保持创建时快照；新转换记录新版本关联 |
| CV24-02 | 节点名称/地址/协议变化 | 产生新节点版本事件，旧版本可查询 |
| CV24-03 | identity_key 指向新 fingerprint | 保留旧 alias 历史，不误合并不同节点 |
| CV24-04 | 同一 URL 再次转换 | 新建历史记录，不覆盖旧记录 |
| CV24-05 | 编辑历史转换记录 | 创建新快照/修订版本，旧内容可审计 |
| CV24-06 | 来源移除或审核撤销 | 生成撤销 generation，已授权设备可拉取撤销事件 |
| CV24-07 | APP 分组删除/改型 | tombstone → APK 增量同步 → 本地清理 → ACK 完整闭环 |
| CV24-08 | 设备离线超过 24 小时 | 重新上线先收到撤销清单，不复活已撤销节点 |
| CV24-09 | 多管理员多 entitlement | 各授权实例范围隔离，不因合并而扩大节点权限 |
| CV24-10 | ACK 重复提交/乱序提交 | 幂等处理，旧 generation 不覆盖新状态 |
| CV24-11 | 旧 APK 不支持 ACK | 进入兼容策略，不提前清除服务端撤销证据 |
| CV24-12 | 历史 legacy payload 解密 | 旧链接可读取，无法证明的节点版本字段保持未知 |

以上均为待执行测试项，不标记通过。APK 源码 ZIP 尚未成功解包，因此无法确认客户端实际缓存结构、设备授权调用、节点标识和 ACK 支持情况。

## 7. 回滚与恢复

- Worker 回滚到旧版本时，新增表/字段应保持向后兼容；旧 Worker 不应依赖新表。
- 新版快照写入失败时，不得返回“已成功归档”；应按业务定义失败或写入可靠 outbox 后返回可追踪状态。
- 不回写旧 payload，不批量重加密旧记录，不物理删除 node version/event、alias event 或 APP revoke event。
- 节点版本恢复通过创建新版本实现；APP 授权撤销恢复也必须创建新的授权事件/generation，不能删除历史撤销记录。
- D1 恢复必须先在独立测试库演练；生产恢复需另行获得明确授权。
- APK 客户端回滚不得导致已处理撤销的节点复活；generation 游标和 ACK 应设计为单调且可重放。

## 8. 本批验证边界

| 项目 | 状态 |
|---|---|
| AGENTS.md 与项目基线 | 已读取 |
| 用户指定归档 Worker | 已静态检查 |
| 转换 payload 加密快照 | 已静态确认 |
| node_records 原位 upsert | 已静态确认 |
| node_identity_aliases 当前映射更新 | 已静态确认 |
| APP groups / group_sources / entitlements 结构 | 已静态确认迁移定义 |
| 生产 D1 实际 schema/数据 | 未核实 |
| 当前 Cloudflare 线上 Worker | 未核实 |
| APK 节点缓存、版本标识与 ACK | 未核实（APK ZIP 未解包） |
| 集成/并发/回归测试 | 未执行 |
| 业务代码/D1/Secrets/部署 | 未修改、未操作 |

## 9. 下一批建议

第二十五批建议聚焦“APP 客户端兼容协议与服务端 API 响应契约”，先从可读的 Worker 与 HTML 中列出版本、下载、核销、status、groups、nodes、links、free 的完整请求字段/响应字段，再明确 APK 旧版本兼容边界。APK 源码仍无法读取的部分继续标注阻塞，不虚构客户端实现。

---
**结论：第二十四批完成的是静态核查与设计登记，不代表已修复或已通过运行测试。不可上传部署。**
