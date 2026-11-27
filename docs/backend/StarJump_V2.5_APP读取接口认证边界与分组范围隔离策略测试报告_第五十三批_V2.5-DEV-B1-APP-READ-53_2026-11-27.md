# 星跃管理平台 V2.5｜APP 读取接口认证边界与分组范围隔离策略测试报告

- 批次：第五十三批
- 版本：`V2.5-DEV-B1-APP-READ-53`
- 日期：2026-11-27
- 状态：**隔离策略 helper 已编码；CI 通过；未接入 Worker；不可部署**
- 仓库：`sxna-web/XYmonihtml` / `main`

## 1. 基线与影响范围

- 读取当前根目录 AGENTS、功能基线、API 权限规范、目录规范、第五十二批报告及 helper。
- 核查 Worker：`backend/worker/V2.5-DEV-B1-CORE-AUTH-49/Worker.js`，Blob SHA `a4689380215e95c1c9f605fc974cc553b3e7037f`。
- 原始 Worker/HTML 基线未修改；第四十九批 Worker 未修改；第五十二批 resolver 只读复用。
- 本批只新增独立策略模块、测试、README 和 CI workflow。

## 2. 本批新增文件

- `backend/worker/V2.5-DEV-B1-APP-READ-53/read-access-policy.mjs`
- `backend/worker/V2.5-DEV-B1-APP-READ-53/read-access-policy.test.mjs`
- `backend/worker/V2.5-DEV-B1-APP-READ-53/README.md`
- `.github/workflows/worker-app-read53-tests.yml`

## 3. 现有 Worker 静态事实

核对第四十九批 Worker 的实际代码：
- `/api/app/status` 只按 device_id 查询最新 entitlement，未校验 Token。
- `/api/app/nodes` 按 device_id 取最新 active entitlement 后验证 query Token；节点查询按 admin_user_id 获取该管理员全部已分配、已批准、已启用来源，不限 APP 分组授权范围。
- `/api/app/groups` 按 device_id 取最新 active entitlement；无有效 entitlement 时，按 device_id 读取 `app_free_grants` 并下发免费组节点，没有 Token 校验。
- `/api/app/free` 可由 admin ID 或 share code 解析管理员，并直接返回免费节点内容。
- `/api/app/links` 按 device_id 取最新 active entitlement，再验证 query Token，随后按 admin_user_id 取链接。
- `groupNodeList` 按 group_id 关联 app_group_sources，但没有同时以 entitlement admin_user_id 验证 app_groups 父记录归属；在现有 Worker 的 groups handler 中，父分组是按 admin_user_id 取出后再调用，因此 handler 需要持续保证此父子约束。

## 4. 本批策略实现

### 4.1 受保护读取接口
helper 对 status/groups/links/nodes 统一调用第五十二批精确 entitlement resolver，必须提供明确 entitlement_id、device_id、Token 和服务端 verifier。拒绝错误 Token、错配设备、过期/撤销授权和 D1 异常。

### 4.2 免费分享编号
将 free share-code 路径明确区分为 `BIND_ADMIN_ONLY`：
- 只允许解析管理员绑定身份；
- 不授权读取节点或分组内容；
- 无有效管理员解析结果拒绝。
这保留“通过管理员身份 ID/分享编号绑定免费分组”的产品入口，但不把编号当作 APP 用户身份凭证。

### 4.3 分组和来源范围
新增 scope predicate：数据行管理员必须等于 entitlement 管理员；若属于分组资源，还必须命中调用方明确提供的 allowedGroupIds。没有分组范围列表时 fail closed。

**重要限制：** 当前已核查 Worker 源码并未证实 entitlement 与 APP 分组之间存在完整、可靠的直接授权关联字段。本批不发明 join、不改现有 SQL，因此 scope predicate 只是隔离策略组件，尚未接入实际数据查询。

## 5. 自动化测试

GitHub Actions：
- Run ID：`45956257572`
- Commit：`536d46787778d1106b4ab5183618dcf628d9dfd1`
- 结果：`completed / success`
- 链接：<https://github.com/sxna-web/XYmonihtml/actions/runs/45956257572>
- Node.js：22
- 语法检查：成功
- Policy tests：成功
- 测试用例：23 项（status/groups/links/nodes 每个接口缺失/错误 Token；两个管理员 entitlement 分别命中；跨 Token/设备拒绝；过期/撤销/D1 异常拒绝；free 仅绑定不读节点；未知 endpoint 拒绝；管理员数据与分组范围错配拒绝）。

此证据只证明隔离 helper 在 Node.js 22 + mock D1 下通过，不证明实际 Worker handler、Cloudflare Workers runtime 或生产 D1 已通过。

## 6. 尚未修复事项

- 本批没有把 helper 接入 Worker 的实际 status/groups/free/links/nodes handler。
- 旧 Worker status 无 Token、groups free-grant device_id 旁路、free 直接返回节点、latest-only、query Token 和 nodes 全管理员来源下发等问题仍然存在。
- APK 源码 ZIP 未解包，无法确认客户端是否可提供 entitlement_id 或 Header Token；没有改变旧协议。
- 真实 D1 schema/关联关系未核实，不能凭 mock 测试宣称分组授权查询已可部署。
- APP HMAC Secret 固定回退未改。

## 7. 数据库、生产与回滚

- D1：未连接、未查询、未修改、未迁移。
- Worker/HTML：既有业务文件未修改。
- Secrets：未读取/修改。
- APK：未解包/修改。
- Cloudflare：未访问/部署。
- 回滚：删除本批独立目录及 workflow，或通过 Git commit 回退；无数据回滚。

## 8. 第五十四批唯一接手卡

**第五十四批：APP 读取接口与分组授权关系的源码/数据契约核实及最小接入方案。**

1. 重读 AGENTS、功能基线、API 规范、目录规范、总方案、进度和第五十一至五十三批报告。
2. 先核对仓库实际 DDL/迁移和 Worker 的 APP 相关 SQL，明确 app_entitlements、app_groups、app_group_sources、app_group_members、app_free_grants、admin_share_codes 的字段与关联语义；仅仓库证据，不推断生产 D1。
3. 查找是否存在卡密到分组的授权关联（如 app_card_group_assignments 或现有其他表）；不能假设字段名。
4. 明确 APP entitlement 与 public/assigned/free 分组可见规则的关联方式，特别是卡密授权分组必须按该卡密管理员和配置组范围过滤。
5. 输出 status/groups/free/links/nodes 的最小兼容接入方案、响应结构影响和 APK 协议风险。
6. 如关联字段足够清晰，可在独立新版本 Worker 副本实施单一读取 handler，并用 Worker.fetch + mock D1 测试；若字段不充分，继续记录阻塞，不编造 SQL。
7. 不改 D1 schema、不操作生产环境、不操作 Secrets、不部署；不擅自改 APK query Token 协议。
8. 完成后更新报告、开发进度、总方案与第五十五批接手卡。

