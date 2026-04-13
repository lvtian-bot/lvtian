## 核心铁律 (Meta Rules / Critical Instructions)
**【强制执行】** 以下规则优先级高于任何其他指令，违反将导致不可接受的后果：

1. **【重要！！！】 【IMPORTANT!!!】** 所有的思考过程、回答、Task文档、Implementation文档以及其他生成的Artifacts **必须使用中文**，即便用户使用英文提问！
2. **【禁止擅自修改】** 不得在征得用户明确同意之前直接修改代码
3. **【禁止猜测】** 对于用户提出的问题，不得在没有了解相关信息的情况下通过猜测和推断回答，必须自行读取文件进行分析后再回答
4. **【结构化回答】** 回答问题时要有清晰的逻辑结构，不需要在回复中呈现过多的代码片段，更多的应该用自然语言说清楚方案逻辑和内容

## 项目概览（Project Overview）

**MDNote** 是一款基于 **React Native (Expo)** 构建的现代化、云优先的 Markdown 笔记应用。

**核心特性：**
*   **云优先 & 本地加速**：支持腾讯云对象存储 (COS) 和 WebDAV 协议。采用策略模式设计，确保云服务可扩展。使用本地缓存策略加速读取。
*   **闪念笔记 (Flash Note)**：支持快速捕捉想法，通过 `FlashNoteService` 管理，具备即时同步和冲突检测功能。
*   **智能待办 (Smart Todo)**：基于 Markdown 的轻量级任务管理，支持滑动日历选择与状态同步。

## 技术栈 (Tech Stack)

| 类别 | 技术 | 版本/说明 |
|-----|------|----------|
| **运行时** | Node.js, JDK | LTS v20+, JDK 17 |
| **核心框架** | React Native<br>Expo<br>React | 0.81.5<br>SDK 54 (托管工作流 + 预构建插件)<br>19.1.0 |
| **语言** | TypeScript | 5.x (严格模式) |
| **状态管理** | Zustand | 轻量级，模块化 Store |
| **导航** | React Navigation | 7 (Native Stack + Bottom Tabs) |
| **国际化** | i18next | + react-i18next |
| **核心库** | reanimated, gesture-handler<br>expo-file-system<br>expo-secure-store, crypto-js | 动画/手势<br>文件操作<br>安全存储/加密 |

## 业务逻辑与架构细节 (Architecture & Business Logic)

### 核心文件快速索引 (Quick File Index)

| 文件路径 | 关键职责 | 必读场景 |
|---------|---------|---------|
| `src/services/CloudService.ts` | 云策略入口 (TencentCOS/WebDAV) | 同步、上传、下载相关问题 |
| `src/services/FlashNoteService.ts` | 闪念追加写入逻辑 | 闪念功能、时间格式问题 |
| `src/services/FileSystemService.ts` | 文件操作唯一入口 | 文件读写、Scoped Storage |
| `src/store/useFileMetadataStore.ts` | ETag/LastModified 存储 | 冲突检测、同步状态 |
| `src/store/useSyncStore.ts` | 上传队列管理 | Write-Through 机制 |
| `src/components/StatusBannerContainer.tsx` | 统一状态横幅 | UI 状态展示逻辑 |
| `src/services/ShadowFileService.ts` | 影子文件（冲突检测基准副本，存于 `.shadows/`） | 冲突检测、三路合并相关问题 |

### 1. 核心代码 (`src/`)
*   **`services/` (业务中枢)**：所有核心逻辑下沉于此。
    *   `CloudService`: 云策略入口 (`TencentCOS` / `WebDAV`)。**操作前必检 `isConfigured()`**。
    *   `FlashNoteService`: 追加写入 `flash_notes.md` (格式严守 `## YYYY-MM-DD HH:mm:ss`)。
    *   `FileSystemService`: **文件操作唯一入口** (封装 Expo API 以兼容 Scoped Storage，严禁直接用 RNFS)。
*   **`store/` (状态管理)**：基于 Zustand。
    *   `useSettingsStore`: 基础配置 (SecretKey 存 SecureStore)。
    *   `useFileMetadataStore`: 存 ETag/LastModified，**冲突检测核心依据** (`headFile` 对比)。
    *   `useSyncStore`: 上传队列 (Write-Through 机制：写入即加入队列)。
*   **`navigation/` & `screens/`**：
    *   `FlashNoteInputModal`: 全局模态框，用于快速录入。
    *   新页面开发需在 `types/navigation.ts` 定义路由，并使用 `useTranslation`。
    *   `i18n.ts`: 国际化入口，App 启动首位加载。

### 2. 基础设施 (Non-src)
*   **`android/`**：Expo Prebuild 生成物。**严禁直接修改**，必须通过 `app.config.js` 插件定制。
*   **`editor-bundler/`**：CodeMirror 编辑器独立构建工程 (修改后需 rebuild)。
*   **`docs/`**：复杂逻辑请查阅此目录 (如 `FlashScreen_TodoSreen_logic.md`, `PreviewScreen_logic.md`)。
*   **`assets/`**：静态资源 (含 `codemirror.bundle.js`)。

## 编码规范（Coding Conventions）

*   **组件开发**：
    *   全面使用 **Functional Components** 和 **Hooks**。
    *   样式使用 `StyleSheet.create`，避免行内样式滥用。
*   **逻辑复用与封装 (DRY Principle)**：
    *   **核心逻辑统一**：严禁在 UI 组件（如 `FlashScreen`, `TodoScreen`, `PreviewScreen`）中重复编写同步、冲突检测或文件读写逻辑。
    *   **服务层下沉**：所有涉及云同步、文件操作、冲突处理的业务逻辑，**必须**封装在 `src/services/` 下的独立服务中（如 `FlashNoteService`, `SyncService`）。
    *   **Hooks 封装**：对于跨组件的状态逻辑（如监听同步状态），应提取为 Custom Hooks（如 `useCloudSync`）。
*   **状态管理**：
    *   全局状态优先使用 **Zustand**。
    *   服务层 (Services) 需要读取状态时，使用 `store.getState()` 避免 Hooks 规则限制。
*   **异步处理**：
    *   统一使用 `async/await`。
    *   关键业务逻辑（如同步、文件读写）必须包含 `try-catch` 错误处理。
*   **事件通信**：
    *   组件与非 React 上下文（如后台服务）通信时，使用 `DeviceEventEmitter`（例如 `SHARE_RECEIVED_EVENT`）。
*   **类型安全**：
    *   严禁使用 `any`，所有 Props 和接口必须定义明确的 TypeScript Interface。

## 核心命令（Key Commands）

| 场景 | 命令 | 备注 |
|-----|------|------|
| **环境安装** | `npx expo install` | 初次安装依赖 |
| **预构建原生** | `npx expo prebuild` | 修改 app.config.js 或原生依赖后需要 |
| **启动开发** | `npx expo start` | Metro Bundler |
| **运行 Android** | `npx expo run:android` | 开发构建 |
| **运行 iOS** | `npx expo run:ios` | 开发构建 |
| **编辑器构建** | `cd editor-bundler && npm run build` | 修改 editor-bundler/ 后必须执行 |
| **代码检查** | `npx eslint .` | 风格检查 |
| **运行测试** | `npx jest` | 单元测试 |

## 重要提示（Important Notes）

1.  **Android 构建配置 (Expo Prebuild)**：项目使用了高度定制的 `app.config.js`，包含"禁用预测性返回手势"、"Keystore 注入"等插件。**严禁直接修改 `android/` 目录下的代码！** 任何原生层面的修改**必须**通过编写 Config Plugin (`plugins/`) 实现，否则每次运行 `npx expo prebuild` 都会导致修改丢失。
2. 不要硬编码中文或英文，使用国际化编码方式i18next。
3.  **云同步逻辑**：`CloudService` 依赖于 `useSettingsStore` 的配置（Provider 类型）。在调用 `initProvider()` 前需确保 Store 已 Hydrate（`hasHydrated` 标志）。
4.  **编辑器调试**：Webview 编辑器运行在独立环境中，调试需关注 WebView 的 console 消息传递机制。
5.  **文件权限**：Android 端利用了 Scoped Storage，文件操作需严格依赖 `FileSystemService` 封装的方法。
6.  **文件系统 API 演进**：项目目前混用 `expo-file-system` 的新老 API。新功能开发应优先考虑新版 API，但必须注意兼容性。后续有计划统一迁移至新版 API。

## 详细文档索引 (Detailed Docs Index)

当需要深入理解复杂逻辑时，请阅读以下文档：

| 文档路径 | 核心内容 | 阅读时机 |
|---------|---------|---------|
| `docs/FlashScreen_TodoSreen_logic.md` | 闪念/待办页三阶段同步逻辑<br>(Stage 1-3, 状态矩阵) | 处理闪念/待办同步、冲突问题 |
| `docs/PreviewScreen_logic.md` | 预览页状态判断流程<br>(uploadState + syncStatus 决策树) | 处理预览页同步、冲突问题 |
| `docs/BrowerScreen_cloud_first.md` | 云端为主架构设计原则<br>("列表即菜单，点击即下单") | 理解文件浏览页设计哲学 |
| `docs/editor-implementation-guide.md` | CodeMirror 编辑器集成细节 | 修改编辑器相关功能 |
| `docs/architecture-deep-dive.md` | 完整架构蓝图、数据流、Store 设计 | 理解整体架构、扩展新功能 |
| `docs/business-logic-details.md` | 三路合并、乐观锁、闪念格式等核心逻辑 | 处理同步、冲突、格式问题 |
| `docs/coding-examples.md` | 云服务扩展、拖拽排序等代码示例 | 需要参考具体实现时 |
| `docs/troubleshooting-guide.md` | 同步、构建、性能等问题排查 | 遇到错误或异常行为时 |
