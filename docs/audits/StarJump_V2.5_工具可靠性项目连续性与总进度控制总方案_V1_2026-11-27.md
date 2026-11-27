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
- 报告 Commit：`c501249b98751aef5326e56f320bf428d5e04d72`
- 版本 Worker：`backend/worker/V2.5-DEV-B1-CORE-AUTH-49/Worker.js`，Blob SHA `a4689380215e95c1c9f605fc974cc553b3e7037f`。
- adapter：`worker-auth-adapter.mjs`，Blob SHA `2f91941c68082a44d5e23e1e25b416ae2901e0f0`。
- adapter tests：`worker-auth-adapter.test.mjs`，Blob SHA `86e226e1a14c00359f7e23ce08913830f1435814`。
- handler tests：`worker-handler.integration.test.mjs`，Blob SHA `d0303a2ed5a9e84d938fb95b9d46711444050abd`。
- README：`b2497b360f67118233a8084547c18e890582661b`。
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
