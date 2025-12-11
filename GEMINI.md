# 项目概览

这是一个名为“MDNote”的 React Native 应用程序，设计为一款云优先、本地加速的 Markdown 笔记应用。它允许用户直接从云存储提供商读取和写入笔记，主要侧重于腾讯云对象存储（COS）。

## 工作方式
1. 【重要！！！】【IMPORTANT!!!】所有的回答、Task文档、Implementation Plan文档以及其他生成的Artifacts必须使用中文，即便我是用英文提问！！！
2. 不得在经过我的同意之前，直接开始修改代码
3. 对于我提出的问题，不得在没有了解相关信息的情况下通过猜测和推断回答，可以自行读取文件进行分析后回答
4. 回答我的问题时要有结构化思路，不需要在回复中呈现过多的代码，更多的需要用自然语言说清楚方案逻辑和内容

## 构建与运行

### 前提条件

- Node.js (LTS v20+)
- JDK 17
- Android Studio 和 Android SDK
- Git

### 安装步骤

1. 克隆代码仓库。
2. 安装项目依赖：
   ```bash
   npm install
   ```
3. (可选) 如果更改了编辑器逻辑，需要重新构建编辑器捆绑包：
   ```bash
   cd editor-bundler
   npm install
   npm run build
   # 输出文件将自动复制到 ../assets/codemirror.bundle.js，或者需要手动复制。
   ```

### 运行应用

1. **启动 Metro Bundler：**
   ```bash
   npm start
   ```

2. **在 Android 上运行：**
   ```bash
   npm run android
   ```

3. **在 iOS 上运行：**
   ```bash
   npm run ios
   ```
   (需要 macOS 环境、Xcode 和 CocoaPods)

### 测试

运行单元测试：
```bash
npm test
```

### 代码检查

检查代码风格问题：
```bash
npm run lint
```

## 开发约定

- **语言：** TypeScript 5.x (严格模式)
- **框架：** React Native 0.81.5 (Expo 托管/裸工作流)
- **状态管理：** Zustand
- **导航：** React Navigation 7 (原生堆栈 + 底部标签)
- **国际化：** i18next (通过 src/i18n.ts 配置)
- **云集成：** 采用策略模式支持多种云服务提供商 (已实现腾讯 COS)。
- **安全性：** 凭据使用 `expo-secure-store` 安全存储。
- **编辑器：** 基于 CodeMirror 6 的 Webview 编辑器。

## 项目结构

- `src/`：主要源代码目录。
  - `components/`：可重用组件 (UI、模态框等)。
  - `hooks/`：自定义 React Hook (例如 `useCloudSync`)。
  - `locales/`：翻译文件 (en.json, zh.json)。
  - `navigation/`：导航逻辑 (应用、笔记、标签页导航器)。
  - `screens/`：应用界面。
  - `services/`：核心业务逻辑 (云服务、文件系统服务、同步服务、腾讯 COS 提供商)。
  - `store/`：状态管理存储 (Zustand)。
  - `types/`：TypeScript 类型定义。
  - `utils/`：实用工具函数。
  - `i18n.ts`：国际化配置。
- `android/`：Android 原生代码。
- `assets/`：静态资源 (图片、编辑器 HTML/捆绑包)。
- `docs/`：文档 (架构、产品需求文档、指南)。
- `editor-bundler/`：用于捆绑 CodeMirror 编辑器的工具。
- `plugins/`：Expo 配置插件 (例如 `withAndroidShare.js`)。
- `PRD.md`：(旧路径，请参见 docs/PRD.md)