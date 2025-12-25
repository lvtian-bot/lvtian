# AI Chat Synchronization Logic (AI对话同步机制)

本文档详细说明了 MDNote 中 AI 对话功能的同步策略、存储结构及核心业务逻辑。该模块旨在实现多端高效同步，同时保持应用启动速度和流量节约。

## 1. 核心架构 (Core Architecture)

AI 对话同步采用 **"懒加载 (Lazy Loading)"** + **"直写同步 (Write-Through)"** 策略。

*   **本地存储**: `mdnote_docs/ai-chats/`
*   **云端存储**: `ai-chats/` (在 WebDAV/COS 根目录下)
*   **文件格式**: JSON (`ChatSession` 序列化)
*   **核心服务**: 
    *   `AIChatStorageService`: 负责业务逻辑封装 (列表管理、重命名、查找)。
    *   `SyncService`: 复用核心同步模块，负责底层上传、下载、队列管理及哈希比对。

## 2. 文件命名规范 (Filename Convention)

为了支持在不下载文件内容的情况下展示标题，我们采用了包含元数据的文件名格式：

```text
{SessionID}_{Title}.json
```

*   **SessionID**: 时间戳格式 `YYYYMMDD_HHmmss` (例如 `20251226_123001`)。
*   **Title**: 用户定义的会话标题 (经过清洗，特殊字符和空格被替换为 `_`)。
*   **示例**: `20251226_123001_My_Trip_Plan.json`

> **注意**: 旧版本或未命名的文件可能仅为 `{SessionID}.json`。系统会自动兼容，解析时若无标题部分则默认为 "Untitled"。

## 3. 同步策略 (Sync Strategy)

### 3.1 列表同步 (List Sync / Metadata Sync)
**触发时机**: App 启动 (`AgentScreen` 挂载) 或 手动刷新。

1.  **列出云端文件**: 获取 `ai-chats/` 目录下的所有文件元数据 (Key, LastModified)。
2.  **构建占位符 (Placeholders)**: 
    *   遍历云端文件列表。
    *   如果本地不存在该 ID 的文件，则在内存中创建一个 **Placeholder Session**。
    *   **标题解析**: 直接从文件名中提取标题，无需下载文件内容。
    *   `isPlaceholder: true` 标记该会话尚未加载详情。
3.  **上传本地独有文件**: 若发现本地有文件但云端没有 (Local Only)，则触发上传。

### 3.2 按需加载 (On-Demand Download)
**触发时机**: 用户点击某个 Placeholder 会话。

1.  用户点击列表项 -> `switchSession(id)`。
2.  检测到 `isPlaceholder: true`。
3.  调用 `AIChatStorageService.downloadSession(id)`。
    *   尝试在云端列表中查找包含该 ID 的文件 (以应对文件名可能的变更)。
    *   调用 `SyncService.performDownload` 下载完整 JSON。
4.  下载完成后，解析 JSON，更新 Store 中的会话详情，移除 `isPlaceholder` 标记。

### 3.3 当前会话同步 (Active Session Sync)
**触发时机**: 切换到某个会话时。

*   调用 `syncCurrentSession(id)`。
*   利用 `SyncService.syncFile` 进行标准的哈希/时间戳比对。
    *   若云端更新 -> 自动下载覆盖。
    *   若本地更新 -> 自动上传。

## 4. 增删改查逻辑 (CRUD Operations)

### 4.1 新建会话 (Create)
1.  生成 ID (`YYYYMMDD_HHmmss`)。
2.  保存到本地文件 (`saveSession`)。
    *   文件名: `{ID}_{Title}.json`。
    *   如果文件不存在，则创建；若存在，则覆盖。
3.  触发后台上传 (`SyncService.uploadFile`)。

### 4.2 重命名 (Rename)
**核心逻辑**: 文件名即标题，重命名本质是文件移动。

1.  **用户操作**: 长按列表项 -> 选择 "Rename"。
2.  **服务层处理** (`renameSession`):
    *   **查找**: 获取旧文件路径 (例如 `..._Old_Name.json`)。
    *   **移动**: 使用 `fsService.moveFile` 将本地文件重命名为 `..._New_Name.json`。
    *   **上传**: 将新文件上传到云端。
    *   **清理**: 删除云端的旧文件 (`cloudService.deleteFile`)。
3.  **路径编码**: 在处理文件名时，会对路径进行 URI 编码 (`encodeURIComponent`)，以防止空格或特殊字符导致 Android 下的 `FileSystem` 崩溃。

### 4.3 删除 (Delete)
1.  **用户操作**: 长按列表项 -> 选择 "Delete"。
2.  **服务层处理** (`deleteSession`):
    *   删除本地文件。
    *   调用云服务删除云端对应文件。

## 5. 关键代码路径 (Key Code Paths)

*   `src/services/AIChatStorageService.ts`: 
    *   `syncSessionList`: 列表同步核心。
    *   `renameSession`: 重命名原子操作。
    *   `getConstructedFilePath`: 文件名生成与清洗。
*   `src/store/useAIStore.ts`: 
    *   `sessions`: 存储会话列表 (含 Placeholders)。
    *   `switchSession`: 处理懒加载逻辑。
*   `src/components/AISidebar.tsx`: 
    *   侧边栏 UI，包含长按菜单 (Rename/Delete) 及重命名弹窗。

## 6. 常见问题 (Troubleshooting)

*   **文件名包含空格**: 已通过正则清洗 (`replace(/[\s...]/g, '_')`) 和 URI 编码解决。
*   **重命名失败**: 若云端删除失败，可能会导致云端存在两个同 ID 但不同标题的文件。系统读取时会以最新的为准，或显示重复项 (取决于列表解析逻辑，目前逻辑按 ID 去重)。
*   **404 错误**: 首次同步时云端目录可能不存在，`AIChatStorageService` 会自动处理 404 并尝试创建目录。
