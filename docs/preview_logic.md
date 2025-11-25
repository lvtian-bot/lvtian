# 预览页（PreviewScreen）状态判断逻辑说明

本文档详细说明了文件预览页在不同场景下的状态判断逻辑、UI 展示及处理方式。

## 核心状态变量

预览页的显示逻辑主要依赖以下几个状态变量的组合：

1.  **`uploadState` (上传状态)**
    *   来源：`useFileMetadataStore` (持久化存储)
    *   取值：
        *   `'uploading'`: 正在上传中
        *   `'failed'`: 普通上传失败（网络、鉴权等）
        *   `'conflict-failed'`: 上传失败：云端文件已更改（乐观锁冲突）
        *   `null`: 无上传活动或上次上传成功

2.  **`syncStatus` (同步状态)**
    *   来源：页面实时计算 (内存状态)
    *   取值：
        *   `'checking'`: 正在检查云端状态
        *   `'synced'`: 已同步（本地与云端一致）
        *   `'conflict'`: 存在冲突（本地与云端不一致）
        *   `'offline'`: 离线模式（无法连接云端，显示本地缓存）
        *   `'error'`: 发生未知错误

3.  **`conflictType` (冲突类型)**
    *   来源：页面实时计算 (仅当 `syncStatus` 为 `'conflict'` 时有效)
    *   取值：
        *   `'localNewer'`: 本地文件比云端新（或云端无此文件）
        *   `'cloudNewer'`: 云端文件比本地新

---

## 详细判断流程

当进入预览页或页面获得焦点时，会执行 `checkSyncStatus` 函数，流程如下：

### 1. 检查上传状态 (uploadState)
此步骤检查持久化的上传状态 `localMetadata.uploadState`，不同值的处理如下：

*   **`'uploading'` (正在上传)**
    *   **处理方式**：
        *   `syncStatus` 设为 `'checking'`
        *   UI 显示：顶部标题栏显示加载转圈。
        *   **阻断后续检查**：直接返回，等待上传完成事件 (`UPLOAD_COMPLETED_EVENT`) 触发刷新。
*   **`'failed'` 或 `'conflict-failed'` (上传失败)**
    *   **处理方式**：**不阻断**。继续执行后续步骤（检查网络、云端等），以便结合当前环境判断最终状态。
*   **`null` (成功/闲置)**
    *   **处理方式**：**不阻断**。继续执行后续步骤。

### 2. 检查网络状态 (新增)
*   **判断条件**：`NetInfo.fetch().isConnected === false`
*   **处理方式**：
    *   **优先检查上传失败记录**：
        *   若 `localMetadata.uploadState` 为 `'failed'` 或 `'conflict-failed'`：
            *   `syncStatus` 设为 `'conflict'`
            *   `conflictType` 设为 `'localNewer'`
            *   **UI Banner**：显示 **"上传失败"** + **"本地更改未同步"**
            *   **目的**：确保用户知道上次上传没成功，即使现在断网了。
    *   **否则 (无上传失败)**：
        *   `syncStatus` 设为 `'offline'`
        *   **UI Banner**：显示 **"离线模式：当前显示本地版本，可能不是最新"**。
        *   **标题栏**：显示警告图标 (⚠️)。
    *   **阻断后续检查**：直接返回。

### 3. 检查云端状态 (网络请求)
系统尝试获取云端文件的元数据（`HEAD` 请求）。

#### A. 云端文件不存在
*   **判断条件**：云端返回 404，但本地文件存在。
*   **处理方式**：
    *   `syncStatus` 设为 `'conflict'`
    *   `conflictType` 设为 `'localNewer'`
    *   **UI Banner**：
        *   若 `uploadState` 为 `'failed'` 或 `'conflict-failed'`：显示 **"上传失败"** + **"本地更改未同步"**
        *   否则：显示 **"本地更改未同步"**
    *   **操作**：提供 **[上传到云端]** 按钮。

#### B. ETag 匹配 (已同步)
*   **判断条件**：`localMetadata.etag === cloudMetadata.etag`
*   **处理方式**：
    *   `syncStatus` 设为 `'synced'`
    *   **UI Banner**：不显示。
    *   **标题栏**：显示绿色对勾 (✅)。
    *   **特殊情况**：即使 `uploadState` 为失败状态，如果 ETag 匹配，说明实际上已经同步了（可能是误报或异地同步），此时**不会**显示错误 Banner，并自动清除失败状态。

#### C. ETag 不匹配 (冲突/不一致)
*   **判断条件**：`localMetadata.etag !== cloudMetadata.etag`
*   **处理方式**：比较修改时间 (`mtime`)。

    *   **情形 C1: 云端更新 (`cloudMtime > localMtime`)**
        *   `syncStatus` 设为 `'conflict'`
        *   `conflictType` 设为 `'cloudNewer'`
        *   **UI Banner**：
            *   若 `uploadState` 为 `'conflict-failed'`：显示 **"上传失败：云端文件已更改"** + **"云端有新版本"**
            *   若 `uploadState` 为 `'failed'`：显示 **"上传失败"** + **"云端有新版本"**
            *   否则：显示 **"云端有新版本"**
        *   **操作**：提供 **[使用云端版本]** 和 **[保存副本]** 按钮。

    *   **情形 C2: 本地更新 (`localMtime >= cloudMtime`)**
        *   `syncStatus` 设为 `'conflict'`
        *   `conflictType` 设为 `'localNewer'`
        *   **UI Banner**：
            *   若 `uploadState` 为 `'conflict-failed'`：显示 **"上传失败：云端文件已更改"** + **"本地更改未同步"**
            *   若 `uploadState` 为 `'failed'`：显示 **"上传失败"** + **"本地更改未同步"**
            *   否则：显示 **"本地更改未同步"**
        *   **操作**：提供 **[上传到云端]** 按钮（强制覆盖）。

### 4. 异常处理 (兜底)
如果在第 3 步的网络请求中发生未预期的错误：

*   **优先检查上传失败记录**：
    *   **判断条件**：`localMetadata.uploadState` 为 `'failed'` 或 `'conflict-failed'`
    *   **处理方式**：
        *   `syncStatus` 设为 `'conflict'`
        *   `conflictType` 设为 `'localNewer'`
        *   **UI Banner**：显示 **"上传失败"** + **"本地更改未同步"**

*   **否则，检查离线模式**：
    *   **判断条件**：本地文件存在
    *   **处理方式**：
        *   `syncStatus` 设为 `'offline'`

*   **兜底错误**：
    *   **处理方式**：`syncStatus` 设为 `'error'`

---

## 总结矩阵

| 场景 | 网络状态 | uploadState | syncStatus | conflictType | Banner 显示内容 | 可用操作 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **正常同步** | 在线 | null | synced | - | (无) | - |
| **正在上传** | (任意) | uploading | checking | - | (无，标题栏转圈) | - |
| **离线浏览(无错误)** | 离线 | null | offline | - | "离线模式..." | [重试连接] |
| **离线(曾上传失败)** | 离线 | failed / conflict-failed | conflict | localNewer | "上传失败" + "本地更改未同步" | [上传到云端] (点击会失败) |
| **上传失败(断网)** | 在线 | failed | conflict | localNewer | "上传失败" + "本地更改未同步" | [上传到云端] |
| **乐观锁冲突** | 在线 | conflict-failed | conflict | cloudNewer | "上传失败：云端文件已更改" + "云端有新版本" | [使用云端版本] [保存副本] |
| **云端有新版** | 在线 | null | conflict | cloudNewer | "云端有新版本" | [使用云端版本] [保存副本] |
| **本地有新版** | 在线 | null | conflict | localNewer | "本地更改未同步" | [上传到云端] |
