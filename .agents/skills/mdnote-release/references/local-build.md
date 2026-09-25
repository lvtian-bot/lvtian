# 本地构建备用路径（非必要不用）

仅当 GitHub Actions 云端构建不可用时使用。Windows 环境下推荐使用 EAS 本地构建或 Gradle 直构。

---

## 方式一：EAS Local 构建（推荐）

1. 确认已安装 `eas-cli`：
   ```bash
   npm install -g eas-cli
   ```
2. 执行本地构建命令：
   ```bash
   eas build --platform android --profile preview --local
   ```
   产物将直接输出到当前根目录或指定的产物目录中。

---

## 方式二：Prebuild + Gradle 直构

1. **版本号确认与同步**：
   - 更新 `package.json` 的 `version`；
   - 更新 `app.config.js` 的 `android.versionCode`；
   - 重新执行预构建注入最新配置：
     ```bash
     npx expo prebuild --platform android --clean --no-install
     ```

2. **Gradle 编译打包**：
   ```bash
   cd android
   ./gradlew assembleRelease
   ```
   *注：助手执行时须显式保证 `JAVA_HOME` 指向 JDK 17，`ANDROID_HOME` 指向有效的 Android SDK 目录。*

3. **构建产物位置**：
   生成的 Release APK 位于：
   `android/app/build/outputs/apk/release/app-release.apk`

4. **签名验证与重命名**：
   - 将 APK 重命名为 `MDNote-vX.Y.Z.apk`；
   - 使用 `gh release create vX.Y.Z MDNote-vX.Y.Z.apk --title "vX.Y.Z"` 创建发布并附加安装包。

---

## 常见坑位与注意点

1. **原生目录不同步**：
   - 直接修改 `app.config.js` 的版本号后，如果不重新 prebuild，Gradle 可能会打包旧版本的代码与元数据。
2. **Keystore 签名文件存在性**：
   - 确保 `keystore/simplejournal.keystore` 和 `keystore/keystore.properties` 物理存在且内容未损坏，否则 Gradle 在 `signingConfigs.release` 环节会报错中止。
