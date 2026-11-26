# 星跃 V2.5 模拟 HTML 与正式系统边界审计（2026-11-27）

## 1. 审计对象与范围

- 仓库：`sxna-web/XYmonihtml`
- 分支：`main`
- 文件：`星跃模拟后台 1.4.61.html`
- 当前 HTML blob SHA：`d046f71caa5af96b0c0978013771cb0a8f101739`
- 文件大小：约 995,913 bytes（GitHub 页面显示值）
- 只读静态源码检查；没有运行页面、访问生产服务或修改正式系统。

## 2. 核心结论：该 HTML 是本地模拟系统，不是正式管理后台

文件头部 meta description 明确写明：
`数据仅保存在当前浏览器，不连接生产 Worker 或 D1。`

页面底部启动日志也明确显示：
`前端本地模拟系统 · 数据保存在本地 · 不连接生产接口`

源码中未检出：
- `/api/` 路径调用
- `fetch(` 网络请求
- `XMLHttpRequest`
- `Authorization` / `Bearer` 请求头

本地数据保存主要通过 `localStorage` 的 `saveDB()` / `loadDB()` 实现；图片资源使用独立 IndexedDB 数据库 `starjump_v1_454_demo_isolated_images`。

因此：
- HTML 内的用户、管理员、卡密、设备、来源、节点、授权、转换记录均为浏览器本地模拟数据。
- HTML 页面中的按钮、状态提示和操作日志不能证明 Worker/D1 已执行同样动作。
- 本 HTML 不能作为正式 Worker API 联调或生产权限验收的证据。
- 不得把它直接部署为生产管理后台，除非先完成正式 API 接入、认证、服务端权限校验、错误处理和安全审计。

## 3. 模拟页面已有功能（只证明模拟逻辑存在）

### 3.1 多管理员身份模拟

相关函数：
- `sj51GetAppIdentities(deviceId, all)`
- `sj51GetAppGroupsForIdentity(deviceId, userId, adminId)`
- `sj51BindIdentity(deviceId, userId, adminId)`
- `sj51PinIdentity(deviceId, adminId, pinned)`

观察：
- 身份记录按 `deviceId + adminId` 查找，可让同一设备模拟保存多个管理员身份。
- 当前展示最多 3 条，或通过 all 参数返回全部。
- 置顶操作会取消同一设备其他身份的 pinned 状态。
- 绑定函数调用本地 `sj51EnsureIdentity()`，并将记录保存到浏览器 DB。
- `sj51EnsureIdentity()` 找到同一 deviceId/adminId 的记录时，会更新其 userId；用户身份切换/冲突规则仍需明确。

结论：只证明 HTML 模拟了多管理员身份列表和绑定行为；不证明 APK 设备身份安全，也不证明 Worker 支持多 entitlement 集合。

### 3.2 模拟分组授权读取

`sj51GetAppGroupsForIdentity()` 会在本地检查身份记录、管理员状态、分组类型、免费资格和已激活卡密的分组 ID，再从本地 `DB.nodes` 组装节点列表。

该函数没有网络请求，也没有 Worker Token 验证；所有授权判断都依赖本地模拟对象。

### 3.3 模拟分组失效和 24 小时清理

`sj51InvalidateGroup()`：
- 增加 group generation；
- 设置 appEnabled=false 和失效时间；
- 在本地 groupLifecycleEvents 写入 cleanupAt（当前时间 + 24 小时）；
- 记录节点 ID；
- 在本地标记相关分享失效，并从相关模拟卡密配置中移除该分组。

`processGroupLifecycleCleanup()`：
- 到期后清理本地模拟 appNodeCache 中对应分组/旧 generation 的缓存关系；
- 尽量保留仍被其他分组引用的缓存；
- 分组已删除时解除模拟节点的该分组关联；
- 更新 cleanupStatus、cleanupCount、cleanedAt 和日志。

重要限制：
- `DB.appNodeCache` 是 HTML 模拟数据，不是 Android APK 的真实本地缓存。
- 该清理函数没有向服务端提交 cleanup acknowledgement。
- 该函数没有服务端撤销墓碑、同步游标或 Worker 版本确认。
- 源码中的清理触发点是页面启动、`sj51GetAppGroupsForIdentity()`、生命周期页面渲染和人工操作；没有发现专门负责此 24 小时清理的后台定时调度。因而页面关闭期间不会由 HTML 自身保证准点执行；再次打开/调用相关函数时才可能补做。
- 不能把模拟清理成功 toast 当作真实 APK 设备已清理。

## 4. 新增验收风险

### SIM-01：模拟页面与生产 API 完全隔离

影响：测试人员可能把本地操作成功误判为生产接口成功。

要求：
1. 正式版必须明确区分 mock/demo 与 production 模式。
2. Mock 模式使用明显标识，禁止显示“已同步生产”“服务端已撤销”等会造成误解的状态。
3. 正式模式所有权限判断必须由 Worker 再次执行，不能信任前端隐藏按钮。
4. 生产 API 接入后，为每个页面操作定义请求方法、路径、认证、权限、请求体、成功响应、错误响应和审计事件。

### SIM-02：模拟 24 小时清理不是后台准时任务

影响：浏览器页面不打开时不会自行运行这段页面 JavaScript；而 APK 本地缓存更不受 HTML 页面调度控制。

要求：
1. Worker 维护服务端撤销版本和清理任务状态。
2. APK 在前台同步、后台任务、重启恢复等允许的生命周期中检查撤销版本。
3. 到期清理策略必须定义“服务端失效时间”和“客户端最迟执行时间”，不要承诺浏览器 JS 或 Android 后台任务绝对准点。
4. 设备恢复联网时，先应用撤销事件再拉取新节点。
5. 设备回传 cleanup acknowledgement，服务端分别记录成功、失败、未确认和最后联系时间。

### SIM-03：本地身份绑定不能替代设备认证

影响：HTML 可通过本地数据构造 deviceId/userId/adminId；这不是不可伪造的设备凭证。

要求：
1. APK 使用服务端签发、可撤销的设备凭证或密钥证明流程。
2. device_id 只作设备标识，不作为唯一认证因子。
3. 绑定、解绑、换机、重置、用户退出、管理员停权需有服务端事件与设备端状态迁移。
4. 明确同一设备多个 APP 用户、同一用户多个设备、同一设备多个管理员的冲突策略。

## 5. 与正式 Worker 的职责分界

| 能力 | 模拟 HTML 当前状态 | 正式系统应由谁负责 |
|---|---|---|
| 管理员/用户界面 | 本地模拟 | HTML 前端展示 |
| 登录和会话认证 | 本地模拟身份状态 | Worker |
| VIP 与卡密有效性 | 本地模拟日期/状态判断 | Worker + D1 |
| 来源所有权 | 本地模拟字段 | Worker + D1 |
| APP entitlement | 本地模拟记录 | Worker + D1 |
| APP Token 签发/验证 | 未接生产 API | Worker |
| 节点版本与撤销墓碑 | 本地 generation 事件仅作演示 | Worker + D1 |
| APK 节点缓存 | 模拟 DB.appNodeCache | Android APK |
| 设备清理确认 | 未实现服务端确认 | APK + Worker + D1 |
| 审计日志 | 本地模拟日志 | Worker + D1 |

## 6. 下一步工作

1. 将 1.4.61 仅作为业务交互与规则参考，不将其视为生产前端。
2. 继续以原始 Worker 为正式后端审计基线，逐项建立 API 契约。
3. HTML 正式接入前，先形成 mock-to-production 接口映射表；没有对应 Worker 接口的功能标记为“待开发”，不能假装已有。
4. APK ZIP 解包后，独立核对 Android 本地缓存、身份持久化、Token 存储、后台清理与服务端确认。
5. 未经明确批准，不修改正式 Worker、D1、Cloudflare Secrets 或生产部署。

## 7. 可复核源码位置

- HTML 文件：`星跃模拟后台 1.4.61.html`
- 本地数据保存：`saveDB()`、`loadDB()`、`localStorage`
- 图片 IndexedDB：`ImageStore`
- 多身份：`sj51GetAppIdentities()`、`sj51EnsureIdentity()`、`sj51BindIdentity()`
- 分组授权：`sj51GetAppGroupsForIdentity()`
- 分组失效：`sj51InvalidateGroup()`
- 本地清理：`processGroupLifecycleCleanup()`
- 启动调用：`boot()`
