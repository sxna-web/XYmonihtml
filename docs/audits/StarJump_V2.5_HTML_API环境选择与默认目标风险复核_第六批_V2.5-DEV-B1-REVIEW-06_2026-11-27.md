# 星跃管理平台 V2.5 DEV：HTML API 环境选择与默认目标风险复核（第六批）

- 版本标识：`V2.5-DEV-B1-REVIEW-06`
- 日期：2026-11-27
- 阶段：DEV 静态代码复核
- 文件：`releases/v2.5-batch1/index.html`
- HTML blob：`a04636d2b9aed0f262c4e520147e9838b21c8556`
- 对应 Worker：`releases/v2.5-batch1/Worker.js`（blob `5a2739d981e1835e692a04b903052f268fed981a`）

> 本报告仅为 HTML 源码静态核查。未发起登录、初始化、数据库或生产 API 请求；未部署。

## 一、当前代码事实

1. 登录页 API 地址输入框在源码中直接预填：
   `https://starjump-api-staging.synahcooo.workers.dev`。
2. `DEFAULT_API_BASE` 也固定为上述 staging 地址。
3. 若 localStorage 中存在 `sj-api`，页面会优先恢复此前保存的地址。
4. 若输入框为空且没有保存值，`apiBase()` 会回退到 `DEFAULT_API_BASE`，因此仍然静默使用 staging。
5. 生产目标通过固定字符串 `PROD_HOST = 'blackstarjump-api-dawn-1242'` 判断；`isProdTarget()` 使用 hostname 的 `includes()`。
6. 登录生产目标时会弹确认框；初始化诊断页在被识别为生产目标时禁止执行。
7. HTML 文案直接写有 staging 与生产 Worker 主机名；初始化诊断区域标注“仅 Staging”。

## 二、风险判断

### H-01：空白 API 地址仍默认发往 Staging

这不是“用户明确选择环境”。用户没有输入地址、清除输入或首次打开页面时，系统仍会向 staging 发请求。用户可能误以为正在操作其正式后台，实际却在 staging 登录或修改数据。

### H-02：生产识别依赖硬编码主机名

若将来正式 Worker 主机名变更，`PROD_HOST` 未同步更新，则新生产地址可能不触发生产确认，也可能绕过初始化诊断的生产阻断。使用 `includes()` 也不是严格的 hostname 精确匹配。

### H-03：localStorage 会延续上次环境

用户此前选过的 API 地址会保存在当前浏览器。页面重开后会恢复旧地址。若用户切换设备、浏览器数据被清除或使用新设备，则又回到 staging 默认值。环境状态没有被做成清晰、可见且强制确认的部署配置。

### H-04：候选版仍把环境主机名写进页面源码

DEV 候选 HTML 包含 staging 和生产主机名。虽然没有发现生产 Secret，但生产 Worker 域名属于部署目标配置，不应依赖源码注释和字符串判断来完成安全环境识别。

## 三、建议的 DEV 修复设计（本报告未实施）

1. 删除静默默认 API 地址：首次打开时 API 地址为空，禁止登录、注册、初始化和任何写操作，直到用户明确选择/确认目标。
2. 使用明确的环境选择：`未配置`、`Staging 测试`、`Production 正式`。选择后页面持续显示醒目的当前环境标识。
3. Worker 根地址作为环境配置项；不要只靠页面硬编码某个旧 hostname 推断生产。
4. Production 选择需二次确认，并显示将要访问的完整 hostname；首次进入、地址发生变化时重新确认。
5. 不能只检查 hostname 的 includes；应使用精确 hostname allowlist 或部署时注入的受信环境配置，并校验 HTTPS、根路径和允许域名。
6. localStorage 仅保存用户明确选择的环境与地址；不得在配置缺失时静默回退到任一环境。
7. 初始化/bootstrap 功能只允许在明确选择的 Staging 环境启用；生产环境在 UI 和 Worker 两端都拒绝该操作。
8. Worker 端仍须独立执行权限与环境保护；前端确认框不是安全边界。
9. 增加测试：首次打开、空地址、错误域名、伪造相似 hostname、旧 localStorage、生产域名变更、staging bootstrap、production bootstrap 被拒绝。

## 四、与部署流程的关系

用户以后只需要上传集中验收通过的 STABLE 文件。DEV/RC 阶段不要求用户改地址或上传；最终部署包应把 Worker 与 HTML 的环境配置方式写清楚，避免让用户手动猜测 Worker 域名。

## 五、状态声明

- 本批没有修改 HTML、Worker、D1、Secrets 或 Cloudflare 配置。
- 未执行 API 测试或部署。
- 结论为源码静态风险确认，不是已修复。
- 当前 Batch 1 仍为 DEV 候选，不得部署到生产。
