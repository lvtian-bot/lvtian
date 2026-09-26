---
name: mdnote-release
description: MDNote 正式版发布与构建发版的操作手册。用户提到发布/发版/出正式版/打 tag/发 Release/构建 APK，或要求把改动打包送到手机上时使用，即使没有明确说"发布"二字。
---

# MDNote 正式版发布

发布分层架构与策略：

- **整包发版（云端构建）**：原生依赖增删升级、`app.config.js` 原生字段改动、版本号递增时使用。走 **GitHub Actions 云端构建**（打 tag 触发，自动在 GitHub Actions 运行并产出 APK 至 GitHub Releases），本地无需占用编译资源。
- **热更新发布（OTA 云端分发）**：仅修改 JS/TS 业务代码、样式或静态资源，不涉及原生代码或依赖改动时使用。走 **EAS Update**（在 GitHub Actions 中手动触发工作流 `EAS Update` 或执行 `npm run update:prod`），用户 App 启动时自动从 Expo 服务器下载最新 bundle 并生效，无需重新安装 APK。
- **本地构建（备用路径）**：仅当 GitHub Actions 不可用或无网络时使用，详见 `references/local-build.md`。

本技能是 MDNote 发版流程的唯一权威规范。

---

## 整包发版（云端构建流水线）

### 前置条件
GitHub 仓库 `lvtian-bot/MDNote` 的 Settings → Secrets and variables → Actions 中配齐以下机密项：
- `ENV_FILE`：生产环境变量（若有）
- `KEYSTORE_BASE64`：`keystore/simplejournal.keystore` 的 Base64 编码字符串
- `KEYSTORE_PROPERTIES`：`keystore/keystore.properties` 的完整文本
- `EXPO_TOKEN`：Expo 网页 Settings → Access Tokens 生成的访问令牌（供 CI 构建调用）
流水线定义文件位于 `.github/workflows/release.yml`（由 `v*` tag 触发）。

---

### 标准发版步骤

1. **工作区检查**：
   - 确认当前在 `main` 分支；
   - 检查 `git status`，逐项核对全部未提交改动与未跟踪文件，按提交规范分类提交，确保工作区干净后再发版：云端构建按标签对应的提交打包，未提交内容不会进入安装包；仅当某项改动确实不宜随本次发布时，向用户说明并经确认后留在工作区，不得默默排除。

2. **递增版本号**：
   - 更新 `package.json` 中的 `version` 字段（按语义化版本从末位递增，如 `0.3.0` → `0.3.1`）；
   - 更新 `app.config.js` 中的 `android.versionCode`（每发一版严格递增 +1）及 `ios.buildNumber`。
   - **向用户报出拟用版本号**（项目铁律：发版前必须向用户展示拟用版本号并取得明确确认）。

3. **提交与推送代码**：
   ```bash
   git add package.json app.config.js
   git commit -m "chore: 发布 X.Y.Z"
   git push origin main
   ```

4. **打 Tag 并推送**：
   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```
   *注意：tag 必须与 package.json 中的 version 严格一致，CI 流水线会自动校验，不一致将直接拒绝构建。*

5. **监控云端构建进度**：
   ```bash
   gh run list --repo lvtian-bot/MDNote --workflow Release
   gh run watch <run-id> --repo lvtian-bot/MDNote --exit-status
   ```
   若构建失败，使用以下命令定位日志：
   ```bash
   gh run view <run-id> --repo lvtian-bot/MDNote --log-failed
   ```

6. **验证产物与告知用户**：
   - 检查 GitHub Release：
     ```bash
     gh release view vX.Y.Z --repo lvtian-bot/MDNote --json assets
     ```
   - 确认产物 `MDNote-X.Y.Z.apk` 已成功挂载；
   - 告知用户前往 GitHub Releases 页面下载 APK 覆盖安装（签名一致时直接覆盖，本地数据不受影响）。

---

## 热更新发布（EAS Update 流程）

当仅修改 JS 代码或前端资源时：

1. **工作区检查与构建 Web 资源**：
   确保 TypeScript 检查通过，并已编译嵌入式 Web 资源：
   ```bash
   npx tsc --noEmit
   npm run build:web
   ```

2. **发布热更新**：
   - **方式 A（首选：GitHub Actions）**：进入 GitHub 仓库页面 Actions → `EAS Update (热更新发布)` → 点击 `Run workflow`，选择 `production` 渠道并填写更新说明即可。
   - **方式 B（本地 CLI）**：在本地运行：
     ```bash
     npm run update:prod -- --message "更新说明"
     ```
   更新推送到 Expo 服务器后，用户下次启动 App 时将自动拉取并应用最新代码。

---

## 本地构建（备用路径，非必要不用）

仅当云端构建不可用时使用，执行前必须阅读本技能的 `references/local-build.md`，执行本地打包命令：
```bash
eas build --platform android --profile preview --local
```
或通过 Android 原生 Gradle 执行打包。
