## 预览页（PreviewScreen）状态判断逻辑说明

本文档详细说明了文件预览页在不同场景下的状态判断逻辑、UI 展示及处理方式。

## 核心状态变量

预览页的显示逻辑主要依赖以下几个状态变量的组合：

1.  **`uploadState` (上传状态)**
    *   来源：`useFileMetadataStore` (持久化存储)
    *   取值：
        *   `'uploading'`: 正在上传中
        *   `'failed'` 或 `'conflict-failed'`: 上传失败（网络、鉴权、乐观锁冲突等）
        *   `null`: 无上传活动或上次上传成功

2.  **`syncStatus` (同步状态)**
    *   来源：页面实时计算 (内存状态)
    *   取值：
        *   `'checking'`: 正在检查云端状态
        *   `'synced'`: 已同步（本地与云端一致）
        *   `'conflict'`: 存在冲突（本地与云端不一致）
        *   `'offline'`: 离线模式（无法连接云端，显示本地缓存）
        *   `'error'`: 发生未知错误

---

## 详细判断流程

当进入预览页或页面获得焦点时，会执行 `checkSyncStatus` 函数，流程如下：

### 1. 检查网络状态 (优先)
*   **判断条件**：`NetInfo.fetch().isConnected === false`
*   **处理方式**：
    *   **优先检查上传失败记录**：
        *   若 `localMetadata.uploadState` 为 `'failed'` 或 `'conflict-failed'`：
            *   `syncStatus` 设为 `'conflict'`
            *   **UI Banner**：显示 **"上传失败"** + **"本地更改未同步"**
            *   **目的**：确保用户知道上次上传没成功，即使现在断网了。
    *   **否则 (无上传失败)**：
        *   `syncStatus` 设为 `'offline'`
        *   **UI Banner**：显示 **"离线模式：当前显示本地版本，可能不是最新"**。
        *   **标题栏**：显示警告图标 (⚠️)。
    *   **阻断后续检查**：直接返回。

### 2. 检查上传状态 (uploadState)
此步骤检查持久化的上传状态 `localMetadata.uploadState`，不同值的处理如下：

*   **`'uploading'` (正在上传)**
    *   **处理方式**：
        *   `syncStatus` 设为 `'checking'`
        *   UI 显示：顶部标题栏显示加载转圈。
        *   **阻断后续检查**：直接返回，等待上传完成事件 (`UPLOAD_COMPLETED_EVENT`) 触发刷新。
*   **`'failed'` (上传失败)**
    *   **处理方式**：**不阻断**。继续执行后续步骤。
    *   *注：具体的失败原因（如乐观锁冲突）将在后续的云端状态检查中被识别为冲突并处理，此处无需特殊分支。*
*   **`null` (成功/闲置)**
    *   **处理方式**：**不阻断**。继续执行后续步骤。

### 3. 检查云端状态 (网络请求)
系统尝试获取云端文件的元数据（`HEAD` 请求）。

#### A. 云端文件不存在
*   **判断条件**：云端返回 404，但本地文件存在。
*   **处理方式**：
    *   **自动操作**：**自动触发上传**。
    *   `syncStatus` 设为 `'checking'` (或 syncing)。
    *   **UI Banner**：不显示。
    *   **异常处理**：若自动上传失败，显示 **"上传失败"** Banner，提供 [重试] 按钮。

#### B. 哈希匹配 (已同步)
*   **判断条件**：`localMetadata.localHash === cloudMetadata.etag`
*   **处理方式**：
    *   **更新同步基准**：将 `cloudMetadata.etag` 直接赋值给 `syncedHash`，确保基准始终为最新同步状态。
    *   `syncStatus` 设为 `'synced'`
    *   **UI Banner**：不显示。
    *   **标题栏**：显示绿色对勾 (✅)。
    *   **特殊情况**：即使 `uploadState` 为失败状态，如果哈希匹配，说明实际上已经同步了（可能是误报或异地同步），此时**不会**显示错误 Banner，并自动清除失败状态。

#### C. 哈希不匹配 (冲突/不一致)
*   **判断条件**：`localMetadata.localHash !== cloudMetadata.etag`
*   **处理方式**：使用三重哈希机制判断冲突类型。
    *   **情形 C1: 仅云端更新 (`localMetadata.localHash === localMetadata.syncedHash`)**
        *   **自动操作**：**自动触发下载**。
        *   `syncStatus` 设为 `'checking'` (或 syncing)。
        *   **UI Banner**：不显示。
        *   **异常处理**：若自动下载失败，显示 **"下载失败"** Banner，提供 [重试] 按钮。

    *   **情形 C2: 仅本地更新 (`cloudMetadata.etag === localMetadata.syncedHash`)**
        *   **自动操作**：**自动触发上传**。
        *   `syncStatus` 设为 `'checking'` (或 syncing)。
        *   **UI Banner**：不显示。
        *   **异常处理**：若自动上传失败，显示 **"上传失败"** Banner，提供 [重试] 按钮。

    *   **情形 C3: 双向冲突**
        *   若上述两种情形均不满足，说明本地和云端都已修改。
        *   `syncStatus` 设为 `'conflict'`
        *   **UI Banner**：显示 **"本地和云端已同时修改"**
        *   **操作**：提供 **[使用云端版本覆盖本地]**、**[保存本地为副本]** 和 **[上传本地覆盖云端]** 按钮，由用户选择解决方式。

### 4. 异常处理 (兜底)
如果在第 3 步的网络请求中发生未预期的错误：

*   **优先检查上传失败记录**：
    *   **判断条件**：`localMetadata.uploadState` 为 `'failed'` 或 `'conflict-failed'`
    *   **处理方式**：
        *   `syncStatus` 设为 `'conflict'`
        *   **UI Banner**：显示 **"上传失败"**
        *   **操作**：提供 **[重试]** 按钮（触发自动上传逻辑）。

*   **否则，检查离线模式**：
    *   **判断条件**：本地文件存在
    *   **处理方式**：
        *   `syncStatus` 设为 `'offline'`
        *   **UI Banner**：显示 **"离线模式：当前显示本地版本，可能不是最新"**。

*   **兜底错误**：
    *   **处理方式**：`syncStatus` 设为 `'error'`
    *   **UI Banner**：显示 **"同步错误"**。

---

## 总结矩阵

| 场景 | 网络状态 | uploadState | syncStatus | Banner 显示内容 | 自动/手动操作 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **完成同步：本地云端一致** | 在线 | null | synced | (无) | - |
| **正在上传** | (任意) | uploading | checking | (无，标题栏转圈) | 自动 |
| **离线浏览** | 离线 | null | offline | "离线模式..." | [重试连接] |
| **仅本地更新** | 在线 | null | checking | (无) | **自动上传** |
| **仅云端更新** | 在线 | null | checking | (无) | **自动下载** |
| **上传失败** | 在线 | failed | conflict | "上传失败" | [重试] |
| **双向冲突** | 在线 | null | conflict | "本地和云端已同时修改" | [以本地为准] [以云端为准] [保存副本] |
