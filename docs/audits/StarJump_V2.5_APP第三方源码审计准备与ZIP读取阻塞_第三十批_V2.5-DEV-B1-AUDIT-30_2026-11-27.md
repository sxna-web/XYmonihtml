# 星跃管理平台 V2.5｜APP 第三方源码审计准备与 ZIP 读取阻塞记录

- **批次**：第三十批
- **版本标识**：V2.5-DEV-B1-AUDIT-30
- **日期**：2026-11-27
- **状态**：仓库核查完成 / 只读扫描工具已提交 / GitHub Actions 尚未运行；不可部署
- **仓库/分支**：sxna-web/XYmonihtml / main
- **依据**：AGENTS.md、仓库目录规范、V2.5 功能基线、APP 第三方源码审计门禁（第二十九批）
- **范围**：核对 APK ZIP 文件元数据、验证二进制读取限制，建立仓库内只读扫描流程。没有修改 APK ZIP、业务代码、D1、Worker、Secrets 或生产环境。

## 1. 原始 ZIP 文件核验

GitHub 仓库根目录存在两个 APK 源码 ZIP：

| 文件 | 大小 | Git Blob SHA |
|---|---:|---|
| StarJump-6.00.47-source .zip | 2,377,487 bytes | 6cadab77895a29db38c3d5e2a4a2c20192255ed7 |
| StarJump-6.00.48-source.zip | 2,323,467 bytes | 2b8b6d105019fb90341c7178438b2d6b0473699f |

GitHub Contents API 能返回上述文件的路径、大小、blob SHA 和原始下载地址；但当前连接器对 Git Blob / 原始 ZIP 的二进制响应返回“only accepts UTF-8 text”，不能取得 ZIP 字节。之前 fetch_file 的 base64 读取也未返回可用内容。

**当前审计状态：ZIP 文件存在已确认；ZIP 内部目录、许可证、源码和依赖均未核实。** 不能据此判断 APK 没有第三方限制。

## 2. 已提交的只读扫描工具

新增：
- `tools/apk_audit/scan_source_zip.py`
- `.github/workflows/apk-source-audit.yml`

工作流仅由 `workflow_dispatch` 手动触发，不会因 push 自动执行。执行内容：
1. Checkout 仓库；
2. 校验两个 ZIP 文件均存在；
3. 输出原包 SHA-256；
4. 使用 Python 标准库读取 ZIP 条目，不把源码解压到仓库、不执行 APK 或 Gradle；
5. 生成 ZIP 文件清单、许可证候选文件名、AndroidManifest 候选路径；
6. 提取 Gradle 依赖坐标候选；
7. 仅记录 URL 主机名，不输出 URL 路径或参数；
8. 对授权激活、设备绑定、远程配置/停用、更新、遥测、支付订阅、隐私采集等关键词记录命中文件路径和行号，不输出匹配源码行；
9. 将脱敏盘点报告作为 GitHub Actions artifact 保存 14 天。

安全边界：
- 工作流只读仓库内容；权限仅 `contents: read`。
- 不调用生产 Worker，不访问 D1，不读取 Secrets，不签名、不构建、不发布 APK。
- 扫描器不执行 ZIP 内代码，也不把命中内容直接写入 Actions 日志。
- 关键词扫描只能作为线索，不能替代完整许可证审查、依赖 SBOM、代码审计或隔离动态测试。

## 3. 本批影响与回滚

- 影响范围：新增一个 Python 只读扫描脚本和一个手动 GitHub Actions 工作流。
- 数据库影响：无。
- Worker / HTML / APP 业务行为影响：无。
- 生产部署影响：无。
- 回滚方式：删除本批新增的两个文件即可；原始 ZIP 和历史提交均保留。
- 工作流尚未运行，因此尚无 ZIP 完整性、内部文件清单或关键词命中结果，不能声称扫描通过。

## 4. 尚需执行的步骤

需要在 GitHub Actions 中手动运行一次：
1. 打开仓库 Actions；
2. 选择 “APK Source ZIP Audit (Manual)”；
3. 点击 “Run workflow”；
4. 等待完成后下载 artifact：`starjump-apk-source-audit-report`。

如果工作流失败，先读取失败日志并修复扫描器，不修改或重新上传原始 ZIP。

## 5. 后续正式审计门禁

拿到扫描报告后，逐项检查：
- LICENSE / NOTICE / COPYING 与商业授权协议；
- Gradle 依赖及其许可证、版本、来源，形成 SBOM；
- AndroidManifest 权限、Service、Receiver、Provider、Intent Filter；
- 第三方域名、授权服务器、更新地址和远程配置；
- 设备 ID / 签名证书 / 包名绑定与授权有效期；
- 遥测、崩溃收集、日志上报和订阅数据外传；
- 混淆代码、AAR/JAR、so 原生库和运行时下载模块；
- 星跃是否拥有自主构建、签名、发布和撤回权限。

只有取得源码证据并完成必要的隔离动态测试后，才能对某项限制标记“存在 / 未发现 / 已排除 / 未知”。“未发现”不等于“已排除”。

---
**结论：第三十批已建立不改动原始 ZIP 的仓库内只读扫描通道，但 GitHub Actions 尚未运行，APP 第三方授权与技术锁定审计仍处于阻塞待执行状态。不可部署。**
