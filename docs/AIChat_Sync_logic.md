# AI Chat Synchronization Logic (AI对话同步机制)

本文档详细说明了 MDNote 中 AI 对话功能的同步策略、存储结构及核心业务逻辑。该模块已重构为 “云端优先 (Cloud-First)” 架构，以确保多端数据的一致性，彻底解决“僵尸文件”、“无法删除未下载文件”等问题。

## 1. 核心架构 (Core Architecture)

AI 对话同步采用 “云端主导 (Cloud-First)” + “懒加载 (Lazy Loading)” 策略。所有的结构性变更（删除、重命名）优先在云端生效，再反馈到本地。

存储位置:

本地: mdnote_docs/ai-chats/

云端: ai-chats/ (在 WebDAV/COS 根目录下)

文件格式: JSON (ChatSession 序列化)

操作模式:

内容同步: 懒加载 + 双向同步 (SyncService)。

结构变更 (Delete/Rename): 悲观 UI 更新 (Pessimistic UI)，即 Wait for Cloud -&gt; Update UI。

### 1.1 核心服务与组件

AIChatStorageService: 业务逻辑核心。实现了 O(1) 的云端文件定位与操作。

useAIStore: 状态管理。负责调用 Service 并根据返回结果更新 UI（仅在成功时更新）。

CloudService: 底层云存储接口 (COS/WebDAV)。

### 1.2 核心同步流程

<div data-type="mermaid" data-content="graph TD
    A[用户操作 (Delete/Rename)] --> B[AgentScreen/Sidebar]
    B --> C{调用 Service}
    C -->|Construct Key| D[Cloud Operation]
    D -->|Success| E[Update Local State]
    E --> F[Update UI]
    D -->|Fail| G[Alert Error &amp; Keep UI Unchanged]
" class="mermaid-diagram">graph TD
    A[用户操作 (Delete/Rename)] --&gt; B[AgentScreen/Sidebar]
    B --&gt; C{调用 Service}
    C --&gt;|Construct Key| D[Cloud Operation]
    D --&gt;|Success| E[Update Local State]
    E --&gt; F[Update UI]
    D --&gt;|Fail| G[Alert Error &amp; Keep UI Unchanged]
</div>## 2. 文件命名规范 (Filename Convention)

采用包含元数据的文件名格式，支持不下载内容即展示标题：

{SessionID}_{Title}.json
SessionID: 例如 20251226_123001 (时间戳 ID)。

Title: 用户标题 (特殊字符被替换为 _)。

算法: getConstructedFilePath(id, title) 可在 O(1) 时间内推导出云端 Key。

## 3. 关键业务逻辑 (Business Logic)

### 3.1 删除 (Delete) - Cloud First &amp; O(1)

解决痛点: 解决了“只在云端的文件（未下载）无法删除”的问题。

旧逻辑: 找本地文件 -&gt; 删本地 -&gt; 删云端。 (若本地无文件，操作中止，导致云端删不掉)。

新逻辑:

构造路径: 根据 Store 中的 id 和 title 直接推导出云端路径 ai-chats/{id}_{title}.json。

云端删除: 直接调用 cloudService.deleteFile(key)。即使文件不存在 (404) 也视为成功。

本地清理: 云端成功后，再尝试清理本地文件（如果存在）。

UI 更新: 只有步骤 2 成功，UI 才会移除条目。

### 3.2 重命名 (Rename) - Atomic Loopback

解决痛点: 解决了“未下载的文件无法重命名”的问题。

场景 A: 本地已下载 (Local Exists)

本地重命名 (moveFile)。

上传新文件 (uploadFile)。

删除云端旧文件。

场景 B: 本地未下载 (Placeholder / Cloud Only)

构造路径: 推导 oldKey 和 newKey。

内存回环:

Download(oldKey) -&gt; 内存 Memory。

内存中更新数据（如需）或直接写入新路径。

Upload(newKey)。

清理: Delete(oldKey)。

结果: 用户感觉不到文件是否在本地，操作体验一致。

### 3.3 列表同步 (List Sync)

懒加载: 仅下载元数据 (Key, Size, Time)。

占位符 (Placeholder): 对于云端存在但本地没有的文件，生成 isPlaceholder: true 的对象。

点击加载: 用户点击 Placeholder 时，触发 downloadSession(id) 获取完整内容。

## 4. 悲观 UI 更新 (Pessimistic UI Updates)

为了保证多端一致性，防止“假成功”，所有结构性操作采用悲观模式：

操作发起: 用户点击删除/重命名。

界面反馈:

Loading: 界面可能会有短暂去抖动或 Loading 态。

Error: 若网络超时或鉴权失败，弹出 Alert，列表回滚/保持原样。

数据一致: 确保了用户看到的列表永远是云端真实状态的映射。

## 5. 常见问题 (Troubleshooting)

Q: 离线时删除了文件怎么办？

A: 当前架构下，离线删除会提示失败（因为无法连接云端确认）。这是为了防止“僵尸文件复活”的设计权衡。建议用户在线时整理文件。

(未来规划: 引入 Tombstone 墓碑机制支持离线删除)

Q: 重命名时断网了会怎样？

A: 系统会抛出错误，UI 保持旧名称。云端可能残留新文件（如果上传成功但删除旧文件失败），下次同步时会被视为两个文件（去重逻辑会处理或显示为副本）。

Q: 为什么删除反应比以前慢了？

A: 因为必须等待服务器返回 200 OK 确认。这是为了数据安全和一致性付出的必要代价。



