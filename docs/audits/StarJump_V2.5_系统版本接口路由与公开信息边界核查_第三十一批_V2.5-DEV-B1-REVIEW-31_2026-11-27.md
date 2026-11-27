# 星跃管理平台 V2.5｜系统版本接口路由与公开信息边界核查

- **批次**：第三十一批
- **版本标识**：V2.5-DEV-B1-REVIEW-31
- **日期**：2026-11-27
- **状态**：静态源码核查 / 接口设计细化；不可部署
- **仓库/分支**：sxna-web/XYmonihtml / main
- **依据**：AGENTS.md、目录规范、功能基线、API 权限规范、API 契约 V1、第二十九批版本清单设计、原始 Worker.js
- **范围**：只读核对版本相关路由、健康检查公开边界、迁移路由现状及后续实现约束。未修改 Worker、HTML、D1、Secrets 或生产环境。

## 1. 原始 Worker 版本实现事实

静态核查原始 Worker：
- 顶部存在 `const VERSION = "1.0.0"`。
- 同时存在 `CANON_VERSION = "v1.0-1"`，其用途为节点规范化/同步清单版本，不能当作管理系统版本。
- `GET /health` 返回 `service`、`version`、固定 `build: "2026-11-23-diag"`、认证模式、legacy admin token 状态和 features 数组。
- `/health` 位于 API 登录认证分发之前，是公开健康检查接口。
- 未发现独立的 `/api/system/version` 或系统组件版本清单路由。
- 当前 health 的 VERSION 只代表 Worker 源码中的常量，不包含 HTML、D1 schema、API contract、构建提交和组件兼容范围。

**结论**：当前公开 health 不能直接升级成完整版本清单，也不能把 Worker 1.0.0 解释为管理系统 V2.5。

## 2. 公开健康接口信息边界

现有 `/health` 已公开：
- 服务标识；
- Worker VERSION；
- 固定 build 字符串；
- 认证模式；
- legacy admin token 的受限状态；
- 功能标签列表。

建议后续将公开 health 收敛为最小运行状态，避免不断增加内部部署信息。尤其不得加入：
- D1 binding 名、数据库 ID、表/字段清单；
- Secret 是否存在、Secret 名称和值；
- 内部提交完整 SHA、分支名、源码路径；
- 管理员数量、账号、卡密或任何用户数据；
- 内部诊断日志、错误堆栈、数据库查询内容；
- 内部部署拓扑和私有 API 地址。

是否删除现有字段属于兼容性变更，必须先检索所有监控与客户端调用方；本批不改变旧响应。

## 3. 推荐的版本接口分层

### 3.1 面向所有客户端的最小版本摘要

建议新增只读 `GET /api/system/version`，仅提供非敏感且面向用户的字段：
- `system_version`：正式管理系统 SemVer；
- `release_channel`：仅公开 STABLE；若当前部署不是 STABLE，返回 `unknown` 或不返回内部通道；
- `app_latest_version_name`、`app_latest_version_code`：仅在现有发布数据经过校验后提供；
- `minimum_supported_app_version_code`：若存在明确兼容策略才提供；
- `compatibility_status`：`compatible | update_recommended | update_required | unknown`；
- `checked_at`；
- `warnings`：对用户可理解的简短提醒，不包含内部细节。

注意：该接口若需读取 D1 中 APP 发布记录，必须按现有发布表真实字段核对；当前不能假设字段或表一定存在，也不能因读取失败伪造最新 APP 版本。

### 3.2 超级管理员详细版本诊断

建议新增 `GET /api/super/system/version`，要求 Worker 已验证的超级管理员会话，不允许协助会话越权访问。返回：
- 系统 manifest 的目标版本；
- Worker 实际运行版本和 build ID；
- HTML 声明版本（由请求页面上报或静态 manifest 提供，必须标注来源）；
- D1 schema 版本（仅在可靠 migration ledger 存在时提供）；
- API contract 版本；
- git commit/build ID；
- 兼容矩阵判断及非敏感错误码。

不得把 HTML 客户端上报的版本当作可信构建证明；不得把“期望 schema 版本”冒充“实际 schema 版本”。无法确认时必须返回 unknown。

## 4. 版本兼容判定规则

兼容检查至少区分：
1. **目标版本**：交付包声明要部署的版本。
2. **实际运行版本**：当前 Worker 返回的真实运行元数据。
3. **实际数据库版本**：由已核验的迁移账本/结构检查得出。
4. **页面版本**：HTML 实际加载版本或其构建标识。
5. **API 契约版本**：Worker 真实提供的契约。

只有所有必要组件均可验证且满足兼容矩阵，才标记 compatible。
- 任何必需数据缺失 → unknown；
- 页面/API 不兼容 → update_required，并阻止敏感写操作；
- D1 schema 未核实 → schema status unknown，不能自动执行迁移；
- 网络错误或 Worker 超时 → unknown，不得沿用上次成功结果伪装当前状态；
- 不能用“版本号较大”简单推断兼容。

## 5. 对现有数据库迁移路由的特别保护

Worker 中存在 `GET /api/super/schema-status` 与 `POST /api/super/migrate`。静态代码可见迁移接口按预置语句尝试执行并跳过 already exists/duplicate column；这不是第二十九批设计的 migration ID + checksum + 依赖账本完整实现的证明。

后续实施前必须：
- 重新读取完整 migrate handler 和 MIGRATE_STATEMENTS；
- 核实真实生产 D1 schema 和绑定；
- 设计 migration ledger、checksum、依赖顺序、执行锁和执行后复核；
- 对部分失败、重复执行、并发、checksum 不匹配建立测试；
- 禁止自动 DROP/TRUNCATE 或重建正式业务表；
- 不能让版本兼容检查自动触发迁移。

本批不执行任何 SQL，也不调用 schema-status/migrate 生产接口。

## 6. HTML 展示实现约束

- 侧栏品牌短版本号必须从本次 HTML 构建元数据读取，不能由用户可编辑表单决定。
- 页脚应展示“管理系统 Vx.y.z”，不使用 APP 的 versionName/versionCode。
- 系统维护 → 版本与兼容性页面分区展示 HTML、Worker、D1 schema、API contract。
- APP 发布管理仍只管理 Android APP 版本，不得混入 system_version。
- 页面请求版本接口失败时显示“暂时无法确认”，不能把 HTML 自己的版本推断成整套系统当前版本。
- DEV/RC 版本信息只对授权测试/超管展示；普通用户只见 STABLE 版本。

## 7. 影响分析、测试和回滚

**潜在影响模块**：Worker 路由、HTML 侧栏/页脚/系统维护页、发布元数据读取、D1 schema 版本读取。

**数据库影响**：设计上优先使用现有 migration ledger（若存在且字段经核实）；若没有，需单独设计追加式迁移，先核实真实 schema。当前不要求写库。

**测试计划**：
1. 未登录访问公开摘要，只能得到最小公开字段；
2. 普通用户不能读取超管详细诊断；
3. 协助会话不能读取超管详细诊断；
4. 超管会话可读取详细诊断且不泄漏 Secret；
5. manifest 缺失、字段无效、版本来源不可信均返回 unknown；
6. HTML/Worker/API/schema 兼容矩阵边界测试；
7. API 超时/网络断开时不误判 compatible；
8. APP 最新版本字段缺失/重复/倒退时安全处理；
9. 旧 health 调用方兼容回归；
10. 版本检查不得触发数据库迁移或任何业务写操作。

**回滚**：
- 新增接口可单独撤回；
- HTML 版本展示可回退至上一套匹配 HTML；
- 不回滚/删除业务数据；
- 若新增 D1 ledger，采用向前兼容的追加式迁移，回滚应用代码不删除 ledger。

## 8. 当前状态表

| 项目 | 状态 |
|---|---|
| Worker VERSION 与 CANON_VERSION 区分 | 已静态核查 |
| /health 公开位置与字段 | 已静态核查 |
| 系统版本 API 是否存在 | 原始 Worker 未发现 |
| 公开摘要与超管诊断接口设计 | 本批细化，未实现 |
| D1 migration ledger 是否真实存在 | 待核实 |
| HTML 动态版本展示 | 未实现 |
| 系统与 APP 版本分离 | 需求已确认 |
| API/浏览器联调 | 未执行 |
| 生产部署 | 未执行 |

---
**结论：第三十一批确认了原始 Worker 只有 Worker 级 VERSION 和公开 health，尚无完整系统版本 API。已细化公开摘要、超管诊断、兼容性判定及数据库迁移保护要求；本批仅静态审计和设计，不可部署。**
