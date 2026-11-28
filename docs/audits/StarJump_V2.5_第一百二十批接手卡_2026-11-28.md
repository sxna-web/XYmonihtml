# 星跃管理平台 V2.5｜第一百二十批接手卡

- 日期：2026-11-28
- 分支：`release/v2.5.0-rc1-converge`
- PR：#2，必须保持 Draft / Open / Unmerged
- 最新已知提交（本卡建立时）：`880976e6b08c3d9c8889fcbc10fb2bd7ec88dfd1`
- 重要规则：开始下一批先重新读取 branch HEAD、PR 状态和 CI；如 HEAD 已变化，以远端为准。

## 1. 本轮完成

### Batch 117
- 逐卡密分组配置 UI + Worker Protocol66 GET/PUT route。
- 真实 Staging 缺 `app_card_group_mappings` 和 `app_card_group_admin_requests`；新 route 缺表返回 503。
- 仅审查 DDL 未执行；完整 tombstone/generation/24h cleanup/ACK 未完成。
- 报告：`docs/release/V2.5.0_RC1_第十八轮逐卡密分组配置与Protocol66路由接入_2026-11-28.md`。

### Batch 118
- 实际读取 `StarJump-6.00.48-source.zip`：SHA256 `1d4f49790ef358d2d8de807fa95fd18c331f06692e1a15c4d9030c6cad8b8012`，2,323,467 bytes，628 entries。
- package `com.xingyue.app`，VERSION_NAME 6.00.48，VERSION_CODE 71，Gradle helper 乘 5，预期 Android versionCode 355。
- 客户端只有 redeem/resolve/links/version 四类星跃 API；没有 groups/free API、Idempotency-Key、tombstone/ACK。
- 当前只保存单个 token/expiry/admin，重复激活覆盖；固定五个内置组，Slot02–05 是占位符；Room ProxyGroup 缺远端 admin/card/group/generation/tombstone。
- Worker `appGroupsForDevice()` 先前只取最新 entitlement，必须与客户端共同升级。
- 报告：`docs/release/V2.5.0_RC1_第十九轮APP6.00.48客户端协议审计与上线阻断清单_2026-11-28.md`。
- 索引：`docs/app/星跃APP_6.00.48源码与接口基准索引_2026-11-28.md`。
- 临时源码 artifact 已下载审阅，Actions workflow 已恢复手动触发；不要把临时 artifact 当长期备份。

### Batch 119
- 用户明确要求 APP 用户体验优先、APP/访问工具可能不可访问、APP 内容必须有记录并能持续后续开发。
- 设计：`docs/app/星跃APP_离线可用性内容留存与用户体验连续性设计_V1_2026-11-28.md`。
- 核心原则：Room 本地优先启动；断网/timeout/429/503/空响应/截断响应不得清空旧数据；明确区分本机已保存/待同步/服务器已确认/冲突/失败；草稿自动保存；安全离线队列；敏感动作不可离线伪成功；凭证加密、日志脱敏；多卡密和免费分组去重；完整 tombstone→24h cleanup→ACK。
- 仓库必须长期记录每版源码 ZIP SHA/版本、API 契约、Room schema/migrations、关键源码路径、UI 路径、离线行为、依赖许可、测试证据和接手卡。

### Batch 120
- Worker 集成测试 mock 未模拟卡密映射 SQL 的 entitlement JOIN，导致 card_ids 读取 undefined 和跨管理员用例假失败。
- 只修正 `worker-handler.integration.test.mjs` mock，按 card/admin/device/active/expiry 匹配 entitlement 并返回 entitlement_id；未改 Worker 业务逻辑、未放宽断言。
- Commit `e88d2265bda441f5851cbb2f520f99f63620ec38`；push Run `46144087843`、PR Run `46144092736` 均 SUCCESS。

## 2. 最新 CI/PR 状态（必须重新核验）

- PR #2：最近核验仍 Open / Draft / Unmerged。
- Branch head 在 ledger commit 后为 `880976e6b08c3d9c8889fcbc10fb2bd7ec88dfd1`。
- 对该最新 head 的 CI 在本卡建立时 queued；不要引用较早 e88 的成功结果冒充 880 的检查。
- 曾经在旧 head 发现 3 个 Worker integration failures，原因是 mock 未模拟新的 entitlement JOIN；在 e88 已修复并通过。后续 head 的检查仍须核验。

## 3. 下一批优先顺序

1. 先查最新 head 的所有 Actions；如失败先取 job logs，定位真正失败测试并修复，不可忽略。
2. 继续核查 Worker `appGroupsForDevice()` 多 entitlement 合并、token 对应授权、admin isolation、free grant 去重、card mapping JOIN；新增真实语义单元测试，保持旧 APP 响应兼容。
3. 根据 6.00.48 基准建立 APP 6.00.50 的完整实施清单：多 entitlement Room migration、groups/free API、动态组模型、离线本地缓存、错误分类、有限重试、激活按钮防重复、版本检查语义统一。
4. 先设计客户端与 Worker 的 API response contract，再同步实现；不可只改后台 UI。
5. 设计并实现服务端 generation/tombstone、APP 增量同步、24h local cleanup、cleanup ACK 全闭环。
6. 真实 Staging 两张映射表仍未创建；必须先完成 migration manifest/checksum/preflight/postcondition/rollback 审查，只有用户明确批准后才能执行 Staging DDL。
7. 最终交付仍以用户要求的两个文件为核心：Worker + 后台 HTML；APP APK 作为独立客户端版本产物和测试交付。不得把测试报告当部署包。

## 4. 已知边界与禁止事项

- 当前 APP 源码 artifact 为临时审阅物；若后续拿不到源码，按源码索引和报告继续设计，重新获取时重新核 SHA 并做版本漂移核查。
- 不得推断 staging URL 是生产 URL；不得硬改 `current=60047`，需先确认 release.version_code 语义。
- 不得删除旧固定内置组、用户手动组或做 destructive Room migration。
- 不得让缓存 entitlement 绕过服务端有效期/撤销/权限判断。
- 不得在 offline queue 中伪成功激活、支付、权限提升、分享发布和不可逆删除。
- 不得执行 D1 DDL/DML、Cloudflare 部署、Secrets/binding 修改或 PR 合并，除非用户明确授权。
- 不得在 Git 或报告中写真实 Token、卡密、密钥、完整订阅 URL。

## 5. 下一批验收标准

- 用户能在网络不可用时打开 APP 并查看此前已保存内容。
- 服务端失败不等于空数据；旧节点不被覆盖。
- 多卡密授权和不同管理员分组不串数据；免费分组每管理员只出现一次。
- 用户操作记录可追溯；开发资料可在 APP 不可访问时支撑后续继续工作。
- 自动化测试全部通过；真实 D1/真实 APP/弱网设备测试如未执行，必须明确标为待验收。
