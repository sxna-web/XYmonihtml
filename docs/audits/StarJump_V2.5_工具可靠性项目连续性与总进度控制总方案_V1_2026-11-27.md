# 星跃管理平台 V2.5｜工具可靠性、项目连续性与总进度控制总方案

> 文档编号：SJ-V2.5-GOV-TOOL-CONTINUITY-001
> 版本：V1.0
> 建立日期：2026-11-27
> 适用范围：星跃管理平台 V2.5 全部 AI 会话、模型、工具调用、代码/文档提交、测试与交付批次
> 状态：**已建立管理规范；自动化门禁与仪表盘实现待实施**
> 主仓库：`sxna-web/XYmonihtml`，分支 `main`

## 0. 目的与强制原则

本方案用于降低工具调用失败、参数错误、重复写入、测试误报、跨会话丢失上下文和项目进度记录断层的风险。它是跨模块的工程管理规则，不替代 `AGENTS.md`、功能基线、数据库保护规范或模块技术设计。

五条不可违反的原则：

1. **先核对再操作**：任何写入前先读取目标文件当前版本、路径、分支与 SHA；不得依赖过期摘要。
2. **失败不伪装成功**：工具超时、限流、异常、返回结构不完整时，状态记为“调用失败/结果未知”，不得声称成功。
3. **不确定先查后重试**：写操作返回超时不代表写入失败。先读取目标路径、Commit 历史或当前内容，确认是否已提交，再决定是否重试。
4. **证据决定状态**：计划、已写入、已测试、已复核、已部署分别记录；不得跨级标记。
5. **会话可恢复**：每个工作批次都更新总进度、批次日志和接手摘要；新会话只需读取仓库中的固定入口即可恢复。

## 1. 项目事实来源优先级

遇到冲突时按以下顺序判断：

1. 用户当前会话明确提出的最新决定/授权；
2. 仓库当前 `main` 分支上的 `AGENTS.md` 与正式功能基线；
3. 当前模块最新已确认规范、实际源码、测试与部署配置；
4. 已提交的批次记录、进度日志、交接摘要；
5. 旧会话摘要与模型记忆；
6. AI 推断或建议。

高优先级与低优先级冲突时，保留冲突记录，不自行篡改已确认规则。生产环境真实状态必须由当前可验证证据确认，不能用仓库旧源码代替线上状态。

## 2. 工具调用可靠性流程

### 2.1 调用前预检

每次调用工具前先在内部核对：

- 工具是否真实存在、当前会话是否可用；必要时从工具目录/描述发现准确名称与参数结构。
- 调用目标是否正确（仓库、分支、文件路径、环境、资源 ID）。
- 参数类型、必填字段、枚举值、时间格式、路径格式是否符合工具 schema。
- 本次操作是读取、创建、更新、删除、执行还是部署；权限与用户授权是否足够。
- 是否有敏感信息会被发送、写入或输出。
- 是否可能产生不可逆副作用或重复执行副作用。
- 是否有必要先读当前版本/状态，建立前置快照。

任何关键参数不确定，先查工具定义或读取资源，不猜参数。

### 2.2 调用后校验

工具返回成功不等于业务结果成功。按操作类型校验：

| 操作类型 | 必须校验的结果 |
|---|---|
| 读取 | 返回目标正确、内容非空/未截断、版本与分支正确 |
| 创建文件 | 路径存在、内容可重新读取、长度/关键段正确、Commit 与 Blob SHA 记录 |
| 更新文件 | 写入前旧 SHA 已确认；写入后新 SHA 与内容复读一致 |
| 删除/移动 | 用户明确授权、目标与依赖复核、结果状态和回滚点 |
| 测试 | 命令、环境、输入、退出码、测试数量、失败数、日志证据 |
| 部署/生产操作 | 明确授权、目标环境核对、部署版本/结果、健康检查和回滚验证 |

### 2.3 失败分类与恢复策略

| 失败类型 | 首要动作 | 是否可直接重试 |
|---|---|---|
| 工具不存在/名称错误 | 重新发现工具及准确 schema | 否，先修正调用 |
| 参数验证失败 | 对照 schema 修正参数 | 仅修正后 |
| 权限/授权失败 | 停止，说明缺少权限或授权 | 否 |
| 限流/暂时不可用 | 保留错误与请求上下文，等待后重新确认状态 | 读取通常可重试；写入先查状态 |
| 超时/连接中断 | 检查操作是否已在远端完成 | 不得盲目重发写入 |
| 返回内容截断/格式异常 | 缩小读取范围或分批读取 | 校验后 |
| 文件已存在/并发冲突 | 重新读取当前文件和 SHA，做差异合并 | 不得覆盖 |
| 测试失败 | 保存完整错误、最小复现，修复后重跑相关及回归测试 | 不可把失败改写成通过 |
| 环境/依赖缺失 | 记录阻塞，使用已批准的替代验证方式 | 不得伪造运行结果 |
| 生产状态不明 | 停止生产操作，先只读核实 | 不可猜测执行 |

**重试规则：**
- 读取类调用可在确认无副作用后有限重试。
- 创建/更新类调用在超时后必须先检查目标路径和 Commit 历史。
- 删除、数据库迁移、密钥修改、部署等高风险操作不自动重试。
- 同一写操作应有明确批次 ID、目标路径和预期 SHA；不得在不确定时创建同名变体文件掩盖问题。
- 工具连续失败两次，停止同一路径盲目尝试，改用工具发现、缩小范围或标记阻塞。

### 2.4 防止“成功假象”

以下均不得作为成功证据：
- 只看到工具调用已发出；
- 只看到无错误文字但没有结果对象；
- 只看到 Commit SHA，没有重新读取文件；
- 只看到测试脚本存在，没有实际运行；
- 只看到本地 SQLite 测试通过，却宣称 D1 兼容；
- 只看到仓库源码，却宣称 Cloudflare 已部署；
- 只看到 UI 隐藏入口，却宣称服务端权限安全。

## 3. 跨会话接手标准流程

每次新会话开始，按顺序执行：

1. 读取仓库根 `AGENTS.md`。
2. 读取本方案。
3. 读取 `docs/星跃管理平台V2.5_功能基线与权限验收规范.md`。
4. 读取 `docs/星跃管理平台V2.5_开发进度与测试验收记录.md`。
5. 读取本方案第 8 节列出的最新会话接手卡。
6. 按当前任务读取对应模块规范、最近两批相关记录和实际源码/测试。
7. 重新检查 GitHub 当前分支、目标路径、最新 Commit 与 Blob SHA；不得默认上次会话后的仓库没有变化。
8. 把“已确认、已实现、已测试、已部署、受阻、待确认”分开列出。
9. 只继续接手卡中明确的下一步；若当前仓库状态与接手卡不一致，以当前仓库证据为准并先修订记录。

会话切换时必须保存接手卡，不要求用户重新解释已经存在于仓库中的规则。新会话不得只依赖模型记忆或聊天历史。

## 4. 统一状态模型

每个任务、文件、测试和发布必须使用以下状态之一：

- `NOT_STARTED`：未开始。
- `PLANNED`：已有方案，未实施。
- `IN_PROGRESS`：实施中。
- `BLOCKED`：受阻，必须写明阻塞和解除条件。
- `IMPLEMENTED_UNTESTED`：已写入/已编码，未完成测试。
- `TESTED_PASS`：测试已实际运行并通过，必须附证据。
- `TESTED_FAIL`：测试实际运行但失败。
- `REVIEWED`：独立复核完成，附复核人/检查项/证据。
- `DEPLOY_APPROVED`：已完成部署计划，等待用户授权。
- `DEPLOYED_VERIFIED`：用户授权后部署完成，并有目标环境验证证据。
- `ROLLED_BACK`：已回滚，附原因和验证。

不得把一个模块的通过状态套用到其他模块。例如本地 SQLite 测试通过，不代表 D1、Worker API、前端或 APP 已通过。

## 5. 每批交付记录模板（强制）

每个批次至少记录：

- 批次编号、项目版本、日期、负责人/执行 AI；
- 用户需求和授权范围；
- 开始时仓库分支、基线 Commit、相关文件 Blob SHA；
- 影响分析与不在本批范围内的内容；
- 计划文件清单和实际修改文件清单；
- 数据库/API/前端/APP/部署影响；
- 每次工具调用的关键目标、结果和错误（不得记录敏感参数）；
- 测试环境、依赖版本、命令、输入、退出码、通过/失败数量；
- GitHub Commit SHA、每个关键文件 Blob SHA、复读验证；
- 已完成、未完成、受阻、待确认事项；
- 回滚方法与风险；
- 下一批唯一明确的首要任务；
- 是否需要用户操作；若不需要，明确告知无需操作。

若某一项不适用，写“不适用”并说明原因，不留空白造成误解。

## 6. 统一总进度控制表

总进度必须以模块和可验收结果为单位，不以文档数量作为完成度。每批结束后更新：

| 模块 | 当前状态 | 已有证据 | 未完成/阻塞 | 下一步 |
|---|---|---|---|---|
| 项目基线/业务规则 | 已建立文档基线 | 功能基线、AGENTS、目录规范 | 仍需逐项对照实际源码 | 持续差距核查 |
| Worker 安全与 API | 设计/静态核查阶段 | API 契约、权限矩阵、修复计划 | 线上 Worker 状态未核实，尚未实现新修复 | 先只读核实与影响分析 |
| D1 迁移体系 | 本地验证器已编码；测试结果见第四十三批记录 | 本地 SQLite 20 项测试报告 | D1 兼容、生产 schema、锁/故障恢复未验证 | 独立复核本地工具与 D1 差异 |
| 通知中心 | 设计与本地 SQL 草案阶段 | 第三十八至四十三批文档/本地文件 | Worker API、事件 outbox、权限隔离、真实持久化 UI 未实现 | 完成接口实现计划和测试隔离 |
| 前端导航与体验 | 设计/静态差距核查阶段 | 第三十四至三十七批规范 | 真实 Worker/D1 接入和页面实现未完成 | 按统一导航分阶段实现 |
| 星跃 APP 对接 | 需求/架构设计与源码审计准备 | 双产品架构规范、审计工具 | APK ZIP 尚未审计完成，第三方限制未知 | 运行 APK Source ZIP Audit |
| 系统/APP 版本管理 | 设计阶段 | 第二十八、二十九、三十一批 | 发布路由和实际版本清单未实现 | 先完成版本 API 与发布模型实施计划 |
| 生产部署 | 未授权/未验证 | 两文件开发基线记录 | 生产 Worker、D1 binding/schema、线上哈希未核实 | 用户明确授权后才进入核查/部署流程 |
| 工具可靠性/会话连续性 | 本方案已建立 | 本文件、AGENTS、批次报告 | 自动化校验门禁和接手卡持续更新待落实 | 每批按本方案执行并更新进度 |

此表是阶段性状态，不是项目整体完成百分比。没有统一测试覆盖和真实部署验收前，不给出虚假的“项目完成 80%”等数字。

## 7. 风险与安全停机条件

遇到以下任一情况，停止相关实施并记录阻塞：

- 无法确认当前分支、目标文件或基线版本；
- 线上 Worker/D1 与仓库资料不一致或无法核实；
- 生产 D1 binding、数据库 ID、schema 或备份状态不明；
- 用户授权范围不清，或涉及生产数据/Secrets/部署但没有明确授权；
- 权限模型与功能基线冲突；
- 迁移脚本存在不可逆操作而无备份/回滚验证；
- 工具写入返回不确定结果且尚未复核；
- 测试失败或缺少必要测试环境；
- 敏感数据可能进入日志、仓库或公开输出；
- 交付包、ZIP/APK 二进制完整性无法验证。

安全停机不是项目失败。必须记录具体阻塞、已完成的安全工作、需要的证据和可继续的非生产任务。

## 8. 当前会话接手卡（2026-11-27）

### 当前项目位置

- 仓库：`sxna-web/XYmonihtml`
- 分支：`main`
- 最近已确认批次：第四十三批 `V2.5-DEV-B1-MIGRATION-IMPL-43`
- 第四十三批报告：`docs/backend/StarJump_V2.5_本地隔离数据库迁移验证器实施与测试报告_第四十三批_V2.5-DEV-B1-MIGRATION-IMPL-43_2026-11-27.md`
- 第四十三批报告 Blob SHA：`73822fae64e0c68a168f68938341cc8df1cb5aa9`
- 第四十三批 Commit SHA：`a3a5bc1b642d82f08f7db6f7231a650b2d7a3a82`

### 第四十三批已完成范围

- 新增本地 SQLite 迁移验证器、checksum、schema diff、CORE/NTF 本地 SQL、20 项测试和 README。
- 批次报告记录 Python 3.13.5、SQLite 3.46.1、20 项通过、退出码 0。
- 该测试结论只适用于本地 SQLite；不证明 D1 兼容。
- 没有修改 Worker、HTML、生产 D1、Secrets；没有部署。

### 当前明确阻塞

- 生产 Worker 当前线上源码/版本和用户最后部署文件的线上哈希未核实。
- 生产 D1 binding、ID、schema、外键和迁移账本未核实。
- D1 SQL/事务/并发语义未验证。
- APK 第三方源码审计工作流尚未取得运行报告。
- 通知 Worker API、事件 outbox、收件箱持久化和服务端权限隔离尚未实现。

### 下一批建议首要任务（第四十四批）

**先做独立复核，不立即接入生产：**
1. 复核第四十三批本地 runner 的安全边界、迁移账本行为、失败原子性、路径限制和 checksum。
2. 检查 CORE/NTF migration 是否存在重复定义、初始化顺序或测试盲点。
3. 增加静态安全测试与可复现报告；修复后重新运行完整本地测试。
4. 单独列出 SQLite 与 D1 语法/事务/锁语义差异，标记待 D1 隔离验证项。
5. 更新本方案的总进度表、批次日志和下一会话接手卡。
6. 只有独立复核通过后，再进入 Worker 通知接口的影响分析；仍不得操作生产 D1 或部署。

### 用户当前无需操作

本批为项目管理机制建立，不要求用户上传 Cloudflare、不要求手动 SQL、不要求提供密钥。只有未来 APK 审计需要用户手动触发 GitHub Actions 时，才在相关批次单独提醒。

## 9. 每次交付前最终核对清单

- [ ] 已读取当前 `AGENTS.md`、功能基线和模块规范。
- [ ] 已读取当前分支和目标文件最新版本。
- [ ] 需求、建议、授权范围区分清楚。
- [ ] 未修改未授权的生产环境、D1、Secrets 或部署。
- [ ] 工具调用失败已分类；不确定写入已复核，不盲目重试。
- [ ] 文件已复读并核对 SHA/长度/关键内容。
- [ ] 测试真实运行，记录命令、环境、退出码和结果；未运行的标为未测试。
- [ ] 更新批次记录和总进度表。
- [ ] 更新会话接手卡，写清下一步。
- [ ] 用户操作步骤简洁且确实必要。

## 10. 规则变更记录

- 2026-11-27 V1.0：建立工具调用预检/后检、失败分类、重试门禁、跨会话接手流程、统一状态模型、批次交付模板、总进度表、停机条件与当前接手卡。


## 11. 最新批次进度与会话接手卡更新（2026-11-27）

### 第四十四批状态

- 批次：`V2.5-DEV-B1-NOTIFY-WEB-44`
- 文档：`docs/backend/StarJump_V2.5_网页后端通知优先与邮箱双渠道权限设计_第四十四批_V2.5-DEV-B1-NOTIFY-WEB-44_2026-11-27.md`
- Commit：`ba2888c55ea296766315fb4f7c7c724ef4397d7f`
- 进度日志 Commit：`3757ddb3338fa2c77d3809e50a75a80855bff657`
- 状态：需求已纳入、架构/影响分析已完成；实现待后续批次。
- 用户最新决定：网页后端通知优先；有效 VIP 管理员一个网页收件箱+一个重要通知邮箱；超管一个网页收件箱+一个业务通知邮箱，并可在专用审计视图查看所有用户的网页通知与邮箱投递记录。
- 重要边界：超管全局审计读取与超管本人收件箱分开；不默认把所有用户每一封邮件都转发到超管邮箱。VIP 管理员按租户/资源授权隔离。普通用户先开网页通知，不默认开放邮箱。流量异常只有在真实计量源与阈值可用时才能触发。

### 总进度表修订

| 模块 | 当前状态 | 下一步 |
|---|---|---|
| 工具可靠性/会话连续性 | V1.0 总方案与强制接手规则已入库 | 每批持续更新 |
| 本地数据库迁移验证器 | 第四十三批 20/20 SQLite 测试报告；第四十四批静态复核发现两个实现细节问题 | 修正 CORE migration 执行路径和 schema diff changed_objects，补测试并实际运行 |
| 网页通知后端 | 用户需求已确认、第四十四批架构设计已提交 | 统一 schema/API/recipient policy，之后在隔离环境实现 |
| 邮箱通知 | 权限需求已确认、数据与安全架构已设计 | 供应商选择、Worker Secret 配置流程、邮箱验证和投递服务另阶段接入 |
| 节点/流量告警 | 事件类别已列入 | 先核实真实节点探测与流量计量来源；未接入不得生成异常通知 |
| 生产 D1/Worker | 未核实、未授权 | 只读核查完成且用户授权前不得迁移/部署 |

### 下一会话唯一首要任务（第四十五批）

1. 重新读取当前 main、AGENTS、第四十三/四十四批资料和迁移工具代码。
2. 修复 `runner.py` 对 CORE-MIG-001 的特殊跳过执行逻辑，使所有迁移统一通过 apply_one 事务执行；保留临时 SQLite 专用安全边界。
3. 修复 `schema_diff.compare_snapshots()`，增加同名对象 SQL 定义变更的 `changed_objects` 差异输出；保留 changed_tables 细节。
4. 增加针对 CORE SQL 执行、索引/视图/触发器同名定义变化、失败回滚和路径安全的测试。
5. 实际运行全套本地 SQLite 测试，记录环境、命令、退出码和结果。
6. 不连接 Cloudflare，不执行 D1，不改 Worker/HTML/Secrets，不部署。
7. 更新第四十五批报告、项目进度和本接手卡。
8. 之后才进入网页通知 schema 最终冻结与 Worker API 隔离实现计划。

用户无需重复说明邮箱通知权限，也无需在此批手动操作。邮箱供应商和真实流量数据源仍属待核查/待配置事项，不能由 AI 猜测。


### 第四十四批用户最新通知规则修订（2026-11-27）

第四十四批设计文档第 13 节为当前最新通知权限基线，覆盖旧矩阵：
- 注册用户：默认开通基础系统网页通知；仅本人可见；可提交反馈并查看本人反馈状态。
- VIP 管理员：在本人基础网页通知外，增加名下用户反馈通知；一个本人邮箱绑定用于重要业务和重要反馈提醒。
- 超级管理员：最高权限，网页端分为“下属用户通知/全局用户通知审计”和“本人业务通知”两个域；邮箱也分为两个独立绑定：下属用户通知邮箱、本人业务通知邮箱。
- 超管可查全体用户通知/反馈及相关投递记录，但不默认把每条普通用户通知逐封发送至下属用户通知邮箱；可按重要级别/事件规则订阅。
- 超管两邮箱独立验证、偏好、投递队列、状态和审计；VIP 管理员仅可查看本人管理范围内的反馈。
- 设计文档追加修订 Commit：`1def25e732ec209fb33d2daae9d561ab192bda51`。
- 项目进度日志补充 Commit：`eec9a1e946fdbd4f6b49335b49777104ce3918cb`。
- 当前仍为需求/架构设计，未实现或部署。

下一通知实现阶段必须先实现注册用户基础网页通知，然后 VIP 用户反馈收件箱与超管双域通知视图，邮箱后续按 VIP 单绑定、超管双绑定分阶段接入。


## 12. 第四十五批完成与第四十六批接手卡（2026-11-27）

### 第四十五批状态：TESTED_PASS / LOCAL-ONLY

- 批次：`V2.5-DEV-B1-MIGRATION-REVIEW-45`
- 报告：`docs/backend/StarJump_V2.5_本地迁移验证器独立复核修正与测试报告_第四十五批_V2.5-DEV-B1-MIGRATION-REVIEW-45_2026-11-27.md`
- 报告 Commit：`d5d11ff3bc49ece514551066c5f6335b1e124fb5`
- 进度记录 Commit：`4cc6ada63c35e89b12df168cb1a9835e30bcf929`
- 修复 CORE-MIG-001 bootstrap 执行路径；迁移 SQL 和账本 checksum insert 同一事务提交；事务内二次检查 checksum。
- schema diff 新增 changed_objects，可定位同名 index/view/trigger/table 定义变化。
- 父目录 symlink 加入拒绝测试。
- 测试环境 Python 3.13.5 / SQLite 3.46.1；24/24 tests passed，0 failed，exit code 0。
- Blob SHA：runner `ea969e0a9f13e43900c7e7aaf0c595221f1820cf`；schema_diff `b2458ebe0f0fe62afab53e37df4c3779d468efd4`；tests `8528552e054acdba84085b5cb61f112981c745c0`；README `58700ca03cd202328cde298f2750ff71a3f2354c`。
- 已提交后复读核对；本批未接 Cloudflare/D1，未改 Worker/HTML/Secrets，未部署。
- SQLite 结果不证明 D1 兼容；NTF-002 schema 仍是本地草案，收件人模型未冻结。

### 主线优先级修订

用户最新决定：通知/邮箱相关功能可以放后续，当前先推进项目主要进度，不让通知模块阻塞 V2.5 主线。此前确认的注册用户基础网页通知、VIP 用户反馈通知、超管双通知域/双邮箱规则保留，不回退、不丢失；暂不作为第四十六批实施内容。

### 总进度表（当前）

| 模块 | 状态 | 下一步 |
|---|---|---|
| 项目基线/业务规则 | 文档基线已建立 | 按现有源码逐项核对 |
| 本地数据库迁移工具 | 第四十五批 24/24 SQLite 测试通过 | 仍需 D1 隔离兼容验证；不得接生产 |
| Worker 安全与 API | 设计/静态核查阶段 | 第四十六批先只读盘点实际源码和 API |
| 核心身份/权限/卡密 | 需求基线已确认，实际实现差距待系统核查 | 盘点 Worker 路由、DB 表、权限校验与测试 |
| 转换与归档 | 需求基线已确认，真实实现映射待核 | 盘点前端调用、Worker 处理、归档表和失败恢复 |
| 节点/分组/分享 | 业务规则已确认，实际实现差距待核 | 盘点分享 API、owner 隔离、APP 对接和 24h 清理 |
| 前端导航与体验 | 设计/静态差距核查 | 核查实际 HTML/JS 后再按主线实施 |
| 通知中心/邮箱 | 权限与架构设计已记录，实施后置 | 主线稳定后再做网页通知和邮箱 |
| 星跃 APP 对接 | APK 第三方源码审计待运行 | 暂不阻塞核心后台主线 |
| 生产部署 | 未授权/未验证 | 不执行生产迁移或部署 |

### 第四十六批唯一首要任务

1. 重新读取当前 main 的 AGENTS、功能基线、目录规范、进度、第四十五批报告及相关 Worker/HTML/API/数据库文档。
2. 只读列出仓库内实际 Worker 源码、前端 HTML/JS、API 路由、数据库结构资料和测试文件；核对 SHA/当前版本。
3. 将实际代码按核心业务分组：身份/session/权限、VIP 生命周期、卡密、订阅转换、转换归档、节点/分组/分享、APP 对接、超管运维。
4. 每项只报告可由实际代码证实的状态：已实现、部分实现、未实现、实现但有风险、无法核实；不能用需求文档代替代码证据。
5. 形成核心主线差距矩阵，按安全风险、用户业务影响、依赖关系、实施风险排序，建议下一批最小可交付实现范围。
6. 不修改生产 Worker/D1/Secrets，不连接 Cloudflare，不部署；若要修改仓库代码，必须先完成只读差距核查和单独影响分析。
7. 更新进度与接手卡。

用户无需提供新的通知说明、邮箱或执行 SQL。当前也不要求用户在手机上做任何操作。


## 13. 第四十六批完成与第四十七批接手卡（2026-11-27）

### 第四十六批状态：REVIEWED / READ-ONLY

- 批次：`V2.5-DEV-B1-CORE-GAP-46`
- 报告：`docs/audits/StarJump_V2.5_核心业务源码差距盘点与实施优先级_第四十六批_V2.5-DEV-B1-CORE-GAP-46_2026-11-27.md`
- 报告 Commit：`57ac035c33d810e6b99d41e1463c999d9160567c`
- 进度记录 Commit：`15ede4ffa7f692fdf22012334fc4898312d348a3`
- 仓库 main 树：91 个 tracked blobs。
- 核对用户指定基线：Worker.js `5da7aa3582558d9da2c2a0ad25a63c5e95e9fe63`；index.html `ab98aecd4c8546eda197bbb4d5a9f5ec0db82613`。
- 已确认 1.4.61 HTML 为本地模拟版，没有 API fetch；不可误作正式后端接入版。
- 主要风险已登记：共享匿名 owner、固定密钥回退、APP status token、latest-only entitlement、APP 写接口 VIP 门禁、filters 权限、VIP 状态聚合、分组撤销/24h ack、迁移入口安全、HTML sync 路由和 staging 环境错配。
- 本批只读核查；未修改 Worker/HTML/D1/Secrets；未做线上测试；未部署。

### 用户最新主线决策

通知网页/邮箱、VIP 用户反馈和超管双通知域保留为后续需求；当前不实施，不阻塞核心后台进度。

### 第四十七批唯一首要任务

**建立身份/VIP 状态与动作级权限模型的可测试实现基础。**

1. 重新读取当前 AGENTS、功能基线、目录规范、总方案、进度、第四十六批报告及最新 Worker 源码 SHA。
2. 不直接修改原始 Worker；在 `backend/worker/` 下建立新版本修订副本，原件保留。
3. 先设计纯函数输入/输出：身份角色、当前有效 activation rows、时间、操作类型、资源创建时间/归属、协助会话 actor/effective/scope。
4. 明确决策规则：
   - L0：基础转换可用，高级 filters 不可用；
   - L1：按普通注册用户权益；
   - 有效 trial/formal：按用户已确认的有效 VIP 权益；
   - trial 到期：历史只读，不得删除；
   - formal 到期：历史可查看/删除，但不得创建/编辑/关联/生成新资源；
   - super_admin：独立最高角色，不依赖 VIP；
   - assist session：scope 与目标用户业务权限取交集，不能提升目标用户权限。
5. 纯函数和表驱动测试先覆盖状态边界、多 activation、时钟边界、查询 unavailable、资源创建时间、协助 scope。
6. 对 Worker 现有 vipStatus() 聚合缺陷给出向后兼容返回结构方案；不能简单以 MAX(ends_at) 和历史 is_formal 授权。
7. 之后将 helper 接入 APP groups/links/cards 的写操作前，逐个检查实际业务动作和到期历史数据规则；不一刀切封锁整个 API。
8. 本批不改 D1 schema、不调用生产 API、不运行迁移、不改 Secrets、不部署。
9. 实际运行 Node/兼容运行时单元测试，记录版本、命令、结果；更新进度和接手卡。

### 当前总进度摘要

| 模块 | 状态 | 下一步 |
|---|---|---|
| 工具可靠性 | 规范已建立，第四十五批 24/24 SQLite 通过 | 持续更新 |
| 本地迁移工具 | CORE bootstrap/schema diff 已修复 | D1 兼容仍待隔离验证 |
| 身份/VIP/权限 | Worker 有实现但存在状态聚合和动作门禁差距 | 第四十七批纯函数授权模型与测试 |
| 转换/归档 | Worker 有核心实现但匿名归属、密钥、filters、限流风险 | 后续第二阶段 |
| APP 授权/分组 | Worker 有路由但 token/多授权/删除清理/门禁风险 | 后续第三阶段 |
| 前端接入 | 原始 HTML 有 API 接入但路径/环境错配；1.4.61 为模拟版 | 随 Worker 修复同步调整 |
| 通知/邮箱 | 规则和架构已记录，用户决定后置 | 核心主线稳定后再实施 |
| 生产 D1/部署 | 未核实、未授权 | 禁止生产操作 |


## 14. 第四十七批完成与第四十八批接手卡（2026-11-27）

### 第四十七批状态：TESTED_PASS / NOT_INTEGRATED

- 批次：`V2.5-DEV-B1-CORE-AUTH-47`
- 报告：`docs/backend/StarJump_V2.5_身份VIP状态与动作级权限模型实施及测试报告_第四十七批_V2.5-DEV-B1-CORE-AUTH-47_2026-11-27.md`
- 报告 Commit：`4849a3b2b5f92a10109d8add61700d4d6e52cb98`
- 进度日志 Commit：`6d61b0c3994cf88bfed1d2c4281cd1d86eafb296`
- 新增隔离纯函数模型和 Node.js 测试；Node.js v22.16.0，26/26 passed，exit code 0。
- Blob SHA：authorization.mjs `6dc7ed5656bb3d2bcdd01674c2ee36d0db3863a5`；authorization.test.mjs `71369d5add228b8988f06a57635559b155f4cb9a`；README `bd6b12154c43a0d68c987caacdcb58a8d1c42302`。
- 状态边界包含 active_trial/formal、expired_trial/formal、pending、none、unavailable；formal 到期历史删除要求资源归属和创建时间截止；超管协助必须同时通过 scope 与目标 VIP 规则。
- 本批尚未接入 Worker；调用方认证、资源归属、tenant 隔离和审计仍未实现；未连接 D1/Cloudflare、未修改原始 Worker/HTML/Secrets、未部署。

### 第四十八批唯一首要任务

1. 重新读取当前 AGENTS、功能基线、第四十六/四十七批报告、当前 main 的原始 Worker/HTML Blob SHA。
2. 在独立版本目录复制用户指定的 Worker 基线，不覆盖原始 Worker；只修改版本化副本。
3. 核对 D1 激活表字段和现有查询语义（只依据仓库源码/文档，生产 schema 未核实要明确标注）。
4. 实现 Worker adapter：服务端从 Session 解析 actor/effective 身份；按 effective user 读取全部 activation rows；调用纯函数模型；资源归属必须由 SQL 条件验证。
5. 先接 APP 分组 POST/PUT/DELETE/sources/members、APP links POST/DELETE、APP cards POST/disable/DELETE 等操作；按操作细分，不得一刀切封锁 GET。
6. 对正式 VIP 到期历史删除，必须在同一查询中校验 owner/admin_user_id 与资源创建时间不晚于正式 VIP 截止；体验到期禁止删除；超管本人独立授权；协助会话同时检查 scope 和目标用户规则。
7. 建立 handler 级 mock tests：L1/体验有效/体验过期/正式有效/正式过期/超管本人/协助 scope/查询失败；每个拒绝分支断言 D1 mock 未调用任何写操作。
8. 真实 Worker runtime 测试条件不足时，标记未验证；不得把 Node helper 单测等同 Worker 集成通过。
9. 不改 D1 schema、不调用生产 API、不操作 Secrets、不部署。
10. 提交批次报告、更新进度和接手卡。

### 当前主线状态

| 模块 | 状态 | 下一步 |
|---|---|---|
| 本地迁移工具 | 第四十五批 24/24 SQLite 通过 | D1 兼容仍待隔离验证 |
| 核心业务差距 | 第四十六批只读审计完成 | 按风险推进 |
| 身份/VIP 权限模型 | 第四十七批纯函数 26/26 Node 测试通过 | 第四十八批接入 Worker adapter/handlers |
| 转换/匿名归属 | 已发现共享匿名 owner、固定密钥、filters/限流问题 | 权限门禁后续分批修复 |
| APP 授权/分组 | 已发现 status token、latest-only、写门禁、物理删除问题 | 先写门禁，再 entitlement/清理闭环 |
| 前端接入 | 原始 index.html API 路径与环境错配 | Worker 接口稳定后修正 |
| 通知/邮箱 | 用户决定后置，需求已留档 | 核心主线完成后再做 |
| 生产环境 | 线上版本与 D1 schema 未核实 | 不操作、不部署 |


## 15. 第四十八批完成与第四十九批接手卡（2026-11-27）

### 第四十八批状态：IMPLEMENTED / CI_TESTED / HANDLER_INTEGRATION_PENDING

- 批次：`V2.5-DEV-B1-CORE-AUTH-48`
- 报告：`docs/backend/StarJump_V2.5_Worker_APP管理写接口VIP门禁接入与测试报告_第四十八批_V2.5-DEV-B1-CORE-AUTH-48_2026-11-27.md`
- 报告 Commit：`1a8981de9ab2ddfa08ef9b60f640d860d2e18e3a`
- 版本 Worker：`backend/worker/V2.5-DEV-B1-CORE-AUTH-48/Worker.js`，Blob SHA `bf04ef31bbd75777263d0dc8b3108da62a852668`。
- adapter：`worker-auth-adapter.mjs`，Blob SHA `17cb6b04267555b9774cf0665384d43a3dec3cb1`。
- tests：`worker-auth-adapter.test.mjs`，Blob SHA `f4999ab485c1a89f42bfa833041b4b1e4a00bc06`。
- 新增 CI：`.github/workflows/worker-auth48-tests.yml`。
- GitHub Actions Run ID：`45953635805`；Node.js v22.23.5；Worker ESM syntax check、adapter syntax check通过；12/12 adapter mock tests passed，0 failed。
- 原始 Worker/HTML Blob SHA 复核未变：Worker `5da7aa3582558d9da2c2a0ad25a63c5e95e9fe63`；HTML `ab98aecd4c8546eda197bbb4d5a9f5ec0db82613`。
- 已接入 APP 分组、APP links、APP cards 的指定用户态写操作。GET 不受 VIP 写门禁影响；身份来自服务端 Session；VIP activation rows 按 effective user 全量读取；正式到期历史删除在最终 DELETE SQL 同时限定 owner 与 created_at cutoff。
- 仅仓库原 Worker DDL 显示的字段得到静态确认；生产 D1 schema 未核实。
- 测试边界：adapter mock tests 不等同 Worker handler/D1 集成测试；通用 assist-scope 拒绝分支的审计写入未由本批 mock 覆盖；Cloudflare Workers runtime 未验证。
- 未修改 D1 schema/数据、Secrets、原始 Worker/HTML；未连接生产 Cloudflare/D1；未部署。
- APP 分组物理删除与 24 小时 tombstone/cleanup acknowledgement 尚未解决；本版本不可部署。

### 当前总进度摘要

| 模块 | 当前状态 | 下一步 |
|---|---|---|
| 项目基线/业务规则 | 已建立并持续维护 | 按批次更新 |
| 本地迁移工具 | 第四十五批 24/24 SQLite 测试通过 | D1 隔离兼容仍待验证 |
| 核心身份/VIP 权限 | 第四十七批 helper 26/26；第四十八批 Worker 副本接入，CI 12/12 adapter tests | 第四十九批 handler 级隔离集成测试 |
| APP 管理写接口 | adapter 已接入版本 Worker 副本 | 验证真实 handler、对象归属、失败恢复 |
| 转换/匿名归属 | 共享匿名 owner、固定密钥、filters/限流风险已登记 | 后续独立修复 |
| APP entitlement/多授权 | token/status/latest-only 风险已登记 | 写门禁稳定后继续 |
| APP 分组撤销 | 仍为物理删除，无 24h ack 闭环 | 单独设计 tombstone/generation/ack |
| 前端接入 | 原始 HTML API 路径/环境错配已登记 | Worker API 稳定后调整 |
| 通知/邮箱 | 用户决定后置 | 核心主线完成后再做 |
| 生产 D1/部署 | 未核实、未授权 | 不操作、不部署 |

### 第四十九批唯一首要任务

**建立隔离 Worker handler 测试环境，完成 APP 管理路由端到端权限回归。**

1. 先重读当前 main、AGENTS、功能基线、本方案、开发进度、第四十八批报告和版本 Worker。
2. 核对最新 Worker/adapter/tests Blob SHA；不可沿用旧 SHA。
3. 在不连接生产 D1 的条件下，建立可复现的 Worker handler 测试夹具；优先使用 Cloudflare Workers 兼容运行时或明确说明 Node mock 的覆盖边界。
4. 覆盖 L1、active_trial、expired_trial、active_formal、expired_formal、direct super、assist scope、activation 查询失败。
5. 对分组 POST/PUT/DELETE/sources/members、links POST/DELETE、cards POST/DELETE/disable 逐路由验证。
6. 对拒绝分支区分 Session last_seen、拒绝审计等维护写与业务数据写；证明拒绝不会产生未授权业务数据变更。不得把 mock helper 单测说成 handler 集成测试。
7. 复核正式 VIP 到期删除的最终 SQL owner + created_at cutoff；检查 D1 mock 的 meta.changes 语义和并发边界。
8. 评估分组物理删除多条 SQL 的失败恢复与关联残留；本批不擅自改 D1 schema。
9. 不连接生产 D1、不运行迁移、不读取/修改 Secrets、不部署。
10. 更新第四十九批报告、开发进度和下一批接手卡。

**部署闸门：**第四十八批 Worker 副本目前不是正式发布包。必须先完成第四十九批 handler 级验证、独立安全复核、回滚/兼容性检查，再决定后续是否形成候选部署包；用户未明确授权前不得部署。


## 16. 第四十九批完成与第五十批接手卡（2026-11-27）

### 第四十九批状态：CI_TESTED / WORKER_FETCH_HANDLER_MOCK_PASS / D1_RUNTIME_PENDING

- 批次：`V2.5-DEV-B1-CORE-AUTH-49`
- 报告：`docs/backend/StarJump_V2.5_Worker_APP管理路由对象归属加固与Handler集成测试报告_第四十九批_V2.5-DEV-B1-CORE-AUTH-49_2026-11-27.md`
- 报告 Commit：`e77228f22dac3e1e8e880a0758adce963a7a9440`
- 版本 Worker：`backend/worker/V2.5-DEV-B1-CORE-AUTH-49/Worker.js`，Blob SHA `a4689380215e95c1c9f605fc974cc553b3e7037f`。
- adapter：`worker-auth-adapter.mjs`，Blob SHA `2f91941c68082a44d5e23e1e25b416ae2901e0f0`。
- adapter tests：`worker-auth-adapter.test.mjs`，Blob SHA `86e226e1a14c00359f7e23ce08913830f1435814`。
- handler tests：`worker-handler.integration.test.mjs`，Blob SHA `d0303a2ed5a9e84d938fb95b9d46711444050abd`。
- README：`e3b124c9e9977b4eba57fabcb08ac7fb0c943928`。
- CI Workflow：`.github/workflows/worker-auth49-tests.yml`；Run ID `45954203952`；Node.js v22.23.5；Worker ESM syntax、adapter syntax均通过；adapter tests 12/12、Worker.fetch handler tests 12/12，均 0 failed。
- handler tests 实际调用版本 Worker `fetch()` 入口并使用 mock D1；这比纯函数测试更接近路由，但不等于 Cloudflare Workers runtime 或真实 D1 集成。
- 已加固 APP 分组 PUT、sources POST、members POST 最终 SQL 的 owner predicates；正式 VIP 到期历史删除仍在最终 DELETE SQL 限定 owner + created_at cutoff。
- 路由复核更正：members/:deviceId DELETE 属于超管分组 handler，不是用户态 APP 分组 handler；adapter 不再错误映射为用户态动作。
- 本批只改版本化 Worker 副本和测试/文档；未改 D1 schema/数据、Secrets、原始 Worker/HTML；未连接生产 Cloudflare/D1；未部署。
- 未完成：APP links/cards handler 级测试；分组多语句删除失败恢复；tombstone/generation/24h cleanup acknowledgement；APP status token 与多 entitlement latest-only 风险。
- 第四十八批版本目录保留原始快照，第四十九批单独版本化，避免覆盖历史交付。

### 当前总进度摘要

| 模块 | 当前状态 | 下一步 |
|---|---|---|
| 项目基线/业务规则 | 已建立并持续维护 | 按批次更新 |
| 本地迁移工具 | 第四十五批 24/24 SQLite 测试通过 | D1 隔离兼容仍待验证 |
| 核心身份/VIP 权限 | 第四十七批 helper 26/26；第四十八批 adapter 12/12；第四十九批 Worker.fetch handler 12/12 | 扩展所有 APP 管理路由集成测试 |
| APP 分组权限 | POST/PUT/DELETE/sources/members POST 门禁接入；PUT/关联 SQL owner 条件已加固 | 并发、批量写和失败恢复验证 |
| APP links/cards | adapter 动作门禁已接入 | 第五十批补 handler 级测试 |
| APP entitlement | status token、多授权 latest-only 风险已登记 | 后续独立修复 |
| APP 分组撤销 | 仍为物理删除，无 24h ack 闭环 | 设计 tombstone/generation/ack |
| 转换/匿名归属 | 共享匿名 owner、固定密钥、filters/限流风险已登记 | 后续独立修复 |
| 前端接入 | 原始 HTML API 路径/环境错配已登记 | Worker API 稳定后调整 |
| 通知/邮箱 | 用户决定后置 | 核心主线完成后再做 |
| 生产 D1/部署 | 未核实、未授权 | 不操作、不部署 |

### 第五十批唯一首要任务

**补齐 APP links 与 APP cards 的 Worker handler 级权限回归，并复核全部 APP 管理写路由。**

1. 重读当前 main、AGENTS、功能基线、本方案、开发进度、第四十八/四十九批报告和第四十九批 Worker。
2. 核对当前 main Blob SHA；不使用旧路径/旧 SHA。
3. 通过实际 Worker.fetch + mock D1 测试 links POST/DELETE、cards POST/DELETE/disable；覆盖有效/过期 trial/formal、L1、direct super、assist scope、VIP 查询失败和跨用户资源 ID。
4. 对分组 sources/members、links、cards 所有写路径逐项检查最终 SQL 是否包含 owner/admin_user_id 条件；不能只靠前置 SELECT。
5. 检查 `userBatch`、D1 `batch()`、审计语句的执行和失败语义；断言拒绝请求不会改变业务表，审计/Session 心跳等维护写必须单独分类。
6. 核查 links DELETE 的 owner/cutoff 原子条件；cards DELETE 是软停用，不得误当历史物理删除。
7. 不连接生产 D1、不执行迁移、不读取/修改 Secrets、不部署。
8. 更新第五十批报告、开发进度和下一批接手卡。

**部署闸门：**第四十九批仍不可部署。需完成 APP links/cards handler 测试、完整 APP 管理 API 独立复核、Worker runtime 兼容验证、回滚和 D1 兼容评估后，才可形成候选发布包；用户明确授权前不部署。


## 17. 第五十批完成与第五十一批接手卡（2026-11-27）

### 第五十批状态：CI_TESTED / APP_LINKS_CARDS_HANDLER_MOCK_PASS

- 批次：`V2.5-DEV-B1-CORE-AUTH-50`
- 报告：`docs/backend/StarJump_V2.5_APP入口与卡密管理Handler权限回归报告_第五十批_V2.5-DEV-B1-CORE-AUTH-50_2026-11-27.md`
- 报告 Commit：`b1b56c0003d351273d81f01c21a580daf70ff690`
- 测试文件：`backend/worker/V2.5-DEV-B1-CORE-AUTH-50/app-links-cards-handler.test.mjs`，Blob SHA `4a59fd2c5cb1f2f63ff23042799f775069407fd1`。
- README：Blob SHA `410173b28941710cc961707bbac8d068785fcf6a`。
- 被测 Worker：第四十九批 `Worker.js`，Blob SHA `a4689380215e95c1c9f605fc974cc553b3e7037f`。
- CI Workflow：`.github/workflows/worker-auth50-tests.yml`；Run ID `45954510215`；Node.js v22.23.5；Worker ESM syntax、adapter syntax均通过；adapter tests 12/12、APP group handler tests 12/12、APP links/cards handler tests 12/12，全部 0 failed。
- handler 测试调用实际版本 Worker `fetch()` 入口，使用 mock D1；不等于 Cloudflare Workers runtime 或真实 D1 集成。
- 确认 APP card DELETE 是软停用，按 disable 授权；正式 VIP 到期不允许继续停用。APP links 历史删除最终 SQL 限定 owner + created_at cutoff。
- 本批无 Worker 业务代码改动；未修改 D1 schema/数据、Secrets、原始 Worker/HTML；未连接生产 Cloudflare/D1；未部署。
- 第四十八/四十九/五十批的版本目录和测试目录分别保留，未覆盖历史版本。

### 当前总进度摘要

| 模块 | 当前状态 | 下一步 |
|---|---|---|
| 项目基线/业务规则 | 已建立并持续维护 | 按批次更新 |
| 本地迁移工具 | 第四十五批 24/24 SQLite 测试通过 | D1 隔离兼容仍待验证 |
| 核心身份/VIP 权限 | 第四十七批 helper 26/26；第四十八批 adapter 12/12；第四十九批 Worker group handler 12/12；第五十批全套 CI 36/36 | 进入 APP entitlement 授权链路审计 |
| APP 分组/入口/卡密写门禁 | adapter 和 mock handler 测试通过；分组 owner SQL 已加固 | 完整独立安全复核、真实 D1/runtime 验证 |
| APP entitlement | status token、多管理员 latest-only、token query 风险已登记 | 第五十一批只读核查与测试设计 |
| APP 分组撤销 | 仍为物理删除，无 24h ack 闭环 | 设计 tombstone/generation/ack |
| 转换/匿名归属 | 共享匿名 owner、固定密钥、filters/限流风险已登记 | 后续独立修复 |
| 前端接入 | 原始 HTML API 路径/环境错配已登记 | Worker API 稳定后调整 |
| 通知/邮箱 | 用户决定后置 | 核心主线完成后再做 |
| 生产 D1/部署 | 未核实、未授权 | 不操作、不部署 |

### 第五十一批唯一首要任务

**只读核查 APP entitlement token 与多管理员授权隔离链路，并建立可复现测试设计。**

1. 重读当前 main、AGENTS、功能基线、本方案、开发进度、第四十六批差距报告及第四十九/五十批报告。
2. 重新核对第四十九批 Worker 当前 SHA；不假定线上 Cloudflare 与仓库源码一致。
3. 逐一追踪 `/api/app/status`、`/api/app/nodes`、`/api/app/groups`、`/api/app/links` 的 token 提取、验证、设备绑定、entitlement 选择和 owner 隔离。
4. 重点确认 status 是否只凭 device_id、是否校验 token；groups/nodes/links 是否 latest-only；token 是否仍放 URL query；多个管理员授权能否独立呈现。
5. 对照 APK 源码可读性和客户端请求协议；ZIP 尚未成功解包前，不假设客户端支持 header token 或多授权实例。
6. 先形成兼容方案和测试矩阵；不改变 APP 客户端协议，不修改 D1 schema，不删除旧 token 路径。
7. 不连接生产 D1、不调用生产 API、不读取/修改 Secrets、不部署。
8. 更新第五十一批报告、开发进度和下一批接手卡。

**部署闸门：**第四十九批 Worker 仍不可部署。必须完成 entitlement/status token 安全、APP 客户端兼容、真实 D1/runtime 验证和独立复核后，才能形成候选部署包；用户明确授权前不部署。


## 第五十一批完成与第五十二批接手卡（2026-11-27）

### 第五十一批状态：STATIC_AUDIT_COMPLETE / TEST_DESIGN_COMPLETE / NOT_IMPLEMENTED

- 批次：`V2.5-DEV-B1-APP-TOKEN-51`
- 报告：`docs/audits/StarJump_V2.5_APP授权Token与多管理员隔离只读审计_第五十一批_V2.5-DEV-B1-APP-TOKEN-51_2026-11-27.md`
- 报告 Commit：`e0c1e7749fbaa513484c5225aaac52054eb17937`
- Worker 基线：第四十九批版本，Blob SHA `a4689380215e95c1c9f605fc974cc553b3e7037f`。
- 核心发现：status 缺 Token 校验；groups 免费 grant 分支只按 device_id；free 允许 admin ID/share code 直接取节点；Token HMAC Secret 固定回退；nodes/groups/links latest-only；Token 通过 URL query；nodes 未按 APP 分组实际授权范围过滤。
- 多管理员原则：每份 entitlement 独立验证、独立管理员数据范围；不能把多个管理员来源无边界合并。
- APK ZIP 尚未解包，旧客户端实际协议未核实；不能贸然移除 query Token 或更改响应结构。
- 本批未修改 Worker/HTML/D1/Secrets/APK；未访问生产 D1/Cloudflare；未部署。

### 第五十二批唯一首要任务

**建立 APP entitlement 精确选择与多授权 Handler 测试基础。**

1. 重读 AGENTS、功能基线、进度、总方案、第五十一批报告及第四十九/五十批代码。
2. 在新版本目录建立 exact entitlement resolver；使用明确 entitlement_id + device_id + Token 验证，不隐式选择最新授权。
3. 建立 Worker.fetch + mock D1 Handler 测试：同设备两管理员两份授权分别成功，且只能读取各自管理员数据。
4. 覆盖 status 缺 Token、free grant 仅凭 device_id、share code 直接读取节点、Token/entitlement/device 错配、过期/撤销、查询失败等拒绝分支。
5. 节点和分组返回必须限制在对应 entitlement 的 APP 分组/来源授权范围；与 Token 认证分开验证。
6. APP HMAC Secret 固定回退需设计 fail-closed 与旧 Token 兼容；不操作生产 Secret，不在无迁移方案时令旧 Token 全失效。
7. query Token→Header 迁移保持待 APK 源码确认，不得宣称旧 APK 兼容。
8. 不改 D1 schema、不调用生产 API、不操作 Secrets、不部署。
9. 完成后更新批次报告、进度和第五十三批接手卡。



## 第五十二批完成与第五十三批接手卡（2026-11-27）

### 第五十二批状态：HELPER_IMPLEMENTED / CI_PASSED / NOT_INTEGRATED / NOT_DEPLOYABLE

- 批次：`V2.5-DEV-B1-APP-TOKEN-52`
- 报告：`docs/backend/StarJump_V2.5_APP精确授权解析器与多授权隔离测试报告_第五十二批_V2.5-DEV-B1-APP-TOKEN-52_2026-11-27.md`
- 报告 Commit：`ce818b307769b0d5b6b44b8d6a0d12deec1ee9d4`
- 新增独立 helper：`backend/worker/V2.5-DEV-B1-APP-TOKEN-52/entitlement-resolver.mjs`；按 entitlement_id + device_id 精确选择，不取最新记录；服务端返回 admin_user_id；检查状态、时间和 Token；异常 fail closed。
- CI Run `45955817050` completed/success；语法检查和 resolver 测试步骤成功；测试文件有 14 个用例。
- 本批没有接入现有 Worker，未修改 APK 协议、D1、Secrets、HTML；未访问生产 Cloudflare/D1；未部署。
- status/free grant/share code/nodes 授权范围等旧 Worker 风险仍存在，不能误报修复。

### 第五十三批唯一首要任务

**APP 读取接口认证边界与分组数据范围的隔离 Handler 验证。**

1. 重读 AGENTS、功能基线、API 规范、总方案、进度、第五十一/五十二批报告。
2. 检查第五十二批 resolver 与 CI 结果，保留历史版本。
3. 在新版本目录建立只读 APP read-handler 测试 harness，覆盖 status、groups、free、links、nodes。
4. 每个接口测试无 Token、错误 Token、entitlement/device 错配、同设备两个管理员授权、过期/撤销、D1 异常。
5. 明确 free share code 的绑定入口与受保护节点数据读取边界；无可信设备凭证不得下发受保护节点数据。
6. 对 nodes/groups 建立 APP 分组/来源授权范围测试；真实关联字段未核实前，不改生产 SQL。
7. 不改变 APK 请求协议，不接入旧 Worker，不改 D1 schema，不操作 Secrets，不部署。
8. APK 源码继续标记未解包；不得宣称 Header Token 或多授权客户端兼容。
9. 完成后更新批次报告、进度和第五十四批接手卡。



## 第五十三批完成与第五十四批接手卡（2026-11-27）

### 第五十三批状态：POLICY_HELPER_IMPLEMENTED / CI_PASSED / NOT_INTEGRATED / NOT_DEPLOYABLE

- 批次：`V2.5-DEV-B1-APP-READ-53`
- 报告：`docs/backend/StarJump_V2.5_APP读取接口认证边界与分组范围隔离策略测试报告_第五十三批_V2.5-DEV-B1-APP-READ-53_2026-11-27.md`
- 报告 Commit：`ebe08239f56674c916d9a4c155e7d32c88344023`
- 新增隔离策略 helper：`backend/worker/V2.5-DEV-B1-APP-READ-53/read-access-policy.mjs`，复用第五十二批精确 entitlement resolver；free share-code 只作为绑定入口，不授予节点/分组读取；分组范围 predicate 同时验证管理员归属和显式 groupId allowlist。
- CI Run `45956257572` completed/success；Node 22 语法检查和 23 项 mock policy tests 通过。
- 本批未接入 Worker handler；未修改 Worker/HTML/D1/Secrets/APK；未访问生产环境；未部署。
- 旧 Worker 的 status/free/groups/nodes/links 风险仍未修复；不得把策略 helper 的测试通过等同于实际接口安全修复。

### 第五十四批唯一首要任务

**APP 读取接口与分组授权关系的源码/数据契约核实及最小接入方案。**

1. 重读 AGENTS、功能基线、API 规范、目录规范、总方案、进度和第五十一至五十三批报告。
2. 只读核对仓库内 DDL/migrations 与 Worker APP SQL，明确 app_entitlements、app_groups、app_group_sources、app_group_members、app_free_grants、admin_share_codes 字段和关系；不推断生产 D1。
3. 检查是否存在卡密到分组授权关联表/字段，不预设名称。
4. 明确 entitlement 与 public/assigned/free 分组可见规则的关联方式；卡密分组必须按卡密管理员及配置组范围过滤。
5. 输出 status/groups/free/links/nodes 最小兼容接入方案、响应结构影响、APK 协议风险。
6. 若关联字段证据充分，可在新版本 Worker 副本实施单一读取 handler 并 Worker.fetch + mock D1 测试；否则明确阻塞，不编造 SQL。
7. 不改 D1 schema、不访问生产、不操作 Secrets、不部署；不擅自修改 APK query Token 协议。
8. 完成后更新报告、进度、总方案与第五十五批接手卡。



## 第五十四批核查结论与第五十五批接手卡（2026-11-27）

### 第五十四批状态：CONTRACT_REVIEWED / CARD_GROUP_RELATION_MISSING / IMPLEMENTATION_BLOCKED / NOT_DEPLOYABLE

- 批次：`V2.5-DEV-B1-APP-SCHEMA-54`
- 报告：`docs/backend/StarJump_V2.5_APP卡密分组授权关系与读取接口数据契约核查报告_第五十四批_V2.5-DEV-B1-APP-SCHEMA-54_2026-11-27.md`
- 报告 Commit：`cf678ae37ecf5ee2a4d341b376769dafdb551492`
- 第四十九批 Worker 内嵌 DDL 证明 app_entitlements.card_id 关联 app_cards，但没有 card_id → group_id 的卡密专属分组关联；app_group_members 仅按设备，app_free_grants 是管理员维度永久免费资格；public/free/assigned 均不能替代卡密专属配置。
- 当前 /api/app/nodes 按管理员全来源下发，绕过 APP 分组；/api/app/groups 以最新 entitlement 取管理员 public/free/assigned 分组；/api/app/free 可直接返回免费节点数据。
- 本批仅源码和数据契约静态核查；无业务代码改动、无代码测试；未连接 D1/Cloudflare，未改 Worker/HTML/Secrets/APK，未部署。
- 建议方向：新增 card-group 关联模型（需用户批准后才可形成正式 migration），读取时以 entitlement.card_id + admin_user_id 精确校验卡密/分组归属；节点接口必须受同一分组 allowlist 约束。

### 第五十五批唯一首要任务

**APP 卡密分组配置管理接口与管理端调用链只读盘点，形成端到端实施规格。**

1. 重读 AGENTS、功能基线、总方案、进度、API 契约和第五十一至五十四批报告。
2. 只读追踪管理端 HTML 的 APP 卡密创建/编辑/列表、APP 分组管理、分组来源配置、分享入口页面和 API 调用。
3. 核对第四十九批 Worker app_cards、app_groups、super/user APP group routes、权限门禁与审计路径。
4. 确认卡密批量生成/编辑接口能力；不得擅自新增字段。
5. 设计卡密绑定多个分组的后台交互、服务端接口、审计、有效 VIP 修改权限、到期只读边界和旧版兼容。
6. 输出关联表 migration 草案与回滚/数据兼容方案，但不创建正式 migration、不连接 D1、不执行 SQL。
7. APK 仍标记 APK_PENDING；不修改客户端协议。
8. 完成后更新报告、进度、总方案与第五十六批接手卡。



## 第五十五批完成与第五十六批接手卡（2026-11-27）

### 第五十五批状态：ADMIN_FLOW_AUDITED / END_TO_END_SPEC_DRAFTED / NOT_IMPLEMENTED / NOT_DEPLOYABLE

- 批次：`V2.5-DEV-B1-APP-CARD-UI-55`
- 报告：`docs/backend/StarJump_V2.5_APP卡密分组管理端调用链与端到端实施规格_第五十五批_V2.5-DEV-B1-APP-CARD-UI-55_2026-11-27.md`
- 报告 Commit：`b579a4b39b3c8d0990d48d6590336d3bf572c63b`
- HTML 1.4.61 的 APP 卡密分组配置是本地模拟 DB 操作，入口属于 masterOnly 且 requireMaster；没有真实 Worker API 调用。管理员 APP 分组 UI 也仍写入本地模拟数据。
- 第四十九批 Worker 已有卡密列表/批量生成/停用/事件接口和用户 APP 分组 CRUD/来源/设备成员接口；但没有 card-group mapping API/表。卡密生成只接受 count/days，卡密列表未返回 groupIds。
- 推荐端到端提案：新增 GET/PUT /api/user/app-cards/:cardId/groups 与 app_card_groups(card_id,group_id)，服务端逐项验证 effectiveId、卡密/分组归属、card 类型、enabled 和 VIP 状态；APP 读取按 entitlement.card_id 限定组及节点来源。
- 未冻结边界：空分组卡密激活策略、public/free/assigned 与 card 专属组叠加、同卡密多设备激活、激活后改组生效时机、APK 请求/响应协议。
- 本批未修改 HTML/Worker/D1/Secrets/APK，无代码测试，未访问生产、未部署。

### 第五十六批唯一首要任务

**APP 卡密分组授权业务规则冻结与兼容矩阵。**

1. 重读 AGENTS、功能基线、API 规范、总方案、进度和第五十四/五十五批报告。
2. 对照历史需求记录，核实卡密独立用户 ID、多设备激活、空分组、激活后修改、VIP 到期、免费组叠加等边界。
3. 只读核对 APK 源码 ZIP 是否在仓库或 Library 可用；不可取得二进制则明确 APK_PENDING，不推测协议。
4. 形成卡密状态 × entitlement 状态 × VIP 状态 × 分组类型 × 设备身份矩阵。
5. 冻结旧 APP API 兼容策略、card group 响应字段、generation/24 小时清理端到端协议。
6. 关键业务冲突仅列最少必要确认项；不擅自创建 migration 或接入 Worker。
7. 完成后更新进度、总方案和第五十七批接手卡。



## 第五十六批完成与第五十七批接手卡（2026-11-27）

### 第五十六批状态：RULES_AUDITED / SOURCE_READ_ONLY_AUDIT_DONE / APP_PENDING / NOT_IMPLEMENTED / NOT_DEPLOYABLE

- 批次：`V2.5-DEV-B1-APP-RULES-56`
- 报告：`docs/backend/StarJump_V2.5_APP卡密分组授权业务规则冻结与旧客户端兼容矩阵_第五十六批_V2.5-DEV-B1-APP-RULES-56_2026-11-27.md`
- 报告 Commit：`298ba34295d413e48073ae59dab191408e52e640`
- Library 找到并解包 `StarJump-6.00.47-source.zip`（2,377,487 bytes，SHA-256 `5a45da3d6e6e42a6aabf776336fdfff8424af0e9c7d756a8fea17f882459f7ab`）。源码有 Room 本地分组和普通订阅刷新，但未发现当前 Worker entitlement/card/device API、card group mapping、generation/tombstone/ack 协议实现。
- 源码根目录 `STARJUMP-BACKEND-AND-MEMBERSHIP-SPEC.md` 仅是待实现 API 设计，不是已接入证据。6.00.48 ZIP 在仓库树中存在但二进制未读取。不能把 X Android wrapper 的 app-debug.apk 误认成星跃 APP。
- 已核实用户规则：一个 APP 用户可绑定多个管理员，同一管理员一条绑定；管理员 ID 仅免费组；卡密取得该卡密配置的全部 card 组 + 符合条件的管理员 free 组；卡密组数量不限；卡密自身过期不回收已取得的管理员免费资格；管理员 VIP 到期不撤销已激活卡密/已生效链接；未激活卡密有 3 天宽限，之后只将 admin_vip_expired 自动失活者在续费后恢复；分组删除/改型立即停止下发并在 24 小时内清理失效节点。
- public/assigned 不默认叠加到卡密专属组。未确认项：同一卡密设备数量上限、空分组卡密激活策略、激活后改组是否追溯所有已激活设备、宽限精确边界。
- 未改业务代码、未跑代码测试、未构建/安装 APK、未连接生产 D1/Cloudflare/Secrets、未部署。

### 第五十七批唯一首要任务

**APP 授权协议与 24 小时分组清理技术设计（不改客户端/不改生产）。**

1. 重读 AGENTS、功能基线、API 规范、总方案、进度、第五十四至五十六批报告。
2. 形成 Worker API v2 契约、精确 entitlement resolver 调用图、card/free group 查询 SQL 草案。
3. 设计 generation/tombstone/lease/ack 状态机，覆盖离线 24 小时边界。
4. 明确多管理员、多卡密、多设备隔离模型；未确认的设备上限/空分组/改组追溯边界不擅自设值。
5. 对照 6.00.47 源码给出最小客户端接入点（网络层、Room 分组映射、GroupUpdater/GroupManager 生命周期），不修改 APK。
6. 继续标记 APK_PENDING；6.00.48 ZIP 尚未解包。
7. 输出测试矩阵、兼容策略、回滚计划；不创建正式 migration、不连接生产 D1、不部署。
8. 更新进度、总方案和第五十八批接手卡。

## 第五十七批完成与第五十八批接手卡（2026-11-27）

### 第五十七批状态：DESIGN_COMPLETE / BUSINESS_RULES_FROZEN / NOT_IMPLEMENTED

- 版本：`V2.5-DEV-B1-APP-PROTOCOL-57`
- 报告：`docs/backend/StarJump_V2.5_APP授权协议与24小时分组清理技术设计_第五十七批_V2.5-DEV-B1-APP-PROTOCOL-57_2026-11-27.md`
- 报告 Commit：`833615e2348097d056e359d78067f4bc64fe94c3`
- 用户已冻结：卡密默认 1 台设备；有效 VIP 管理员可调整至 5 台；超过 5 台需超管。允许空分组卡密激活；身份 ID 取管理员 free 组，卡密取其 card 组 + 符合条件的 free 组。卡密分组变更同步影响全部仍有效已激活设备。
- 完成 API v2 契约、精确 entitlement resolver 调用图、card/free 查询 SQL 草案、设备上限原子占额设计、多管理员隔离模型、generation/tombstone/lease/ack 状态机、离线 24h 约束、6.00.47 客户端接入点、测试矩阵、兼容与回滚方案。
- 重要安全规则：空 card 组不扩大成管理员全量组；public/assigned 不默认叠加；服务端变更提交后立即停止下发；离线设备租约到期 fail closed；不同 entitlement 独立 cursor/cache/ack。
- 未改 Worker/HTML/APK/D1/Secrets；未创建 migration；未连接生产 D1/Cloudflare；未跑代码测试/Gradle/真机测试；未部署。
- APP 状态继续 APK_PENDING：6.00.47 仅作结构参考；6.00.48 ZIP 尚未解包，第三方源码限制未知。
- 当前 APP 授权 helper（第五十二/五十三批）仍未接入真实 Worker handler；新 API v2 仍为设计契约。

### 第五十八批唯一首要任务

**APP v2 授权协议静态实现准备与隔离测试骨架（不接生产、不部署）。**

1. 重读 AGENTS、功能基线、API 规范、数据库保护规范、总方案、进度和第五十七批报告。
2. 只读核对第五十二/五十三批 helper 与测试文件，确认可复用边界。
3. 设计隔离 Worker v2 handler 模块和 mock D1 fixtures，不接入原始生产 Worker。
4. 实现并实际测试纯函数：设备上限策略、card/free group allowlist、generation 单调性、tombstone/ack 幂等、lease 截止判断。
5. 对 SQL 做静态契约测试，确保节点查询必须限制 allowed_group_ids 并二次验证 owner/source。
6. APK 6.00.48 未解包前继续标记 APP_PENDING，不改 APK。
7. 不创建正式 migration、不连接生产 D1、不修改 Secrets、不部署。
8. 完成后更新进度、总方案和第五十九批接手卡；没有实际运行的测试不得标记通过。


## 第五十八批完成与第五十九批接手卡（2026-11-27）

### 第五十八批：隔离 APP v2 授权实现与测试骨架

- 版本：`V2.5-DEV-B1-APP-PROTOCOL-58`
- 报告：`docs/backend/StarJump_V2.5_APP_v2授权隔离实现与测试骨架报告_第五十八批_V2.5-DEV-B1-APP-PROTOCOL-58_2026-11-27.md`
- 报告 Commit：`855a6fd69ce6c4a4835dad4f4e5c0ebd20424a04`
- CI Run：`45960847230`，Node 22 语法检查通过，36/36 tests 通过。
- 隔离实现包含设备数策略、card/free allowlist、owner guard、generation/tombstone/ack/lease、SQL query contract、注入式 v2 read-handler scaffold、mock D1 fixture。
- 本批未接入现有 Worker、未核验生产 D1、未创建正式 migration、未修改 HTML/APK/Secrets、未连接生产 Cloudflare、未部署。
- 真实 D1 原子占额、持久化 sync event、Android 本地删除/ack、离线租约真机测试仍未实现。APK_PENDING；6.00.48 源码和第三方限制未审计。

### 第五十九批唯一首要任务

**APP v2 隔离集成测试与原子设备占额模型验证（不接生产、不部署）。**

1. 重读 AGENTS、功能基线、API 规范、数据库结构与变更保护规范、总方案、进度、第五十七/五十八批报告。
2. 复核第五十八批 handler 与 36 项测试，补充伪造 entitlement、跨设备/管理员、恶意 group rows、乱序 ack、lease 到期边界反例。
3. 为设备占额设计 D1 原子更新/事务适配器；只在 mock 或本地隔离 SQLite/兼容测试库验证并发语义，不触碰生产 D1。
4. 为 card/free group loader 设计依赖注入 adapter，验证 owner/card/group 三方一致性及空组规则。
5. 核对 nodes 查询绑定参数顺序、SQL owner 条件和来源审批字段，字段需有版本源码/隔离 schema 证据。
6. 评估 resolver、read policy 与 v2 scaffold 的最小接入边界，不修改现有 Worker handler。
7. 如能取得 6.00.48 ZIP 二进制，单独做只读源码/第三方授权审计；ZIP 元数据不等于源码审计完成。
8. 不创建正式 migration、不连接生产 D1、不修改 Secrets、不部署。
9. 实际运行全部测试后更新进度、总方案和第六十批接手卡。


## 第五十九批记录与第六十批接手卡（2026-11-27）

- 批次：V2.5-DEV-B1-APP-PROTOCOL-59
- 范围：多卡密 entitlement 分组组合、同管理员免费分组去重、同名分组序列号标识、card/free loader owner 复核、条件单语句设备占额、handler 与 sync 反例测试。
- 本地结果：Node 16/16 passed；SQLite 并发 3/3 passed；GitHub Actions Run 45963909988 completed/success（第五十八批 36/36、第五十九批 16/16、SQLite 3/3）。
- 设备模型：单条条件 INSERT...SELECT + (card_id, device_id) 唯一键；仅完成本地 SQLite 并发模型验证。不得将其视为 Cloudflare D1 已验证。
- 生产保护：未访问 Cloudflare/生产 D1，未建 migration，未改 Worker/HTML/APK/Secrets，未部署。
- 当前状态：隔离 DEV 已编码；CI_PASSED；NOT_INTEGRATED；NOT_DEPLOYABLE。
- 风险：真实 schema、slot 回填、设备释放策略、D1 并发语义和 APK serial label 协议仍待验证。

### 第六十批唯一接手卡

APP v2 D1 兼容验证准备与 6.00.48 源码只读审计（不接生产、不部署）。检查本批 CI；复核重复 entitlement/group ID/name/free 去重；设计 slot migration/backfill/release 但不创建正式 migration；如有明确隔离 D1 才验证并发；只读审计 6.00.48 ZIP 与第三方授权；保持 APK_PENDING；不接入 Worker、不部署。


## 第六十批阶段记录（2026-11-27）

- V2.5-DEV-B1-APP-PROTOCOL-60：隔离代码与回归测试完成；CI_PASSED（Run 45965260408，Node 71/71、SQLite 3/3）；D1_NOT_TESTED；APK_6.00.48_NOT_AUDITED；NOT_INTEGRATED；NOT_DEPLOYABLE。
- 新版 group composition 拒绝重复 entitlement、额外 loader 结果、同 entitlement 重复 card group；同名序列号只在同管理员内追加；输出采用字段白名单投影。
- 设备 slot schema/backfill/release 仅为设计提案，没有 migration。未找到可确认的隔离 D1，不用生产或 staging 替代。
- Library 仅有 6.00.47；GitHub tree 确认 6.00.48 ZIP 存在但二进制无法读取，不能宣称完成源码/第三方许可审计。
- 第六十一批：继续设备 slot 生命周期与客户端授权协议对照；如有可读取 6.00.48 ZIP 再审计；不接生产、不部署。


## 13. 第六十一批进度与第六十二批接手卡（2026-11-27）

### 第六十一批状态

- 版本：`V2.5-DEV-B1-APP-PROTOCOL-61`
- 报告：`docs/backend/StarJump_V2.5_APP_v2设备占额生命周期与6.00.47客户端映射对照报告_第六十一批_V2.5-DEV-B1-APP-PROTOCOL-61_2026-11-27.md`
- CI Run：`45966848333` completed/success；Node 22 语法检查通过，10/10 tests passed，0 failed。
- 第六十批 CI Run `45965260408` 已读取完整 job log，确认 Node 71/71、SQLite 3/3，0 失败。
- 第六十一批新增 slot lifecycle 纯函数：规范化 backfill 计划、同卡同设备去重、超限存量 grandfather、设备解绑审批门禁、卡密过期/撤销 hold 及续期/VIP 状态不自动释放。
- 卡密过期/撤销是否释放容量、设备解绑审批人范围仍是待用户确认业务规则；当前 helper 仅表达保守提案，不接入线上。
- 6.00.47 Room 数据映射已重新核对：本地 group numeric id + node groupId；没有 entitlement/admin/card/generation/lease/cursor/ack 映射；Room version 7 存在 destructive migration fallback 风险。
- Library 仍没有 6.00.48 可读取副本，第三方授权和客户端协议审计继续受阻，APP_PENDING。
- 没有隔离 D1 可用，D1_NOT_TESTED；未创建 migration；未修改 Worker/HTML/APK/Secrets；未连接生产或 staging；未部署。

### APP v2 当前总体状态（按验收层级）

| 层级 | 状态 | 说明 |
|---|---|---|
| 业务规则与 API v2 设计 | 已形成设计/部分冻结 | 需保留待确认业务项 |
| 隔离 helper 与 mock/纯函数测试 | 多批 CI 通过 | 仍未接入现有 Worker |
| 真实 Worker 集成 | 未实施 | 原始两文件 Worker 基线未改 |
| D1 schema / migration / 并发 | 未验证 | 没有经确认的隔离 D1；生产禁止擅动 |
| 6.00.48 第三方源码审计 | 受阻 | 没有可读取 ZIP 二进制副本 |
| Android Room/API v2 实施 | 未实施 | 6.00.47 只有结构参考，且 destructive fallback 必须先处理 |
| APK 构建/真机在线离线测试 | 未实施 | 仍为 APK_PENDING |
| 部署 | 未授权/未执行 | 不可部署 |

### 第六十二批唯一首要任务

**APP v2 设备槽位策略确认准备与隔离 D1 可用性核查（不部署）。**

1. 重读 AGENTS、功能基线、API、D1 保护规范、总方案、进度和第五十七至六十一批报告。
2. 复核第六十一批 CI Run 45966848333 与 backfill helper 边界；失败先修复。
3. 只读核查是否出现 6.00.48 可读取文件；无则保持 APK_PENDING。
4. 继续列出设备释放策略最少确认项；“过期/撤销先 hold”仅为安全提案，不冻结为硬规则。
5. 若出现明确隔离 D1，先只读核对 schema 并生成 backfill dry-run 冲突报告；否则仅完善 fixture/冲突报告测试，不接生产或 staging。
6. 继续评估 resolver、group loader、group composition、slot adapter 接入 Worker 的最小影响方案；不修改原始 Worker。
7. 更新总进度和第六十三批接手卡；不创建正式 migration、不改 HTML/APK/Secrets、不部署。


## 14. 第六十二批进度与第六十三批接手卡（2026-11-27）

### 第六十二批状态

- 版本：`V2.5-DEV-B1-APP-PROTOCOL-62`
- 报告：`docs/backend/StarJump_V2.5_APP_v2回填冲突报告与隔离D1可用性核查_第六十二批_V2.5-DEV-B1-APP-PROTOCOL-62_2026-11-27.md`
- CI Run：`45967697304` completed/success；Node 22 语法检查通过，5/5 tests passed，0 failed。
- 当前 main tree 180 entries，未截断；没有 Wrangler 配置或可核实的 APP v2 隔离 D1 binding/database ID。未将生产或 staging 当作隔离测试目标。
- 新增脱敏 backfill dry-run 报告器；只接受规范化输入，不执行 SQL；报告不输出 deviceKey/entitlementId，固定标注 schema UNVERIFIED、sqlExecuted=false、migrationCreated=false、approvalRequired=true。
- Library 仍只有 6.00.47，6.00.48 无可读取副本，APP_PENDING。
- 设备过期/撤销释放和解绑审批人仍待用户确认；保守 hold 仅为提案。
- 未连接 D1、未创建 migration、未修改 Worker/HTML/APK/Secrets、未部署。

### APP v2 当前状态补充

| 项目 | 当前状态 |
|---|---|
| 槽位生命周期纯函数 | 已编码、CI 通过；未接入 |
| Backfill 冲突 dry-run 报告器 | 已编码、CI 通过；无真实数据输入 |
| 隔离 D1 兼容/并发 | 未验证；未发现明确隔离 binding |
| 6.00.48 第三方源码审计 | 受阻；二进制不可读取 |
| Worker v2 实际路由接入 | 未实施 |
| APK Room/API v2 | 未实施；6.00.47 显示 destructive migration 风险 |
| 真实 APP 联调/部署 | 未进行 |

### 第六十三批唯一首要任务

**APP v2 真实 Worker 接入前置差距与最小集成边界审查（继续隔离，不部署）。**

1. 重读 AGENTS、功能基线、API、D1 保护规范、总方案、进度及第五十一至六十二批相关报告。
2. 复核第六十二批 CI Run 45967697304、脱敏输出与 backfill planner 组合边界。
3. 对照用户指定的原始 Worker/HTML 两份基准文件，绘制旧 APP 路由、鉴权、卡密/分组/节点查询与新 resolver/loader/composition/slot helper 的逐路由差距矩阵；只读，不改原始文件。
4. 明确旧 API 的 fail-closed 边界和兼容窗口；6.00.48 未审计前不得宣称 Header Token 或多 entitlement 客户端兼容。
5. 形成最小 Worker 集成文件布局、适配器接口、feature flag 与回滚顺序；不接入生产 Worker。
6. 槽位释放/解绑审批未确认项继续保留，不擅自冻结。
7. 若无 6.00.48 ZIP 与隔离 D1，保持 APK_PENDING / D1_NOT_TESTED；不创建 migration、不操作 Secrets、不部署。
8. 更新总进度和第六十四批接手卡。


## 15. 第六十三批进度与第六十四批接手卡（2026-11-27）

### 第六十三批状态

- 版本：`V2.5-DEV-B1-APP-PROTOCOL-63`
- 报告：`docs/backend/StarJump_V2.5_APP_v2真实Worker接口差距与最小集成边界审查_第六十三批_V2.5-DEV-B1-APP-PROTOCOL-63_2026-11-27.md`
- CI Run `45970232967` completed/success；Node 22 语法检查通过，6/6 tests passed，0 failed。首次 Run `45970083786` 因测试预期计数写错失败，修正后重跑通过，失败历史保留。
- 原始 Worker 与 HTML 1.4.61 已按 blob SHA 复核。HTML 1.4.61 不含 `/api/`、fetch、XHR、Authorization/Bearer 调用，仍是本地模拟界面。
- 16 项旧 APP/管理路由矩阵已形成。关键缺陷包括：status 无 Token；nodes/groups/links 取 latest entitlement；nodes 越过卡密分组范围；free 公开链路直接下发节点；缺 card_id-group_id 关联；管理端卡密/分组写操作未见有效 VIP gate；HMAC 固定 fallback；batch58 handler 混淆 Session Token 与 entitlement Token。
- v2 建议采用新增 namespace + 默认关闭 flags，exact resolver -> group loader -> composition -> slot adapter；不直接改写旧路由。
- 未连接 D1、未执行 SQL、未创建 migration；未改 Worker/HTML/APK/Secrets；未部署。线上两文件版本未读取，不能由仓库文件推断线上。
- 6.00.48 未审计，APP_PENDING。

### 第六十四批唯一首要任务

**APP v2 entitlement Token 认证适配器与精确读取 Handler（隔离编码 + mock 测试，不接 Worker）。**

1. 重读 AGENTS、功能基线、API/D1 保护规范、总方案、进度及第五十一至六十三批报告。
2. 修正第五十八批 handler 的 Session/entitlement token 语义冲突；建立独立 adapter：显式 entitlementId + deviceId + HMAC Token -> 第五十二批 resolver。
3. Secret 缺失、Token 验证失败、entitlement 过期、device 绑定不匹配、D1 异常统一 fail closed。
4. groups/nodes/links/status 只允许使用解析出的 entitlement context；客户端 adminId 不得成为查询依据。
5. 加入精确 entitlement 请求、同设备多 entitlement、不允许 latest fallback、跨管理员隔离、空分组和异常状态测试。
6. 保留 legacy API 不变；不接入生产 Worker，不改 HTML/APK/D1/Secrets，不部署。
7. 若 6.00.48 或隔离 D1 仍不可用，继续记录 APK_PENDING/D1_NOT_TESTED，不虚报联调完成。
8. 更新进度、总方案和第六十五批接手卡。




## 16. 第六十四批结果与第六十五批接手卡（2026-11-27）

### 第六十四批结果

- 版本：`V2.5-DEV-B1-APP-PROTOCOL-64`
- 报告：`docs/backend/StarJump_V2.5_APP_v2_entitlementToken认证适配器与精确读取Handler报告_第六十四批_V2.5-DEV-B1-APP-PROTOCOL-64_2026-11-27.md`
- 最终 CI Run `45973150016` completed/success；Node 22 语法检查通过，23/23 tests passed，0 failed。首次 Run `45972711669` 失败记录保留；修正后 Run `45972878003` 通过，verifier 缓存优化后的最终 Run 再次通过。
- 新增独立 entitlement HMAC adapter：只读专用 `APP_ENTITLEMENT_SECRET`，无密钥 fail closed，不回退 SESSION_PEPPER/固定默认密钥；HMAC 输入为源码观察到的 `entitlementId|deviceId`，输出 base64url。
- 新增精确读取 handler：显式 entitlementId + X-App-Device-ID + Bearer entitlement Token；不再调用 Session resolver；status/groups/nodes/links 全部使用第五十二批 resolver 返回的 entitlement context；节点和链接受 owner/group allowlist 二次检查；空 allowlist 不执行节点查询。
- 第五十八批历史文件保留未覆盖；本批仅新增隔离替代实现。所有 loader 仍是注入依赖，尚未形成真实 D1 SQL 集成。
- 未接入现有 Worker；未连接 D1/Cloudflare；未执行 SQL/创建 migration；未修改 HTML/APK/Secrets；未部署。6.00.48 未审计，APP_PENDING；隔离 D1 不存在/未核实，D1_NOT_TESTED。

### APP v2 当前状态（第六十四批后）

| 层级 | 状态 | 说明 |
|---|---|---|
| 精确 entitlement resolver | 隔离 helper 已编码并有测试 | 未接入 Worker |
| entitlement HMAC adapter | 隔离实现已编码，23/23 CI 通过 | 专用 APP_ENTITLEMENT_SECRET 未配置；未验证 Cloudflare Workers runtime |
| groups/nodes/links/status Handler | mock D1 测试通过 | loader 仍注入；未核实真实 SQL/schema |
| group loader/composition | 既有隔离 helper 多批通过 | 尚未组合进本批 handler 的真实数据路径 |
| Worker v2 实际路由接入 | 未实施 | legacy Worker 未改 |
| D1 schema/migration/并发 | 未验证 | D1_NOT_TESTED |
| 6.00.48 第三方源码审计 | 受阻 | APK_PENDING |
| Android Room/API v2 与真机测试 | 未实施 | 6.00.47 只能作为结构参考 |
| 生产部署 | 未授权/未执行 | 不可部署 |

### 第六十五批唯一首要任务

**APP v2 group loader / card-free scope 与 Handler 组合集成测试（继续隔离，不接 Worker）。**

1. 重读 AGENTS、功能基线、API/D1 保护规范、总方案、进度及第五十一至六十四批报告。
2. 复核第六十四批最终 CI Run `45973150016` 和最终文件 SHA。
3. 对照第五十九/六十批 group loader、composition、projection helper，建立第六十五批 adapter，将每个 entitlement 的 card groups 与管理员 free group 精确组合。
4. 覆盖同一管理员多卡密免费组只一份、同名 card group 追加序列号、不同管理员免费组隔离、空卡密分组、重复 entitlement/group ID fail closed。
5. 读取接口继续显式 entitlement context；不得引入 latest fallback 或客户端 adminId 查询。
6. 若 loader 所需 schema 字段仍未在真实隔离 D1 核实，只做 mock contract 测试并标记 D1_NOT_TESTED；不得编造生产 SQL 或 migration。
7. 不修改 Worker/HTML/APK/D1/Secrets，不连接生产/staging，不部署。
8. 更新进度、总方案和第六十六批接手卡。




## 17. 第六十五批结果与第六十六批接手卡（2026-11-27）

### 第六十五批结果

- 版本：`V2.5-DEV-B1-APP-PROTOCOL-65`
- 报告：`docs/backend/StarJump_V2.5_APP_v2多卡密分组组合与精确授权Handler集成报告_第六十五批_V2.5-DEV-B1-APP-PROTOCOL-65_2026-11-27.md`
- 最终 CI Run `45976476574` completed/success；Node 22 语法检查通过，26/26 tests passed，0 failed。首次 Run `45975792137` 因测试括号语法错误失败，保留历史；后续修正并补充端到端/分类器/响应最小化测试后最终通过。
- 新增隔离多 entitlement 组合 service 与 POST Handler：每个 entitlement ID + device ID + Token 单独解析；同一请求全部 credential 必须有效；不使用 latest fallback；请求体不放 URL，限制 32 KiB / 20 份凭证，响应 no-store。
- 分组组合复用第五十九/六十批 loader/composition 契约：同管理员免费组按 ID 去重、不同管理员隔离、同名卡密组追加服务端序列号、空卡密组不扩大范围；最小响应不输出 cardId/entitlementId/卡密原文/任意 DB 列。
- 强制注入服务端 entitlement 分类器。已观察的旧 entitlement schema 未证明存在 kind 字段，因此禁止从客户端推断或把 kind 当作已存在数据库列；CARD 分类还必须与已解析 entitlement.card_id 一致。
- IDENTITY 服务层测试仅验证抽象组合契约；实际身份 ID/share-code resolver 尚未实现，不能宣称真实身份 ID 免费组链路已接通。
- 新 endpoint 未注册 Worker；所有 resolver/classifier/loader/serial label 都是注入依赖，真实 D1 SQL 尚未实现。未连接 D1、未执行 SQL/创建 migration、未改 Worker/HTML/APK/Room/Secrets、未部署。D1_NOT_TESTED；APP_PENDING。

### APP v2 当前状态（第六十五批后）

| 层级 | 状态 | 说明 |
|---|---|---|
| 精确 entitlement resolver / Token adapter | 隔离实现、23/23 CI 通过 | 未接入 Worker；Secret 未配置 |
| 单 entitlement groups/nodes/links/status handler | mock 测试通过 | loaders 仍注入，真实 D1 未核实 |
| 多 entitlement 分组组合 service | 隔离实现、26/26 CI 通过 | 逐份 Token 精确解析；无 latest fallback |
| composed groups HTTP handler | 隔离实现、端到端 mock 通过 | 未注册 Worker 路由；客户端未验证 |
| entitlement kind 分类 | 强制 server-side adapter 接口 | 现有 schema 是否有分类字段未证实 |
| IDENTITY 免费组 resolver | 未完成 | 身份 ID/share-code 只能作为发现/绑定，不得直接授权读取 |
| D1 schema/SQL/migration/并发 | 未验证 | D1_NOT_TESTED |
| 6.00.48 第三方源码与客户端兼容 | 受阻 | APP_PENDING |
| Android Room/API v2 与真机测试 | 未实施 | 6.00.47 仅为结构参考 |
| 生产部署 | 未授权/未执行 | 不可部署 |

### 第六十六批唯一首要任务

**APP v2 身份 ID 免费组发现/绑定 resolver 与卡密 entitlement 组合边界审查（隔离设计 + mock 测试，不接 Worker）。**

1. 重读 AGENTS、功能基线、API/D1 保护规范、总方案、进度及第五十一至六十五批报告。
2. 只读核对原始 Worker 的 `/api/app/resolve`、`/api/app/free`、`admin_share_codes`、`app_free_grants`、`admin_app_perms` 实际调用链和数据边界。
3. 明确身份 ID/share code 只负责发现/绑定，不能仅凭公开 ID 读取节点/分组；必须有服务端绑定状态、设备绑定、限流/防枚举和管理员授权检查。
4. 设计独立 IDENTITY credential resolver；不把 identity ID 当 entitlement ID，不复用卡密 HMAC 语义，除非存在可信服务端签发凭证方案。
5. mock 覆盖同管理员免费组只一份、不同管理员隔离、重复绑定幂等、禁用免费组拒绝、share code 轮换/撤销、跨设备/跨管理员拒绝。
6. 不读取或泄露真实 share code、卡密、Token；不执行 SQL、不创建 migration。
7. 不修改 Worker/HTML/APK/D1/Secrets，不接生产路由、不部署。
8. 更新进度、总方案和第六十七批接手卡。




## 18. 第六十六批结果与第六十七批接手卡（2026-11-27）

### 第六十六批结果

- 版本：`V2.5-DEV-B1-APP-IDENTITY-66`
- 报告：`docs/backend/StarJump_V2.5_APP_v2身份ID免费组发现绑定Resolver与多卡密组合审查_第六十六批_V2.5-DEV-B1-APP-IDENTITY-66_2026-11-27.md`
- 最终 CI Run `45978198685` completed/success；Node 22 语法检查通过，23/23 tests passed，0 failed。早期失败 Run 保留，最终以该 Run 为准。
- 原始 Worker 只读审计确认：公开 `/api/app/resolve` 通过 share code 返回管理员 ID/name/free flag，没有设备绑定/challenge/token/rate-limit；`/api/app/free` 可凭 admin ID 或 code 直接返回免费节点；`admin_share_codes` 旧 DDL 没有 version/revocation 字段；`app_free_grants` 是卡密 redeem 产生的 device/admin 免费资格，不是身份 ID 绑定记录；旧 free route 未见有效 VIP 状态检查。
- 新增独立 identity Token adapter 和 binding service：APP_IDENTITY_SECRET 单独签发 Token，claims 绑定 binding/admin/device/device-key thumbprint/iat/exp；最大 TTL 23 小时；每次受保护读取都要验证绑定记录、当前 VIP/账号/free 开关，以及新的 request nonce + 设备私钥签名证明。
- share code 只做发现/绑定；公开发现响应不泄露 admin ID/token/node；绑定按 admin+device 幂等；多管理员分别绑定；同管理员身份免费组去重；不同管理员隔离；与第六十五批卡密 free group 组合时按 admin+group ID 去重，卡密专属组保留。
- 轮换/撤销策略当前是 DEV 提案：旧 code 不能新绑定，轮换不自动删除既有 binding；单独 revoke binding、free switch 关闭或管理员失去有效资格后拒绝读取。此策略生产前需用户确认。
- 重要阻塞：旧 share-code DDL 没有 codeVersion/revocation，未发现 identity binding/challenge/nonce 表；durable rate limit、challenge/nonce 原子消费、binding upsert 必须后续由持久化 adapter 实现。Android Keystore/每请求签名兼容未审计 6.00.48。
- 所有持久化和权限依赖仍是注入接口；没有真实 D1 SQL。未接入 Worker，未改 HTML/APK/Room/D1/Secrets，未部署。D1_NOT_TESTED；APP_PENDING。

### APP v2 状态矩阵（第六十六批后）

| 层级 | 状态 | 说明 |
|---|---|---|
| 精确 entitlement Token / 单授权读取 | 隔离实现，23/23 测试 | 未接 Worker；D1 loader 注入 |
| 多卡密 group composition | 隔离实现，26/26 测试 | 未接 Worker；D1 loader 注入 |
| Identity discovery/binding service | 隔离实现，23/23 测试 | challenge/binding/rate-limit adapter 注入 |
| Identity HMAC credential | 隔离实现 | APP_IDENTITY_SECRET 未配置；不可复用 entitlement/session secret |
| 每次身份读取设备私钥证明 | mock contract 通过 | Android Keystore/6.00.48 未审计 |
| Share-code version/revocation persistence | 未实施 | 原始旧 DDL 无相关字段 |
| Identity binding/challenge/nonce persistence | 未实施 | 未发现相关表；无 D1 migration |
| IDENTITY + CARD free-group composition | 隔离 helper 测试通过 | 不代表生产 API 接通 |
| 真实 D1 / Workers runtime / Android 联调 | 未测试 | D1_NOT_TESTED / APP_PENDING |
| 生产部署 | 未授权/未执行 | 不可部署 |

### 第六十七批唯一首要任务

**APP v2 identity challenge / nonce / binding 持久化状态机与并发契约测试（隔离实现，不接 D1、不接 Worker）。**

1. 重读 AGENTS、功能基线、API/D1 保护规范、总方案、进度及第五十一至六十六批报告。
2. 为 bind challenge、每次 request nonce、identity binding 和 share-code version 设计状态机及最小数据契约；区分现有字段与新增设计字段。
3. 建立 mock durable-store adapter，验证 challenge 单次消费、nonce 防重放、绑定唯一约束、并发重复 bind 幂等、撤销与轮换竞态、过期清理。
4. 验证多个 Worker 并发/重试下不能重复消费 challenge/nonce 或创建重复绑定；不能只依赖单实例内存锁。
5. 对照第六十六批 service 接口，输出后续 D1 adapter 契约和迁移前只读核查清单。
6. 真实 D1 schema 未核实前，不生成可执行 migration，不执行 SQL。
7. 不修改 Worker/HTML/APK/Room/D1/Secrets，不接生产路由、不部署。
8. 更新进度、总方案和第六十八批接手卡。


---

## 第六十七批连续性更新（2026-11-27）

- 版本：`V2.5-DEV-B1-APP-IDENTITY-67`；报告见 `docs/backend/StarJump_V2.5_APP_v2身份绑定挑战Nonce持久化状态机与并发契约测试报告_第六十七批_V2.5-DEV-B1-APP-IDENTITY-67_2026-11-27.md`。
- CI Run `45978995116` completed/success，Node 22.23.5，14/14 tests passed，0 failed；https://github.com/sxna-web/XYmonihtml/actions/runs/45978995116
- 隔离状态机契约覆盖 challenge 单次消费、nonce 防重放、binding 唯一幂等/撤销、share-code version CAS 轮换及 transient cleanup。所有 store 方法仍是注入接口；mock Map 不等于 D1/多 Worker 原子性证明。
- 未连接 D1，未执行 SQL/创建 migration，未改 Worker/HTML/APK/Room/Secrets，未注册路由，未部署。D1_NOT_TESTED / APP_PENDING / 不可部署。
- 免费分组仍以管理员身份免费授权为当前优先规则；特殊免费分组卡密是冲突时的条件性备选，不得提前替换当前模型。

### 第六十八批唯一接手卡

**APP v2 身份持久化 adapter 与真实 schema 前置差距核查（只读 + SQL 契约设计，不执行 SQL、不接 Worker）。**

1. 重读 AGENTS、功能基线、API/D1 保护规范、总方案、进度及第五十一至六十七批 APP 报告。
2. 复核 Run `45978995116` 和第六十六批接口。
3. 只读检查仓库 Worker/D1 schema 来源、迁移目录、绑定配置；不得将原始 Worker DDL 当线上 schema。
4. 映射 8 个 store 方法到 SQLite/D1 条件更新、唯一约束、事务及冲突语义，标注现有/未知/新增字段。
5. 评估 D1 原子性和需隔离环境验证的部分；不生成 migration、不执行 SQL。
6. 不接 Worker、不改 HTML/APK/Room/Secrets、不连接生产/staging、不部署。
7. 免费分组特殊卡密仍为条件性备选。
8. 更新进度、总方案和第六十九批接手卡。


---

## 第六十八批连续性更新（2026-11-27）

- 版本：`V2.5-DEV-B1-APP-IDENTITY-68`；报告见 `docs/backend/StarJump_V2.5_APP_v2身份持久化Adapter与真实D1Schema前置差距核查报告_第六十八批_V2.5-DEV-B1-APP-IDENTITY-68_2026-11-27.md`。
- 只读检查原始 Worker 与 CORE-AUTH-49 DDL：legacy `admin_share_codes` 仅 admin_user_id/code/created_at；`app_free_grants` 是 device/admin free grant，不是 identity binding；未见 identity challenge/nonce/binding 表。
- 当前仓库未找到 Wrangler 配置或 APP v2 专用隔离 D1 binding/database ID；本地 migration runner 明确只允许 disposable temp SQLite，不是 D1 runner；仓库可见 migrations 是 CORE/NTF，没有 APP identity migration。不能据此推断 Cloudflare Dashboard 当前线上配置。
- 新增 `backend/worker/V2.5-DEV-B1-APP-IDENTITY-68/D1-ADAPTER-CONTRACT.md`，将 8 个 store 方法映射为参数化 SQL、条件 UPDATE、UNIQUE、CAS、bounded cleanup；明确不可使用 read-then-write/INSERT OR REPLACE/Worker 内存锁。
- Cloudflare 官方 D1 文档：`prepare().bind()` 参数化 SQL；`batch()` 顺序事务批次，失败回滚；此为平台能力，不是本项目真实 D1 验证。D1_NOT_TESTED。
- 本批没有运行代码/D1 测试；未连接 D1，未执行 SQL/创建 migration，未修改 Worker/HTML/APK/Room/Secrets，未部署。APP_PENDING；不可部署。
- 免费分组仍优先管理员身份授权；特殊免费分组卡密仅为冲突时条件性备选。

### 第六十九批唯一接手卡

**APP v2 D1 adapter 的隔离可执行性验证计划与 SQL 语义测试设计（不接生产、不部署）。**

1. 重读 AGENTS、功能基线、API/D1 保护规范、总方案、进度和第五十一至六十八批报告。
2. 对照 D1-ADAPTER-CONTRACT 细化 8 个 store 方法成功/冲突/过期/重试/并发结果矩阵。
3. 用本地 disposable SQLite fixture 验证 SQL 语义，并标明不代表 D1。
4. 制定 Cloudflare 隔离 D1 验证清单：DB ID、binding、迁移历史、schema、batch rollback、RETURNING/meta changes、并发唯一冲突、限流。
5. 无明确批准隔离 D1 环境时，不连接 staging/production，不猜 binding。
6. 不创建/执行 D1 migration，不接 Worker，不改 HTML/APK/Room/Secrets，不部署。
7. 免费组身份授权优先；特殊免费分组卡密保持条件性备选。
8. 更新进度、总方案和第七十批接手卡。


---

## 第六十九批连续性更新（2026-11-27）

- 版本：`V2.5-DEV-B1-APP-IDENTITY-69`；报告：`docs/backend/StarJump_V2.5_APP_v2_D1Adapter隔离SQL语义验证与八方法结果矩阵_第六十九批_V2.5-DEV-B1-APP-IDENTITY-69_2026-11-27.md`。
- 新增 disposable SQLite SQL semantics fixture、README 和 CI workflow；Run `45980988186` completed/success，Python 3.13.18，10/10 passed，exit code 0。
- 首次 Run `45980918539` 因测试发现模式不匹配运行 0 项/exit 5；已更正命名和 discovery pattern，保留首次失败记录。
- 覆盖八个 store 方法对应的本地 SQL 语义：challenge insert/conditional consume、nonce unique、binding unique/idempotency/revocation、share-code CAS/read、transient cleanup；另测 SQLite rollback analogue。
- fixture schema 是合成临时 schema，不是 D1 真实结构或 migration。未做多 isolate 并发，未证明 D1 batch rollback、RETURNING/meta.changes。
- 未连接 production/staging D1；未执行 SQL/创建 migration；未接 Worker；未修改 HTML/APK/Room/Secrets；未部署。D1_NOT_TESTED / APP_PENDING / 不可部署。
- 当前总进度修订：APP v2 identity 的 service mock contract 与本地 SQLite SQL semantics 已有独立测试证据；真实 D1 adapter、真实 schema、D1 并发与 Android proof 仍未验证。
- 免费分组身份授权优先；特殊免费分组卡密仍为真实冲突时的条件性备选。

### 第七十批唯一接手卡

**APP v2 D1 Adapter 的真实隔离环境准入门槛与 SQL/结果语义实现规格（不接生产）。**

1. 重读 AGENTS、功能基线、API/D1 保护规范、总方案、进度及第六十七至六十九批报告。
2. 核对第六十九批测试、workflow、Run、Blob SHA。
3. 细化 8 个 D1 statement contract：bind 参数、条件更新、RETURNING/meta.changes、唯一冲突、owner-scoped read、重试边界。
4. 设计 binding insert-if-absent + winner read 组合，避免把 batch 当 JS callback。
5. 审查 nonce TTL 清理与签名有效期的防重放关系。
6. 建立独立非生产 D1 准入清单与 schema snapshot 模板；仅在用户明确指定并批准后连接。
7. 无批准环境时只做规格/mock contract，不连接 staging/production。
8. 不创建/执行 migration，不接 Worker，不改 HTML/APK/Room/Secrets，不部署。
9. 更新总进度、总方案和第七十一批接手卡。


---

## 第七十批连续性更新（2026-11-27）

- 版本：`V2.5-DEV-B1-APP-IDENTITY-70`；报告：`docs/backend/StarJump_V2.5_APP_v2_D1Adapter语句契约与隔离环境准入规格报告_第七十批_V2.5-DEV-B1-APP-IDENTITY-70_2026-11-27.md`。
- 新增 `backend/worker/V2.5-DEV-B1-APP-IDENTITY-70/D1-STATEMENT-CONTRACT.md`、`D1-ISOLATED-ENV-ADMISSION.md`、README。
- 八个 D1 store 方法现在有具体 SQL 形状、bind 参数顺序、零行/冲突/异常分类、重试边界和 owner-scoped 查询要求。
- upsertBinding 的两条 statement 必须预先准备后由 D1.batch 顺序执行；batch 返回后 JS 检查 winner；unique(admin,device) 是并发唯一性约束，不能覆盖 key 或复活 revoked。
- nonce retention 推导：若服务端 timestamp 只接受 `abs(ts-now) <= S`，首次接收时可能处于未来边缘，nonce 最短保留至少 `first_seen + 2*S + safety margin`；具体 S 与 margin 必须由服务端配置冻结。
- durable rate limit 仍为独立前置依赖；旧 rate_limits schema 未核实，不假定兼容。
- 已查阅 Cloudflare 官方 prepared statements、return object、D1 batch 文档；batch 按顺序执行，语句失败会中止/回滚批次；D1Result 包含 success/meta/results。该平台文档不证明本项目真实 D1 schema/binding/runtime，也不替代目标 SQL 实测。
- 本批仅规格文档，无新增代码测试；未连接 D1、未执行 SQL/创建 migration、未接 Worker、未修改 HTML/APK/Room/Secrets/Cloudflare 配置、未部署。D1_NOT_TESTED / APP_PENDING / 不可部署。
- 下一批第七十一批：独立复核八方法 SQL、审计幂等、nonce 时间边界、legacy share-code 兼容和 durable rate limit；不连接 D1。

### 第七十一批唯一接手卡

**APP v2 D1 statement contract 独立安全复核与审计幂等方案（不连接 D1）。**

1. 重读 AGENTS、功能基线、API/D1 保护规范、总方案、进度及第六十八至七十批报告。
2. 静态审查八方法 SQL 参数、schema 假设、条件、冲突、零行和异常语义。
3. 审查 upsertBinding winner SELECT 并发正确性与审计追加幂等，不在 batch 内使用 JS 分支。
4. nonce retention 边界矩阵：未来/过去最大偏移、时间边界、重放、清理前后。
5. 审查 share-code rotation 与 legacy routes 兼容，不更改未确认政策。
6. 评估 durable rate-limit 原子计数与旧表适配证据。
7. 无用户批准的隔离 D1 不连接；不创建/执行 migration，不接 Worker，不改 HTML/APK/Room/Secrets，不部署。
8. 更新进度、总方案与第七十二批接手卡。


## 23. 第七十一批结果与第七十二批接手卡（2026-11-27）

### 第七十一批结果

- 版本：`V2.5-DEV-B1-APP-IDENTITY-71`。
- 报告：`docs/backend/StarJump_V2.5_APP_v2_D1语句契约独立安全复核与审计幂等方案报告_第七十一批_V2.5-DEV-B1-APP-IDENTITY-71_2026-11-27.md`。
- 新增：`backend/worker/V2.5-DEV-B1-APP-IDENTITY-71/D1-SECURITY-REVIEW.md`、README。
- 静态复核八个 D1 方法，补齐 expected constraint 分类、owner-scoped 零行语义、D1 changes/RETURNING 验证、timeout outcome-unknown、nonce cleanup stable-key 要求。
- Binding 创建审计提案：同一个 batch 加第三条条件 INSERT-SELECT；仅本次尝试的 binding_id/owner/device/key/created_at 完全匹配才写入；唯一 deterministic event_key 防重；重试复用相同 immutable operation identifiers；audit statement 失败应回滚整个 batch。该方案待隔离 D1 验证，不是现有 schema 或实现。
- Nonce 边界：若接受规则为 abs(T-now)<=S 且两端包含，最坏可重放区间为 first_seen + 2S；额外 safety margin 必不可少。动态调大 skew 会使旧记录 retention 不足，应冻结配置或版本化签名协议。
- Legacy share-code：原始 Worker 可见 DDL 仅 admin_user_id/code/created_at，多个旧路由依赖原始 code；必须保持旧字段/路由兼容，不能把公开 code 当身份认证；轮换是否撤销既有绑定仍待用户确认。
- Durable rate limit：原始 Worker 的 rate_limits 是全局 bucket/count/updated_at；增量与阈值读取分离，错误时 fail-open；不满足 APP identity 的原子、多维、fail-closed 需求，不能直接复用。
- 本批为静态复核，无新增可执行测试；未连接任何 D1、未执行 SQL/迁移、未接 Worker、未改 HTML/APK/Room/Secrets、未部署。D1_NOT_TESTED / APP_PENDING / NOT_DEPLOYABLE。

### 第七十二批唯一接手卡

**APP v2 D1 审计/幂等事件契约与 durable rate-limit 协议冻结审查（设计阶段，不连接 D1）。**

1. 重读 AGENTS、功能基线、API/D1 保护规范、总方案、进度及第六十八至七十一批报告。
2. 将 binding 创建审计提案扩展为完整事件契约：event key、actor/owner/target、不可变 payload、保留策略、重复请求和 timeout 行为。
3. 为 binding revoke 与 share-code rotation 设计幂等审计契约，不改变尚未确认的轮换业务政策。
4. 冻结候选 identity rate-limit 算法：维度、窗口、原子判定、Retry-After、清理和 fail-closed；数值阈值保持可配置，不擅自设定最终额度。
5. 对照 APP 签名协议重新核对 nonce 时间精度、协议版本与 skew 变更行为；不宣称 Android 兼容。
6. 保留 legacy share-code 分阶段兼容方案，不改路由和 schema。
7. 不连接 D1、不执行 SQL/迁移，不改 Worker/HTML/APK/Room/Secrets，不部署。
8. 更新进度、总方案和第七十三批接手卡。


## 24. 第七十二批结果与第七十三批接手卡（2026-11-27）

### 第七十二批结果

- 版本：V2.5-DEV-B1-APP-IDENTITY-72。
- 报告：docs/backend/StarJump_V2.5_APP_v2身份审计事件与持久化限流协议设计报告_第七十二批_V2.5-DEV-B1-APP-IDENTITY-72_2026-11-27.md。
- 新增：backend/worker/V2.5-DEV-B1-APP-IDENTITY-72/AUDIT-AND-RATE-LIMIT-PROTOCOL.md、README。
- 完成不可变 append-only 审计事件逻辑契约；actor/owner 分离、owner-scoped 读取、唯一 event_key、相同 key 不同 payload 完整性冲突、秘密字段禁止进入审计载荷。
- 为 binding 创建/撤销/share-code 轮换设计确定性事件键和条件审计写入；timeout outcome-unknown，重试复用相同 operation_id/event_key；审计失败不得报告业务状态变更成功。
- 审计保留政策未确认，不设置自动清理。
- Durable identity rate-limit 候选采用 append-only event ledger + 单条条件 INSERT-SELECT 同时检查 network/device/admin/action 滑动窗口；限额不设最终数值，独立 HMAC key，不复用 APP/session/entitlement secrets。跨 isolate 并发、D1 RETURNING、查询计划、Retry-After 和 cleanup 尚未实测。
- 签名协议要求版本化 canonicalization/timestamp precision/nonce/skew；每版本单独 S_v/P_v/M_v；对称 inclusive skew 下 retention >= first_seen + 2*S_v + M_v；不允许原版本直接扩大 skew。
- Legacy share-code 字段/路由保持不变；轮换对既有绑定/会话/挑战/free grant 的影响仍待确认。
- 本批只改文档，无可执行测试；未连接 D1、未执行 SQL/迁移、未改 Worker/HTML/APK/Room/Secrets/Cloudflare、未部署。D1_NOT_TESTED / APP_PENDING / NOT_DEPLOYABLE。

### 第七十三批唯一接手卡

**APP v2 identity audit/rate-limit 契约对抗性复核与隔离测试规格（设计阶段，不连接 D1）。**

1. 重读 AGENTS、功能/API/数据库保护基线、总方案、进度和第六十八至七十二批报告。
2. 对 binding create/revoke/rotation 的并发、超时、重复键、不同 payload、部分提交风险进行独立对抗性复核。
3. 审查滑动窗口 SQL 形状在并发、重复 event_id、缺失维度、共享 NAT、时钟跳变、查询成本、cleanup race 下的边界；不对 D1 执行。
4. 制定隔离 D1 batch/statement atomicity、RETURNING、限流竞争准入、Retry-After 的精确测试输入/预期/证据模板。
5. 复核 nonce 协议版本 rollout 与旧/新 APK 兼容；无客户端源码证据仍标 APP_PENDING。
6. 基于仓库源码完成 legacy share-code 调用方盘点，不改路由/schema。
7. 不连接 D1、不执行 SQL/迁移，不改 Worker/HTML/APK/Room/Secrets，不部署。
8. 更新进度、总方案和第七十四批接手卡。


---

## 第七十三批结果与第七十四批唯一接手卡（2026-11-27）

### 第七十三批结果

- 版本：`V2.5-DEV-B1-APP-IDENTITY-73`；报告：`docs/backend/StarJump_V2.5_APP_v2身份审计限流契约对抗性复核与隔离测试规格报告_第七十三批_V2.5-DEV-B1-APP-IDENTITY-73_2026-11-27.md`。
- 新增：`backend/worker/V2.5-DEV-B1-APP-IDENTITY-73/ADVERSARIAL-REVIEW-AND-ISOLATED-TESTS.md`、README。
- 本批完成对 binding create/revoke/rotation 的并发、超时、重复键、不同 payload、零行和部分提交风险静态复核，并给出精确隔离 D1 测试输入/预期/证据模板。
- 重要修正：D1 batch 仅在语句错误时中止/回滚；条件 INSERT-SELECT 零行不是 SQL error。业务写入后，required audit INSERT-SELECT 若零行，批处理仍可能成功；batch 返回后检查 changes 已无法回滚。必须设计经隔离 D1 验证的 in-batch assertion/constraint。相同 event_key 的 DO NOTHING 不足以判断 payload 是否相同。
- 第六十七批 challenge consume 与 binding create 是分离 store 调用；存在先消费 challenge、后创建 binding 失败导致 challenge 被烧掉的风险。下一版必须合并原子逻辑边界。
- Cloudflare Debug D1 文档指出 Promise.race 超时不取消 D1 写操作，写操作可能仍提交。所有写超时均为 outcome-unknown，复用原 operation/binding/event IDs 并 owner-scoped 核实。
- 限流对抗性测试覆盖多 isolate 并发、重复 event_id、缺失维度、共享 NAT、窗口边界、时钟跳变、Retry-After、多维释放时间、索引成本、cleanup race、HMAC key rotation 和 fail-closed。
- Legacy share-code 源码盘点包括 admin_share_codes、ensureShareCode、/api/user/share-code、/api/super/admins/:id/share-code、/api/app/resolve、/api/app/free、/api/app/download 和原始 HTML 展示调用；APK/外部客户端调用方仍未审计，清单不是完整证明。旧字段/路由保持不变。
- Nonce/签名新旧协议需要版本化；APK 源码未审计，APP_PENDING。
- 本批只有静态源码/文档复核与公开 Cloudflare 文档核对；没有执行自动化测试、SQLite fixture 或 D1；未连接 D1、未执行 SQL/迁移、未改 Worker/HTML/APK/Room/Secrets/Cloudflare 配置、未部署。D1_NOT_TESTED / APP_PENDING / NOT_DEPLOYABLE。

### 第七十四批唯一接手卡

**APP v2 identity 原子操作重构设计与本地可执行对抗性 fixture（仍不连接 D1）。**

1. 重读 AGENTS、功能/API/数据库保护基线、总方案、进度和第六十七至七十三批资料。
2. 重构逻辑状态机契约，使 challenge consume + binding insert/winner resolution + required audit 属于同一原子逻辑操作。
3. 设计 required-audit in-batch assertion：审计零行、event_key 同 payload 重试、event_key 不同 payload 冲突均有明确结果；不能依赖 batch 返回后的 JS 检查回滚。
4. 扩展本地 disposable SQLite fixture，覆盖 challenge 已消费后 binding 写失败、audit zero-row、audit SQL error rollback、相同/不同 payload 重试、timeout-after-commit 模拟、revoke/rotation race、limiter 窗口边界与 Retry-After。
5. SQLite 仅作为本地语义测试，不得宣称 D1 多 isolate 并发通过；真实 D1 仍须隔离环境与用户明确批准。
6. 不连接任何 D1，不执行 SQL/迁移，不修改 Worker/HTML/APK/Room/Secrets/Cloudflare 配置，不部署。
7. 更新进度、总方案和第七十五批唯一接手卡。


---

## 第七十四批结果与第七十五批唯一接手卡（2026-11-27）

### 第七十四批结果

- 版本：`V2.5-DEV-B1-APP-IDENTITY-74`；报告：`docs/backend/StarJump_V2.5_APP_v2身份原子操作重构与本地对抗性测试报告_第七十四批_V2.5-DEV-B1-APP-IDENTITY-74_2026-11-27.md`。
- 新增 atomic operation redesign、SQLite fixture、README 和 GitHub Actions workflow。
- 修正第六十七批 challenge consume 与 binding create 分离调用的逻辑缺口：下一版 adapter 必须把 challenge 条件消费、binding insert/既有绑定解析、必要审计和 operation receipt 放入同一原子逻辑单元。
- 必需审计不能依赖条件 INSERT-SELECT 零行来触发失败；提出最终 operation receipt 的 CHECK(audit_assert=1) 断言候选。若 challenge/binding/audit 任一必要状态缺失，最终 CHECK 应抛错并使同批次回滚。该 operation receipt 表和 CHECK 约束是候选设计，不是已核实生产 schema；D1 验证与用户批准前不得迁移。
- 幂等：同 operation ID + 同 canonical payload 为重放；同 ID 不同 payload 为完整性冲突；同 event key 不同 payload 必须因最终审计断言失败而回滚。超时仍是 outcome-unknown，复用原 IDs 并 owner-scoped 核实。
- GitHub Actions Run `45993837077`：completed/success；Job `140488126131`；Python 3.13.18；12/12 passed、0 failed。测试为内存 SQLite 合成 schema。
- 12 项覆盖成功绑定/审计、binding SQL 失败回滚、audit zero-row 回滚、audit SQL error 回滚、同 ID 同 payload 重放、同 ID 异 payload 冲突、timeout-after-commit retry、既有 binding 去重、revoke CAS、rotation CAS、limiter window/Retry-After、event key 异 payload 回滚。
- 不代表 D1 compatibility、多 Worker isolate 并发、生产 schema、APK 兼容或线上部署通过。
- 未连接任何 D1；未执行 D1 SQL/迁移；未修改 Worker/HTML/APK/Room/Secrets/Cloudflare 配置；未部署。D1_NOT_TESTED / APP_PENDING / NOT_DEPLOYABLE。

### 第七十五批唯一接手卡

**APP v2 identity create/revoke/rotation 统一 operation receipt + audit assertion，以及限流幂等边界本地测试（仍不连接 D1）。**

1. 重读 AGENTS、功能/API/数据库保护基线、总方案、进度和第六十七至七十四批资料。
2. 设计 create/revoke/rotation 共用 operation receipt 与审计 CHECK assertion，不假设生产已有对应表或字段。
3. 增加本地 SQLite 测试：revoke/rotation audit missing/mismatch rollback；event key 同 payload 与异 payload；owner-scoped operation receipt；duplicate limiter event_id；缺失必需维度；多维 Retry-After 取最晚释放点；cleanup 与窗口边界。
4. 明确 SQLite 仅是本地语义测试，不宣称 D1 多 isolate 并发通过。
5. 不连接任何 D1，不执行 SQL/迁移，不修改 Worker/HTML/APK/Room/Secrets/Cloudflare 配置，不部署。
6. 更新进度、总方案和第七十六批唯一接手卡。


## 12. 第七十五批进度与第七十六批接手卡（2026-11-27）

### 第七十五批结果

- 版本：`V2.5-DEV-B1-APP-IDENTITY-75`；报告：`docs/backend/StarJump_V2.5_APP_v2身份操作收据审计断言与限流幂等测试报告_第七十五批_V2.5-DEV-B1-APP-IDENTITY-75_2026-11-27.md`。
- 新增统一 operation receipt/audit assertion 设计、SQLite fixture、README、GitHub Actions workflow。
- create/revoke/rotation 统一要求 owner-scoped receipt、operation type/request fingerprint、result/version、audit event key 与最终 CHECK assertion。revoke 使用 generation CAS，rotation 使用 version CAS；missing/mismatched audit 应在同一原子单元回滚。
- Limiter fixture 覆盖 event_id exact replay/conflict、required dimensions、half-open window、inclusive-left-edge Retry-After、multi-dimension latest release、cleanup retention boundary。
- Run `45995374834` completed/success；Job `140493331634`；Python 3.13.18；24/24 passed、0 failed、exit 0。日志已读取核对。
- 仅本地合成 SQLite schema；不证明 D1 CHECK/EXISTS/batch rollback、多 isolate 并发、生产 schema、Worker/API 或 Android 兼容。
- 未连接任何 D1；未执行 SQL/迁移；未改 Worker/HTML/APK/Room/Secrets/Cloudflare 配置；未部署。D1_NOT_TESTED / APP_PENDING / NOT_DEPLOYABLE。

### 总进度表（第七十五批后）

| 模块 | 当前状态 | 已有证据 | 未完成/下一步 |
|---|---|---|---|
| APP v2 identity service/state machine | 隔离 DEV 测试与协议设计 | 第六十四至七十五批 mock/SQLite CI | 未接真实 D1 adapter/Worker；继续 D1 隔离准入 |
| Identity operation receipt/audit | 候选逻辑契约 + SQLite 24/24 | Run 45995374834 | D1 CHECK/EXISTS/batch atomicity 未验证 |
| Durable identity limiter | 候选算法 + SQLite 边界测试 | event idempotency、维度、Retry-After、cleanup 24 项集成测试 | D1 并发/共享 NAT/时钟/成本/Secret rotation 未验证 |
| APP Android compatibility | APP_PENDING | APK 源码尚未完成审计 | 需完整 APK 源码与第三方限制核查 |
| 生产 D1 / Worker / deployment | 未授权/未验证 | 无本批生产证据 | 需明确隔离环境授权；生产仍禁止擅自操作 |

### 第七十六批唯一接手卡

**APP v2 identity 原子操作的 D1 隔离验证准入包与语义差距收敛（不接生产、不执行迁移）。**

1. 重读 AGENTS、功能基线、API/数据库保护规范、总方案、进度及第六十八至七十五批资料。
2. 对照第七十五批统一 receipt/audit assertion 与第七十四批 challenge+binding atomic contract，整理 D1 disposable 环境可执行验证矩阵：CHECK、scalar EXISTS、prepared binding、batch rollback、RETURNING/meta changes、唯一冲突、owner scope、create/revoke/rotation 竞争、timeout-after-commit 恢复。
3. 将 limiter 测试矩阵扩展为 D1 验证输入：多维并发、重复 event_id、缺失维度、共享 NAT、时钟跳变、窗口边界、Retry-After、cleanup race、查询成本/索引和 HMAC key rotation；阈值/保留期仍待确认。
4. 只准备隔离环境准入与验证脚本/文档；没有用户明确指定并批准的 disposable D1 binding/database ID 时，不连接任何 D1、不执行远端 SQL。
5. 不生成/执行生产 migration，不修改 Worker/HTML/APK/Room/Secrets/Cloudflare 配置，不部署。
6. 更新总进度、总方案与第七十七批唯一接手卡。


## 13. 第七十六批结果与第七十七批接手卡（2026-11-27）

### 第七十六批结果

- 版本：`V2.5-DEV-B1-APP-IDENTITY-76`；报告：`docs/backend/StarJump_V2.5_APP_v2身份原子操作D1隔离验证准入包报告_第七十六批_V2.5-DEV-B1-APP-IDENTITY-76_2026-11-27.md`。
- 新增 D1 isolated validation plan、26-case machine-readable JSON matrix、offline validator、README、CI workflow 和报告。
- 官方 D1 docs 核实：batch sequential/non-concurrent; SQL error abort/rollback; result order follows input; success and meta.changes are distinct; each D1 database is single-threaded and queues concurrent requests; Promise.race timeout does not cancel writes; D1 Insights includes rows read/written and duration.
- Run `45995978023` completed/success；Job `140495345000`；Python 3.13.18；26-case matrix structure PASS。日志明确没有 network/D1 access、SQL execution 或 migration。
- 本批仅验证矩阵完整性，不是 D1/Worker/APP 测试。
- 专用 disposable D1、准确 database ID/binding、环境隔离证据、只读/写入授权均未提供或未授予；没有访问任何 D1。
- 未执行 SQL/迁移，未修改 Worker/HTML/APK/Room/Secrets/Cloudflare 配置，未部署。D1_NOT_TESTED / APP_PENDING / NOT_DEPLOYABLE。

### 总进度表（第七十六批后）

| 模块 | 当前状态 | 已有证据 | 未完成/下一步 |
|---|---|---|---|
| APP v2 identity service/state machine | 隔离 DEV 契约与本地测试 | 第六十四至七十五批 mock/SQLite CI | 未接真实 D1 adapter/Worker |
| Identity operation receipt/audit | 候选原子契约 + SQLite 24/24 | Run 45995374834；D1 验证矩阵 D1-002…D1-016 | D1 CHECK/EXISTS/batch atomicity 未验证 |
| Durable identity limiter | 候选算法 + SQLite 边界测试 | 第七十五批 24/24；D1 矩阵 D1-017…D1-026 | 多请求限流、共享 NAT、时钟、cleanup race、HMAC rotation 未验证 |
| D1 isolated admission | 准入包和 26-case matrix 已完成 | Run 45995978023 offline structure PASS | 未提供 disposable DB/binding 和授权 |
| APP Android compatibility | APP_PENDING | APK 源码尚未完成审计 | 第三方授权、签名、设备证明、协议兼容未核实 |
| Production D1 / Worker / deployment | 未授权/未验证 | 本批未访问 | 生产仍禁止擅自操作 |

### 第七十七批唯一接手卡

**APP v2 D1 原子断言 SQL 候选静态可移植性复核与隔离执行器设计（仍不连接 D1）。**

1. 重读 AGENTS、功能/API/数据库保护基线、总方案、进度和第七十至七十六批文件。
2. 对第七十四/七十五批 CHECK assertion 候选 SQL 做 SQLite/D1 静态语法边界复核：CHECK 列约束、INSERT-SELECT/CASE WHEN EXISTS、唯一 event_key、精确 payload 比对、NULL 语义、prepared binding 顺序、batch 最终断言位置。
3. 专门复核 create/revoke/rotation 的 receipt 断言是否存在零行、重复键、owner 错配、payload canonicalization 和状态 CAS 漏洞；发现问题先写反例，不推测已支持。
4. 设计只接受显式隔离配置的未来 D1 harness：默认禁用、无默认 binding/database、环境身份核对、synthetic run namespace、只清理本 run ID、失败立即停止；本批不读取凭证、不连接 D1、不执行 SQL。
5. 继续完善限流多维并发、共享 NAT、时钟、cleanup race、HMAC key overlap 的静态用例和证据模板，不设生产阈值。
6. 不生成/执行生产 migration，不修改 Worker/HTML/APK/Room/Secrets/Cloudflare 配置，不部署。
7. 更新总进度、总方案与第七十八批唯一接手卡。


## 14. 第七十七批结果与第七十八批唯一接手卡（2026-11-27）

### 第七十七批结果

- 版本：`V2.5-DEV-B1-APP-IDENTITY-77`；报告：`docs/backend/StarJump_V2.5_APP_v2_D1原子断言SQL静态复核与隔离执行器准入契约报告_第七十七批_V2.5-DEV-B1-APP-IDENTITY-77_2026-11-27.md`。
- 新增 `SQL-PORTABILITY-AND-ASSERTION-REVIEW.md`、`D1-HARNESS-ADMISSION-CONTRACT.md`、README、离线结构 validator 和 workflow。
- 核心静态发现：CHECK(NULL) 语义要求 assertion 同时 NOT NULL + CHECK=1；条件 INSERT-SELECT 零行不触发 SQL error；最终 receipt 必须是同 batch 最后一个无条件写入，并以 CASE 产生 0/1 后触发 CHECK；DO NOTHING 必须由完整 envelope assertion 兜底。
- 发现 Batch 74 existing-binding receipt 允许无 created audit / nullable key，与 Batch 75 NOT NULL audit_event_key fixture 不一致；owner-scoped receipt lookup 与全局 operation_id 主键作用域也未冻结；payload delimiter 拼接不具备无歧义 canonicalization。列入第七十八批优先收敛。
- Harness 只形成准入契约：默认禁用、无默认 DB/binding/credential、独立核实 database ID 与 binding、只读/写入/cleanup 分开授权、run namespace 严格隔离、失败停止。未创建可连接 D1 的 runner。
- CI workflow 已提交，结果待实际运行核验；不宣称通过。
- 未连接任何 D1、未读取凭证、未执行 SQL/迁移、未修改 Worker/HTML/APK/Room/Secrets/Cloudflare 配置、未部署。状态：STATIC_REVIEW_COMPLETE / D1_NOT_TESTED / APP_PENDING / NOT_DEPLOYABLE。

### 第七十八批唯一接手卡

**APP v2 identity 原子操作候选协议冲突收敛与离线反例测试（仍不连接 D1）。**

1. 重新读取 AGENTS、功能基线、数据库保护规范、总方案、进度、第七十四至七十七批文件和最新 CI 结果。
2. 冻结 created/existing binding 两种 operation receipt/audit 语义，补充既有绑定路径反例测试；不得为旧绑定伪造 created 审计。
3. 为 operation_id owner scope、audit event key scope、canonical payload 编码、NULL/空串/缺失字段差异建立明确契约与反例测试。
4. 复核 create/revoke/rotation 三种 final assertion 的每个必需谓词及 CAS 输入输出；建立占位符数量/顺序静态检查。
5. 完善 limiter HMAC 双 key overlap 和 cleanup/admission 竞态证据规格，不设生产阈值。
6. 仍不连接 D1、不读取凭证、不执行 SQL、不创建 migration、不修改 Worker/HTML/APK/Room/Secrets/Cloudflare 配置、不部署。
7. 更新进度与总方案，给出第七十九批唯一接手卡。

- 第七十七批 CI 后续核验结果：Run `45996975612` completed/success；Job `140498704644`；Python 3.13.18；离线结构检查 PASS，日志明确无 network/D1、无凭证读取、无 SQL 执行。不得将该结果扩大解释为 D1/SQL 测试通过。


## 15. 第七十八批结果与第七十九批唯一接手卡（2026-11-27）

### 第七十八批结果

- 版本 `V2.5-DEV-B1-APP-IDENTITY-78`；报告 `docs/backend/StarJump_V2.5_APP_v2身份原子操作协议冲突收敛与离线反例测试报告_第七十八批_V2.5-DEV-B1-APP-IDENTITY-78_2026-11-27.md`。
- 收敛 Batch 74/75/77 的 created/existing 冲突：created 必须审计 `binding.created`；existing 不得伪造 created，因 challenge consumption 是状态变化，建议记录独立 `binding.existing_resolved`；两种结果都有 owner-scoped receipt 和事件键。
- operation receipt 与 audit event 唯一范围均定义为 owner-scoped composite key；canonical payload v1 使用版本化 typed length-prefix，明确 NULL/empty/missing/int/bool 和 NFC；拒绝 delimiter 拼接。
- 新增 bind manifest 静态核对、23 个离线 Python 反例测试、GitHub Actions workflow；测试结果待实际核验。
- 定义 HMAC 双版本 overlap 和 cleanup/admission 竞态证据要求，不选择生产阈值、密钥、窗口、保留期或轮换时长。
- 未连接 D1、未读取凭证、未执行 SQL/迁移、未修改 Worker/HTML/APK/Room/Secrets/Cloudflare 配置、未部署。状态：CONTRACT_DESIGN_COMPLETE / OFFLINE_TESTS_PENDING / D1_NOT_TESTED / APP_PENDING / NOT_DEPLOYABLE。

### 第七十九批唯一接手卡

**APP v2 identity adapter 设计前置：三类原子操作完整状态转移与审计矩阵（仍不连接 D1）。**

1. 重读 AGENTS、功能基线、数据库保护规范、总方案、进度及第七十四至七十八批材料和最新 CI。
2. 将 create-created/create-existing/revoke/rotation 的前置状态、CAS 条件、成功状态、失败分类、receipt、audit exact-match 谓词、重试/超时恢复整理为逐字段矩阵。
3. 检查 canonicalization v1 字段清单和事件 envelope 是否覆盖 actor/owner/target/outcome/reason/schema version；缺项列为待确认，不擅自补业务语义。
4. 设计 bind manifest 示例与静态校验器反例；覆盖 SQL 字符串、注释、转义、问号及占位符顺序。
5. 完善 HMAC key overlap 状态机、cleanup/admission 原子性前置条件及证据表；不设生产阈值。
6. 仍不连接 D1、不读取凭证、不执行 SQL、不创建 migration、不修改 Worker/HTML/APK/Room/Secrets/Cloudflare 配置、不部署。
7. 更新总进度、总方案和第八十批唯一接手卡。

- 第七十八批离线 CI 实际证据：Run `45997564796` completed/success；Job `140500692553`；Python 3.13.18；23/23 tests passed。范围仅 Python 参考模型/边界反例，不证明 D1、SQL、Worker 或 APP 行为。


---

## 第七十九批连续性更新（2026-11-27）

- 批次：`V2.5-DEV-B1-APP-IDENTITY-79`；报告：`docs/backend/StarJump_V2.5_APP_v2身份完整状态转移审计矩阵与限流轮换反例报告_第七十九批_V2.5-DEV-B1-APP-IDENTITY-79_2026-11-27.md`。
- 新增操作状态矩阵：create-created、create-existing、revoke、share-code rotation 的 preconditions、CAS、成功状态、audit exact-match、失败分类、幂等重试、timeout recovery、rollback 逐项定义。
- canonical request fingerprint 与 audit envelope 分离；通用 canonical_v1 不足以保证 operation-specific field coverage。actor mapping、reason_code enum/nullability、payload allow-list、target ID audit permission、canonical ordered field list 均标记为 adapter freeze blockers。
- bind manifest linter 扩展 exact SQL SHA-256、statement ID、placeholder 顺序、唯一 semantic name、source/storage/nullability/missing policy/sensitivity；扫描单/双引号、backtick、bracket identifier、双写转义、行/块注释，拒绝 named/numbered placeholders。
- HMAC overlap 新增关键反例：分散在 old/new key-version buckets 的历史事件，逐桶独立比较会 undercount；必须基于 immutable event_id 做跨版本 union/dedupe 后原子准入，或证明某一桶有完整历史覆盖。不可简单 sum（双写会重复）或 max(bucket count)。
- 首轮 Run `45998840209` success，34/34；后续 manifest linter 加强中有失败修订 Run `45998985251`、`45999030188`、`45999045868`，测试夹具已修正，最终 Run `45999063646` 待核验。以最终 Run 日志作为最终测试状态。
- 本批仅 DEV 文档、离线测试与 workflow；未连接 D1、未读取凭证、未执行 SQL/迁移、未改 Worker/HTML/APK/Room/Secrets/Cloudflare 配置、未部署。仍为 `D1_NOT_TESTED / APP_PENDING / NOT_DEPLOYABLE`。
- **第八十批唯一接手卡：APP v2 adapter contract freeze checklist 与 disposable D1 证据缺口关闭计划（仍不连接 D1）。**
  1. 重读 AGENTS、功能基线、总方案、进度和第七十四至七十九批材料/最新 CI。
  2. 对 Batch 79 的 actor mapping、reason enums/nullability、payload allow-list、canonical field order、rotation side effects 分类“已确认/待用户确认/技术验证”，不得自行冻结业务语义。
  3. 核验 Batch 79 最终 CI；失败先修测试并保留失败记录。
  4. 将 disposable D1 每个 case 映射到 schema capability、statement、result vector、rollback proof、cleanup evidence，不执行。
  5. 设计 HMAC event_id union/dedupe 索引/查询成本与 key migration coverage 验证，不设生产阈值。
  6. 复核 legacy share-code 调用方与 rotation side-effect 兼容风险，不改旧路由/schema。
  7. 不连接 D1、不读取凭证、不执行 SQL/迁移、不修改 Worker/HTML/APK/Room/Secrets/Cloudflare 配置、不部署。
  8. 更新总进度、总方案和第八十一批接手卡。
