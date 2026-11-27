# 星跃管理平台 V2.5｜Batch 1 HTML 与 APK 交付物复核补充

- 版本标识：`V2.5-DEV-B1-REVIEW-02`
- 日期：2026-11-27
- 状态：**DEV 静态复核；禁止生产部署**
- 对象：`repair/v2.5-batch1-auth-vip-app` 的 `releases/v2.5-batch1/index.html`、`Worker.js`、部署说明；原始 HTML 与 Worker。
- 未访问 Cloudflare 生产环境；未执行 D1 SQL；未修改 Secrets；未部署。

## 1. APK ZIP 读取结果

尝试通过 GitHub 文件读取接口以 base64 方式读取仓库根目录的 `StarJump-6.00.48-source.zip`。接口返回文件名和 blob SHA `2b8b6d105019fb90341c7178438b2d6b0473699f`，但 content 为空（长度 0）。这不是可解包文件，不能据此审计 APK。ZIP 仍需通过可靠的二进制附件/下载方式取得。

## 2. HTML 候选版实证差异

重新读取原始 HTML 与 Batch 1 候选 HTML：

- 原始 HTML blob：`ab98aecd4c8546eda197bbb4d5a9f5ec0db82613`，276,880 字符。
- 候选 HTML blob：`a04636d2b9aed0f262c4e520147e9838b21c8556`，276,603 字符。
- 文件并非完全相同，但候选 HTML 仍保留注释 `星跃后台 V1.0 · 单文件模拟管理系统`。
- 候选 HTML 登录页 API 地址仍显示 Staging 与生产 Worker 主机名，并默认填写 `https://starjump-api-staging.synahcooo.workers.dev`。
- 脚本 `DEFAULT_API_BASE` 仍是 staging Worker；如果用户没有主动改输入框或本地保存值，默认请求会指向 staging。
- “立即同步”按钮仍直接请求 `/api/admin/sync`，不是已审计报告建议的用户态 `/api/user/sources/:id/sync`。不能仅凭统一 API 地址输入框就宣称 API 调用已全部修正。
- HTML 仍含多组 `/api/super/*`、`/api/admin/*`、`/api/user/*` 路径；需要逐项与候选 Worker 路由、当前登录身份和服务端权限核对。

## 3. 结论与风险

1. Batch 1 HTML 尚不能作为“正式生产后台 HTML”放行。
2. 默认 staging API 地址有把用户操作导向错误环境的风险；生产地址也不能未经用户确认直接硬编码。
3. 用户态“立即同步”仍调用 admin API，存在身份/权限边界错误风险。
4. “文件有变化”不等于“前端 API 契约已全部兼容”。需要完整路由清单与 Worker 实际 handler 一一比对。
5. HTML 顶部保留“模拟管理系统”注释，与实际文件用途/版本说明不一致；需要澄清它是模拟 UI 源码改造还是 Cloudflare 当前正式 HTML 的完整副本。不能擅自把它标成正式后台。

## 4. 下一步修复要求

- 将 API 环境选择改为显式、醒目的环境状态；首次启动不得静默使用 staging 或生产地址。
- 不得将生产主机名作为默认值；生产目标必须由部署配置明确指定并显示环境标识。
- 将用户面板来源同步改为正确的用户态 API，并核实 Worker handler 的 owner、VIP、source 状态、审计门禁。
- 建立 HTML 所有 fetch/apiUrl 路径与 Worker route/handler 的自动化契约检查。
- 对照真实 Cloudflare HTML 资产确认当前生产页面来源；现有仓库原始 HTML 只能作为指定的代码基线，不能证明它就是线上当前内容。
- APK ZIP 获取可解包副本后，完成 status Token、设备绑定、多 entitlement、节点缓存主键、撤销事件和 cleanup ack 核查。

## 5. 发布门槛更新

Batch 1 继续保持 `DEV`，不能升为 RC。至少完成：
- staging 默认地址风险修复；
- `/api/admin/sync` 调用身份边界修复；
- 全量 HTML→Worker API 契约核对；
- APK 请求兼容性实证；
- Secrets/D1 绑定由安全方式核实；
- 隔离环境 API + D1 集成测试；
- 回滚包和版本校验值。

用户无需现在部署或修改 Cloudflare。