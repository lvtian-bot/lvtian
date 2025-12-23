# 闪念笔记页 (FlashScreen/TodoScreen) 核心逻辑与状态流转说明 (V5.2 - Standard Matrix)

本文档详细说明了闪念笔记页（含待办页）的同步机制。逻辑已与《预览页逻辑说明》深度对标，实现了 **分阶段同步**、**自动救援** 及 **逐文件冲突处理**。

---

## 1. 核心状态变量 (Core State Variables)

页面状态由 `useFlashNoteList` Hook 维护，数据源自 `FlashNoteService.syncAll()` 的三阶段执行结果。

*   **`syncStatus`**: 全局流转状态 (`checking` -> `synced`/`conflict`/`error` / `offline` / `not-configured`)
*   **`uploadErrorFiles`**: **[Array]** 重试后仍失败的文件路径列表 (对应 Stage 2)。
*   **`conflictedFiles`**: **[Array]** 智能合并失败的冲突文件路径列表 (对应 Stage 2 & 3)。
*   **`isSyncing`**: UI 专用，当状态为 `checking` 时为 true。

---

## 2. 三阶段同步流程 (Three-Stage Sync Process)

### Stage 1: 环境检查 (Global Environment Check)
*   **离线检查**: 若 `netState.isConnected === false`，直接中断，状态设为 `offline`。
*   **配置检查**: 若未配置云服务，直接中断，状态设为 `not-configured`。

### Stage 2: 本地修复与救援 (Local Repair & Rescue)
扫描所有本地已知文件（主文件 + 历史归档），检查其 `FileMetadata` 状态：
1.  **普通失败 (`failed`)**:
    *   操作：自动重试一次上传。
    *   结果：若仍失败，加入 `uploadErrorFiles` 列表。
2.  **乐观锁冲突 (`conflict-failed`)**:
    *   判定：`PreconditionFailed` (ETag 不匹配)。
    *   操作：**立即尝试智能合并 (Smart Merge)**。
        *   **合并成功**：自动上传，用户**无感知**，状态恢复正常。
        *   **合并失败**：即确实存在内容冲突，加入 `conflictedFiles` 列表。

### Stage 3: 全量同步与冲突检测 (Full Sync & Discovery)
只有通过前两阶段后，才会执行：
1.  **拉取列表**: 联合本地文件列表与云端前缀扫描列表。
2.  **逐个比对 (Item-by-Item Check)**: 对每一个文件执行标准同步检查：
    *   **Local Only (New)**: 上传。
    *   **Cloud Only (New)**: 下载。
    *   **Synced (Hash Match)**: 跳过。
    *   **Cloud Newer**: 下载。
    *   **Local Newer**: 上传。
    *   **Bidirectional Conflict**: **默认智能合并**。
        *   合并成功 -> 上传 -> Synced。
        *   合并失败 -> 加入 `conflictedFiles`。

---

## 3. 总结矩阵 (Summary Matrix)

> **关键差异说明**：与预览页不同，闪念/待办页管理**多个文件**（主文件 + N 个历史归档）。因此矩阵中新增：
> *   `uploadErrorFiles` 队列 (简称 **UE**)
> *   `conflictedFiles` 队列 (简称 **CF**)
> 
> 表中针对"某个文件"的状态描述，实际对应该文件在队列中的存在性。

| 顺序/场景 | 网络状态 | uploadState<br>(某文件) | L == C ?<br>(某文件) | 冲突逻辑详情<br>(L=Local, C=Cloud, S=Synced) | syncStatus<br>(全局) | **UE 队列** | **CF 队列** | Banner 显示内容 | Banner 可操作项 | 标题栏图标 | 自动操作 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **1. 离线浏览** | 离线 | (任意) | - | - | offline | - | - | "离线模式..." | [点击 Banner 重试] | ⚠️ (警告) | 无 |
| **2. 未配置云端** | 在线 | (任意) | - | - | not-configured | - | - | "未配置云服务" | [点击 Banner 去配置] | ⚠️ (警告) | 无 |
| **3. 正在同步** | 在线 | - | - | - | checking | 空 | 空 | 无 | 无 | 🔄 (转圈) | Stage 1/2/3 执行中 |
| **4. Stage 2: 上传失败 (重试无效)** | 在线 | failed | - | (已重试) | error 或 conflict | **有**<br>(File A) | - | **"上传失败: File A"** | **[重试]** | ⚠️ (警告) | 无 |
| **5. Stage 2: 乐观锁救援成功** | 在线 | conflict-failed<br>(处理中) | - | Smart Merge OK | checking -> synced | 空 | 空 | 无 | 无 | 🔄 -> ✅ | **自动合并并上传**<br>用户无感知 |
| **6. Stage 2: 乐观锁救援失败** | 在线 | conflict-failed | - | Smart Merge Failed | conflict | 空 | **有**<br>(File B) | "文件冲突: File B" | [使用云端] [使用本地] [存为副本] | ⚠️ (警告) | 无 |
| **7. Stage 3: 完成同步 (无冲突)** | 在线 | null | Yes | - | synced | 空 | 空 | 无 | 无 | ✅ (对勾) | 无 |
| **8. Stage 3: 仅云端更新** | 在线 | null | No | **L == S**<br>(本地未变，云变) | checking | - | - | 无 | 无 | 🔄 (转圈) | **触发自动下载** |
| **9. Stage 3: 仅本地更新** | 在线 | null | No | **C == S**<br>(云未变，本地变) | checking | - | - | 无 | 无 | 🔄 (转圈) | **触发自动上传** |
| **10. Stage 3: 双向冲突 (智能合并成功)** | 在线 | null | No | **L != S && C != S**<br>Merge OK | synced | 空 | 空 | 无 | 无 | ✅ (对勾) | **自动三路合并并上传**<br>用户无感知 |
| **11. Stage 3: 双向冲突 (智能合并失败)** | 在线 | null | No | **L != S && C != S**<br>Merge Failed | conflict | 空 | **有**<br>(File C) | "文件冲突: File C" | [使用云端] [使用本地] [存为副本] | ⚠️ (警告) | 无 |
| **12. 同步错误** | 在线 | null | - | - | error | 可能有 | 可能有 | (优先显示 UE 或 CF) | (对应按钮) | ❌ (红叉) | 无 |

---

## 4. UI 优先级规则 (Banner Priority)

当同时存在多种状态时，`StatusBannerContainer` 按以下顺序显示 Banner：

1.  **Offline** (场景 1) - 最高优先级
2.  **Not Configured** (场景 2)
3.  **Upload Errors** (场景 4) - `uploadErrorFiles.length > 0`
4.  **Conflicts** (场景 6, 11) - `conflictedFiles.length > 0`

**逐一击破策略**：
*   如果 `uploadErrorFiles` 有多个文件，Banner 显示第一个文件名（如 "上传失败: FileA.md (+2)"）。
*   用户解决（重试）第一个文件后，列表更新，Banner 自动显示下一个。
*   `conflictedFiles` 同理，逐个解决。

---

## 5. 关键差异点 (vs Preview Screen)

| 特性 | 预览页 (Single File) | 闪念/待办页 (Multi-File) |
| :--- | :--- | :--- |
| **处理对象** | 单一文件 | 主文件 + N 个历史归档 |
| **状态粒度** | 直接映射到当前文件 | 聚合状态 + 队列列表 |
| **智能合并触发** | 仅在显式检测到双向冲突时 | **Stage 2 (乐观锁) + Stage 3 (双向)** 均自动触发 |
| **Banner 复用** | 使用 `StatusBannerContainer` | 使用 `StatusBannerContainer` (同一组件) |
| **冲突解决** | 直接操作当前文件 | 操作队列中的第一个文件，逐个清空 |