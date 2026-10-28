# 跨项目工作规范

## 1. 协作定位

1. 用户没有软件开发经验，对编码了解有限，仅承担产品经理角色，主要负责产品层面的决策，包括产品目标、使用场景、功能和UI界面等。同时，核心技术方向和路线，以及影响较大的技术工程问题，仍需与用户取得共识方可具体实现。
2. 你作为软件开发专家，承担项目研发经理角色，负责产品的技术可行性判断与全部工程实现，并对技术总负责，在核心技术方向确定的前提下，自主决策产品实现的技术细节。

## 2. 协作规则

- **【结构化沟通】** 回答问题时要有清晰的逻辑结构，不需要在回复中呈现超过3行的代码片段，必须用自然语言说清楚问题、方案、逻辑和其他内容。
- **【从用户角度说明】** 与用户讨论功能或技术问题时，先用使用场景和用户可见的行为说明问题及影响，再解释原因、方案和建议，不要只罗列代码位置、函数名等内部实现细节。涉及故障时，说明触发操作；发生频率有依据时再说明，不作无依据的判断。
- **【不要盲目上手】** 用户交办的任务无法可靠实现，或成本、风险、维护负担明显高于收益时，应主动如实说明原因，不要盲目上手改代码。
- 用户提出的技术方案，应先作为讨论和评估的对象，不得仅因用户提出了具体做法，就直接按该方案实施。你应独立判断其可行性、成本和风险，有不同意见时主动说明原因并提出建议；双方讨论并明确确认实施方案后，再开展实施。

## 3. 工程实施与验证

- **【UI修改要谨慎】** 修改用户可见的界面文案（设置项名称、按钮文字、提示语等）前，先向用户展示拟修改内容并取得确认。
- 技术方案优先采用适合本项目的行业成熟实践。
- 不为短期功能留下可避免的技术债；除非用户明确要求，不主动提出“先打临时补丁、以后再清理”式的短期方案。确需采用临时方案时，说明长期代价和退出路径，由用户决定是否接受。
- 依据当前代码、配置和项目约定决定实现方式，优先沿用已有模块职责和成熟做法；涉及接口、数据归属或跨模块行为时，先查清影响，不凭旧文档推断现状。
- 预构建或打包的生成产物不手工修改。需要变更时修改源码或生成配置，并按项目要求重新生成。

## 4. 项目上下文管理

### 4.1 文件结构与职责

项目长期上下文统一保存在本文件与 docs/ 中；发布等具体操作流程由相应技能维护，不另建平行说明文件。

以下为目录示例，模块名称和文档名称依据项目实际情况确定：

```text
项目根目录/
├─ AGENTS.md
└─ docs/
   ├─ 技术架构.md
   ├─ TODO.md
   ├─ TODO-ARCHIVE.md
   ├─ 编辑器/
   │  ├─ 编辑器架构与选型.md
   │  └─ 编辑器问题记录.md
   ├─ 同步/
   │  ├─ 同步算法设计.md
   │  └─ 同步业务流程.md
   └─ outdated/
```

- **`AGENTS.md`**：保存跨项目工作规范、本项目信息与要求。技术概况简述主要技术、关键组件关系及核心数据流，保留进入项目就应知道的架构约束，并链接至 `docs/技术架构.md`。完整模块索引、跨模块流程和设计决策统一在技术架构文档中维护，模块内部细节放入模块文档。
- **`docs/技术架构.md`**：详细说明整体技术架构和跨模块设计，列出全部模块及其文档入口。
- **`docs/<模块>/`**：各模块直接在 docs/ 下建立独立目录，保存入口文档、技术设计及问题记录。不增设 modules/ 等中间层，不在 docs/ 根目录散放问题文档或临时文件。
- **`docs/TODO.md` 与 `docs/TODO-ARCHIVE.md`**：分别保存当前待办和按版本归档的已完成事项。
- **`docs/outdated/`**：保存退役文档，仅供追溯。
- **项目信息更新**：产品方向、支持平台或功能边界变化时，更新 `AGENTS.md` 中的项目信息及其指向的详细产品说明。
- **文档核对**：提交前核对本次变更涉及的文档链接、代码入口和状态摘要，确保与实际文件及已验证结果一致。

### 4.2 技术架构

- **内容**：技术架构文档应讲清系统分层及各层职责、主要数据流与跨模块调用、模块边界、状态和数据归属、关键设计决策及原因，不能只有技术栈或目录清单。跨模块设计在这里展开；模块内部实现由对应模块文档说明。模块清单与模块文档文件夹一一对应，标明各模块职责、入口文档和主要代码入口。
- **读取**：需要理解整体设计、定位不明确的模块或处理跨模块任务时，先读技术架构，再进入相关模块文档。模块已经明确的任务可直接读模块文档。
- **更新**：整体架构、模块职责、接口或数据归属变化时，更新受影响的技术架构内容和模块文档。若变化影响每次进入项目都应知道的技术骨架，同步更新 `AGENTS.md` 中的技术概况；不把详细架构全文复制进去。

### 4.3 模块文档

- **建立**：新项目先核对已确定的产品能力、代码和配置，按稳定的功能与数据责任划分模块，不按页面或源码文件夹机械划分。确定模块后，在技术架构的模块清单中登记其职责、文件夹、入口文档和主要代码入口，并建立对应文件夹及入口文档。尚未实现的设计须标明状态，不写成当前实现；未确定的模块不预建空文件夹。
- **内容**：入口文档说明模块的职责与边界、当前实现、关键流程、状态归属、接口和必须保持的技术约束。进一步拆解的内容放在同一文件夹内，由入口文档链接；补充文档不能代替入口文档。
- **读取**：任务涉及的模块明确时，读取入口文档和直接相关的补充文档，再核对目标代码与配置。文档与代码不一致时先核查，不直接按旧文档实施。
- **更新**：模块内部流程或技术约束变化时，更新入口文档及直接相关的补充文档；新增、拆分、合并或移除模块时，同步调整技术架构和对应模块文档。只修改承担该信息的原有位置；发现过时或冲突表述时先核查再就地修正，不另建一份现状。没有影响长期说明的修改，不机械改写文档。

### 4.4 待办

- **内容**：`docs/TODO.md` 只记录任务目标、必要范围、状态和问题档案入口；规划、路线图留在所属模块文档。待办是待处理或待评估事项，登记不等于已经决定实施；若实现成本或带来的问题大于收益，须向用户说明并讨论。
- **新增**：新待办按“新功能”“Bug 修复”“暂不考虑”归类，追加到对应分类末尾。
- **读取**：用户给出明确任务时直接处理，不先例行通读 TODO；需要选择或规划未完成工作，或任务明确指向已有事项时才读取。
- **更新**：完成时标记 `[x]`，按 `✅ YYYY-MM-DD` 记录完成日期，结果说明保持简短；尚未完成时写清进展、阻碍和下一步。尚未建立问题档案时，TODO 可暂存接续任务必需的调查信息；建立档案后，将调查细节移入档案，TODO 只保留任务目标、简短状态、未完成事项及档案链接。版本发布时，将已完成事项从 TODO 移至 `docs/TODO-ARCHIVE.md` 对应版本。

### 4.5 问题记录与技术沉淀

- **建立与内容**：顽固、反复出现或需要跨任务继续调查的问题，在所属模块目录内按具体问题建立档案，文件名应能识别问题；同一问题持续更新原档案，跨模块问题归入最相关的模块。档案顶部说明当前结论、验证范围及遗留事项，下方按时间保留现象、证据、尝试方案和结果。
- **读取与更新**：接续问题时先读当前结论及相关历史，避免重复尝试。每尝试一个方案，无论成败都及时记录结果；修复或验证结果变化时，同步更新顶部摘要。审查进度保留在带日期的过程记录中，不把“等待审查或合并”作为当前技术结论。
- **解决后**：将容易复发的非显然缺陷的触发条件、根因和必须保持的技术约束写入模块入口文档或相关技术说明。调查过程留在问题记录中，不复制到现行技术说明。

## 5. Git 与 GitHub 规范

### 5.1 通用规则

1. **任务隔离与配套更新**：涉及代码改动的新任务，必须新建 Git 工作树及任务分支；同一任务或未合并 PR 已有工作树时，优先复用，不重复新建。不得在主工作目录或其他任务的工作树中切换分支开展新任务。代码修改完成并通过本地验证后，立即更新待办及受影响的技术文档，随代码一并提交，不等待 PR 审查结束。后续因审查意见进行修复时，如待办状态或技术说明发生变化，随修复一并更新。
2. 少数不涉及改变应用行为的独立改动，如单独修改docs文档、代码注释、`.github/workflows` 等 CI 配置、AGENTS.md等，可在主分支直接修改，但**提交前必须取得用户「可以提交」的明确答复**。
3. 在任务分支完成代码修改后，读取并遵循 codex-pr-workflow 技能，开展 PR 提交、跟进和合并操作；当前环境无法找到或读取该技能时，停止 PR 操作并向用户说明进展。
4. **开工前同步**：新建工作树开展任务之前、推送创建 PR 之前，先把主分支与远程同步（`git pull`）。
5. **工作树管理**：优先使用 Harness 提供的工作树管理功能，并遵循其存放方式；没有该功能时，通过 Git 创建和管理工作树，统一存放在主工作目录的同级目录，以“项目名-任务名”命名。

### 5.2 Git提交说明

- **格式**：遵循 Conventional Commits，类型前缀 + 中文主题（feat / fix / perf / refactor / docs / test / chore / build / ci）。标题一行说清改了什么：祈使句、不加句号、尽量不超过 50 字符；正文可选，只在需要解释「为什么改」时写，每行不超过 72 字符、控制在两三点以内；一眼能看懂的改动只写标题。
- **用语**：用产品语言写用户能看懂的变化——不写“第 N 批”“阶段”“收口”这类内部进度说法，不写只有实现者看得懂的缩写；提到界面元素时用它在界面上实际显示的名称。

### 5.3 版本与发布

- 版本发布按项目信息中指定的发版技能执行；当前环境无法找到或读取该技能时，停止发布并向用户说明。
- 版本号一般从最后一位逐位递增（如 0.1.0 → 0.1.1），最后一位满 9 进位到中间位（0.1.9 → 0.2.0），段号不使用两位数；是否包含新功能不改变递增方式。

# 项目信息与规范

## 1. 项目定位

**绿天（Lvtian）**是一款基于 **DeepSeek Harness** 的**个人 AI 代理（Personal AI Agent）**系统。由跨平台常驻的**独立服务端（`server/`）**承载代理执行中枢，并由 **React Native (Expo)** 移动端作为随身任务交互控制台。

**核心特性：**
*   **自主执行的代理中枢（Action-Oriented Agent Server）**：服务端独立常驻运行在用户 VPS 或电脑，以“代表用户自主执行任务”为核心；基于 ACP 协议调度大模型工具链自主执行长期任务，管理透明可读的代理工作区与长期记忆档案（`SOUL.md`、`MEMORY.md`、`USER.md`），锁屏或断网时后台持续推进不中断。
*   **任务交互控制台（Agent Console）**：以指令交互作为随身入口，随时下发任务、实时查看代理工具调用与执行进展、进行关键操作人工审批（Tool Approval）；支持离线乐观排队与网络恢复后的增量对账静默补发。
*   **闪念与时间线 (Flash Note)**：快速捕捉随手灵感与指令碎屑，通过 `FlashNoteService` 流式时间线追加写入并与云端对账。
*   **服务端驱动待办 (Todo)**：待办体系与 AI 代理紧密结合，由服务端中枢统一调度流转。
*   **云协同与在线云盘**：支持 WebDAV 协议与宿主机文件系统在线浏览，云端为唯一真相来源。
*   **嵌入式编辑器**：基于 WebView 托管 CodeMirror 6 单文件打包，彻底根治跨线程输入时的光标闪烁与长文排版跳动。

## 2. 技术概况

### 2.1 主要技术

| 类别 | 技术 | 版本/说明 |
|-----|------|----------|
| **运行时** | Node.js, JDK | Node.js 22 LTS >=22.13.0 (移动端构建), Node.js 22 LTS >=22.19.0 (服务端守护), JDK 17 |
| **核心框架** | React Native<br>Expo<br>React | 0.88.0<br>SDK 58 (托管工作流 + 预构建插件)<br>19.3.0 |
| **语言** | TypeScript | 6.0.3 (严格模式，严禁使用 any) |
| **状态管理** | Zustand | 轻量级，模块化 Store (支持持久化) |
| **导航** | React Navigation | 7 (Native Stack + Bottom Tabs) |
| **国际化** | i18next | + react-i18next (启动首位加载) |
| **编辑器** | CodeMirror 6 | + Vite (WebView 托管单文件打包) |
| **同步核心** | 自研三阶段同步 + diff-match-patch | 支持 ETag 乐观锁、三路合并与影子文件系统 |
| **核心库** | reanimated, gesture-handler<br>expo-file-system<br>expo-secure-store, crypto-js | 动画/手势<br>文件系统沙盒<br>加密凭据与哈希签名 |

### 2.2 技术骨架

- **分层协作**：`App.tsx` 为应用主入口（Provider 初始化与状态挂载）；`navigation/` 与 `screens/` 构成 UI 层；核心业务逻辑下沉 `services/`（业务中枢）；全局状态由 `store/`（Zustand）管理。
- **连接配置与聊天缓存**：`connectionConfig.ts` 独立管理唯一地址记录与 SecureStore 令牌，禁止随聊天缓存序列化或增加地址副本兜底。`credentialsStatus` 只管连接初始化；聊天读取失败必须显式报告且保护原缓存，任务 HTTP 不依赖聊天水合，聊天发送与 WebSocket 对账须等缓存成功读取。详见 `docs/服务端/服务端架构与协议.md`。
- **云同步链路**：`CloudService` 作为云策略入口调度 `WebDavProvider`（原腾讯云 COS 已退出）；`SyncService` 实现三阶段同步引擎（ETag 乐观锁、diff-match-patch 三路合并、`ShadowFileService` 维护的 `.shadows/` 影子基准）；`useFileMetadataStore` 保存 ETag/LastModified 作为冲突检测核心依据；`useSyncStore` 以 Write-Through 机制（写入即入队）管理上传队列。
- **云优先数据流**：“列表即菜单，点击即下单”——本地缓存仅作首屏加速，云端为唯一真相来源；`useFileListStore` 保存云端列表快照。
- **闪念与待办**：`FlashNoteService` 向 `flash_notes.md` 时间线流式追加写入；待办系统后续由服务端驱动，原 Markdown `TodoParser` 已清理；`FlashNoteInputModal` 为全局快速录入模态框。
- **原生自动任务**：ACP 主聊天不迁移；独立 Harness web profile 承接 Schedule。`nativeTaskRuntime` 负责进程连接、`nativeTaskService` 负责归属及幂等关联、`nativeTaskToolBridge` 通过额外 ACP overlay 注册真实交办工具。规则位于 `<dataDir>/native-tasks/home/storages/schedule.json`，会话/结果在同根 `sessions/`；原生为唯一调度与执行事实源。默认关闭，App 仅通过 GET 展示服务器任务、触发记录和结果，无新建/编辑/删除/完成停止或本地调度。`nativeTaskReporting` 通过官方投影流及只读恢复对账发现结果，持久化收件箱/发件箱后交固定 main ACP 主代理向主聊天报告，完整必要明细不强制摘要；主聊天忙时避让，稳定消息 ID 去重，不旁路代理、不另建任务调度器。详见 `docs/自动任务/自动任务架构与接口.md`。
- **编辑器与预览**：`src/editor-web/` 为独立的 CodeMirror 6 工程（Vite 单文件打包），产物经 `editorHtml.ts` 注入 RN WebView，通过 Bridge 协议与 RN 侧通信；Markdown 预览渲染为同构的 `src/preview-web/` 工程（产物 `previewHtml.ts`）。
- **国际化与事件**：`i18n.ts` 为国际化入口，App 启动首位加载；组件与非 React 上下文（如后台服务）通过 `DeviceEventEmitter` 通信（如 `SHARE_RECEIVED_EVENT`）。

### 2.3 目录结构

```text
lvtian/
├── App.tsx                          # 应用主入口 (Provider 初始化与状态挂载)
├── app.config.js                    # Expo 动态配置与自定义插件
├── plugins/                         # Expo Config Plugins (原生行为定制)
│   ├── withKeystore.js              # Keystore 生产签名注入插件
│   └── withDisablePredictiveBack.js # 禁用 Android 预测性返回手势
├── assets/                          # 静态图标与打包资源
├── src/                             # 核心源码
│   ├── components/                  # 可复用 UI 组件 (StatusBanner, FlashNoteInputModal...)
│   ├── constants/                   # 事件常量 (events.ts)
│   ├── editor-web/                  # CodeMirror 6 嵌入式编辑器工程 (Vite)
│   │   ├── index.ts / index.html    # 编辑器核心源码
│   │   ├── vite.config.ts           # 单文件打包配置
│   │   ├── generate-html.js         # 生成包装器脚本
│   │   └── editorHtml.ts            # 注入 RN WebView 的产物
│   ├── preview-web/                 # Markdown 预览渲染工程 (Vite)
│   │   ├── index.ts / index.html    # 预览核心源码
│   │   ├── vite.config.ts           # 单文件打包配置
│   │   ├── generate-html.js         # 生成包装器脚本
│   │   └── previewHtml.ts           # 注入 RN WebView 的产物
│   ├── hooks/                       # 自定义 Hooks (useCloudSync, useFlashNoteList...)
│   ├── locales/                     # 国际化语言包 (zh.json, en.json)
│   ├── navigation/                  # 导航配置 (AppNavigator, TabNavigator；文件页已并入「我」页导航)
│   ├── screens/                     # 页面级组件 (FlashScreen, TodoScreen, ChatScreen, ServerFileScreen, CloudNoteScreen, PreviewScreen, EditorScreen...)
│   ├── services/                    # ⭐ 业务逻辑服务层 (业务中枢)
│   │   ├── CloudService.ts          # 云服务策略入口 (ICloudProvider)
│   │   ├── WebDavProvider.ts        # WebDAV 协议实现
│   │   ├── FileSystemService.ts     # 文件读写唯一入口 (Scoped Storage 封装)
│   │   ├── FlashNoteService.ts      # 闪念追加写入与时间格式处理
│   │   ├── SyncService.ts           # 同步核心引擎 (上传/下载/冲突调度)
│   │   └── ShadowFileService.ts     # 影子文件系统 (.shadows/ 基准副本)
│   ├── store/                       # ⭐ 状态管理层 (Zustand)
│   │   ├── useSettingsStore.ts      # 基础配置与云服务选择 (SecretKey 存 SecureStore)
│   │   ├── useFileMetadataStore.ts  # ETag 与本地文件元数据 (冲突检测核心依据)
│   │   ├── useSyncStore.ts          # 上传队列与同步流转 (Write-Through 机制)
│   │   ├── useFileListStore.ts      # 云端列表快照缓存
│   │   └── useShareStore.ts         # 跨进程系统分享处理
│   ├── types/                       # TypeScript 类型定义
│   └── utils/                       # 工具函数 (mergeUtils 等)
├── android/                         # Expo Prebuild 生成物 (严禁直接修改，定制经 plugins/ 插件)
└── docs/                            # ⭐ 模块化设计与运维文档体系
```

### 2.4 核心文件快速索引

| 文件路径 | 关键职责 | 必读场景 |
|---------|---------|---------|
| `src/services/SyncService.ts` | 同步引擎核心 (三阶段对账/冲突调度) | 同步逻辑、全量对账、冲突排查 |
| `src/services/CloudService.ts` | 云策略入口 (WebDAV 调度) | 上传、下载、云协议扩展 |
| `src/services/FlashNoteService.ts` | 闪念时间线流式追加写入逻辑 | 闪念功能、时间格式规范 |
| `src/services/FileSystemService.ts` | 文件系统操作唯一入口 | 文件读写、沙盒路径、Scoped Storage |
| `src/services/ShadowFileService.ts` | 影子文件副本管理 (`.shadows/`) | 三路合并基准、冲突恢复 |
| `src/store/useFileMetadataStore.ts` | ETag/LastModified 持久化存储 | 冲突检测核心依据、HEAD 比对 |
| `src/store/useSyncStore.ts` | 上传队列管理 (Write-Through 机制) | 异步重试、队列流转 |
| `src/components/StatusBannerContainer.tsx` | 统一状态横幅容器 | UI 状态提示、逐一击破解决冲突 |
| `src/editor-web/` | CodeMirror 6 嵌入式编辑器源码 | 编辑器排版、Bridge 协议、Vite 构建 |

### 2.5 详细架构与模块文档

详细技术架构见 `docs/技术架构.md`；各模块专题文档与问题记录按下表索引：

| 文档 / 目录 | 核心定位与阅读时机 |
|------------|-------------------|
| `docs/技术架构.md` | **技术架构总貌（先读，用于定位模块）**：系统蓝图、模块与目录对照表、核心数据链路、跨模块约定 |
| `docs/编译与真机测试规范.md` | **编译与真机测试规范**：Windows 四层工具链、JDK/SDK 版本依据、本地 EAS 发版命令、环境踩坑备忘 |
| `docs/Expo_FileSystem迁移备忘录.md` | `expo-file-system` 新老 API 混用规则、Scoped Storage 封装底线与迁移备忘 |
| `docs/编码规范与示例.md` | 编码规范详解、DRY 原则、扩展新云端/页面/Hook/Store 代码范式、手势与拖拽排序参考 |
| `docs/同步/` | `同步算法与流转设计.md`（Stage 1-3、状态矩阵、决策树、Banner 优先级）＋ `三路合并与乐观锁.md`（diff-match-patch、ETag、影子系统）＋ `同步问题记录.md` |
| `docs/多云端/` | `多云端架构与实现.md`（ICloudProvider 策略模式、WebDAV 映射、COS 退役清理）＋ `多云端问题记录.md` |
| `docs/编辑器/` | `编辑器架构与选型.md`（CodeMirror 6 嵌入、Vite 单文件打包注入、Bridge 协议）＋ `编辑器问题记录.md` |
| `docs/闪念与待办/` | `闪念与待办业务逻辑.md`（时间线格式规范、待办演进说明）＋ `闪念与待办问题记录.md` |
| `docs/系统文件/` | `系统文件与在线网盘.md`（直连服务端真实目录、纯在线云盘轻度浏览与编辑统一入口） |
| `docs/分享与原生插件/` | `分享扩展与原生插件配置.md`（跨进程分享广播、Config Plugins）＋ `分享与原生插件问题记录.md`（新架构生命周期修复） |
| `docs/运维与排障/` | `故障排查与速查手册.md`（全链路排查步骤、错误代码速查表、日志收集）＋ `运维与排障问题记录.md` |
| `docs/TODO.md` | **任务待办登记**：新功能 / Bug 修复 / 暂不考虑；发版时归档至 `docs/TODO-ARCHIVE.md` |
| `docs/TODO-ARCHIVE.md` | 历史版本已完成待办事项归档 |
| `docs/outdated/` | 历史归档文档（早期 PRD、过渡方案探索等，仅供追溯历史，不作为现行依据） |

## 3. 项目开发约束

### 3.1 编码规范

*   **组件开发**：全面使用 Functional Components 和 Hooks；样式使用 `StyleSheet.create`，避免行内样式滥用。
*   **逻辑复用与封装 (DRY)**：
    *   **核心逻辑统一**：严禁在 UI 组件（如 `FlashScreen`, `TodoScreen`, `PreviewScreen`）中重复编写同步、冲突检测或文件读写逻辑。
    *   **服务层下沉**：所有涉及云同步、文件操作、冲突处理的业务逻辑，必须封装在 `src/services/` 下的独立服务中（如 `FlashNoteService`, `SyncService`）。
    *   **Hooks 封装**：跨组件的状态逻辑（如监听同步状态）提取为 Custom Hooks（如 `useCloudSync`）。
*   **状态管理**：全局状态优先使用 Zustand；服务层 (Services) 读取状态时使用 `store.getState()`，规避 Hooks 规则限制。
*   **异步处理**：统一使用 `async/await`；关键业务逻辑（如同步、文件读写）必须包含 `try-catch` 错误处理与超时熔断控制。
*   **事件通信**：组件与非 React 上下文（如后台服务）通信时使用 `DeviceEventEmitter`（例如 `SHARE_RECEIVED_EVENT`）。
*   **类型安全**：严禁使用 `any`，所有 Props 和接口必须定义明确的 TypeScript Interface。
*   **新页面开发**：需在 `types/navigation.ts` 定义路由，并使用 `useTranslation`。

### 3.2 原生与构建约束

*   **Android 构建配置 (Expo Prebuild)**：项目使用了高度定制的 `app.config.js`，包含“禁用预测性返回手势”、“Keystore 注入”等插件。**严禁直接修改 `android/` 目录下的代码！** 任何原生层面的修改必须通过编写 Config Plugin (`plugins/`) 实现，否则每次运行 `npx expo prebuild` 都会导致修改丢失。
*   **编辑器调试与构建**：WebView 编辑器运行在独立环境中，修改 `src/editor-web/` 源码后必须执行 `npm run build:editor` 重新打包注入；调试时需通过 Bridge 的 `LOG` 消息关注 WebView 控制台输出。
*   **本地编译前版本同步门禁**：执行本地构建或真机部署（`npx expo run:android`、`eas build --local`、Gradle 直接打包）前，必须先核对 `app.config.js` 的 `version`/`android.versionCode` 与 `android/app/build.gradle` 的 `versionName`/`versionCode` 是否一致；不一致时必须先执行 `npx expo prebuild --clean` 再编译，否则会打出旧版本号安装包导致无法覆盖安装。发版递增版本号后、下次本地编译前同样适用。

### 3.3 服务与数据约束

*   **云服务校验**：`CloudService` 操作前必须校验 `isConfigured()`。
*   **Hydration 顺序**：`CloudService` 依赖 `useSettingsStore` 的配置（Provider 类型），调用 `initProvider()` 前需确保 Store 已 Hydrate（`hasHydrated` 标志为 true）。
*   **闪念时间格式**：`FlashNoteService` 追加写入 `flash_notes.md`，格式严守 `## YYYY-MM-DD HH:mm:ss`。
*   **文件沙盒权限**：Android 端利用 Scoped Storage，文件操作严格依赖 `FileSystemService` 封装的方法（文件读写唯一入口），严禁直接使用第三方 RNFS，严禁硬编码路径。
*   **文件系统 API 演进**：项目目前混用 `expo-file-system` 的新老 API。新功能开发优先考虑新版 API，但必须注意兼容性。改动文件系统相关代码前先读 `docs/Expo_FileSystem迁移备忘录.md`，禁止在未确认替代方案的情况下移除稳定引用。

### 3.4 国际化强制约束

*   不硬编码中文或英文，所有面向用户的文本均需使用国际化编码方式 `i18next`。

## 4. 开发、构建与验证

| 场景 | 命令 | 备注 |
|-----|------|------|
| **环境安装** | `npx expo install` | 初次安装或更新依赖 |
| **预构建原生** | `npx expo prebuild --clean` | 修改 app.config.js 或原生插件后需要 |
| **启动开发** | `npx expo start` | Metro Bundler (可加 `-c` 清缓存) |
| **运行 Android（开发）** | `npx expo run:android` | Debug 构建，部署到真机/模拟器本地调试 |
| **运行 iOS（开发）** | `npx expo run:ios` | Debug 构建，仅用于本地调试 |
| **正式整包发版（云端 CI）** | 打 tag `v*` 推送 | **发版首选**：GitHub Actions 自动构建 APK 并发布 Release（操作见用户级技能 `expo-app-release`） |
| **构建 Android APK（本地备用）** | prebuild ＋ gradle 直构 | Windows 上 `eas build --local` 不可用（仅 Linux/macOS），操作与坑位见用户级技能 `expo-app-release` |
| **构建 Android AAB（云端发版）** | `eas build --platform android --profile production` | Play Store 用，输出 AAB，在 EAS 云端构建 |
| **构建 iOS（云端）** | `eas build --platform ios --profile production` | App Store 用，须在 EAS 云端构建 |
| **编辑器构建** | `npm run build:editor` | 修改 `src/editor-web/` 后必须执行（Vite 打包 + HTML 注入） |
| **预览构建** | `npm run build:preview` | 修改 `src/preview-web/` 后必须执行（Vite 打包 + HTML 注入） |
| **Web 资源全量构建** | `npm run build:web` | 依次执行编辑器与预览两个构建 |
| **OTA 热更新（生产通道）** | `npm run update:prod` | build:web 后执行 `eas update --channel production` |
| **OTA 热更新（预览通道）** | `npm run update:preview` | build:web 后执行 `eas update --channel preview` |
| **类型检查** | `npx tsc --noEmit` | 静态类型检查，修改代码后推荐运行 |
| **代码检查** | `npx eslint .` | 代码风格检查 |
| **运行测试** | `npx jest` | 单元测试 |

## 5. 版本与发布

- 整包发版与 OTA 热更新按用户级技能 expo-app-release 执行。
