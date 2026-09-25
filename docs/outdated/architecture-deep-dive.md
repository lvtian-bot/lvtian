# MDNote 架构深度解析

> **适用场景**: 当需要深入理解项目架构、数据流、目录结构时阅读此文档

---

## 1. 目录结构树

```
D:/MDNote/
├── 📄 App.tsx                          # 应用主入口 (Provider 初始化)
├── 📄 index.js                         # React Native 入口点
├── 📄 app.config.js                    # Expo 配置 + 自定义插件
├── 📄 GEMINI.md                        # AI 工作指南
├── 📄 CLAUDE.md                        # Claude 特定工作指南
│
├── 📁 src/                             # 源代码根目录
│   ├── 📄 i18n.ts                      # 国际化配置 (优先加载)
│   │
│   ├── 📁 services/                    # ⭐ 核心业务服务 (业务逻辑集中地)
│   │   ├── CloudService.ts             # 云服务抽象接口 (ICloudProvider)
│   │   ├── TencentCOSProvider.ts       # 腾讯云 COS 实现
│   │   ├── WebDavProvider.ts           # WebDAV 协议实现 (坚果云)
│   │   ├── FileSystemService.ts        # 文件系统封装 (唯一 IO 入口)
│   │   ├── FlashNoteService.ts         # 闪念笔记业务逻辑
│   │   ├── SyncService.ts              # 同步服务 (上传/下载/冲突)
│   │   ├── ShadowFileService.ts        # 影子文件管理
│   │   └── LLMService.ts               # AI 大模型服务
│   │
│   ├── 📁 store/                       # ⭐ Zustand 状态管理
│   │   ├── useSettingsStore.ts         # 应用设置 (主题/云配置)
│   │   ├── useSyncStore.ts             # 云同步队列状态
│   │   ├── useFileMetadataStore.ts     # 文件元数据 (etag/lastModified)
│   │   ├── useShareStore.ts            # 分享内容处理
│   │   ├── useFileListStore.ts         # 文件列表缓存
│   │   └── useAIStore.ts               # AI 功能状态
│   │
│   ├── 📁 screens/                     # 应用屏幕页面
│   │   ├── FlashScreen.tsx             # 闪念时间线页
│   │   ├── TodoScreen.tsx              # 待办事项页
│   │   ├── NoteScreen.tsx              # 笔记浏览页
│   │   ├── PreviewScreen.tsx           # 文件预览页
│   │   ├── EditorScreen.tsx            # Markdown 编辑器
│   │   ├── SettingsScreen.tsx          # 设置页
│   │   ├── CloudRepoConfigScreen.tsx   # 云存储配置页
│   │   ├── AIConfigScreen.tsx          # AI 配置页
│   │   └── AgentScreen.tsx             # AI Agent 对话页
│   │
│   ├── 📁 navigation/                  # 导航配置
│   │   ├── AppNavigator.tsx            # 主应用导航器
│   │   ├── TabNavigator.tsx            # 底部 Tab 导航
│   │   └── NoteNavigator.tsx           # 笔记子导航
│   │
│   ├── 📁 components/                  # UI 组件库
│   │   ├── FlashNoteInputModal.tsx     # 闪念输入模态框
│   │   ├── StatusBanner.tsx            # 状态横幅组件
│   │   ├── StatusBannerContainer.tsx   # 横幅容器 (优先级管理)
│   │   ├── AISidebar.tsx               # AI 功能侧栏
│   │   ├── DatePickerModal.tsx         # 日期选择器
│   │   └── ...                         # 其他 UI 组件
│   │
│   ├── 📁 hooks/                       # 自定义 Hooks
│   │   ├── useCloudSync.ts             # 云同步 Hook
│   │   └── useFlashNoteList.ts         # 闪念列表 Hook
│   │
│   ├── 📁 utils/                       # 工具函数
│   │   ├── theme.ts                    # 主题配置
│   │   ├── pathUtils.ts                # 路径处理
│   │   ├── mergeUtils.ts               # 三路合并工具
│   │   ├── cosSignature.ts             # COS 签名工具
│   │   └── TodoParser.ts               # Todo 解析器
│   │
│   ├── 📁 types/                       # TypeScript 类型定义
│   │   ├── navigation.ts               # 导航类型
│   │   └── todo.ts                     # Todo 类型
│   │
│   ├── 📁 locales/                     # 国际化翻译
│   │   ├── zh.json                     # 中文 (默认)
│   │   └── en.json                     # 英文 (回退)
│   │
│   └── 📁 constants/                   # 常量定义
│       └── events.ts                   # 事件常量
│
├── 📁 docs/                            # ⭐ 项目文档 (AI 必读)
│   ├── FlashScreen_TodoSreen_logic.md  # 闪念/待办三阶段同步逻辑
│   ├── PreviewScreen_logic.md          # 预览页状态判断矩阵
│   ├── BrowerScreen_cloud_first.md     # 云优先架构原则
│   ├── editor-implementation-guide.md  # 编辑器实现指南
│   └── ai-guides/                      # AI 辅助文档目录
│       ├── architecture-deep-dive.md   # 本文档
│       ├── business-logic-details.md   # 业务逻辑详解
│       ├── troubleshooting-guide.md    # 故障排查指南
│       └── coding-examples.md          # 代码示例集
│
├── 📁 android/                         # Android 原生代码 (Prebuild 生成)
├── 📁 plugins/                         # Expo 配置插件
├── 📁 editor-bundler/                  # CodeMirror 编辑器独立构建工程
└── 📁 assets/                          # 静态资源
```

---

## 2. 核心文件快速定位表

**🎯 当需要修改某个功能时，请定位到以下文件：**

| 需要修改的功能 | 定位到文件 | 关键位置/说明 |
|---------------|-----------|--------------|
| **云同步逻辑** | `CloudService.ts` | `ICloudProvider` 接口定义 |
| **冲突检测策略** | `FlashNoteService.ts` | 三路合并逻辑 |
| **闪念格式解析** | `FlashScreen.tsx` | 时间戳正则匹配 |
| **待办解析器** | `TodoParser.ts` | Markdown Todo 语法解析 |
| **配置新云服务** | `TencentCOSProvider.ts` / `WebDAVProvider.ts` | 实现 `ICloudProvider` 接口 |
| **主题颜色** | `theme.ts` | 颜色常量定义 |
| **上传重试机制** | `useSyncStore.ts` | 队列管理逻辑 |
| **文件元数据** | `useFileMetadataStore.ts` | ETag 和 uploadState 管理 |
| **导航路由** | `navigation.ts` (types) | 导航参数类型定义 |
| **状态横幅优先级** | `StatusBannerContainer.tsx` | Banner 显示优先级逻辑 |
| **AI 对话流** | `LLMService.ts` | 流式对话实现 |
| **国际化文本** | `locales/zh.json` | 中文翻译键值对 |

---

## 3. 导航结构图

```
AppNavigator (Native Stack)
├─ MainTabs (Bottom Tab Navigator)
│  ├─ FlashTab
│  │  └─ FlashScreen (闪念时间线)
│  ├─ NoteTab
│  │  └─ NoteNavigator (Native Stack)
│  │     ├─ NoteScreen (文件浏览列表)
│  │     └─ PreviewScreen (文件预览)
│  ├─ TodoTab
│  │  └─ TodoScreen (待办事项)
│  └─ SettingsTab
│     ├─ SettingsScreen (设置首页)
│     ├─ CloudRepoConfigScreen (云配置)
│     ├─ FlashNoteConfigScreen (闪念配置)
│     └─ AIConfigScreen (AI 配置)
│
├─ EditorScreen (全屏编辑器，Modal 呈现)
└─ AgentScreen (AI Agent 对话页)
```

---

## 4. 核心数据流图

### 📤 Write-Through 上传机制

```
用户保存文件 (EditorScreen)
    ↓
FileSystemService.writeFile(path, content)  ← ① 本地写入
    ↓
计算文件哈希 (crypto-js/MD5)
    ↓
CloudService.uploadFile(path, content)      ← ② 立即上传
    ↓
    ├─ 【成功】
    │   ↓
    │   FileMetadataStore.setMetadata({
    │       etag: cloudEtag,                ← ③ 更新元数据
    │       syncedHash: localHash,
    │       uploadState: null
    │   })
    │   ↓
    │   SyncStore.removeFromQueue(path)     ← ④ 从队列移除
    │
    └─ 【失败】
        ↓
        FileMetadataStore.setUploadState(
            path,
            isPreconditionFailed ? 'conflict-failed' : 'failed'
        )                                   ← ⑤ 记录失败状态
        ↓
        SyncStore.addToQueue(path, 'retry') ← ⑥ 加入重试队列
```

### 📥 按需下载机制（云优先策略）

```
用户点击文件列表项 (NoteScreen)
    ↓
检查本地文件: fsService.exists(path)
    ↓
    ├─ 【本地存在】
    │   ↓
    │   直接打开 PreviewScreen
    │
    └─ 【本地不存在】
        ↓
        显示加载指示器
        ↓
        CloudService.downloadFile(cloudPath, localPath)
        ↓
        ├─ 【下载成功】
        │   ↓
        │   保存文件元数据 (etag, lastModified)
        │   ↓
        │   打开 PreviewScreen
        │
        └─ 【下载失败】
            ↓
            显示错误提示: "下载失败，请检查网络"
```

### 🔄 三阶段同步流程 (FlashScreen/TodoScreen)

```
页面获得焦点 (useFocusEffect)
    ↓
触发: FlashNoteService.syncAll()
    ↓
┌─────────────────────────────────────────┐
│ Stage 1: 环境检查                        │
├─────────────────────────────────────────┤
│ ① 离线检查 (netState.isConnected)       │
│    → 失败: 返回 offline 状态             │
│ ② 配置检查 (cloudService.isConfigured())│
│    → 失败: 返回 not-configured 状态      │
└─────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────┐
│ Stage 2: 本地修复与救援                  │
├─────────────────────────────────────────┤
│ 扫描本地文件:                            │
│ ① uploadState === 'failed'              │
│    → 自动重试上传一次                    │
│    → 仍失败: 加入 uploadErrorFiles       │
│ ② uploadState === 'conflict-failed'     │
│    → 尝试智能合并 (Smart Merge)          │
│    → 成功: 自动上传 (用户无感知)          │
│    → 失败: 加入 conflictedFiles          │
└─────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────┐
│ Stage 3: 全量同步与冲突检测               │
├─────────────────────────────────────────┤
│ ① 联合本地 + 云端文件列表                │
│ ② 逐文件比对 (headFile 获取 etag)       │
│    - Local Only → 上传                  │
│    - Cloud Only → 下载                  │
│    - L == C → 跳过                      │
│    - L != C (仅云变) → 自动下载          │
│    - L != C (仅本地变) → 自动上传        │
│    - L != C (双向冲突) → 智能合并        │
│        · 成功: 上传                     │
│        · 失败: 加入 conflictedFiles     │
└─────────────────────────────────────────┘
    ↓
返回同步结果: {
    status: 'synced' | 'conflict' | 'error',
    uploadErrorFiles: [],
    conflictedFiles: []
}
```

---

## 5. 状态管理架构 (Zustand Stores)

### 5.1 Store 依赖关系图

```
useSettingsStore (设置中心)
    ↓ 提供配置
    ├─→ CloudService (云服务初始化)
    ├─→ FlashNoteService (闪念配置)
    └─→ LLMService (AI 配置)

useFileMetadataStore (元数据中心)
    ↓ 存储 etag/uploadState
    ├─→ CloudService (冲突检测)
    ├─→ SyncService (同步状态)
    └─→ PreviewScreen (状态显示)

useSyncStore (队列中心)
    ↓ 管理上传队列
    ├─→ CloudService (上传任务)
    └─→ SyncService (重试逻辑)

useFileListStore (缓存中心)
    ↓ 缓存云端列表
    └─→ NoteScreen (首屏加载)

useAIStore (AI 状态)
    ↓ 对话历史
    └─→ AgentScreen (会话管理)

useShareStore (分享处理)
    ↓ 待处理分享
    └─→ GlobalShareHandler (跨应用分享)
```

### 5.2 持久化策略

| Store | 持久化 | 存储介质 | 说明 |
|-------|-------|---------|------|
| `useSettingsStore` | ✅ | AsyncStorage | SecretKey 单独存 SecureStore |
| `useFileMetadataStore` | ✅ | AsyncStorage | `uploading` 状态不持久化 |
| `useSyncStore` | ✅ | AsyncStorage | 队列状态持久化 |
| `useFileListStore` | ✅ | AsyncStorage | 缓存云端列表 |
| `useAIStore` | ✅ | AsyncStorage | 对话历史 |
| `useShareStore` | ❌ | 内存 | 临时状态 |

---

## 6. 云服务策略模式设计

### 6.1 ICloudProvider 接口定义

```typescript
interface ICloudProvider {
  // 基础操作
  uploadFile(cloudPath: string, localPath: string, options?: UploadOptions): Promise<UploadResult>;
  downloadFile(cloudPath: string, localPath: string): Promise<void>;
  deleteFile(cloudPath: string): Promise<void>;

  // 元数据操作
  headFile(cloudPath: string): Promise<FileMetadata>;
  listFiles(prefix: string): Promise<CloudFileItem[]>;

  // 配置检查
  isConfigured(): boolean;
}
```

### 6.2 当前实现

| 实现类 | 协议 | 使用场景 | 配置项 |
|--------|------|---------|--------|
| `TencentCOSProvider` | 腾讯云 COS API | 默认云存储 | bucket, region, secretId, secretKey |
| `WebDAVProvider` | WebDAV (HTTP/HTTPS) | 坚果云、自建服务器 | serverUrl, username, password |

### 6.3 扩展新云服务流程

1. 在 `src/services/` 创建 `XxxProvider.ts`
2. 实现 `ICloudProvider` 接口
3. 在 `CloudService.ts` 的 `initProvider()` 添加分支
4. 在 `useSettingsStore.ts` 添加配置字段
5. 在 `CloudRepoConfigScreen.tsx` 添加 UI 配置项

---

## 7. 文件系统封装（Scoped Storage 兼容）

### 7.1 FileSystemService 核心职责

- **统一 API**: 封装 `expo-file-system` 的新老 API
- **路径处理**: 自动处理 `DocumentDirectoryPath` 前缀
- **权限兼容**: 兼容 Android 11+ Scoped Storage
- **错误处理**: 统一异常捕获和转换

### 7.2 禁止行为

❌ **严禁直接使用** `react-native-fs` 或 `expo-file-system` 的原生 API
✅ **必须通过** `fsService` 实例调用

**错误示例**:
```typescript
import RNFS from 'react-native-fs';
await RNFS.readFile(path); // ❌ 禁止
```

**正确示例**:
```typescript
import { fsService } from '@/services/FileSystemService';
await fsService.readFile(path); // ✅ 正确
```

---

## 8. 事件驱动通信机制

### 8.1 核心事件列表

| 事件常量 | 触发时机 | 监听位置 | 传递数据 |
|---------|---------|---------|---------|
| `UPLOAD_COMPLETED_EVENT` | 上传成功/失败 | PreviewScreen, FlashScreen | `{ path, success, etag? }` |
| `SHARE_RECEIVED_EVENT` | 接收外部分享 | App.tsx | `{ content, type }` |
| `SYNC_STATUS_CHANGED` | 同步状态变化 | 所有同步相关页面 | `{ status, path? }` |
| `AI_RESPONSE_STREAM` | AI 流式响应 | AgentScreen | `{ delta, done }` |

### 8.2 事件通信示例

```typescript
import { DeviceEventEmitter } from 'react-native';
import { UPLOAD_COMPLETED_EVENT } from '@/constants/events';

// 发送事件
DeviceEventEmitter.emit(UPLOAD_COMPLETED_EVENT, {
  path: 'notes/test.md',
  success: true,
  etag: 'abc123'
});

// 监听事件
useEffect(() => {
  const listener = DeviceEventEmitter.addListener(
    UPLOAD_COMPLETED_EVENT,
    (data) => {
      if (data.path === currentFilePath) {
        refreshSyncStatus();
      }
    }
  );

  return () => listener.remove();
}, [currentFilePath]);
```

---

## 9. 国际化架构 (i18next)

### 9.1 加载优先级

```
App.tsx 启动
    ↓
首位加载: import './src/i18n.ts'  ← 必须在所有组件前
    ↓
i18next.init({
  lng: 'zh',        ← 默认中文
  fallbackLng: 'en' ← 回退英文
})
    ↓
加载翻译资源: zh.json, en.json
    ↓
组件可使用: useTranslation()
```

### 9.2 添加新翻译键

1. 在 `src/locales/zh.json` 添加中文翻译
2. 在 `src/locales/en.json` 添加英文翻译（可选，但推荐）
3. 组件中使用: `t('your.new.key')`

**最佳实践**:
- 键名使用小写点分隔: `screen.flash.title`
- 避免硬编码文本，所有用户可见文本都使用 `t()`
- 支持插值: `t('greeting', { name: 'User' })`

---

## 10. Expo Prebuild 与配置插件

### 10.1 核心原则

**【铁律】严禁直接修改 `android/` 或 `ios/` 目录下的代码！**

原因: 每次运行 `npx expo prebuild` 都会根据 `app.config.js` 重新生成这些目录，手动修改会丢失。

### 10.2 正确的原生修改流程

1. 在 `plugins/` 目录创建配置插件
2. 在 `app.config.js` 的 `plugins` 数组中引用
3. 运行 `npx expo prebuild --clean` 重新生成

**示例：禁用 Android 预测性返回手势**

```javascript
// plugins/withDisablePredictiveBack.js
const { withAndroidManifest } = require('@expo/config-plugins');

module.exports = function withDisablePredictiveBack(config) {
  return withAndroidManifest(config, async (config) => {
    const androidManifest = config.modResults;
    const application = androidManifest.manifest.application[0];

    // 添加 android:enableOnBackInvokedCallback="false"
    application.$['android:enableOnBackInvokedCallback'] = 'false';

    return config;
  });
};
```

```javascript
// app.config.js
module.exports = {
  // ...
  plugins: [
    './plugins/withDisablePredictiveBack.js',
    // 其他插件...
  ]
};
```

---

## 11. 编辑器构建流程（editor-bundler）

### 11.1 独立构建原因

CodeMirror 是一个完整的浏览器端编辑器，需要独立打包后嵌入到 React Native WebView 中。

### 11.2 构建步骤

```bash
cd editor-bundler
npm install  # 初次需要安装依赖
npm run build
```

构建产物: `assets/codemirror.bundle.js`

### 11.3 修改流程

1. 修改 `editor-bundler/src/editor.js`
2. 运行 `npm run build`
3. 确认 `assets/codemirror.bundle.js` 已更新
4. 在 React Native 端重新加载应用

**注意**: 修改编辑器后必须重新构建，否则 WebView 中仍使用旧代码。
