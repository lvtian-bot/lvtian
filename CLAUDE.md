# CLAUDE.md

该文件为 Claude Code (claude.ai/code) 在该代码库中工作提供指导。

## 工作要求
1. 所有的思考过程、回答、Task文档、Implementation Plan文档以及其他生成的Artifacts必须使用中文编写，即便我是用英文提问
2. 不得在经过我的同意之前，直接开始修改代码
3. 对于我提出的问题，不得在没有了解相关信息的情况下通过猜测和推断回答，可以自行读取文件进行分析后回答
4. 回答我的问题时要有结构化思路，不需要在回复中呈现过多的代码，更多的需要用自然语言说清楚方案逻辑和内容
5. 命令行解释器是git bash，相关工具请使用与git bash兼容的命令行工具

## 项目概述

MDNote 是一个基于 Expo 框架构建的 React Native 移动应用，用于管理带有云同步功能的 Markdown 笔记。它包含基于时间线的"闪记"系统、文件浏览器以及与腾讯云对象存储 (COS) 的集成，用于云备份和同步。

## 开发命令

### 项目设置
```bash
# 安装依赖
npm install
```

### 运行应用
```bash
# 启动 Metro 打包器
npm start

# 运行在 Android 设备上
npm run android

# 运行在 iOS 设备上
npm run ios
```

### 开发工具
```bash
# 运行代码检查
npm run lint

# 运行测试
npm test

# 执行预构建 (生成原生项目文件)
npm run prebuild
```

## 架构概述

### 导航结构
- **根导航器** (`AppNavigator`): Native Stack Navigator
  - `MainTabs`: Bottom Tab Navigator (闪记时间线、文件浏览器、设置)
  - `Editor`: 全屏编辑器，用于查看/编辑 Markdown 文件

### 状态管理 (Zustand)
应用使用 Zustand 存储并结合 AsyncStorage 持久化：

1. **`useSettingsStore`** (`src/store/useSettingsStore.ts`)
   - 主题设置
   - 腾讯云 COS 配置 (bucket, region)
   - 闪记配置 (路径、文件名)
   - 注意：凭证 (secretId/secretKey) 单独存储在 react-native-keychain 中以确保安全

2. **`useSyncStore`** (`src/store/useSyncStore.ts`)
   - 云同步上传队列
   - 队列项状态跟踪 (pending, uploading, failed, success)
   - 重试次数管理

3. **`useFileMetadataStore`** (`src/store/useFileMetadataStore.ts`)
   - 存储文件的 etags 和 lastModified 时间戳
   - 用于同步过程中的冲突检测

4. **`useShareStore`** (`src/store/useShareStore.ts`)
   - 处理分享内容的状态管理
   - 保存待处理的分享内容


### 核心服务

#### 文件系统服务 (`src/services/FileSystemService.ts`)
- 封装 react-native-fs 用于本地文件操作
- 根路径: `RNFS.DocumentDirectoryPath`
- 提供的操作: listFiles, readFile, writeFile, createDirectory, deleteFile, moveFile, exists, stat

#### 云服务 (`src/services/CloudService.ts`)
- 云存储提供程序的抽象接口 (`ICloudProvider`)
- 当前实现: `TencentCOSProvider`
- 提供程序在应用初始化时根据设置进行配置
- 提供的操作: uploadFile, downloadFile, getCloudFileContent, listFiles, deleteFile, headFile

### 新增组件与导航

#### 状态横幅组件 (`src/components/StatusBanner.tsx`)
- 统一管理的状态提示组件
- 支持 warning、info、error 三种类型
- 支持自定义操作按钮
- 模块化的离线、冲突等横幅提示

#### 笔记导航器 (`src/navigation/NoteNavigator.tsx`)
- 新增的笔记列表导航器
- 使用 React Navigation Native Stack
- 提供笔记文件的浏览和管理功能

### 上传流程

1. **初始化** (App.tsx):
   - 应用启动时，检查有效的 COS 配置和凭证
   - 如果找到，则初始化 TencentCOSProvider 并将其设置到 cloudService

2. **写入流程**:
   - 用户保存文件 → 本地写入 → 直接上传到云端
   - 上传成功: 更新本地元数据 (etag, lastModified)
   - 上传失败: 记录错误并加入重试队列
   - 上传结果 (etag, lastModified) 存储在 FileMetadataStore 中

3. **冲突检测**:
   - EditorScreen 和 TimelineScreen 在加载时检查同步状态
   - 通过 `headFile()` 比较本地 etag 与云端 etag
   - 如果不匹配: 通过比较时间戳确定云端版本新还是本地版本新
   - 用户可以选择: 使用云端版本、保留本地版本或上传本地版本 (强制)

### 闪记功能

闪记是存储在单个文件中的带时间戳的 Markdown 条目 (默认文件名: `flash_notes.md`)。

**格式**:
```markdown
## 2025-01-19 14:30:00
Note content here

## 2025-01-18 10:15:00
Another note
```

**实现**:
- `TimelineScreen`: 解析闪记文件，按时间倒序显示
- `FlashNoteInputModal`: 用于添加/编辑单个闪记的模态组件
- 文件路径可通过设置配置 (flashNoteConfig.path + flashNoteConfig.filename)
- `GlobalShareHandler`: 处理从其他应用分享的内容并自动显示闪记输入模态框

### 国际化 (i18n)

- 使用 i18next 配合 react-i18next
- 翻译文件: `src/locales/en.json`, `src/locales/zh.json`
- 默认语言: 中文 (`zh`), 回退语言: 英文 (`en`)
- 在 `src/i18n.ts` 中初始化, 在 `App.tsx` 顶部导入

### 主题

- 主题集中管理在 `src/utils/theme.ts`
- 当前使用浅色主题配色
- 设置中存在主题模式选项，但深色模式尚未完全实现

## 关键技术模式

### 安全考虑
- **永远不要提交凭证**: COS secretId/secretKey 存储在 react-native-keychain (加密存储) 中
- 设置存储仅包含非敏感配置 (bucket, region)
- 实现新的云提供程序时，请遵循相同的模式

### 文件路径
- 应用中的所有文件路径都相对于 `DocumentDirectoryPath`
- 云端密钥通常与文件路径匹配以保持目录结构
- 直接使用 `filePath` 作为云端密钥以保持层级结构

### TypeScript 类型
- 导航类型: `src/types/navigation.ts` (RootStackParamList, MainTabParamList)
- 服务接口: 在各自的服务文件中定义
- 文件/云端项目类型: `FileItem`, `CloudFileItem`

## 常见开发任务

当添加涉及文件操作的功能时:
1. 所有本地文件操作都使用 `fsService` (不要直接使用 RNFS)
2. 对于云操作，首先检查 `cloudService.isConfigured()`
3. 上传成功后更新 FileMetadataStore 中的 etag/lastModified
4. 考虑同步冲突 - 如果读取云文件，需要实现冲突检测

当添加新屏幕时:
1. 在 `src/types/navigation.ts` 中定义路由参数
2. 将屏幕添加到适当的导航器 (AppNavigator 或 TabNavigator)
3. 所有用户可见的字符串都使用 `useTranslation()` hook
4. 遵循现有屏幕模式实现同步状态指示器

当修改状态存储时:
1. 所有存储都使用 Zustand 并配合 persist middleware
2. 修改后测试持久化功能 (清除应用数据并重新加载)
3. 敏感数据使用 react-native-keychain 而不是 AsyncStorage

当使用 Expo 配置插件时:
1. 在 `app.config.js` 中定义自定义配置插件
2. 使用 `withAndroidManifest` 和 `withMainActivity` 等函数修改原生配置
3. 遵循 Expo 最佳实践实现插件逻辑
