# 闪念笔记页 (FlashScreen) 业务逻辑执行流程详解 (V3.1 - Restored & Finalized)

本文档详细描述了闪念笔记（含待办事项）的完整业务逻辑，包含了全量同步机制、页面生命周期状态流转以及冲突处理方案。

---

## 1. 本地文件加载策略 (Local File Loading Strategy)

为确保极致的“秒开”体验，系统在发起任何网络同步之前，会优先执行本地文件加载逻辑。

### A. 初始加载 (Initial Load & Optimistic UI)
1.  **扫描与排序 (Scan & Sort)**：
    *   `FlashNoteService` 扫描本地所有的笔记文件（含 `main.md` 和 `flash_notes_YYYYMM.md` 等归档）。
    *   按照 **时间倒序** 排列文件路径，确保最新的内容始终排在最前。
2.  **分批读取 (Batch Loading)**：
    *   **默认阈值**：初始仅加载最新的 **4** 个文件 (`initialLoadCount = 4`)。
    *   **性能考量**：避免一次性读取数百个历史文件导致内存激增或 UI 卡顿。
3.  **并行解析 (Parallel Parsing)**：
    *   系统并行读取这 4 个文件的内容，解析为内存对象 (`FlashNote` 或 `TodoItem`)。
    *   **结果合并**：将解析结果合并为一个单一列表，并再次按时间戳/状态排序，呈现给用户。

### B. 分页加载 (Pagination / Infinite Scroll)
1.  **触发条件**：当用户滑动列表到底部时。
2.  **执行动作**：
    *   从排序后的文件列表中，取出 **下一个** 未加载的文件。
    *   读取解析并追加到当前列表末尾。
    *   循环往复，直到加载完所有本地历史归档。

---

## 2. 核心同步机制：全量批量同步 (Unified Batch Sync)

所有的闪念笔记同步操作均由 `FlashNoteService.syncAll()` 作为统一入口，底层调用 `SyncService.syncBatchFiles()`。

### 逻辑流程
1.  **扫描本地文件 (Local Scan)**：
    *   根据配置（主文件名 + 归档模式 regex），扫描本地所有 Flash Note 文件。
    *   **关键点**：即使是离线创建的历史归档文件，也会在此步骤被纳入同步范围。
2.  **获取云端列表 (Cloud List)**：
    *   发起 **1次** `listFiles(prefix)` 请求，获取云端所有文件的元数据（ETag, LastModified）。
3.  **构建全量集合 (Union Set)**：
    *   合并 `cloudFiles` 和 `localFiles`，形成一个去重的完整文件列表。
4.  **双向比对与队列生成**：
    *   遍历集合中的每个文件：
        *   **Synced (Skipped)**: 本地与云端 Hash 一致。
        *   **Cloud Newer**: 云端 Hash 变动 -> **下载队列**。
        *   **Local Newer**: 本地 Hash 变动 -> **上传队列**。
        *   **New Local File**: 仅本地存在 -> **上传队列**。
        *   **New Cloud File**: 仅云端存在 -> **下载队列**。
        *   **Conflict**: 双向修改 -> 标记冲突。
5.  **并发执行**:
    *   并发执行队列中的所有上传/下载任务。

---

## 3. 页面生命周期与 UI 状态 (Page Lifecycle - V3.1 Optimistic UI)

本节还原了页面在不同操作下的详细状态流转，采用了“所见即所得 (Optimistic UI)”策略。

### A. 初始化加载 (Mount / fetchLocalData)
1.  **优先本地展示 (Local First)**：
    *   页面加载时，**立即**调用 `fetchLocalData` 读取本地文件并渲染（即执行第1节描述的逻辑）。
    *   **效果**：用户打开 App 即刻看到内容，无需等待网络请求，消除“白屏”或“转圈”焦虑。
2.  **启动后台同步 (Background Sync)**：
    *   同时，在后台“静默”调用 `FlashNoteService.syncAll()`。
    *   **无阻塞**：此过程不阻塞 UI，正文区域**不显示**下拉刷新指示器 (Spinner)。
    *   **状态反馈**：仅通过顶部导航栏的“云同步图标”展示状态（Checking -> Syncing -> Synced/Error）。
3.  **事件驱动更新 (Event Driven)**：
    *   `FlashNoteService` 在同步过程中会广播 `BATCH_SYNC_STATUS_CHANGED_EVENT` 更新顶部图标。
    *   如果同步发现了云端新内容（下载成功），会广播 `FLASH_NOTES_UPDATED_EVENT`。
    *   页面监听到更新事件后，自动调用 `refreshLoadedData()` 刷新视图，将最新内容“无缝”呈现给用户。

### B. 下拉刷新 (Manual Refresh)
1.  **用户操作**：手动执行下拉动作。
2.  **执行逻辑**：
    *   UI 显示下拉刷新指示器 (Spinner)。
    *   **强制等待** `await flashNoteService.syncAll()` 执行完成。
    *   同步完成后重新读取本地数据，并隐藏 Spinner。
    *   **场景**：用户怀疑数据不是最新，或遭遇网络故障恢复后，可使用此功能强制同步。

### C. 页面切换与获焦 (Tab Focus & Event Bus)
1.  **旧机制**：依赖 `useFocusEffect` 在页面获焦时重读文件。
2.  **新机制 (V3.1)**：完全依赖 **全局事件总线 (DeviceEventEmitter)**。
    *   当在“待办页”打钩完成后，Service 层会发出 `FLASH_NOTES_UPDATED_EVENT`。
    *   即使“闪念页”在后台，它的监听器也会收到通知并静默刷新数据。
    *   **效果**：用户切换回闪念页时，数据已经是同步后的最新状态，无需再次刷新。

### D. 加载更多 (Infinite Scroll)
1.  **触发逻辑**：列表滚动到底部。
2.  **执行逻辑**：
    *   检查 `hasMore` 和 `allFilePaths`。
    *   读取下一个历史归档文件（例如 `flash_notes_202312.md`）。
    *   解析并追加到当前列表 (`setNotes`)。

---

## 4. 编辑与即时同步 (Instant Sync)

系统实现了“写操作即时同步”，保证数据安全性。

| 用户操作 | 本地行为 | 同步行为 |
| :--- | :--- | :--- |
| **新建笔记** | 立即追加写入本地文件 | **立即**触发后台上传 (`uploadFile`) |
| **修改内容** | 立即重写本地文件 | **立即**触发后台上传 |
| **打钩待办** | 立即更新状态并写入 | **立即**触发后台上传 |
| **删除笔记** | 立即从本地移除 | **立即**触发后台上传 |

*注：上述同步行为均为 Fire-and-Forget 模式，UI 不会等待上传完成，用户体验极其流畅。*

---

## 5. 冲突处理 (Conflict Resolution)

当同步过程中检测到“双向冲突”时（Status = Conflict）：

### A. 智能合并 (Smart Merge - 仅限闪念笔记)
系统会优先尝试**自动合并**：
1.  基于“影子文件”(Base)、本地文件(Local)和当前云端文件(Remote)进行三路合并。
2.  **成功时**：自动生成合并后的文本（包含双方的新增内容），保存并上传，**用户无感知自动修复冲突**。
3.  **失败时**（例如修改了同一行）：回退到下方的手动处理流程。

### B. 手动处理 (Manual Resolution - 普通文件或合并失败)
当智能合并不可用或失败时，UI 顶部会出现橙色 **StatusBanner**。

1.  **UI 表现**：
    *   提示信息：“本地和云端已同时修改 (冲突)”。
2.  **用户决策**：
    *   **使用云端版本 (Use Cloud)**：丢弃本地修改，下载云端版本。
    *   **上传覆盖 (Overwrite Cloud)**：强制推送本地版本，覆盖云端。
    *   **保存副本 (Save Copy)**：将本地文件重命名备份（如 `_old_timestamp.md`），然后下载云端版本。这是最安全的处理方式。

---

## 6. 待办页 (TodoScreen) 逻辑一致性

**更新 (V3.1)**：待办页目前已与闪念页逻辑**完全统一**。

*   **复用核心**：两者均使用配置相同的 `useFlashNoteList` 钩子。
*   **启动行为**：第一次打开待办页时，同样触发“优先本地加载 + 后台静默同步”流程。
*   **数据一致性**：由于共享底层 Service 和事件监听，任一页面的修改都会实时反映在另一页面，真正做到了数据源的单一可信（Single Source of Truth）。