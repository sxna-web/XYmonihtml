# 星跃管理平台 V2.5｜APP 精确授权解析器与多授权隔离测试报告

- 批次：第五十二批
- 版本：`V2.5-DEV-B1-APP-TOKEN-52`
- 日期：2026-11-27
- 状态：**隔离 helper 已编码；CI 语法检查与测试任务通过；未接入现有 Worker；不可部署**
- 仓库：`sxna-web/XYmonihtml` / `main`

## 1. 本批实施范围

根据第五十一批接手卡，本批在独立目录新增精确 entitlement resolver 和 Node.js 测试，不覆盖原始 Worker、第四十九批 Worker 或第五十批测试代码。

新增文件：
- `backend/worker/V2.5-DEV-B1-APP-TOKEN-52/entitlement-resolver.mjs`
- `backend/worker/V2.5-DEV-B1-APP-TOKEN-52/entitlement-resolver.test.mjs`
- `backend/worker/V2.5-DEV-B1-APP-TOKEN-52/README.md`
- `.github/workflows/worker-app-token52-tests.yml`

## 2. Resolver 行为

`resolveAppEntitlement()` 要求调用方明确传入：
- entitlement_id；
- device_id；
- Token；
- 服务端 Token 验证回调；
- 可注入测试时钟。

解析器使用参数化 SQL：
`SELECT id, admin_user_id, device_id, expires_at, status FROM app_entitlements WHERE id = ? AND device_id = ? LIMIT 1`

安全属性：
1. 通过 entitlement_id + device_id 精确选择，不按 created_at 取最新授权。
2. 管理员身份只从 D1 返回记录读取，不接受客户端传入的 admin_user_id。
3. 校验 entitlement 绑定、active 状态、到期时间和 Token。
4. D1 异常、Token 验证异常、时间格式错误均 fail closed。
5. 不执行任何数据库写入。

本 helper 使用的列名均在第四十九批 Worker 的现有查询中出现过；这不等于已验证生产 D1 schema。

## 3. 自动化测试

GitHub Actions：
- Run ID：`45955817050`
- Commit：`b181cb6ce7e52aefa0b1ae9d178a40e09b1022cd`
- 结果：`completed / success`
- Workflow：<https://github.com/sxna-web/XYmonihtml/actions/runs/45955817050>
- Node：22
- 步骤：Resolver 语法检查成功；entitlement resolver 测试步骤成功。

测试覆盖 14 个用例：
1. 同一设备的较早 entitlement 可精确命中，不会被较新记录遮蔽。
2. 同设备另一管理员 entitlement 可独立命中。
3. A Token 不能认证 B entitlement。
4. 错误 device_id 不会选中授权。
5. 缺少 entitlement_id 在访问 D1 前拒绝。
6. 缺少 Token 在访问 D1 前拒绝。
7. 非 active 授权拒绝。
8. 已过期授权拒绝。
9. 非法到期时间 fail closed。
10. D1 查询异常 fail closed。
11. Token verifier 异常 fail closed。
12. 客户端伪造 admin_user_id 不影响服务端归属。
13. 非法 device_id 在访问 D1 前拒绝。
14. 非法服务器时钟 fail closed。

CI 的 job 与两个步骤均为 success。该证据只证明隔离 helper 在 Node.js 22 下语法检查和 mock 测试通过，不证明 Cloudflare Workers runtime 或真实 D1 集成通过。

## 4. 尚未修复/接入的现有风险

本批刻意没有将 helper 接入第四十九批 Worker，原因是 APK 实际协议尚未解包确认，且接口响应兼容与免费授权边界仍需单独实施/测试。以下风险仍存在于旧 Worker，不能视为已修复：
- `/api/app/status` 当前缺少 Token 校验；
- `/api/app/groups` 的 free grant 路径仍有仅凭 device_id 读取风险；
- `/api/app/free` 仍需区分公开绑定入口与受保护节点数据读取；
- Token HMAC 密钥固定回退仍未实施 fail-closed 迁移；
- nodes/groups/links 仍使用 latest-only entitlement 选择和 query Token；
- nodes 尚未严格限制在实际 APP 分组授权范围；
- APK 是否能提供 entitlement_id、Header Token、多授权本地命名空间尚未确认。

## 5. 影响、回滚与生产保护

- D1 schema/data：无影响，未访问、未修改。
- Worker/HTML：原始文件和现有 Worker 未修改；本批只新增独立 helper。
- Secrets/环境变量：未读取、未修改。
- APK：未解包、未修改。
- Cloudflare：未访问、未部署。
- 回滚：删除本批独立目录和 workflow 文件，或通过 Git commit 回退；不涉及数据库回滚。

## 6. 第五十三批唯一接手卡

**第五十三批：APP 读取接口认证边界与分组数据范围的隔离 Handler 验证。**

1. 重读 AGENTS、功能基线、API 规范、总方案、进度、第五十一/五十二批报告。
2. 检查本批 resolver 和 CI 结果，保持第五十二批文件不覆盖。
3. 在新版本目录建立只读 APP read-handler 测试 harness；优先围绕 status、groups、free、links、nodes。
4. 对每个接口分别测试：无 Token、错误 Token、错配 entitlement/device、同设备两个管理员 entitlement、过期/撤销和 D1 异常。
5. 先定义 free share code 的“绑定入口”与“节点内容读取”边界，不得在缺少设备凭证时直接下发受保护节点数据。
6. 对 nodes/groups 建立分组/来源授权范围测试；未核实真实关联字段前，不改生产 SQL。
7. 不更改 APK 协议，不接入旧 Worker，不改 D1 schema，不操作 Secrets，不部署。
8. APK 源码继续标记未解包；不得声称 Header Token 或多授权客户端兼容。
9. 完成后更新报告、开发进度、总方案与第五十四批接手卡。

