# 星跃管理平台 V2.5｜Cloudflare 两个部署基准文件对接核查

> 日期：2026-11-27  
> 范围：按用户要求，以 Cloudflare 最后上传部署的两个文件作为后续开发基准；本报告核查仓库中对应的 Worker.js 与 index.html。  
> 性质：静态源码核查；不是线上运行时证明、D1 实测或部署验收。

## 1. 本轮采用的两个基准文件

| 模块 | 仓库文件 | Git blob SHA | 源码识别信息 |
|---|---|---|---|
| Cloudflare Worker | `原始StarJump_V1点0_Final-zip-26-11-25-14:56/Worker.js` | `5da7aa3582558d9da2c2a0ad25a63c5e95e9fe63` | `VERSION=1.0.0`；健康信息 build=`2026-11-23-diag` |
| 管理后台/转换页面 | `原始StarJump_V1点0_Final-zip-26-11-25-14:56/index.html` | `ab98aecd4c8546eda197bbb4d5a9f5ec0db82613` | 单 HTML 文件；包含超级管理员、普通用户面板及转换页面 |

后续开发以这两个文件为基线，保留原件并生成独立的新版本目录，不覆盖历史文件。仓库 blob SHA 只证明本次读取的 Git 文件版本，不等同于 Cloudflare 线上运行时版本证明；本轮按用户指定将其作为开发基准。

## 2. 前后端是否属于同一套系统

### 2.1 已确认的匹配部分

- HTML 不是完全静态页面：源码中存在登录、注册、会话、用户来源、VIP、APP 卡密、APP 分组、下载、公告、转换等 API 调用。
- Worker 中存在对应的认证、用户态、超管、转换和 APP 路由分发。
- HTML 中可见的 API 路径大部分能在 Worker 路由或对应的通用路由处理函数中找到入口。
- Worker 注释要求 D1 binding 名称为 `DB`；并列出 `ADMIN_TOKEN`、`SESSION_PEPPER`、`ADMIN_ORIGIN`、`ALLOW_REGISTRATION`、`SESSION_TTL_HOURS` 等运行配置要求。

### 2.2 环境地址存在分流风险

HTML 管理登录区域的 API 地址输入框默认值为：

`https://starjump-api-staging.synahcooo.workers.dev`

管理面板的 `apiBase()` 从页面输入框读取地址；但转换页面的 `loadGroups()`、转换提交及转换链接管理代码另从 localStorage 的 `sj-api` 读取地址，并在没有保存值时回退到 staging 地址。

因此同一个 HTML 页面存在两套 API 地址来源：
1. 管理后台：页面 API 地址输入框；
2. 转换页面：localStorage 的 `sj-api`。

两者可能指向不同 Worker。即使管理后台已经切换到生产 Worker，转换页面仍可能访问 staging。新版本必须统一 API 环境配置来源，并在页面显著显示当前环境；生产环境操作继续保留明确提示，不能静默把用户请求发往生产。

## 3. 当前源码中已直接确认的高风险差异

### P0/P1：必须先修复或形成明确防护

1. **APP 分组管理缺有效 VIP 服务端门禁**  
   Worker 的 `userAppGroupsRoute` 注释明确写着“注册用户也能用”。该处理函数对本人分组执行 GET、POST、PUT、DELETE 及来源/设备关联操作时，未见有效 VIP 状态检查。与已确认规则“注册非 VIP、VIP 过期管理员只读；有效 VIP 管理员才可管理”不一致。

2. **APP 分组删除为物理删除且非原子**  
   超管和用户态分组删除都分别执行删除 `app_groups`、`app_group_sources`、`app_group_members` 的 SQL。没有先写撤销墓碑、generation 或 cleanup acknowledgement；三条语句也不是同一个 batch。分组删除/改型后 APK 24 小时清理规则因此没有形成端到端闭环。

3. **APP 状态接口不验证授权 Token**  
   `/api/app/status` 只按 `device_id` 查询最新 entitlement 并返回状态，没有校验对应 entitlement token。设备标识本身不能替代授权凭证。

4. **多管理员/多 entitlement 读取只选最新一条**  
   APP nodes、groups、links 等路径存在按 device_id 查询后 `ORDER BY created_at DESC LIMIT 1` 的逻辑。多个管理员对同一设备的有效授权可能互相遮蔽，不能满足多管理员授权并存的目标。

5. **APP 授权凭证放在 URL query**  
   APP nodes/groups/links 等请求从 query 参数读取 token。令牌可能进入代理、访问日志或诊断记录；新版本应优先使用 Authorization 请求头，并保持必要的客户端兼容过渡。

6. **固定默认密钥回退仍存在**  
   Worker 转换加密和 APP entitlement token 相关代码存在固定字符串回退（例如 `starjump-convert`、`starjump-app`）。生产 Secret 缺失时不能继续使用公开固定值，应 fail closed，并提供安全迁移/轮换方案。

### 其他重要差异

7. **免费分组授权路径仍有永久 grant 逻辑**  
   APP 卡密激活时会写入 `app_free_grants`，注释称激活过一次即可永久保留该管理员免费分组资格。该永久性与免费授权最终规则尚需对照确认，不能擅自继续扩大。

8. **数据库升级接口风险较高**  
   `/api/super/schema-status` 只检查指定表是否存在，未完整核对字段、索引、外键和约束。`/api/super/migrate` 接收 `confirm=yes` 后直接执行一组建表/补列语句；部分 ALTER/索引/审计失败会被 catch 后忽略。该接口不是完整的版本化迁移账本，也不是“先展示差异、再由用户确认”的安全升级流程。正式 D1 未完成只读 schema 对照和备份前，不得调用该接口执行迁移。

9. **转换匿名归属和密钥缺失策略仍需修复**  
   现有 Worker 转换路径仍可见共享匿名 owner key `g:anonymous` 的回退逻辑；转换密钥缺失时存在固定默认值回退。需要按先前 P1 审计项修复，避免不同匿名用户数据归属混淆和密钥可预测。

10. **HTML 的旧接口兼容层需要逐项核验**  
    HTML 使用 `/api/admin/sync` 等旧管理接口；Worker 保留 legacy admin 路由。后续不能简单删除旧路由，必须逐项确认调用主体、数据范围和权限，再决定迁移到新 API 或保留兼容适配。

## 4. 与已确认业务规则的关键差距

| 业务要求 | 当前源码证据 | 当前判断 |
|---|---|---|
| APP 对接/星链接仅注册用户可查看，有效 VIP 才可管理 | userAppGroupsRoute 允许注册用户执行写操作；其他 APP 管理写路由此前审计也发现缺 VIP gate | 未达标 |
| 分组删除/改型后 24 小时 APK 本地清理 | APP 分组物理删除；源码未发现 tombstone 或 cleanup acknowledgement 字段/流程 | 未达标 |
| APP status 必须验证授权 | status 路由未校验 token | 未达标 |
| 同设备多个管理员授权并存 | 关键 APP 查询只取最新 entitlement | 未达标 |
| 敏感 token 不放 URL | APP token 从 query 读取 | 有风险 |
| Secret 缺失时 fail closed | 存在固定默认密钥回退 | 未达标 |
| 数据库升级先检查差异再安全执行 | schema-status 只看表；migrate 直接执行并吞部分错误 | 未达标 |
| 管理后台与转换页面使用同一 API 环境 | 两套 API 地址来源，转换页默认 staging | 有环境错配风险 |

## 5. 本轮完成与未完成边界

已完成：
- 阅读仓库 `AGENTS.md`、V2.5 功能基线、目录版本规范、API 契约及动作级权限矩阵。
- 读取两个基准文件完整内容并记录 Git blob SHA。
- 静态检查 HTML API 调用、Worker 路由、APP 授权、分组删除、迁移入口和环境配置。
- 确认这两个文件可作为后续修改基准，但原始版本必须保留。

尚未完成：
- 未连接 Cloudflare 生产环境核对运行时版本。
- 未连接正式 D1，未执行 SQL，未核对真实 schema。
- 未运行 Worker/API 集成测试或真实 APK 联调。
- 未修改两个基准文件、未部署 Worker、未改 Secrets。
- APK 端 generation/tombstone/cleanup acknowledgement 仍缺少源码实证。

## 6. 下一阶段实施顺序

1. **先做可回滚的修复版本设计**：以这两个文件为唯一代码基线，结合已确认权限矩阵和 P1-01 至 P1-60 审计项，先输出逐文件影响分析、API 兼容、D1 影响、测试及回滚计划。
2. **优先修复身份与 APP 授权安全**：固定密钥 fail-closed、无效 Session 不降级匿名、APP status Token 校验、多 entitlement 正确聚合、APP 管理写操作有效 VIP 门禁。
3. **再实现 APP 分组生命周期闭环**：分组版本/撤销标记/generation、APK 增量同步、客户端清理、cleanup acknowledgement；不能以物理删除代替。
4. **统一前端 API 环境配置**：管理后台和转换页共用同一 API base，避免 staging/production 分流。
5. **最后设计数据库安全升级界面**：先只读检查表/列/索引/外键差异，再按迁移版本与 checksum 一键升级；迁移必须单独审核，不自动执行。
6. 每一阶段生成完整、互相匹配的 Worker 与 HTML 更新文件，用户上传部署；在用户部署前不标记“已部署”。

## 7. 数据库与生产保护

本轮没有数据库变更，没有生产环境操作。后续如需 D1 schema 变更，必须先取得正式 D1 的只读结构证据，形成兼容迁移、备份、回滚和验收计划；没有用户明确批准，不执行正式 D1 变更或生产部署。
