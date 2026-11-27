# 星跃管理平台 V2.5｜APP v2 五域协议缺口收敛与客户端兼容设计报告

- 批次：`V2.5-DEV-B1-APP-IDENTITY-83`
- 日期：2026-11-28
- 状态：`PROTOCOL_CONTRACT_DESIGN_COMPLETE / 6_00_48_SOURCE_UNAVAILABLE / TOKENIZER_LOCAL_TEST_PASS_18_OF_18 / CONTRACT_CONTENT_CHECK_PASS_9_OF_9 / ACTIONS_RUN_NOT_VERIFIED / D1_NOT_TESTED / APP_NOT_INTEGRATED / NOT_DEPLOYABLE`

## 一、本批结论

1. 继续盘点 Library 全部 ZIP 文件及按文件名/内容检索后，仍只找到 `StarJump-6.00.47-source.zip`，没有 6.00.48 源码副本。仓库中的 6.00.48 ZIP 二进制无法由当前 GitHub 文本接口解包。6.00.47 结论不得外推到 6.00.48 或已安装 APK。
2. 将用户确认的多管理员、多卡密、免费组去重、不同管理员隔离、同名卡密组序列号区分、空分组卡密可激活、默认一台/有效 VIP 管理员最高五台的规则映射到客户端缺口。
3. 完成 APP v2 五个协议域的逻辑契约设计：discovery/bind、card activation、entitlement status、composed catalog、group generation/tombstone/ack。所列 operation 是逻辑契约名，不是已注册 Worker 路由。
4. 明确 Android Keystore 非导出私钥、备份排除、恢复后重新绑定和 verified HTTPS App Links challenge callback 方案；不改 APK。
5. 将未来 statement manifest 拆分为 identity adapter、limiter adapter、disposable harness 三个接口；补充保守的匿名 positional placeholder 词法扫描器及反例测试。
6. HMAC 设计提出 opaque dimension_id + per-key-version alias registry 候选，并列出并发首次建档、别名映射冲突、回填高水位、回滚与清理等尚未证明的义务；不冻结生产方案。

## 二、客户端兼容性矩阵

| 项目 | 6.00.47 证据 | 本批判断 |
|---|---|---|
| APP 身份发现/绑定 | 未发现 Worker identity caller、challenge 或 binding storage | 缺失 |
| 卡密激活/多 entitlement | 未发现激活 API、entitlement token 或多卡密状态存储 | 缺失 |
| 多管理员与免费组组合 | 未发现服务端 composed catalog 调用 | 缺失 |
| 同名卡密组序列号区分 | 未发现来源凭证分组模型 | 缺失 |
| 设备公钥证明 | 未发现 Android Keystore 设备身份流程 | 缺失 |
| 身份 deep-link callback | 现有 deep link 是订阅/代理配置导入 | 缺失；不可复用导入 scheme |
| generation/tombstone/ack | 未发现客户端增量目录和清理确认 | 缺失 |
| 6.00.48 | 源码 ZIP 不可读取 | 未核实 |

## 三、文件与测试

新增：
- `backend/worker/V2.5-DEV-B1-APP-IDENTITY-83/APP-V2-PROTOCOL-CONTRACT.md`
- `backend/worker/V2.5-DEV-B1-APP-IDENTITY-83/placeholder_tokenizer.py`
- `backend/worker/V2.5-DEV-B1-APP-IDENTITY-83/test_placeholder_tokenizer.py`
- `backend/worker/V2.5-DEV-B1-APP-IDENTITY-83/test_batch83_contract.py`
- `backend/worker/V2.5-DEV-B1-APP-IDENTITY-83/README.md`
- `.github/workflows/worker-app-identity83-review.yml`

验证证据：
- Python 3.13 本地隔离执行 tokenizer 测试：18/18 passed；额外覆盖数字形式命名参数标记与空 SQL 拒绝。
- 对 GitHub 复读的协议文档执行 9 组内容完整性检查：9/9 passed。
- Workflow 已提交，但本轮没有取得对应 GitHub Actions run/job/log 的可核验结果，因此不标记 Actions CI 通过。
- tokenizer 仅是 SQL lexical scanner，不解析 SQL 语义、不执行 SQL，也不证明 D1 兼容。

## 四、风险与阻塞

- U80-01..08 仍未见用户决策，相关审计、actor/reason、payload、rotation side effects、challenge cleanup 和 retry 语义继续 fail closed。
- 6.00.48 源码未取得；当前客户端集成能力仍以 6.00.47 为限。
- APP v2 仍未注册到 Worker，客户端未接入；feature flag 必须保持 OFF。
- HMAC dimension_id/alias registry 只是待证明候选，不是生产架构批准。
- 未取得专用 disposable D1 名称/ID/binding 和授权；D1_NOT_TESTED。
- 无真实 APK runtime、网络抓包、Worker 集成、D1 SQL 或迁移证据。

## 五、数据库、部署与安全边界

本批仅新增 DEV 文档、Python 词法扫描器、离线测试和 GitHub Actions workflow。未连接 D1、未执行 SQL、未创建 migration、未读取凭证/Secrets、未修改 Worker/HTML/APK/Room/Cloudflare 配置、未部署生产环境。

## 六、第八十四批唯一接手卡

**HMAC dimension alias registry 并发一致性证明与三类 statement manifest 骨架（继续离线，不连接 D1）。**

1. 重读 AGENTS、功能/API/DB 规范、总方案、进度和第八十二/八十三批文件。
2. 为 opaque dimension_id + K1/K2 aliases 建立并发首次发现模型：K1-only/K2-only 竞争、双版本 alias 绑定、两个 dimension_id 分裂、alias 唯一性冲突、event_id tuple conflict。
3. 建立 partial backfill、高水位追赶、late retry、K1 retirement、K2 rollback、cleanup/admission race 反例；任何无法证明完整覆盖的分支 fail closed。
4. 为 identity、limiter、harness 各建独立 JSON statement-manifest schema 骨架；只定义字段与静态校验，不放生产 SQL 或真实 bind 值。
5. 复核 tokenizer 对 SQLite/D1 lexical differences 的适用边界，补充注释、引号、Unicode、空 SQL 和 malformed input 测试；不执行 SQL。
6. 若仍无法取得 6.00.48 二进制，继续保持版本未核实，不将 6.00.47 结论外推。
7. 不连接 D1、不读取凭证、不修改 Worker/HTML/APK/Room/Secrets/Cloudflare 配置、不部署。
8. 更新总进度、总方案和第八十五批唯一接手卡。
