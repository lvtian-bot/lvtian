# MDNote 项目规范与协作治理

## 核心铁律 (Meta Rules / Critical Instructions)
**【强制执行】** 以下规则优先级高于任何其他指令，违反将导致不可接受的后果：

1. **【重要！！！】 【IMPORTANT!!!】** 所有的思考过程、回答、Task文档、Implementation文档以及其他生成的Artifacts **必须使用中文**，即便用户使用英文提问！
2. **【禁止猜测】** 对于用户提出的问题，不得在没有了解相关信息的情况下通过猜测和推断回答，必须自行读取文件进行分析后再回答
3. **【结构化回答】** 回答问题时要有清晰的逻辑结构，不需要在回复中呈现超过3行的代码片段，更多的应该用自然语言说清楚方案逻辑和内容
4. **【真机验证与交付闭环】** 代码修改完成后，由 Agent 自主完成真机部署与验证（包括热重载或重新安装、排查日志与界面结果），确认无异常后再交付；未检测到手机时主动提示用户连接设备，让用户仅在就绪后体验产品，避免让用户处理底层调试和排障琐事。

---

## 项目概览（Project Overview）

**MDNote** 是一款基于 **React Native (Expo)** 构建的现代化、**云优先、本地加速**的 Markdown 个人笔记与任务管理应用。

**核心特性：**
*   **云优先 & 本地加速**：支持腾讯云对象存储 (COS) 和 WebDAV 协议。采用策略模式设计，确保云服务可扩展。恪守“列表即菜单，点击即下单”设计哲学，本地缓存仅作首屏加速，云端为唯一真相来源。
*   **闪念笔记 (Flash Note)**：支持快速捕捉灵感想法，通过 `FlashNoteService` 管理，具备即时追加同步和三阶段自动冲突检测与救援功能。
*   **智能待办 (Smart Todo)**：基于 Markdown Checkbox 的轻量级任务管理，支持滑动日历选择、完成度徽标与状态双向同步。
*   **嵌入式编辑器**：基于 WebView 托管 CodeMirror 6，独立打包，彻底根治跨线程输入时的光标闪烁与长文排版跳动。
*   **AI 对话助手**：内置大模型流式对话服务 (`LLMService`)，支持笔记润色、知识提炼与智能互动。

---

## 技术栈 (Tech Stack)

| 类别 | 技术 | 版本/说明 |
|-----|------|----------|
| **运行时** | Node.js, JDK | LTS v20+, JDK 17 |
| **核心框架** | React Native<br>Expo<br>React | 0.86.3<br>SDK 57 (托管工作流 + 预构建插件)<br>19.2.3 |
| **语言** | TypeScript | 5.x (严格模式，严禁使用 any) |
| **状态管理** | Zustand | 轻量级，模块化 Store (支持持久化) |
| **导航** | React Navigation | 7 (Native Stack + Bottom Tabs) |
| **国际化** | i18next | + react-i18next (启动首位加载) |
| **编辑器** | CodeMirror 6 | + Vite (WebView 托管单文件打包) |
| **同步核心** | 自研三阶段同步 + diff-match-patch | 支持 ETag 乐观锁、三路合并与影子文件系统 |
| **核心库** | reanimated, gesture-handler<br>expo-file-system<br>expo-secure-store, crypto-js | 动画/手势<br>文件系统沙盒<br>加密凭据与哈希签名 |

---

## 业务逻辑与架构细节 (Architecture & Business Logic)

### 项目结构 (Project Structure)
```text
MDNote/
├── App.tsx                          # 应用主入口 (Provider 初始化与状态挂载)
├── app.config.js                    # Expo 动态配置与自定义插件
├── plugins/                         # Expo Config Plugins (原生行为定制)
│   ├── withKeystore.js              # Keystore 生产签名注入插件
│   └── withDisablePredictiveBack.js # 禁用 Android 预测性返回手势
├── src/                             # 核心源码
│   ├── components/                  # 可复用 UI 组件 (StatusBanner, DatePickerModal...)
│   ├── constants/                   # 事件常量 (events.ts)
│   ├── editor-web/                  # CodeMirror 6 嵌入式编辑器工程 (Vite)
│   │   ├── index.ts / index.html    # 编辑器核心源码
│   │   ├── vite.config.ts           # 单文件打包配置
│   │   ├── generate-html.js         # 生成包装器脚本
│   │   └── editorHtml.ts            # 注入 RN WebView 的产物
│   ├── hooks/                       # 自定义 Hooks (useCloudSync, useFlashNoteList...)
│   ├── locales/                     # 国际化语言包 (zh.json, en.json)
│   ├── navigation/                  # 导航配置 (AppNavigator, TabNavigator, NoteNavigator)
│   ├── screens/                     # 页面级组件 (FlashScreen, TodoScreen, NoteScreen, PreviewScreen, EditorScreen...)
│   ├── services/                    # ⭐ 业务逻辑服务层 (业务中枢)
│   │   ├── CloudService.ts          # 云服务策略入口 (ICloudProvider)
│   │   ├── TencentCOSProvider.ts    # 腾讯云 COS 实现
│   │   ├── WebDavProvider.ts        # WebDAV 协议实现
│   │   ├── FileSystemService.ts     # 文件读写唯一入口 (Scoped Storage 封装)
│   │   ├── FlashNoteService.ts      # 闪念追加写入与时间格式处理
│   │   ├── SyncService.ts           # 同步核心引擎 (上传/下载/冲突调度)
│   │   ├── ShadowFileService.ts     # 影子文件系统 (.shadows/ 基准副本)
│   │   └── LLMService.ts            # AI 模型流式传输服务
│   ├── store/                       # ⭐ 状态管理层 (Zustand)
│   │   ├── useSettingsStore.ts      # 基础配置与云服务选择 (SecretKey 存 SecureStore)
│   │   ├── useFileMetadataStore.ts  # ETag 与本地文件元数据 (冲突检测核心依据)
│   │   ├── useSyncStore.ts          # 上传队列与同步流转 (Write-Through 机制)
│   │   ├── useFileListStore.ts      # 云端列表快照缓存
│   │   ├── useShareStore.ts         # 跨进程系统分享处理
│   │   └── useAIStore.ts            # AI 对话与模型配置
│   ├── types/                       # TypeScript 类型定义
│   └── utils/                       # 工具函数 (mergeUtils, TodoParser, cosSignature...)
└── docs/                            # ⭐ 模块化设计与运维文档体系
```

### 核心文件快速索引 (Quick File Index)

| 文件路径 | 关键职责 | 必读场景 |
|---------|---------|---------|
| `src/services/SyncService.ts` | 同步引擎核心 (三阶段对账/冲突调度) | 同步逻辑、全量对账、冲突排查 |
| `src/services/CloudService.ts` | 云策略入口 (TencentCOS/WebDAV 调度) | 上传、下载、云协议扩展 |
| `src/services/FlashNoteService.ts` | 闪念时间线流式追加写入逻辑 | 闪念功能、时间格式规范 |
| `src/services/FileSystemService.ts` | 文件系统操作唯一入口 | 文件读写、沙盒路径、Scoped Storage |
| `src/services/ShadowFileService.ts` | 影子文件副本管理 (`.shadows/`) | 三路合并基准、冲突恢复 |
| `src/store/useFileMetadataStore.ts` | ETag/LastModified 持久化存储 | 冲突检测核心依据、HEAD 比对 |
| `src/store/useSyncStore.ts` | 上传队列管理 (Write-Through 机制) | 异步重试、队列流转 |
| `src/components/StatusBannerContainer.tsx` | 统一状态横幅容器 | UI 状态提示、逐一击破解决冲突 |
| `src/editor-web/` | CodeMirror 6 嵌入式编辑器源码 | 编辑器排版、Bridge 协议、Vite 构建 |

### 1. 核心代码职责划分 (`src/`)
*   **`services/` (业务中枢)**：所有核心逻辑下沉于此。
    *   `CloudService`: 云策略入口 (`TencentCOS` / `WebDAV`)。**操作前必须校验 `isConfigured()`**。
    *   `FlashNoteService`: 追加写入 `flash_notes.md` (格式严守 `## YYYY-MM-DD HH:mm:ss`)。
    *   `FileSystemService`: **文件操作唯一入口** (封装 Expo API 以兼容 Scoped Storage，严禁直接用第三方 RNFS)。
    *   `ShadowFileService`: 维护 `.shadows/` 目录下的基准版本，支撑智能三路合并。
*   **`store/` (状态管理)**：基于 Zustand。
    *   `useSettingsStore`: 基础配置 (SecretKey 存 SecureStore)。
    *   `useFileMetadataStore`: 存 ETag/LastModified，**冲突检测核心依据** (`headFile` 对比)。
    *   `useSyncStore`: 上传队列 (Write-Through 机制：写入即加入队列)。
*   **`navigation/` & `screens/`**：
    *   `FlashNoteInputModal`: 全局模态框，用于快速录入。
    *   新页面开发需在 `types/navigation.ts` 定义路由，并使用 `useTranslation`。
    *   `i18n.ts`: 国际化入口，App 启动首位加载。

### 2. 基础设施 (Non-src)
*   **`android/`**：Expo Prebuild 生成物。**严禁直接修改**，必须通过 `app.config.js` 插件 (`plugins/`) 定制。
*   **`src/editor-web/`**：CodeMirror 嵌入工程，修改后必须执行 `npm run build:editor` 重新打包注入。
*   **`docs/`**：模块化设计文档与问题记录体系。
*   **`assets/`**：静态图标与打包资源。

---

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
    *   关键业务逻辑（如同步、文件读写）必须包含 `try-catch` 错误处理与超时熔断控制。
*   **事件通信**：
    *   组件与非 React 上下文（如后台服务）通信时，使用 `DeviceEventEmitter`（例如 `SHARE_RECEIVED_EVENT`）。
*   **类型安全**：
    *   严禁使用 `any`，所有 Props 和接口必须定义明确的 TypeScript Interface。

---

## 核心命令（Key Commands）

| 场景 | 命令 | 备注 |
|-----|------|------|
| **环境安装** | `npx expo install` | 初次安装或更新依赖 |
| **预构建原生** | `npx expo prebuild --clean` | 修改 app.config.js 或原生插件后需要 |
| **启动开发** | `npx expo start` | Metro Bundler (可加 `-c` 清缓存) |
| **运行 Android（开发）** | `npx expo run:android` | Debug 构建，部署到真机/模拟器本地调试 |
| **运行 iOS（开发）** | `npx expo run:ios` | Debug 构建，仅用于本地调试 |
| **正式整包发版（云端 CI）** | 打 tag `v*` 推送 | **发版首选**：GitHub Actions 自动构建 APK 并发布 Release（操作见项目技能 `mdnote-release`） |
| **构建 Android APK（本地备用）** | `eas build --platform android --profile preview --local` | 本地执行 EAS 流程，输出测试/备用 APK |
| **构建 Android AAB（云端发版）** | `eas build --platform android --profile production` | Play Store 用，输出 AAB，在 EAS 云端构建 |
| **构建 iOS（云端）** | `eas build --platform ios --profile production` | App Store 用，须在 EAS 云端构建 |
| **编辑器构建** | `npm run build:editor` | 修改 `src/editor-web/` 后必须执行（Vite 打包 + HTML 注入） |
| **类型检查** | `npx tsc --noEmit` | 静态类型检查，修改代码后推荐运行 |
| **代码检查** | `npx eslint .` | 代码风格检查 |
| **运行测试** | `npx jest` | 单元测试 |

---

## 重要提示（Important Notes）

1.  **Android 构建配置 (Expo Prebuild)**：项目使用了高度定制的 `app.config.js`，包含“禁用预测性返回手势”、“Keystore 注入”等插件。**严禁直接修改 `android/` 目录下的代码！** 任何原生层面的修改**必须**通过编写 Config Plugin (`plugins/`) 实现，否则每次运行 `npx expo prebuild` 都会导致修改丢失。
2.  **国际化强制约束**：不要硬编码中文或英文，所有面向用户的文本均需使用国际化编码方式 `i18next`。
3.  **云同步与 Hydration 顺序**：`CloudService` 依赖于 `useSettingsStore` 的配置（Provider 类型）。在调用 `initProvider()` 前需确保 Store 已 Hydrate（`hasHydrated` 标志为 true）。
4.  **编辑器调试与构建**：WebView 编辑器运行在独立环境中，修改源码后必须执行 `npm run build:editor`；调试时需通过 Bridge 的 `LOG` 消息关注 WebView 控制台输出。
5.  **文件沙盒权限**：Android 端利用了 Scoped Storage，文件操作需严格依赖 `FileSystemService` 封装的方法，严禁使用硬编码路径。
6.  **文件系统 API 演进**：项目目前混用 `expo-file-system` 的新老 API。新功能开发应优先考虑新版 API，但必须注意兼容性。改动文件系统相关代码前先读 `docs/Expo_FileSystem迁移备忘录.md`，禁止在未确认替代方案的情况下移除稳定引用。

---

## 专题文档索引 (Detailed Docs Index)

按需读取对应专题文档并核对代码，不默认通读；文档说明当前实现，动手前仍须核对目标代码。

| 文档 / 目录 | 核心定位与阅读时机 |
|------------|-------------------|
| `docs/技术架构.md` | **技术架构总貌（先读，用于定位模块）**：系统蓝图、模块与目录对照表、核心数据链路、跨模块约定 |
| `docs/开发环境.md` | **开发环境与构建规范**：Windows 四层工具链、JDK/SDK 版本依据、本地 EAS 发版命令、环境踩坑备忘 |
| `docs/Expo_FileSystem迁移备忘录.md` | `expo-file-system` 新老 API 混用规则、Scoped Storage 封装底线与迁移备忘 |
| `docs/编码规范与示例.md` | 编码规范详解、DRY 原则、扩展新云端/页面/Hook/Store 代码范式、手势与拖拽排序参考 |
| `docs/同步/` | `同步算法与流转设计.md`（Stage 1-3、状态矩阵、决策树、Banner 优先级）＋ `三路合并与乐观锁.md`（diff-match-patch、ETag、影子系统）＋ `同步问题记录.md` |
| `docs/多云端/` | `多云端架构与实现.md`（ICloudProvider 策略模式、COS 签名、WebDAV 映射）＋ `多云端问题记录.md` |
| `docs/编辑器/` | `编辑器架构与选型.md`（CodeMirror 6 嵌入、Vite 单文件打包注入、Bridge 协议）＋ `编辑器问题记录.md` |
| `docs/闪念与待办/` | `闪念与待办业务逻辑.md`（时间线格式规范、TodoParser 算法与日历联动）＋ `闪念与待办问题记录.md` |
| `docs/浏览与缓存/` | `云优先架构与按需缓存.md`（“列表即菜单，点击即下单”、View/Action 分层、单向数据流）＋ `浏览与缓存问题记录.md` |
| `docs/AI助手/` | `AI助手架构与流式实现.md`（LLMService 抽象、SSE 流式打字机实现、凭据安全）＋ `AI助手问题记录.md` |
| `docs/分享与原生插件/` | `分享扩展与原生插件配置.md`（跨进程分享广播、Config Plugins）＋ `分享与原生插件问题记录.md`（新架构生命周期修复） |
| `docs/运维与排障/` | `故障排查与速查手册.md`（全链路排查步骤、错误代码速查表、日志收集）＋ `运维与排障问题记录.md` |
| `docs/TODO.md` | **任务待办登记**：新功能 / Bug 修复 / 暂不考虑；发版时归档至 `docs/TODO-ARCHIVE.md` |
| `docs/TODO-ARCHIVE.md` | 历史版本已完成待办事项归档 |
| `docs/outdated/` | 历史归档文档（早期 PRD、过渡方案探索等，仅供追溯历史，不作为现行依据） |

---

## 项目管理与自主演进 (Project Management & Autonomy)

### 1. 工作规范
*   **真机验证与交付闭环**：代码修改后，由 Agent 自主在连接的真机上完成部署、热重载与界面日志验证。未连接手机时主动提示用户连接设备，避免让用户处理底层排查与测试，确保最终交付时应用已就绪，用户直接上手体验。
*   **范围控制**：修改代码前先查看 `git status` 与目标文件差异，只处理本任务范围，严禁带入无关文件的改动。
*   **分支权限**：创建分支必须先取得用户同意，不得擅自创建或切换分支。
*   **文案确认**：用户可见的界面文案（设置项名称、按钮文字、提示语等）修改前须向用户展示并取得明确确认。
*   **原子提交原则**：每个提交对应一个完整、独立的逻辑单元，以意图是否单一完整为准，不以改动行数为准；零散关联的变更宜在收尾时合并为一个提交；未推送的提交需要修整时优先 `amend`，不追加无意义的修正提交。
*   **任务协同**：用户已给明确任务时直接处理；需要选择或规划未完成工作、或任务明确指向已有事项时查阅 `docs/TODO.md`。新增事项按「新功能」「Bug 修复」「暂不考虑」归类；完成事项按 `✅ YYYY-MM-DD` 打标，发版时归档至 `docs/TODO-ARCHIVE.md`。

### 2. 上下文维护机制（自主闭环治理核心）
*   **长期上下文分三层**：
    1.  *第一层（索引与准则）*：本文件 `AGENTS.md`（项目规范、铁律、核心命令与全局索引）；
    2.  *第二层（领域事实与经验）*：`docs/` 模块专题文档与问题记录（架构设计、算法原理、历史踩坑与技术约束）；
    3.  *第三层（唯一真相源）*：代码本身。可从权威代码获取的信息（如依赖版本以 `package.json` 为准）不在文档中冗余硬编码。
*   **文档单一真相与即时纠偏**：产品方向、架构设计、模块职责或接口变化时，只更新受影响的权威文档；发现过时或冲突表述时直接就地修正，禁止累积多份现状文档。
*   **TODO 与问题档案的分工**：`docs/TODO.md` 主要记录任务目标、必要范围和完成状态；规划与路线图留在所属模块文档中维护。**核心大问题（顽固 Bug、反复出现的冲突、异常崩溃）的完整档案不写进 TODO，必须记录在所属模块的问题记录文档（`docs/<模块>/<模块>问题记录.md`，缺则先建）**，TODO 条目只登记任务并链接该档案；进行中的复杂调查可暂存排障信息，问题解决后收敛任务。
*   **排查过程闭环（失败方案与成功方案同等重要）**：在所属模块的问题记录文档中，每尝试一个方案（无论成败）都必须实时回写结果；问题根治后，将最终结论收敛沉淀为模块技术文档中的**技术约束**。
*   **防复发技术沉淀**：已解决且容易复发的非显然 Bug，必须将触发条件、根因和必须保持的技术约束写入所属专题文档，不保留无意义的冗长排障流水。
*   **历史退役机制**：文档完成历史使命后统一移入 `docs/outdated/`，细节由 Git 历史承载；`outdated/` 目录仅用于追溯历史，不作为现行技术依据。

### 3. 提交规范
*   **Conventional Commits**：遵循规范前缀（`feat` / `fix` / `chore` / `docs` / `refactor` 等）+ 中文主题，一行说清改动意图，不加末尾句号。
*   **版本发布管理**：版本号从末位逐位递增（如 `0.6.1` → `0.6.2`），发布提交统一为 `chore: 发布 X.Y.Z`；修改版本号或发布前，须向用户报出拟用版本号并取得明确同意。
