# 星跃管理平台 V2.5｜第一批安全修复代码核验报告

- 日期：2026-11-27
- 分支：`repair/v2.5-batch1-auth-vip-app`
- Worker 更新文件 blob：`5a2739d981e1835e692a04b903052f268fed981a`
- HTML 更新文件 blob：`a04636d2b9aed0f262c4e520147e9838b21c8556`
- 基准 Worker：`5da7aa3582558d9da2c2a0ad25a63c5e95e9fe63`
- 基准 HTML：`ab98aecd4c8546eda197bbb4d5a9f5ec0db82613`
- 本报告针对独立更新副本；原始文件未覆盖。

## 已实施

| 编号 | 修改 | 核验 |
|---|---|---|
| B1-01 | 无 Authorization 保留匿名；无效 Bearer 拒绝 | 静态断言通过 |
| B1-02 | 移除共享匿名 owner，缺 guest_key 返回 400 | 静态断言通过 |
| B1-03 | SESSION_PEPPER 缺失/少于 32 字符时 fail closed | 静态断言通过 |
| B1-04 | VIP 当前有效窗口判断，保留历史字段语义 | 静态断言通过 |
| B1-05 | APP 分组、入口、卡密管理写操作有效 VIP 门禁 | 三个 handler 均有门禁 |
| B1-06 | 转换过滤/重命名有效 VIP 门禁，基础转换保持开放 | 静态断言通过 |
| B1-07 | APP HMAC 去除固定公开密钥回退 | 静态断言通过 |
| B1-08 | APP status 要求 entitlement Token | 静态断言通过 |
| B1-09 | APP nodes/groups/links 按 Token 匹配所有有效 entitlement | 静态断言通过 |
| B1-10 | HTML 后台与转换页统一 API base | 旧分流 fallback 已移除 |

## 静态检查结果

- Worker：`268760` 字符，JavaScript 引擎语法解析通过。
- HTML：`276603` 字符，3 个脚本块语法解析通过。
- 原始基准文件没有被覆盖。
- 未新增/删除/修改 D1 schema。
- 未修改 Cloudflare Secrets、生产 Worker 或部署设置。

## 部署前阻塞核对

1. `SESSION_PEPPER` 至少 32 字符且保留原值；否则新 Worker 会拒绝 Session 哈希相关操作。
2. 若存在 `APP_HMAC_SECRET`，首次兼容部署时必须与现有 `SESSION_PEPPER` 一致；否则已有 APP Token 失效。
3. APK 调用 `/api/app/status` 必须携带 Token。当前 APK 源码尚未取得，旧 APK 是否发送该字段未验证。
4. 正式 D1 binding 必须保持用户当前实际数据库，不能按旧源码注释擅自切换。

## 本批未解决风险

APP 分组 tombstone/generation/cleanup ack、24 小时 APK 本地清理、免费授权凭证闭环、卡密事件脱敏与审计、转换密文 key 轮换、幂等限流、Cron stale 节点物理清理等，留待下一批。

## 结论

完整 Worker/HTML 更新文件已生成，静态语法和关键代码断言通过。这不代表生产测试通过，也不是无条件直接上线证明；部署前必须完成 Secret 和 APK status Token 兼容核对。
