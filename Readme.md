# GEMINI.md - MDNote 项目 AI 工作指南

> **文档版本**: V6.0 (2025-12-24)
> **适用对象**: Gemini / Claude / 其他 AI 编程助手
> **维护原则**: 本文档是 AI 理解项目的唯一真相来源，所有架构变更必须同步更新此文档

---

## 1. AI 标准工作流程

```
┌─────────────────────────────────────────────────────────┐
│  Step 1: 接收任务                                        │
│  → 仔细阅读用户需求，识别关键信息                          │
└─────────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────┐
│  Step 2: 信息收集 (NEVER 猜测)                           │
│  → 使用 Read/Grep/Glob 工具读取相关文件                    │
│  → 参考 docs/ 目录下的业务逻辑文档                         │
└─────────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────┐
│  Step 3: 方案设计                                        │
│  → 遵循编码规范（第 6 章）                                │
│  → 检查是否复用现有服务/组件                              │
└─────────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────┐
│  Step 4: 征求同意                                        │
│  → 使用 AskUserQuestion 或直接询问                        │
│  → 说明方案、潜在影响、备选方案                           │
└─────────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────┐
│  Step 5: 执行修改                                        │
│  → 严格遵循 DRY 原则                                      │
│  → 修改后运行相关测试                                     │
└─────────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────────┐
│  Step 6: 验证结果                                        │
│  → 运行 lint/test 命令                                    │
│  → 向用户汇报结果                                         │
└─────────────────────────────────────────────────────────┘
```

---

## 2. 项目概览 (Project Overview)

### 2.1 产品定位

**MDNote** 是一款 **云优先 (Cloud-First)** 的现代化 Markdown 笔记应用，基于 **React Native (Expo)** 构建。

### 2.2 核心特性

| 特性 | 描述 | 技术实现 |
|------|------|----------|
| **☁️ 云优先 & 本地加速** | 云端为唯一真相来源，本地缓存加速访问 | WebDAV 协议，策略模式设计 |
| **⚡ 闪念笔记 (Flash Note)** | 快速捕捉想法的时间线笔记 | `FlashNoteService` + 三阶段同步机制 |
| **✅ 待办管理 (Todo)** | 任务管理模块 | 服务端驱动的独立待办体系（移动端就绪引导态） |
| **🤖 AI 助手 (AI Agent)** | 集成大模型对话能力，辅助整理笔记 | `LLMService` + 流式对话 |
| **🔄 智能同步** | 乐观锁 + 三路合并冲突检测 | ETag 机制 + Write-Through 策略 |
| **📱 跨平台** | Android/iOS 统一体验 | Expo SDK 57 + React Native 0.86.3 |

### 2.3 用户核心场景

```
用户打开应用
    ↓
【场景 A: 快速记录】
    → 启动默认进入 "闪念" Tab → 输入想法 → 自动同步到 WebDAV 云端

【场景 B: 浏览笔记】
    → 点击 "系统文件" Tab → 查看云端文件列表 → 点击文件 → 按需下载 → 预览/编辑

【场景 C: 管理待办】
    → 点击 "待办" Tab → 查看服务端就绪引导态

【场景 D: AI 辅助】
    → 在任意笔记页 → 打开 AI 侧栏 → 对话整理内容
```

---

## 3. 技术栈 (Tech Stack)

### 3.1 运行时环境

- **Node.js**: LTS v20+
- **JDK**: 17 (Android 构建)
- **命令行**: Git Bash (Windows) / Bash (macOS/Linux)

### 3.2 核心框架 & 版本

| 技术 | 版本 | 说明 |
|------|------|------|
| **React Native** | 0.81.5 | 移动应用核心框架 |
| **Expo** | SDK 54 | 托管工作流 + 预构建插件 |
| **React** | 19.1.0 | UI 组件库 |
| **TypeScript** | 5.x | 严格模式 (strict: true) |
| **React Navigation** | 7.x | Native Stack + Bottom Tabs |
| **Zustand** | 4.x | 轻量级状态管理 |
| **i18next** | 23.x | 国际化 (中文优先，英文回退) |

### 3.3 关键依赖库

```json
{
  "核心库": {
    "react-native-reanimated": "动画引擎",
    "react-native-gesture-handler": "手势处理",
    "expo-file-system": "文件系统操作 (新 API)",
    "expo-secure-store": "安全存储 (凭证加密)",
    "crypto-js": "哈希计算与加密",
    "react-native-fs": "文件系统 (旧 API，迁移中)",
    "react-native-keychain": "密钥链存储 (旧方案，迁移中)"
  },
  "云服务": {
    "WebDAV": "WebDAV 协议支持"
  },
  "编辑器": {
    "codemirror": "Markdown 编辑器核心",
    "react-native-webview": "WebView 容器"
  }
}
```

**⚠️ API 迁移提示**：
- 文件系统正在从 `react-native-fs` 迁移到 `expo-file-system` 新 API
- 安全存储正在从 `react-native-keychain` 迁移到 `expo-secure-store`
- 新功能开发必须优先使用新 API，但需注意兼容性

---

## 4. 架构蓝图 (Architecture Blueprint)

### 4.1 目录结构树

```
MDNote/
├── 📄 App.tsx                          # 应用主入口 (Provider 初始化)
├── 📄 index.js                         # React Native 入口点
├── 📄 app.config.js                    # Expo 配置 + 自定义插件
├── 📄 AGENTS.md                        # 工作规范与项目定义
│
├── 📁 src/                             # 源代码根目录
│   ├── 📄 i18n.ts                      # 国际化配置 (优先加载)
│   │
│   ├── 📁 services/                    # ⭐ 核心业务服务 (业务逻辑集中地)
│   │   ├── CloudService.ts             # 云服务抽象接口 (ICloudProvider)
│   │   ├── WebDavProvider.ts           # WebDAV 协议实现 (坚果云等)
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
│   │   └── ...                         # 其他 UI 组件
│   │
│   ├── 📁 hooks/                       # 自定义 Hooks
│   │   ├── useCloudSync.ts             # 云同步 Hook
│   │   └── useFlashNoteList.ts         # 闪念列表 Hook
│   │
│   ├── 📁 utils/                       # 工具函数
│   │   ├── theme.ts                    # 主题配置
│   │   ├── pathUtils.ts                # 路径处理
│   │   └── mergeUtils.ts               # 三路合并工具
│   │
│   ├── 📁 types/                       # TypeScript 类型定义
│   │   └── navigation.ts               # 导航类型
│   │
│   ├── 📁 locales/                     # 国际化翻译
│   │   ├── zh.json                     # 中文 (默认)
│   │   └── en.json                     # 英文 (回退)
│   │
│   └── 📁 constants/                   # 常量定义
│       └── events.ts                   # 事件常量
│
├── 📁 docs/                            # ⭐ 项目文档 (AI 必读)
│   ├── 技术架构.md                     # 技术架构总纲
│   └── ...                             # 各模块专题文档
│
├── 📁 android/                         # Android 原生代码 (Prebuild 生成)
├── 📁 plugins/                         # Expo 配置插件
├── 📁 src/editor-web/                  # CodeMirror 编辑器独立构建工程
└── 📁 assets/                          # 静态资源
```

### 4.2 核心文件快速索引 (AI Quick Reference)

**🎯 当你需要修改某个功能时，请定位到以下文件：**

| 需要修改的功能 | 定位到文件 | 关键位置/说明 |
|---------------|-----------|--------------|
| **云同步逻辑** | `CloudService.ts` | `ICloudProvider` 接口与策略调度 |
| **冲突检测策略** | `FlashNoteService.ts` | 闪念时间线三路合并逻辑 |
| **闪念时间格式** | `FlashNoteService.ts` | 严守 `## YYYY-MM-DD HH:mm:ss` 规范 |
| **配置云存储** | `WebDavProvider.ts` | 实现 `ICloudProvider` WebDAV 接口 |
| **主题颜色** | `theme.ts` | 颜色常量定义 |
| **上传重试机制** | `useSyncStore.ts` | 队列管理逻辑 |
| **文件元数据** | `useFileMetadataStore.ts` | ETag 和 uploadState 管理 |
| **导航路由** | `navigation.ts` (types) | 导航参数类型定义 |
| **状态横幅优先级** | `StatusBannerContainer.tsx` | Banner 显示优先级逻辑 |
| **国际化文本** | `locales/zh.json` | 中文翻译键值对 |

### 4.3 导航结构图

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

### 4.4 核心数据流图

#### 📤 Write-Through 上传机制

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
    │       lastModified: cloudLastModified,
    │       uploadState: null,
    │       syncedHash: localHash
    │   })
    │   ↓
    │   UI 显示 ✅ (同步成功)
    │
    └─ 【失败】
        ↓
        ├─ 【乐观锁冲突】PreconditionFailed (412)
        │   ↓
        │   FileMetadataStore.setMetadata({
        │       uploadState: 'conflict-failed'  ← ④ 标记冲突
        │   })
        │   ↓
        │   触发智能合并 (mergeUtils.ts)
        │
        └─ 【其他错误】网络/鉴权等
            ↓
            useSyncStore.addToQueue({          ← ⑤ 加入重试队列
                filePath: path,
                status: 'pending',
                retryCount: 0
            })
            ↓
            FileMetadataStore.setMetadata({
                uploadState: 'failed'
            })
            ↓
            UI 显示 ⚠️ (上传失败，提供重试按钮)
```

#### 📥 三阶段同步检测 (FlashScreen/TodoScreen)

```
用户进入页面 / 下拉刷新
    ↓
┌─────────────────────────────────────────────┐
│ Stage 1: 环境检查                            │
├─────────────────────────────────────────────┤
│ ① 网络检查 (NetInfo)                         │
│    → 离线? 立即中断，显示 offline Banner      │
│ ② 配置检查 (cloudService.isConfigured())     │
│    → 未配置? 立即中断，显示配置引导           │
└─────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────┐
│ Stage 2: 本地修复与救援                      │
├─────────────────────────────────────────────┤
│ 扫描本地已知文件的 FileMetadata              │
│ ① uploadState === 'failed'                  │
│    → 自动重试一次上传                         │
│    → 仍失败? 加入 uploadErrorFiles 队列       │
│ ② uploadState === 'conflict-failed'         │
│    → 立即尝试智能合并 (三路合并)              │
│       ├─ 合并成功? 自动上传，用户无感知        │
│       └─ 合并失败? 加入 conflictedFiles 队列  │
└─────────────────────────────────────────────┘
    ↓
┌─────────────────────────────────────────────┐
│ Stage 3: 全量同步与冲突检测                   │
├─────────────────────────────────────────────┤
│ ① 拉取云端列表 (cloudService.listFiles())    │
│ ② 逐文件比对 (本地哈希 vs 云端 ETag)          │
│    ├─ Local Only → 上传                      │
│    ├─ Cloud Only → 下载                      │
│    ├─ Hash Match → 跳过                      │
│    ├─ L == S, C != S → 下载 (仅云端更新)      │
│    ├─ L != S, C == S → 上传 (仅本地更新)      │
│    └─ L != S, C != S → 智能合并 (双向冲突)    │
│       ├─ 合并成功? 自动上传                   │
│       └─ 合并失败? 加入 conflictedFiles 队列  │
└─────────────────────────────────────────────┘
    ↓
最终状态:
├─ syncStatus: 'synced' | 'conflict' | 'error'
├─ uploadErrorFiles: string[]  (失败文件列表)
└─ conflictedFiles: string[]   (冲突文件列表)
```

**🔑 关键概念：三重哈希机制**
- **L (Local Hash)**: 当前本地文件的 MD5 哈希
- **C (Cloud ETag)**: 云端文件的 ETag (腾讯 COS 返回)
- **S (Synced Hash)**: 上次成功同步时的哈希 (存储在 FileMetadataStore)

**判断逻辑：**
- `L == C` → 已同步
- `L == S, C != S` → 仅云端更新 (自动下载)
- `L != S, C == S` → 仅本地更新 (自动上传)
- `L != S, C != S` → 双向冲突 (智能合并或用户介入)

---

## 5. 业务逻辑详解 (Business Logic Deep Dive)

### 5.1 云优先架构原则

**设计哲学**: "列表即菜单，点击即下单"

**核心理念**：
1. **唯一真相来源 (Single Source of Truth)**: 云端对象存储
2. **列表渲染**: 仅依赖云端返回的文件列表
3. **本地缓存**: 仅作为"上次已知状态"用于加速首屏展示

**严格禁止**：
- ❌ 在列表加载时扫描本地文件系统 (`fsService.readDir`)
- ❌ 尝试合并 (Merge) 云端和本地的文件列表
- ❌ 将本地文件的存在性作为业务逻辑的判断依据

**正确做法**：
```typescript
// ✅ 正确: 云端优先
const fileList = await cloudService.listFiles(prefix);
setFiles(fileList); // 直接使用云端列表

// 用户点击文件时才检查本地
const handleFilePress = async (filePath) => {
  const exists = await fsService.exists(filePath);
  if (!exists) {
    await syncService.performDownload(filePath); // 按需下载
  }
  navigate('Preview', { filePath });
};

// ❌ 错误: 合并本地和云端列表
const localFiles = await fsService.readDir('/'); // 禁止!
const mergedList = mergeLists(localFiles, cloudFiles); // 禁止!
```

**参考文档**: `docs/BrowerScreen_cloud_first.md`

---

### 5.2 闪念笔记 (Flash Note) 核心逻辑

#### 文件格式规范

闪念笔记存储在单个 Markdown 文件中 (默认 `flash_notes.md`)，格式如下：

```markdown
## 2025-12-24 14:30:00
这是一条闪念笔记的内容。
可以包含多行文本。

## 2025-12-23 10:15:00
这是另一条闪念笔记。

## 2025-12-22 08:00:00
更早的一条记录。
```

**格式要求**：
- 时间戳标题必须严格遵循 `## YYYY-MM-DD HH:mm:ss` 格式
- 每条闪念之间用空行分隔
- 内容支持任意 Markdown 语法

#### 追加写入机制

```typescript
// FlashNoteService.ts 核心逻辑伪代码
async function addFlashNote(content: string) {
  const timestamp = formatTimestamp(new Date()); // "## 2025-12-24 14:30:00"
  const entry = `${timestamp}\n${content}\n\n`;

  // ① 读取现有文件
  const existingContent = await fsService.readFile(flashNotePath);

  // ② 追加到文件开头 (最新的在最上面)
  const newContent = entry + existingContent;

  // ③ 写入本地
  await fsService.writeFile(flashNotePath, newContent);

  // ④ 立即上传 (Write-Through)
  await cloudService.uploadFile(flashNotePath, newContent);
}
```

#### 三阶段同步流程

**详见**: `docs/FlashScreen_TodoSreen_logic.md` (V5.2 Standard Matrix)

**核心状态变量**：
- `syncStatus`: 全局同步状态 (`checking` / `synced` / `conflict` / `offline` / `not-configured` / `error`)
- `uploadErrorFiles`: 重试后仍失败的文件路径列表
- `conflictedFiles`: 智能合并失败的冲突文件列表

**关键差异**：与单文件预览页不同，闪念页管理 **多个文件** (主文件 + 历史归档)，因此使用 **队列** 管理失败和冲突。

---

### 5.3 待办管理 (Todo) 逻辑说明

> **架构演进说明**：早期基于 Markdown Checkbox 的本地待办解析器（`TodoParser.ts`）与滑动日历已退役清理。待办模块正重构为服务端驱动的独立任务系统，当前移动端展示就绪引导态。

---

### 5.4 文件预览页状态判断逻辑

**详见**: `docs/PreviewScreen_logic.md` (完整状态矩阵)

#### 核心状态变量

1. **`uploadState`** (持久化在 `FileMetadataStore`)
   - `'uploading'`: 正在上传 (不持久化，重启后重置为 `null`)
   - `'failed'`: 上传失败 (网络/鉴权等)
   - `'conflict-failed'`: 上传失败 (乐观锁冲突)
   - `null`: 无上传活动或上次上传成功

2. **`syncStatus`** (内存状态，实时计算)
   - `'checking'`: 正在检查云端状态
   - `'synced'`: 已同步
   - `'conflict'`: 存在冲突
   - `'offline'`: 离线模式
   - `'not-configured'`: 未配置云服务
   - `'error'`: 发生错误

#### 检查流程 (优先级从高到低)

```
进入预览页 / 页面获得焦点
    ↓
【优先级 1】网络检查
    → NetInfo.isConnected === false?
       → 是: syncStatus = 'offline', 中断, 显示离线 Banner
       → 否: 继续
    ↓
【优先级 2】配置检查
    → cloudService.isConfigured() === false?
       → 是: syncStatus = 'not-configured', 中断, 显示配置 Banner
       → 否: 继续
    ↓
【优先级 3】上传状态检查
    → uploadState === 'uploading'?
       → 是: syncStatus = 'checking', 中断, 等待上传完成事件
    → uploadState === 'failed'?
       → 是: 自动重试一次
          → 仍失败? syncStatus = 'error', 显示重试 Banner
          → 成功? 继续下一步
    → uploadState === 'conflict-failed'?
       → 是: syncStatus = 'conflict', 中断, 显示冲突 Banner
    → uploadState === null?
       → 继续
    ↓
【优先级 4】云端状态检查 (HEAD 请求)
    ① 云端文件不存在?
       → 自动触发上传
    ② localHash === cloudETag?
       → 是: syncStatus = 'synced'
       → 否: 继续三重哈希判断
    ③ 三重哈希判断:
       → L == S, C != S? 仅云端更新, 自动下载
       → L != S, C == S? 仅本地更新, 自动上传
       → L != S, C != S? 双向冲突, syncStatus = 'conflict'
```

#### 状态矩阵速查表

| 场景 | 网络 | uploadState | L==C? | 冲突逻辑 | syncStatus | Banner | 图标 | 自动操作 |
|------|------|-------------|-------|---------|-----------|--------|------|---------|
| 离线浏览 | 离线 | 任意 | - | - | offline | "离线模式..." | ⚠️ | 无 |
| 未配置 | 在线 | 任意 | - | - | not-configured | "未配置云服务" | ⚠️ | 无 |
| 正在上传 | 在线 | uploading | - | - | checking | 无 | 🔄 | 等待完成 |
| 上传失败 (首次) | 在线 | failed | - | 未重试 | checking | 无 | 🔄 | 自动重试 |
| 上传失败 (再次) | 在线 | failed | - | 已重试 | error | "上传失败" [重试] | ⚠️ | 无 |
| 乐观锁冲突 | 在线 | conflict-failed | - | 已拒 | conflict | "本地和云端..." | ⚠️ | 无 |
| 完成同步 | 在线 | null | Yes | - | synced | 无 | ✅ | 无 |
| 仅云端更新 | 在线 | null | No | L==S | checking | 无 | 🔄 | **自动下载** |
| 仅本地更新 | 在线 | null | No | C==S | checking | 无 | 🔄 | **自动上传** |
| 双向冲突 | 在线 | null | No | L!=S, C!=S | conflict | "本地和云端..." | ⚠️ | 无 |

---

### 5.5 智能合并 (Smart Merge) 机制

#### 三路合并算法

```typescript
// utils/mergeUtils.ts 核心逻辑伪代码
interface MergeResult {
  success: boolean;
  content?: string; // 合并后的内容
  conflicts?: string[]; // 冲突位置描述
}

async function smartMerge(
  localContent: string,
  cloudContent: string,
  baseContent: string // 上次同步时的内容 (syncedHash 对应)
): Promise<MergeResult> {
  // ① 如果本地或云端与 base 完全相同, 直接采用另一方
  if (localContent === baseContent) {
    return { success: true, content: cloudContent };
  }
  if (cloudContent === baseContent) {
    return { success: true, content: localContent };
  }

  // ② 尝试行级三路合并
  const localLines = localContent.split('\n');
  const cloudLines = cloudContent.split('\n');
  const baseLines = baseContent.split('\n');

  const merged: string[] = [];
  const conflicts: string[] = [];

  // 简化版 diff3 算法
  for (let i = 0; i < Math.max(localLines.length, cloudLines.length, baseLines.length); i++) {
    const localLine = localLines[i];
    const cloudLine = cloudLines[i];
    const baseLine = baseLines[i];

    if (localLine === cloudLine) {
      merged.push(localLine); // 双方一致, 无冲突
    } else if (localLine === baseLine) {
      merged.push(cloudLine); // 仅云端修改
    } else if (cloudLine === baseLine) {
      merged.push(localLine); // 仅本地修改
    } else {
      // 真正的冲突: 双方都修改了同一行
      conflicts.push(`Line ${i + 1}: Local="${localLine}", Cloud="${cloudLine}"`);
      // 默认策略: 保留本地版本 (可配置)
      merged.push(localLine);
    }
  }

  if (conflicts.length > 0) {
    return { success: false, conflicts };
  }

  return { success: true, content: merged.join('\n') };
}
```

#### 合并触发时机

1. **Stage 2 (乐观锁救援)**:
   - 上传失败且错误为 `PreconditionFailed` (412)
   - `uploadState === 'conflict-failed'`
   - 立即尝试智能合并

2. **Stage 3 (双向冲突检测)**:
   - 三重哈希判断为双向冲突 (`L != S && C != S`)
   - 自动尝试智能合并

#### 合并结果处理

```
智能合并 (smartMerge)
    ↓
    ├─ 【成功】
    │   ↓
    │   自动上传合并后的内容
    │   ↓
    │   更新 FileMetadata (syncedHash = 新哈希)
    │   ↓
    │   用户无感知, syncStatus = 'synced'
    │
    └─ 【失败】(存在真正的冲突)
        ↓
        加入 conflictedFiles 队列
        ↓
        显示冲突 Banner, 提供三个选项:
        ├─ [使用云端版本覆盖本地]
        ├─ [保存本地为副本, 使用云端]
        └─ [上传本地覆盖云端]
```

---

### 5.6 AI 助手 (AI Agent) 集成

#### LLMService 架构

```typescript
// services/LLMService.ts 核心接口
interface LLMConfig {
  provider: 'openai' | 'anthropic' | 'custom';
  apiKey: string;
  baseURL?: string;
  model: string;
}

class LLMService {
  private config: LLMConfig;

  // 流式对话
  async streamChat(
    messages: ChatMessage[],
    onChunk: (chunk: string) => void
  ): Promise<void> {
    // 使用 SSE (Server-Sent Events) 或 WebSocket
    const stream = await fetch(this.config.baseURL + '/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: messages,
        stream: true
      })
    });

    const reader = stream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = new TextDecoder().decode(value);
      onChunk(chunk); // 实时回调给 UI
    }
  }

  // 笔记总结
  async summarizeNote(noteContent: string): Promise<string> {
    const messages = [
      { role: 'system', content: '你是一个专业的笔记整理助手。' },
      { role: 'user', content: `请总结以下笔记:\n\n${noteContent}` }
    ];

    return await this.streamChat(messages, () => {});
  }
}
```

#### AI 侧栏 (AISidebar) 集成

- **触发位置**: 预览页 (PreviewScreen) / 编辑器页 (EditorScreen)
- **交互方式**: 侧边栏滑入，支持多轮对话
- **上下文注入**: 自动将当前笔记内容作为上下文发送给 AI

---

## 6. 编码规范 (Coding Conventions)

### 6.1 DRY 原则 (Don't Repeat Yourself)

**【强制执行】** 这是本项目最重要的编码原则！

#### 逻辑复用与封装

| 逻辑类型 | 禁止位置 | 正确位置 | 示例 |
|---------|---------|---------|------|
| **核心业务逻辑** | ❌ UI 组件 (screens/components) | ✅ `src/services/` | 同步、冲突检测、文件读写 |
| **状态管理逻辑** | ❌ 多个组件中重复 | ✅ Zustand Store | 上传队列、文件元数据 |
| **跨组件逻辑** | ❌ 复制粘贴代码 | ✅ Custom Hooks (`src/hooks/`) | `useCloudSync`, `useFlashNoteList` |
| **工具函数** | ❌ 多处重复定义 | ✅ `src/utils/` | 路径处理、哈希计算、日期格式化 |

#### 反例与正例对比

**❌ 错误示例**: 在多个页面重复同步逻辑

```typescript
// FlashScreen.tsx (错误)
const FlashScreen = () => {
  const checkSync = async () => {
    // 大段同步逻辑...
    const netState = await NetInfo.fetch();
    if (!netState.isConnected) {
      setSyncStatus('offline');
      return;
    }
    // ... 100+ 行代码
  };

  useEffect(() => { checkSync(); }, []);
};

// TodoScreen.tsx (错误 - 复制了相同逻辑!)
const TodoScreen = () => {
  const checkSync = async () => {
    // 大段同步逻辑... (与 FlashScreen 几乎完全相同)
    const netState = await NetInfo.fetch();
    if (!netState.isConnected) {
      setSyncStatus('offline');
      return;
    }
    // ... 100+ 行代码
  };

  useEffect(() => { checkSync(); }, []);
};
```

**✅ 正确示例**: 提取到服务层 + Hooks

```typescript
// services/FlashNoteService.ts (正确)
export class FlashNoteService {
  static async syncAll(): Promise<SyncResult> {
    // 统一的三阶段同步逻辑
    const netState = await NetInfo.fetch();
    if (!netState.isConnected) {
      return { status: 'offline' };
    }
    // ... 完整同步逻辑
  }
}

// hooks/useFlashNoteList.ts (正确)
export function useFlashNoteList() {
  const [syncStatus, setSyncStatus] = useState('checking');

  const performSync = async () => {
    const result = await FlashNoteService.syncAll(); // 复用服务层逻辑
    setSyncStatus(result.status);
  };

  useEffect(() => { performSync(); }, []);

  return { syncStatus, performSync };
}

// FlashScreen.tsx (正确 - 简洁!)
const FlashScreen = () => {
  const { syncStatus, performSync } = useFlashNoteList(); // 复用 Hook
  // UI 逻辑...
};

// TodoScreen.tsx (正确 - 简洁!)
const TodoScreen = () => {
  const { syncStatus, performSync } = useFlashNoteList(); // 复用相同 Hook
  // UI 逻辑...
};
```

---

### 6.2 服务层下沉原则

**核心思想**: UI 组件只负责展示和用户交互，所有业务逻辑必须下沉到 `services/`。

**服务层设计规范**：

```typescript
// services/SyncService.ts 示例
export class SyncService {
  // ✅ 正确: 纯函数，不依赖 React Hooks
  static async performUpload(
    filePath: string,
    content: string
  ): Promise<UploadResult> {
    try {
      // ① 本地写入
      await fsService.writeFile(filePath, content);

      // ② 计算哈希
      const hash = MD5(content).toString();

      // ③ 获取当前元数据 (使用 getState(), 不使用 Hooks)
      const metadata = useFileMetadataStore.getState().getMetadata(filePath);

      // ④ 上传到云端
      const cloudResult = await cloudService.uploadFile(filePath, content, {
        ifMatch: metadata?.etag // 乐观锁
      });

      // ⑤ 更新元数据
      useFileMetadataStore.getState().setMetadata(filePath, {
        etag: cloudResult.etag,
        lastModified: cloudResult.lastModified,
        uploadState: null,
        syncedHash: hash
      });

      return { success: true, etag: cloudResult.etag };

    } catch (error) {
      if (error.code === 'PreconditionFailed') {
        // 乐观锁冲突
        useFileMetadataStore.getState().setMetadata(filePath, {
          uploadState: 'conflict-failed'
        });
        return { success: false, reason: 'conflict' };
      }

      // 其他错误
      useFileMetadataStore.getState().setMetadata(filePath, {
        uploadState: 'failed'
      });
      useSyncStore.getState().addToQueue(filePath);
      return { success: false, reason: 'network' };
    }
  }
}
```

**在服务层读取 Zustand 状态的正确方式**：

```typescript
// ✅ 正确: 使用 getState()
const currentSettings = useSettingsStore.getState();
const bucket = currentSettings.cloudConfig.bucket;

// ❌ 错误: 在服务层使用 Hooks (会报错!)
const bucket = useSettingsStore(state => state.cloudConfig.bucket);
```

---

### 6.3 组件开发规范

#### 函数式组件 + Hooks

```typescript
// ✅ 正确示例
import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { theme } from '@/utils/theme';

interface MyComponentProps {
  title: string;
  onPress?: () => void;
}

export const MyComponent: React.FC<MyComponentProps> = ({ title, onPress }) => {
  const { t } = useTranslation(); // 国际化
  const [count, setCount] = useState(0);

  useEffect(() => {
    // 副作用逻辑
  }, []);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>{t('common.title')}</Text>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    padding: theme.spacing.md,
    backgroundColor: theme.colors.background
  },
  title: {
    fontSize: theme.fontSize.lg,
    color: theme.colors.text
  }
});
```

#### 样式规范

```typescript
// ✅ 正确: 使用 StyleSheet.create
const styles = StyleSheet.create({
  container: {
    padding: 16,
    backgroundColor: '#FFFFFF'
  }
});

// ⚠️ 避免: 行内样式 (仅用于动态样式)
<View style={{ padding: dynamicPadding }} />

// ❌ 错误: 滥用行内样式
<View style={{ padding: 16, backgroundColor: '#FFFFFF' }} />
```

---

### 6.4 TypeScript 类型安全

**【强制执行】** 严禁使用 `any` 类型！

```typescript
// ❌ 错误
function processFile(file: any) { // 禁止!
  return file.name;
}

// ✅ 正确
interface FileItem {
  name: string;
  path: string;
  size: number;
  lastModified: number;
}

function processFile(file: FileItem): string {
  return file.name;
}
```

**常用类型定义位置**：
- 导航类型: `src/types/navigation.ts`
- 服务接口: 在各自的服务文件中定义

---

### 6.5 异步处理规范

```typescript
// ✅ 正确: 使用 async/await + try-catch
async function syncFile(filePath: string) {
  try {
    const content = await fsService.readFile(filePath);
    await cloudService.uploadFile(filePath, content);
    console.log('上传成功');
  } catch (error) {
    console.error('上传失败:', error);
    // 错误处理逻辑
  }
}

// ❌ 错误: 缺少错误处理
async function syncFile(filePath: string) {
  const content = await fsService.readFile(filePath); // 可能抛出异常!
  await cloudService.uploadFile(filePath, content); // 可能抛出异常!
}
```

---

### 6.6 事件通信规范

**跨组件/跨上下文通信使用 DeviceEventEmitter**：

```typescript
// constants/events.ts
export const EVENTS = {
  SHARE_RECEIVED: 'SHARE_RECEIVED_EVENT',
  UPLOAD_COMPLETED: 'UPLOAD_COMPLETED_EVENT',
  SYNC_STATUS_CHANGED: 'SYNC_STATUS_CHANGED_EVENT'
};

// 发送事件
import { DeviceEventEmitter } from 'react-native';
import { EVENTS } from '@/constants/events';

DeviceEventEmitter.emit(EVENTS.UPLOAD_COMPLETED, { filePath: '/foo/bar.md' });

// 接收事件
useEffect(() => {
  const subscription = DeviceEventEmitter.addListener(
    EVENTS.UPLOAD_COMPLETED,
    (data) => {
      console.log('文件上传完成:', data.filePath);
    }
  );

  return () => subscription.remove(); // 清理监听器
}, []);
```

---

## 7. 开发工作流 (Development Workflow)

### 7.1 核心命令

#### 环境准备与安装

```bash
# 安装依赖 (使用 Expo 命令)
npx expo install

# 验证环境
node --version   # 应为 v20+
java -version    # 应为 JDK 17
```

#### 启动开发环境

```bash
# 1. 预构建原生代码 (仅当以下情况需要)
#    - 修改了 app.config.js
#    - 添加/删除了原生依赖
#    - 修改了 plugins/ 下的配置插件
npx expo prebuild

# 2. 启动开发服务器 (Metro Bundler)
npx expo start

# 3. 在 Android 上运行 (开发构建)
npx expo run:android

# 4. 在 iOS 上运行 (开发构建)
npx expo run:ios
```

#### 编辑器构建 (重要！)

如果你修改了 `editor-bundler/` 下的 CodeMirror 编辑器代码，**必须**执行以下步骤：

```bash
cd editor-bundler

# 初次需要安装依赖
npm install

# 构建编辑器
npm run build

# 构建产物会生成在 editor-bundler/dist/codemirror.bundle.js
# 需要手动复制到 assets/ 目录 (或通过 build 脚本自动同步)
cp dist/codemirror.bundle.js ../assets/

cd ..
```

**⚠️ 注意**: 编辑器在 WebView 中运行，调试时需要查看 WebView 的 console 输出。

#### 质量保证

```bash
# 代码风格检查
npx eslint .

# 自动修复 lint 错误
npx eslint . --fix

# 运行测试
npx jest

# 类型检查
npx tsc --noEmit
```

---

### 7.2 常见开发任务

#### 添加涉及文件操作的功能

1. **所有本地文件操作都使用 `fsService`** (不要直接使用 RNFS 或 expo-file-system)
   ```typescript
   import { fsService } from '@/services/FileSystemService';

   // ✅ 正确
   const content = await fsService.readFile('/path/to/file.md');

   // ❌ 错误
   import RNFS from 'react-native-fs';
   const content = await RNFS.readFile('/path/to/file.md', 'utf8');
   ```

2. **对于云操作，首先检查 `cloudService.isConfigured()`**
   ```typescript
   if (!cloudService.isConfigured()) {
     Alert.alert('未配置云服务', '请先在设置中配置云存储');
     return;
   }

   await cloudService.uploadFile(filePath, content);
   ```

3. **上传成功后更新 FileMetadataStore 中的 etag/lastModified**
   ```typescript
   const result = await cloudService.uploadFile(filePath, content);

   useFileMetadataStore.getState().setMetadata(filePath, {
     etag: result.etag,
     lastModified: result.lastModified,
     uploadState: null,
     syncedHash: MD5(content).toString()
   });
   ```

4. **考虑同步冲突** - 如果读取云文件，需要实现冲突检测
   - 参考 `PreviewScreen.tsx` 中的 `checkSyncStatus` 函数
   - 使用三重哈希机制判断冲突类型

---

#### 添加新屏幕

1. **在 `src/types/navigation.ts` 中定义路由参数**
   ```typescript
   export type RootStackParamList = {
     MainTabs: undefined;
     Editor: { filePath: string };
     MyNewScreen: { userId: string }; // 新增
   };
   ```

2. **将屏幕添加到适当的导航器**
   ```typescript
   // navigation/AppNavigator.tsx
   <Stack.Screen
     name="MyNewScreen"
     component={MyNewScreen}
     options={{ title: '我的新页面' }}
   />
   ```

3. **所有用户可见的字符串都使用 `useTranslation()` hook**
   ```typescript
   // 在 src/locales/zh.json 中添加
   {
     "myNewScreen": {
       "title": "我的新页面",
       "description": "这是一个新页面"
     }
   }

   // 在组件中使用
   const { t } = useTranslation();
   <Text>{t('myNewScreen.title')}</Text>
   ```

4. **遵循现有屏幕模式实现同步状态指示器**
   - 使用 `StatusBannerContainer` 统一管理横幅
   - 使用 `HeaderSyncStatus` 显示标题栏图标

---

#### 修改状态存储

1. **所有存储都使用 Zustand 并配合 persist middleware**
   ```typescript
   import create from 'zustand';
   import { persist } from 'zustand/middleware';
   import AsyncStorage from '@react-native-async-storage/async-storage';

   interface MyStore {
     count: number;
     increment: () => void;
   }

   export const useMyStore = create<MyStore>()(
     persist(
       (set) => ({
         count: 0,
         increment: () => set((state) => ({ count: state.count + 1 }))
       }),
       {
         name: 'my-store',
         storage: {
           getItem: async (name) => {
             const value = await AsyncStorage.getItem(name);
             return value ? JSON.parse(value) : null;
           },
           setItem: async (name, value) => {
             await AsyncStorage.setItem(name, JSON.stringify(value));
           },
           removeItem: async (name) => {
             await AsyncStorage.removeItem(name);
           }
         }
       }
     )
   );
   ```

2. **修改后测试持久化功能** (清除应用数据并重新加载)
   ```bash
   # Android
   adb shell pm clear com.yourapp.packagename

   # 然后重新启动应用，检查状态是否正确恢复
   ```

3. **敏感数据使用 expo-secure-store 而不是 AsyncStorage**
   ```typescript
   import * as SecureStore from 'expo-secure-store';

   // 存储凭证
   await SecureStore.setItemAsync('cos-secret-key', secretKey);

   // 读取凭证
   const secretKey = await SecureStore.getItemAsync('cos-secret-key');
   ```

---

#### 使用 Expo 配置插件

1. **在 `app.config.js` 中定义自定义配置插件**
   ```javascript
   // app.config.js
   module.exports = {
     expo: {
       plugins: [
         './plugins/disablePredictiveBackGesture',
         './plugins/injectKeystore'
       ]
     }
   };
   ```

2. **使用 `withAndroidManifest` 和 `withMainActivity` 等函数修改原生配置**
   ```javascript
   // plugins/disablePredictiveBackGesture.js
   const { withAndroidManifest } = require('@expo/config-plugins');

   module.exports = function disablePredictiveBackGesture(config) {
     return withAndroidManifest(config, async (config) => {
       const androidManifest = config.modResults.manifest;

       // 修改 AndroidManifest.xml
       androidManifest.application[0].$['android:enableOnBackInvokedCallback'] = 'false';

       return config;
     });
   };
   ```

3. **遵循 Expo 最佳实践实现插件逻辑**
   - 插件应该是纯函数
   - 插件应该返回修改后的 config
   - 修改后运行 `npx expo prebuild` 生效

---

### 7.3 Git 工作流和提交规范

#### 提交信息规范

```bash
# 格式: <type>: <subject>

# Type 类型:
# feat:     新功能
# fix:      Bug 修复
# refactor: 重构 (既不是新功能也不是修复)
# docs:     文档修改
# style:    代码格式调整 (不影响逻辑)
# test:     测试相关
# chore:    构建/工具链相关

# 示例:
git commit -m "feat: 增加 WebDAV 云服务支持"
git commit -m "fix: 修复闪念页同步冲突检测逻辑"
git commit -m "refactor: 将同步逻辑从组件提取到 SyncService"
git commit -m "docs: 更新 GEMINI.md 架构说明"
```

#### 分支策略

```bash
# 主分支
main          # 生产环境代码

# 开发分支
dev           # 开发环境代码

# 功能分支
feature/xxx   # 新功能开发

# 修复分支
fix/xxx       # Bug 修复

# 示例工作流:
git checkout -b feature/webdav-support
# ... 开发功能 ...
git commit -m "feat: 增加 WebDAV 云服务支持"
git push origin feature/webdav-support
# 创建 Pull Request 到 dev 分支
```

---

## 8. 陷阱与限制 (Gotchas & Limitations)

### 8.1 Android 构建配置 (Expo Prebuild)

**🚨 极其重要！严禁直接修改 `android/` 目录下的代码！**

**原因**：
- `android/` 目录是由 `npx expo prebuild` 自动生成的
- 每次运行 `npx expo prebuild` 都会完全覆盖该目录
- 直接修改会在下次 prebuild 时丢失

**正确做法**：
1. 在 `app.config.js` 中修改配置
2. 编写配置插件 (`plugins/`)
3. 使用 `withAndroidManifest`, `withMainActivity` 等 Expo 提供的函数
4. 修改后运行 `npx expo prebuild` 生效

**示例**：
```javascript
// ❌ 错误: 直接修改 android/app/src/main/AndroidManifest.xml
// 这些修改会在下次 prebuild 时丢失!

// ✅ 正确: 在 app.config.js 中使用插件
module.exports = {
  expo: {
    plugins: [
      './plugins/customAndroidConfig'
    ]
  }
};

// plugins/customAndroidConfig.js
const { withAndroidManifest } = require('@expo/config-plugins');

module.exports = function customAndroidConfig(config) {
  return withAndroidManifest(config, async (config) => {
    // 在这里修改 AndroidManifest
    return config;
  });
};
```

---

### 8.2 云同步逻辑

**依赖 Store Hydration**：

```typescript
// ❌ 错误: 在 Store hydrate 之前调用
async function initApp() {
  await cloudService.initProvider(); // 可能读取到空配置!
}

// ✅ 正确: 等待 Store hydrate 完成
async function initApp() {
  // 等待 Store 从 AsyncStorage 恢复
  await new Promise<void>((resolve) => {
    const unsubscribe = useSettingsStore.subscribe(
      (state) => {
        if (state.hasHydrated) {
          unsubscribe();
          resolve();
        }
      }
    );
  });

  // 现在可以安全地初始化云服务
  await cloudService.initProvider();
}
```

**操作前必检 `isConfigured()`**：

```typescript
// ❌ 错误: 直接调用可能抛出异常
await cloudService.uploadFile(filePath, content);

// ✅ 正确: 先检查配置
if (!cloudService.isConfigured()) {
  Alert.alert('未配置云服务');
  return;
}
await cloudService.uploadFile(filePath, content);
```

---

### 8.3 编辑器调试

**WebView 编辑器运行在独立环境中**：

- WebView 内部的 JavaScript 代码无法直接访问 React Native 环境
- 需要通过 `window.ReactNativeWebView.postMessage()` 通信

**调试方法**：

```typescript
// editor-bundler/src/index.js (WebView 内部)
console.log('这条日志不会出现在 RN 的 console 中!');

// 发送消息到 React Native
window.ReactNativeWebView.postMessage(JSON.stringify({
  type: 'log',
  message: 'WebView 内部日志'
}));

// EditorScreen.tsx (React Native)
<WebView
  source={{ uri: 'file:///android_asset/codemirror.bundle.js' }}
  onMessage={(event) => {
    const data = JSON.parse(event.nativeEvent.data);
    if (data.type === 'log') {
      console.log('[WebView]', data.message); // 现在会出现在 RN console
    }
  }}
/>
```

**Android WebView 调试**：
```bash
# 在 Chrome 中打开
chrome://inspect

# 找到你的 WebView 实例，点击 "inspect"
# 现在可以在 Chrome DevTools 中调试 WebView 内部的 JavaScript
```

---

### 8.4 文件权限 (Android Scoped Storage)

**Android 11+ 强制使用 Scoped Storage**：

- 应用只能访问自己的私有目录 (`DocumentDirectoryPath`)
- 无法直接访问公共存储 (`/sdcard/`)

**正确做法**：

```typescript
// ✅ 正确: 使用应用私有目录
import RNFS from 'react-native-fs';
const basePath = RNFS.DocumentDirectoryPath; // /data/user/0/com.app/files
const filePath = `${basePath}/notes/test.md`;

// ❌ 错误: 尝试访问公共存储 (会被拒绝)
const filePath = '/sdcard/notes/test.md';
```

**需要访问公共文件？**
- 使用 `expo-document-picker` 让用户选择文件
- 使用 `expo-media-library` 访问相册
- 使用 `expo-file-system` 的 SAF (Storage Access Framework) API

---

### 8.5 文件系统 API 演进

**当前状态**：项目混用 `react-native-fs` 和 `expo-file-system` 新老 API

**迁移计划**：
- 新功能开发优先使用 `expo-file-system` 新 API
- 旧代码逐步迁移 (需要充分测试)

**兼容性注意事项**：

```typescript
// 旧 API (react-native-fs)
import RNFS from 'react-native-fs';
await RNFS.readFile(filePath, 'utf8');

// 新 API (expo-file-system)
import * as FileSystem from 'expo-file-system';
await FileSystem.readAsStringAsync(filePath);

// ⚠️ 注意: 路径格式可能不同
// RNFS: /data/user/0/com.app/files/test.md
// Expo: file:///data/user/0/com.app/files/test.md (需要 file:// 前缀)
```

---

## 9. 问题排查 (Troubleshooting)

### 9.1 常见错误与解决方案

| 错误现象 | 可能原因 | 解决方案 | 相关文件 |
|---------|---------|---------|---------|
| **同步冲突无法解决** | 智能合并失败，存在真正的内容冲突 | 检查 `FileMetadataStore` 中的 `uploadState` 是否为 `conflict-failed`；使用手动解决选项 (使用云端/使用本地/存为副本) | `PreviewScreen.tsx:120`<br>`FlashNoteService.ts:89` |
| **上传一直失败** | 网络问题或云服务配置错误 | ① 检查网络连接；② 检查 `useSettingsStore` 中的 WebDAV 配置；③ 检查 `expo-secure-store` 中的凭证是否正确 | `CloudService.ts:40`<br>`WebDavProvider.ts` |
| **WebView 编辑器无响应** | JavaScript 加载失败或通信中断 | ① 检查 `src/editor-web/editorHtml.ts` 是否生成；② 查看 WebView console 消息 (使用 `onMessage` 监听)；③ 重新构建编辑器 (`npm run build:editor`) | `EditorScreen.tsx`<br>`src/editor-web/` |
| **Android 构建失败** | Prebuild 插件配置错误 | ① 检查 `app.config.js` 中的 plugins 配置；② 清除 `android/` 目录并重新运行 `npx expo prebuild`；③ 查看错误日志定位插件问题 | `app.config.js`<br>`plugins/` |
| **文件列表为空** | 云服务未配置或网络问题 | ① 检查 `cloudService.isConfigured()` 返回值；② 检查 `useFileListStore` 中的缓存是否损坏；③ 清除缓存重新拉取 (`AsyncStorage.removeItem('file-list-cache')`) | `NoteScreen.tsx:80`<br>`CloudService.ts:150` |
| **闪念无法保存** | 文件路径配置错误 | 检查 `useSettingsStore` 中的 `flashNoteConfig.path` 和 `flashNoteConfig.filename`；确认目录存在 (`fsService.exists()`) | `FlashNoteService.ts:30`<br>`FlashNoteConfigScreen.tsx` |
| **AI 对话无响应** | API 配置错误或网络超时 | ① 检查 `useAIStore` 中的 `apiKey` 和 `baseURL`；② 查看网络请求日志；③ 确认 API 提供商状态 | `LLMService.ts:100`<br>`AIConfigScreen.tsx` |
| **应用启动后状态丢失** | Store 持久化失败 | ① 检查 AsyncStorage 权限；② 查看 Store 的 `hasHydrated` 状态；③ 清除 AsyncStorage 重新初始化 | `useSettingsStore.ts:20`<br>`App.tsx:50` |
| **文件下载失败** | 云端文件不存在或权限问题 | ① 使用 `cloudService.headFile()` 检查文件是否存在；② 检查云服务凭证权限；③ 查看云服务控制台日志 | `SyncService.ts:200`<br>`PreviewScreen.tsx:150` |

---

### 9.2 调试技巧

#### 查看文件元数据状态

```typescript
// 在任意组件中
import { useFileMetadataStore } from '@/store/useFileMetadataStore';

const metadata = useFileMetadataStore.getState().getMetadata('/notes/test.md');
console.log('文件元数据:', {
  etag: metadata?.etag,
  lastModified: metadata?.lastModified,
  uploadState: metadata?.uploadState,
  syncedHash: metadata?.syncedHash,
  localHash: metadata?.localHash
});
```

#### 查看同步队列

```typescript
import { useSyncStore } from '@/store/useSyncStore';

const queue = useSyncStore.getState().queue;
console.log('同步队列:', queue);
// 输出: [{ filePath: '/notes/test.md', status: 'pending', retryCount: 1 }]
```

#### 强制重新同步

```typescript
// 清除元数据
useFileMetadataStore.getState().clearMetadata('/notes/test.md');

// 清除同步队列
useSyncStore.getState().clearQueue();

// 重新检查同步状态
await checkSyncStatus();
```

#### 查看 WebView 日志

```typescript
// EditorScreen.tsx
<WebView
  onMessage={(event) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      console.log('[WebView Message]', data);
    } catch (e) {
      console.log('[WebView Raw]', event.nativeEvent.data);
    }
  }}
  onError={(syntheticEvent) => {
    const { nativeEvent } = syntheticEvent;
    console.error('[WebView Error]', nativeEvent);
  }}
/>
```

---

### 9.3 性能排查

#### 文件列表加载慢

**原因**：云端列表过大或网络慢

**解决方案**：
1. 检查缓存是否生效 (`useFileListStore`)
2. 实现分页加载 (如果云服务支持)
3. 优化列表渲染 (使用 `FlatList` 的 `windowSize` 和 `removeClippedSubviews`)

#### 同步检查耗时长

**原因**：逐文件 HEAD 请求过多

**解决方案**：
1. 批量 HEAD 请求 (如果云服务支持)
2. 实现增量同步 (只检查修改时间大于上次同步时间的文件)
3. 减少同步频率 (设置合理的检查间隔)

---

## 10. 附录 (Appendix)

### 10.1 重要文档索引

| 文档 | 路径 | 描述 |
|------|------|------|
| **闪念/待办同步逻辑** | `docs/FlashScreen_TodoSreen_logic.md` | V5.2 三阶段同步流程完整说明 |
| **预览页状态判断** | `docs/PreviewScreen_logic.md` | 11 种场景的状态矩阵 |
| **云优先架构原则** | `docs/BrowerScreen_cloud_first.md` | 文件浏览页设计哲学 |
| **编辑器实现指南** | `docs/editor-implementation-guide.md` | CodeMirror 集成说明 |

### 10.2 术语表

| 术语 | 英文 | 解释 |
|------|------|------|
| **闪念笔记** | Flash Note | 快速捕捉想法的时间线笔记，存储在单个 Markdown 文件中 |
| **三重哈希机制** | Triple Hash Mechanism | 使用 Local Hash, Cloud ETag, Synced Hash 三个值判断冲突类型 |
| **乐观锁** | Optimistic Locking | 使用 ETag 作为版本号，上传时通过 `If-Match` 头部实现并发控制 |
| **智能合并** | Smart Merge | 基于三路合并算法自动解决文件冲突 |
| **Write-Through** | Write-Through Cache | 本地写入后立即上传到云端的策略 |
| **云优先** | Cloud-First | 云端为唯一真相来源，本地仅作缓存 |
| **Stage 1/2/3** | Three-Stage Sync | 三阶段同步：环境检查、本地修复、全量同步 |
| **uploadState** | Upload State | 文件上传状态 (uploading/failed/conflict-failed/null) |
| **syncStatus** | Sync Status | 同步状态 (checking/synced/conflict/offline/not-configured/error) |

### 10.3 快速参考卡片

```
┌─────────────────────────────────────────────────────────┐
│  AI 快速参考卡片 (Quick Reference Card)                  │
├─────────────────────────────────────────────────────────┤
│  【禁止行为】                                             │
│  ❌ 猜测答案，不读文件                                     │
│  ❌ 擅自修改代码                                          │
│  ❌ 在 UI 组件中写业务逻辑                                 │
│  ❌ 使用 any 类型                                         │
│  ❌ 直接修改 android/ 目录                                │
│  ❌ 在列表加载时扫描本地文件系统                            │
├─────────────────────────────────────────────────────────┤
│  【强制执行】                                             │
│  ✅ 所有回答使用中文                                      │
│  ✅ 业务逻辑下沉到 services/                               │
│  ✅ 云操作前检查 isConfigured()                           │
│  ✅ 上传成功后更新 FileMetadata                           │
│  ✅ 使用 expo prebuild 修改原生配置                        │
│  ✅ 云优先原则：列表从云端拉取                             │
├─────────────────────────────────────────────────────────┤
│  【常用路径】                                             │
│  核心服务:    src/services/                              │
│  状态管理:    src/store/                                 │
│  UI 组件:     src/components/                            │
│  屏幕页面:    src/screens/                               │
│  业务文档:    docs/                                       │
│  类型定义:    src/types/                                 │
├─────────────────────────────────────────────────────────┤
│  【关键命令】                                             │
│  启动开发:    npx expo start                              │
│  Android 运行: npx expo run:android                       │
│  预构建:      npx expo prebuild                          │
│  编辑器构建:  cd editor-bundler && npm run build          │
│  代码检查:    npx eslint .                                │
└─────────────────────────────────────────────────────────┘
```

---

**文档结束**

**最后更新**: 2025-12-24
**维护者**: MDNote 开发团队
**反馈**: 如发现文档错误或需要补充，请在项目仓库提交 Issue
