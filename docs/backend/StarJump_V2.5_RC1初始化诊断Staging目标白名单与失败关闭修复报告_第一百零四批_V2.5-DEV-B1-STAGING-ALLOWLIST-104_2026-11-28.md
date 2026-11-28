# 星跃管理平台 V2.5 RC1｜初始化诊断 Staging 目标白名单修复

- 批次：第一百零四批
- 标识：V2.5-DEV-B1-STAGING-ALLOWLIST-104
- 日期：2026-11-28
- 分支：release/v2.5.0-rc1-converge
- 初始 HEAD：ae116f4ae9f3ee632c634289b4c51f2f90c9500e

## 发现的问题

HTML 中“初始化诊断（仅 Staging）”按钮原先只判断 API hostname 是否包含已知生产 Worker 名称片段。该逻辑不是 Staging allowlist：任何不包含该片段的其他 HTTPS 主机（包括未核实的生产 Worker、自定义域名或错误地址）都会通过判断。按钮随后直接使用 apiBase() 拼接路径；API 地址为空时还可能形成相对路径请求，未复用统一 HTTPS/root URL 校验。

## 修复内容

文件：releases/v2.5.0-rc1/index.html

1. 新增精确 Staging hostname 常量：starjump-api-staging.synahcooo.workers.dev。
2. 新增 isStagingTarget()：必须同时满足 HTTPS、hostname 完全相等、无子路径、无 query/hash。
3. 初始化诊断按钮改为 fail closed：只要不满足精确 Staging allowlist，就提示已阻止请求并 return；不再仅排除已知生产主机名。
4. 初始化请求改用 apiUrl('/api/auth/bootstrap')，复用统一的 API 根地址、HTTPS 和路径校验；删除绕过校验的 apiBase() 直接拼接路径。
5. 不影响普通登录及其他业务 API 请求；不改变 Worker 端业务接口。

文件：scripts/rc1_cron_no_source_regression.py

新增静态回归断言：
- 必须存在精确 Staging hostname 常量；
- 必须严格比较完整 hostname；
- 初始化诊断必须先执行 isStagingTarget() fail-closed 判断；
- 初始化请求必须使用 apiUrl()，不得使用原始字符串拼接。

## 安全边界与验证

- 这是 HTML 客户端的静态防误发保护，不是服务端授权替代；Worker 仍必须独立执行认证和权限校验。
- 该按钮仍仅用于既定 Staging 初始化诊断，不允许用于正式生产 bootstrap。
- 本批未发送任何 bootstrap 请求，未访问 Staging/Production Worker、D1 或 Secrets。
- CI 将在本批最终 HEAD 上执行 HTML 内联脚本语法、Cron/static regression、Worker tests、SQLite isolated verifier 与 artifact build。
- 不部署、不合并；PR #2 维持 Draft/Open/Unmerged。
