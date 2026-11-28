# 星跃管理平台 V2.5 RC1｜前端 API 根地址校验统一修复

- 批次：第一百零五批
- 标识：V2.5-DEV-B1-API-ROOT-GUARD-105
- 日期：2026-11-28
- 分支：release/v2.5.0-rc1-converge
- 初始 HEAD：d00bec01658c6bd7322a677f1c262b4d0c26e312

## 发现

RC1 HTML 已有 apiUrl(path) 统一校验（要求用户填写 API 根地址、HTTPS、Worker 根路径），但仍有 10 处直接 fetch(base + path) 绕过该函数，覆盖：
- APP 卡密 CSV 导出（页面内重复绑定的两处实现）；
- 访客转换分组查询；
- 公告读取；
- 访客订阅/节点转换；
- 访客历史分组与链接查询；
- 访客分组改名；
- 访客转换链接撤销。

这类请求在 API 地址为空、不是 HTTPS 或带子路径时，可能绕过统一错误提示与根地址约束；其中导出请求也缺少统一 redirect:error / cache:no-store 策略。

## 修复

文件：releases/v2.5.0-rc1/index.html

1. 上述直接 fetch(base + ...) 全部改为 fetch(apiUrl(...))，覆盖用户管理、访客转换、公告和访客链接管理请求。
2. 卡密导出 status 参数使用 encodeURIComponent，避免状态值直接拼入 query。
3. 删除相关函数中不再需要的 apiBase 临时变量；保留 apiUrl() 内部自己的 base 局部变量与根地址校验。
4. 不改变 API 路径、请求方法、业务 payload 或 Worker 路由，不新增服务端权限。

文件：scripts/rc1_cron_no_source_regression.py

新增静态断言，确保 HTML 不再包含 fetch(base + ...) / fetch(base+...) 形式的直接请求，并确保卡密导出、访客转换和公告读取均经过 apiUrl()。

## 验证范围与限制

- CI 对最终 HEAD 执行 HTML inline script 语法检查、静态回归、Worker regression、SQLite isolated verifier 与候选 artifact 构建。
- 该修改仅统一前端 URL 校验；不证明 API 业务逻辑、D1 schema、APP 6.00.48 客户端兼容或 Cloudflare 真实运行时。
- 未发送真实 API 请求，未访问 Cloudflare/D1/Secrets，未执行 SQL/DDL/DML。
- 未部署、未合并；PR #2 保持 Draft/Open/Unmerged。
