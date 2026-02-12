   # 发布Expo新版本

   请按照以下步骤完成Expo项目的版本发布：

   ## 📋 发布流程

   ### 1. 环境检查
   - 确认当前分支是 main
   - 如果有未提交的改动，**不要**先提交，说明稍后会与版本号修改一并提交
   - 确认是否已登录GitHub CLI（gh auth status）

   ### 2. 确认版本号
   - 读取 package.json 中的当前版本号
   - **使用 AskUserQuestion 工具**询问要发布的新版本号，提供四个选项：
     - 无需修改
     - **Patch** (x.x.X+1): 修复bug，小改动
     - **Minor** (x.X+1.0): 新功能，向后兼容
     - **Major** (X+1.0.0): 重大更新，可能不兼容
     - **自定义**: 用户手动输入版本号
   - 显示即将更新的版本号（当前 → 新版本）

   ### 3. 更新版本号（如果需要）
   只需要更新以下文件的版本号（使用中文与我交流）：
   - `package.json` 的 `version` 字段
   - `app.config.js` 的 `buildNumber` 和 `versionCode`两个字段

   **操作要求：**
   - 向我展示所有即将修改的内容（用diff格式）
   - 等待我确认后再执行修改
   - **重要**：更新完版本号后，**不要立即提交**，将在步骤5与暂存区的其他改动一并提交

   ### 4. 构建Android APK
   - 提示用户自行构建APK后再开始下面的工作
   - 用户反馈完成后，继续下面的工作
   - 重命名APK文件：将APK重命名为 {APP_NAME}-v{VERSION}.apk 格式

   ### 5. Git提交与标签
   - 读取从上一个版本标签到当前的所有commit历史
   - 分析这些commits，生成2-3个建议的commit message
   - 使用 AskUserQuestion 工具让用户选择提交信息：
     - 显示2-3个AI生成的commit message建议（作为选项）
     - 每个建议都应该包含主要改动总结
     - 提供"自定义"选项，让用户输入自己的message
   - 提交所有改动（包括版本号修改和暂存区已有的代码改动）：
     git add .
     git commit -m "用户选择或输入的message"
   - 说明：此提交会包含版本号文件修改和之前暂存的所有代码改动
   - 创建带注释的标签：
     git tag -a vX.X.X -m "版本 X.X.X"
   - 推送代码和标签：
     git push origin main
     git push origin vX.X.X

   ### 6. 创建GitHub Release
   - 分析从上一个版本到当前版本的所有commits
   - 生成2-3个版本主题建议
     - 示例："编辑器增强与稳定性改进"、"多功能优化版本"、"性能提升与问题修复"
   - 使用 AskUserQuestion 工具让用户选择版本主题：
     - 显示2-3个AI生成的主题建议
     - 提供"自定义"选项，让用户输入自己的主题
   - 根据commit历史自动生成Release Notes草稿，包含：
     - 🎉 新功能列表
     - 🔧 优化改进列表
     - 🐛 问题修复列表
     - 📦 安装说明
     - 📊 版本信息（版本号、构建号、APK大小等）
   - 使用 AskUserQuestion 工具让用户确认或修改Release Notes：
     - 选项1: "使用AI生成的Release Notes"
     - 选项2: "我要补充内容"（可以输入额外说明）
     - 选项3: "完全自定义"（用户提供完整内容）
   - **创建临时Release Notes文件**：将生成的Release
   Notes内容写入临时文件（如release-notes.md），避免直接传递字符串时出现格式问题
   - **使用gh release create命令创建Release**：使用--notes-file参数从文件中读取Release Notes
     gh release create vX.X.X {APP_NAME}-v{VERSION}.apk --title "vX.X.X - 版本主题" --notes-file
   release-notes.md
   - **清理临时文件**：发布完成后删除临时的release-notes.md文件
   - 示例：
     # 将Release Notes写入临时文件
     cat > release-notes.md << 'EXAMPLE_NOTES'
     ## 🐛 问题修复
     - 修复编辑器功能

     ## 📦 安装说明
     下载 `MDNote-v0.2.3.apk` 并安装到您的Android设备。
     EXAMPLE_NOTES

     # 创建Release
     gh release create v0.2.3 MDNote-v0.2.3.apk -t "v0.2.3 - 编辑器修复版本" --notes-file
   release-notes.md

     # 清理临时文件
     rm release-notes.md

   Release Notes格式示例：
   ## 🎉 新功能
   - 功能1
   - 功能2

   ## 🔧 优化改进
   - 改进1
   - 改进2

   ## 🐛 问题修复
   - 修复1
   - 修复2

   ## 📦 安装说明
   下载 `{APP_NAME}-vX.X.X.apk` 并安装到您的Android设备。

   ## 📊 版本信息
   - **版本号**：X.X.X
   - **构建号**：Android versionCode XX, iOS Build XX
   - **APK大小**：约XXM

   ### 7. 完成反馈
   - 显示GitHub Release URL
   - 总结本次发布：
     - 版本号变更（旧版本 → 新版本）
     - 更新的文件列表
     - 重命名后的APK文件名和大小
     - Git commit和tag信息

   ⚠️ 注意事项
   - 所有交流使用中文
   - 所有需要用户决策的地方都使用 AskUserQuestion 工具，提供AI建议选项 + 开放性输入
   - 每个关键步骤都需要等待我的确认
   - 如果发现工作目录不干净，询问是否继续
   - 如果gh未登录或token过期，提示先运行 gh auth login
   - APK文件必须重命名，格式为 {APP_NAME}-v{VERSION}.apk，不包含架构信息

   🔧 智能处理
   - APK文件名：构建后自动重命名为 {APP_NAME}-v{VERSION}.apk 格式，不包含架构信息
   - iOS检测：自动检测ios目录和版本配置文件位置（Info.plist 或 project.pbxproj）
   - 版本号解析：自动解析当前版本号并正确递增
   - 错误恢复：如果某步骤失败，提供回滚建议
   - AI辅助决策：所有需要输入的地方都提供AI生成的建议选项