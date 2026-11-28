# 2026-11-29｜StarJump 6.00.50 ARM64 CI 构建与 APK 签名核验记录

- 项目：StarJump APP 6.00.50 DEV
- 仓库：sxna-web/XYmonihtml
- 分支：main
- Actions run：46184869195
- Job：141102408156
- 构建 head SHA：84546b5042ae2fafd84b8574f662ba21e0f60c04
- Artifact ID：15279088043

## 1. CI 构建结果

- GitHub Actions run conclusion：success。
- Gradle：BUILD SUCCESSFUL；app:assembleOssRelease 完成，日志显示 60 actionable tasks executed。
- 工作流 APK metadata 验证通过：applicationId com.xingyue.app；versionName 6.00.50；versionCode 360；application-label 星跃；native-code arm64-v8a。
- compileSdkVersion 35；targetSdkVersion 35；日志显示 sdkVersion 21。
- Artifact：StarJump-6.00.50-ARM64-DEV；Artifact ZIP 大小 15,904,567 bytes。
- Artifact ZIP SHA-256：3cad5e0e570fea6ba65a58a7f427fb7ebdf258efe7fefaff538644919fc42a25；与 GitHub Artifact API digest 一致。

## 2. Artifact 下载与本地复核

- 下载文件：/mnt/data/StarJump-6.00.50-ARM64-DEV.zip。
- ZIP 内容：StarJump-6.00.50-arm64-v8a.apk（17,023,200 bytes）及其 .sha256 文件。
- ZIP 完整性：unzip -t PASS。
- APK SHA-256：ff0e1609cc3fd4cbc8f5cccb55dcdcfe7ee975225cde38f3ba681837e7ef747b。
- 使用 Artifact 内附 .sha256 执行 sha256sum -c：OK。
- APK ZIP 容器完整性：unzip -t PASS。
- APK 仅发现 lib/arm64-v8a/libgojni.so；ABI 与工作流目标一致。

## 3. 关键阻塞：APK 未签名

- 对 APK ZIP 结构检查，未发现 META-INF/MANIFEST.MF、META-INF/*.RSA/DSA/EC 等 v1 签名材料。
- 检查 APK Signing Block 的标准位置与 magic，未发现 APK Sig Block 42（v2/v3 签名块）。
- jarsigner -verify 输出 jar is unsigned；该结果与 APK 内缺少 v1/v2/v3 签名结构相互印证。
- GitHub Actions 日志中 Initialize Gradle assets 环境变量 LOCAL_PROPERTIES 为空。
- 因此当前 Artifact 虽然构建成功、元数据正确、校验和正确，但 APK 未签名，不能作为可安装 APK 交付，也不能称为可发布版。
- 工作流目前只验证 aapt metadata 与 SHA-256，没有 apksigner verify 门禁；需要先配置正式签名材料，再补签名校验步骤。

## 4. 其他构建告警

- Java 21 编译时提示 Java source/target 8 已过时；这是 warning，不影响本次构建成功，但后续应评估兼容后调整。
- 依赖源码中有 deprecated API 与 unchecked/unsafe operations warnings；本批未擅自修改第三方代码。

## 5. 安全与部署边界

- 未生成或修改签名 keystore；未把私钥、密码写入仓库或日志。
- 未修改 Worker、D1、Secrets、Cloudflare 配置；未执行 DDL/DML；未部署生产；未合并 PR。
- 未在真实 Android 设备安装/升级；未做 Room instrumentation、Keystore runtime、多管理员多卡授权、API/Worker/D1 联调。

## 6. 下一步

1. 先确认用户是否已有可继续沿用的 APP 发布签名 keystore；如果没有，需要明确授权生成一把新的长期发布密钥。签名密钥必须离线备份，不能提交到公开 GitHub 仓库。
2. 用户确认签名方案后，将 keystore 与密码通过 GitHub Actions Secrets 安全注入，确保 Gradle release variant 实际签名。
3. 在工作流增加 apksigner verify --verbose --print-certs 门禁；无签名或验签失败不得上传名为可安装包的 Artifact。
4. 重新构建后下载 APK，核对包名/版本/ABI/签名证书指纹/sha256，再安排真机安装与升级测试。

本记录结论：CI 编译通过；Artifact 完整且校验和匹配；APK 签名缺失，当前不可安装交付。