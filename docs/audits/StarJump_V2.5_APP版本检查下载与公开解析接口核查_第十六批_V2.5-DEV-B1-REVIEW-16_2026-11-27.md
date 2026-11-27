# 星跃管理平台 V2.5｜APP 版本检查、下载与公开解析接口核查

> 批次：第十六批  
> 版本标识：V2.5-DEV-B1-REVIEW-16  
> 日期：2026-11-27  
> 状态：DEV 静态源码审计；未修改业务代码  
> 核查分支：repair/v2.5-batch1-auth-vip-app  
> 核查文件：releases/v2.5-batch1/Worker.js、releases/v2.5-batch1/index.html  
> 依据：AGENTS.md、V2.5 功能基线与权限验收规范  
> 兼容性：不修改 Worker、HTML、D1、Secrets、Cron 或线上部署

## 1. 本批结论

候选 Worker 提供公开 APP 版本检查、下载入口列表和管理员分享编号解析接口。公开读取本身可以符合 APP 下载页/更新检查的产品需求，但当前公开接口会返回管理员名称、管理员 ID、分享编号状态及下载 URL 等信息；应明确哪些信息属于公开展示，哪些只用于内部授权，不应将公开分享编号当作认证凭证。

下载链接校验允许 HTTP 与 HTTPS。APP 更新记录则只接受以 HTTPS 开头的地址，但没有在该处对主机名做 allowlist 或下载文件类型/签名校验。更新 API 返回数据库中配置的 URL，APK 若直接下载并安装，必须有 APK 签名校验和版本降级保护，不能仅依赖 HTTPS 或版本号。

本批未发现 Worker 对公开下载/更新接口执行管理员身份校验；这是公开接口的当前行为，不直接等于漏洞，需按产品意图和数据敏感级别确认。管理员后台修改下载链接和 release 记录的写接口仍位于超管/用户 API 路由门禁之后。

## 2. 已核实的公开接口

### 2.1 APP 版本检查：GET /api/app/version

- 不要求登录 Session。
- 参数 platform 默认 android；current 转为数字。
- 查询该平台 active=1 的最高 version_code release。
- 返回 update、force、version_code、version_name、url、notes、min_version_code。
- 当 latest.force=1，或 current 低于 min_version_code 时，若存在更新则 force=true。
- 没有 active release 时返回 update=false。

风险边界：
- release URL 和 notes 是公开输出；不要把内部测试地址、签名材料、密钥或未发布版本写入该记录。
- current 参数由客户端提供，不能作为服务端安全判断依据。
- 静态源码未见 APK 包签名哈希、签名证书指纹或下载后完整性验证字段。

### 2.2 APP 下载列表：GET /api/app/download

- 不要求登录 Session。
- 接收 admin 或 code 参数。
- code 通过 admin_share_codes 查出 admin_user_id。
- 调用 listDownloads()，返回该管理员启用的专属下载链接及全局下载链接。
- 返回字段包括下载链接记录的 id、scope、title、url、sort。

风险边界：
- 分享编号是公开定位/分享标识，不是用户身份凭证。
- 接口不校验分享编号所属管理员是否仍有效 VIP，也不检查管理员账号封禁状态。
- 若产品规则要求管理员失效后下载页仍保留，则需明确其专属链接是否继续展示；若不应展示，需要服务端状态条件。
- HTTP 下载链接允许明文传输，可能被中间人篡改或降级。

### 2.3 分享编号解析：GET /api/app/resolve

- 不要求登录 Session。
- 接收 code，校验长度和字符格式。
- 通过 admin_share_codes 查询 admin_user_id 和 app_users.username。
- 查询 admin_app_perms.free_group_enabled。
- 返回 code、admin_user_id、admin_name、free_group_enabled。

风险边界：
- 该接口公开暴露管理员内部 ID 与用户名。若 APK 后续只需要显示管理员名称和免费组开关，建议仅返回最小必要字段，不返回内部主键。
- 返回的 free_group_enabled 只是展示/路由提示，不应成为服务端授权凭证；实际免费组读取仍必须独立验证 APP 用户/设备身份和 grant 状态。
- 需防止分享编号被当成身份认证，或通过枚举编号批量收集管理员信息。

## 3. 公开接口与后台写接口的边界

静态路由显示：
- /api/app/version、/api/app/download、/api/app/resolve 作为公开 GET 读取路径分派。
- 超管 release 管理位于 /api/super/releases。
- 超管下载链接管理位于 /api/super/downloads。
- 用户下载链接管理位于 /api/user/downloads。
- 用户 API 要求 Session，超管 API 还需满足对应超管身份门禁。

本批没有运行实际 HTTP 请求，因此只能确认源码路由结构，不能证明生产 Worker 当前部署了该版本，也不能证明实际 D1 记录内容。

## 4. 风险与建议

### P1-16-01｜APP 更新缺少可验证的 APK 完整性元数据

版本 API 只返回版本信息和 URL，没有发现 sha256、签名证书指纹或签名校验策略字段。

建议：
1. 发布记录保存 APK SHA-256、版本 code/name、签名证书指纹、文件大小、平台和发布日期。
2. APK 下载后校验 SHA-256，并使用 Android PackageManager/签名证书策略验证包签名。
3. 版本升级不得接受签名证书不一致的 APK。
4. 对强制更新、最低支持版本、回滚/紧急撤回制定明确策略。
5. 不将 HTTPS 当作 APK 身份验证的唯一保障。

### P1-16-02｜下载链接允许 HTTP

validDownloadUrl() 同时允许 http 与 https，APP 下载入口可能使用明文 HTTP。

建议：正式版默认仅允许 HTTPS；如确有 HTTP 历史链接，先盘点实际记录、展示明确风险并安排迁移，不可直接在未知生产数据上批量改写。

### P1-16-03｜公开分享解析返回内部标识

resolve 接口返回 admin_user_id 与 admin_name。admin_user_id 属于内部数据标识，未必需要公开。

建议：公开接口只返回 UI 必需的展示名称、免费组可用提示及短期不可预测的公开 share reference；内部 admin_user_id 不直接返回 APK，授权查询由服务端根据 share reference 解析。

### P1-16-04｜下载列表对管理员状态的处理规则未明确

listDownloads() 仅过滤 enabled 和 scope，没有检查管理员当前 VIP 状态、账号状态或下载入口是否已被撤销。

建议：先按产品规则明确“管理员 VIP 到期后，APP 下载页的专属下载链接是否继续公开”。如果要自动切公共下载链接，应在服务端统一实现，并保证管理员恢复 VIP 后恢复其原链接；不要只靠前端显示逻辑。

### P2-16-05｜公开分享编号缺少枚举防护证据

本批看到了 code 格式校验与数据库查询，但未看到该接口自身的原子限流、失败次数保护或批量枚举告警。

建议：对 resolve/download 按 IP、code 维度进行服务端原子限流，避免编号枚举；响应对不存在编号和不可公开编号采用一致策略，减少信息探测。

### P2-16-06｜更新地址缺少目标域约束

release URL 校验只检查 HTTPS 前缀。后台管理员可配置任意 HTTPS URL。若超管账号或配置被滥用，APP 会被引导至恶意下载地址。

建议：release 管理增加可信域名 allowlist、变更二次确认、URL 前后值审计、发布者和时间记录；紧急外部 CDN 切换应走明确审批。

### P2-16-07｜下载链接/Release 的历史版本和撤回机制不足

静态路径中发现 release 创建与删除，下载链接新增与删除；本批未发现完整发布版本状态机、软删除/撤回历史和变更审批流程。

建议：发布记录采用 draft → staged → active → withdrawn 状态；删除/撤回保留审计历史，防止误删后无法追溯。

## 5. 与已确认业务规则对照

| 业务要求 | 静态核查 |
|---|---|
| APP 下载页可展示下载入口 | 已有公开下载列表接口 |
| 管理员可配置自己的下载入口 | 有用户下载链接管理接口 |
| 超管可管理全局下载入口 | 有超管下载管理接口 |
| APP 检查版本更新 | 有公开版本检查接口 |
| 分享编号用于解析管理员信息 | 有 resolve 接口，但公开返回内部 ID，建议最小化 |
| APK 安装包可信与防篡改 | 当前接口未发现哈希/签名元数据闭环 |
| 管理员 VIP 到期后入口切公共链接 | 本批下载列表未见 VIP 状态条件；需明确是否与“购卡入口”是同一规则，不能混为一谈 |
| 敏感凭证不公开 | 分享编号不是密码，但不应承担认证作用 |

## 6. 修复前置计划（本批不实施）

1. 先审计 APK 源码，确认 version/download/resolve 的请求参数、响应字段和下载/安装校验流程。
2. 与用户确认管理员 VIP 到期后“APP 下载入口”与“购卡入口”是否采用同一公共链接切换规则。
3. 设计 release 完整性字段及 APK 签名校验方案，兼容当前已发布版本。
4. 将下载 URL 默认限制为 HTTPS，并建立可信域名 allowlist。
5. 精简 resolve 响应字段，内部 admin_user_id 不作为 APK 客户端授权依据。
6. 对公开分享编号解析和下载列表加原子限流、枚举告警。
7. 核对真实 D1 release/download_links schema 与线上数据后再制定迁移；未经用户批准不执行生产 SQL。

## 7. 必须补充的测试矩阵

| 场景 | 预期 |
|---|---|
| 未登录查询公开版本 | 只返回已发布的公开版本元数据 |
| 未登录查询下载列表 | 只返回启用且允许公开的下载链接 |
| 无效/停用分享编号 | 不泄漏管理员内部信息 |
| 枚举大量 share code | 被原子限流并记录安全事件 |
| 配置 HTTP 下载链接 | 正式策略拒绝或进入明确兼容警告 |
| 配置非 allowlist 更新域 | 发布流程拒绝或要求审批 |
| APK 下载文件被篡改 | APK 端 SHA/signature 校验失败 |
| APK 签名证书与历史版本不同 | 阻止升级并显示安全错误 |
| 发布版本 force/min_version_code 边界 | 更新提示准确且可回滚 |
| 管理员 VIP 到期/恢复 | 下载入口按用户确认规则切换/恢复 |
| 删除/撤回 release | 保留审计与历史，不造成不可追踪 |
| 外部下载站不可用 | APP 显示可理解错误，不崩溃 |

## 8. APK 源码核查阻塞说明

仓库中存在 `StarJump-6.00.47-source .zip` 与 `StarJump-6.00.48-source.zip`，但当前 GitHub 文件读取通道对 ZIP 返回空内容，无法据此解包。此前也未取得可验证的 ZIP 本地副本。

因此本批不对 APK 的实际实现作推断，不声称已经核实：
- APK 当前请求哪些 API；
- device_id 的生成与持久化；
- Token 的存储和 Header/query 传递；
- 下载后是否验证 APK 签名；
- 旧版本是否兼容新的 API 字段。

要完成 APK 源码实证，需要在后续取得 ZIP 的可读取副本或仓库内已解包源码。不会要求用户现在通过手机手动解压或重新上传大文件；后续优先尝试 GitHub 仓库归档/分卷文件的可用读取路径。

## 9. 本批边界与结论

- 已完成：阅读协作规则与功能基线；静态追踪 Worker 公开 APP version/download/resolve 路由、处理函数和 HTML 后台相关 API 路径。
- 未完成：APK 源码核验、生产 D1 读取、线上 API 请求、APK 安装/签名实测。
- 未修改：Worker、HTML、D1、Secrets、Cron、生产部署。
- 发布等级：仅 DEV 静态审计，不是 RC，不可部署。

**结论：** 公开版本检查和下载入口可以作为产品功能保留，但 APK 更新链路尚缺可验证的包完整性/签名闭环；下载链接允许 HTTP；公开解析接口返回内部管理员标识。必须先与 APK 源码联调并确认管理员到期时下载入口规则，才能设计兼容修复。
