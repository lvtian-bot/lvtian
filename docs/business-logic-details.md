# MDNote 业务逻辑详解

> **适用场景**: 当需要理解核心业务逻辑实现细节、算法原理时阅读此文档

---

## 1. 三路合并算法 (Three-Way Merge)

### 1.1 核心概念

**三个版本对比**:
- **L (Local)**: 本地当前版本
- **C (Cloud)**: 云端当前版本
- **S (Synced)**: 上次成功同步的基准版本

**决策矩阵**:

| 场景 | L == S | C == S | L == C | 操作 |
|-----|--------|--------|--------|------|
| 已同步 | ✅ | ✅ | ✅ | 跳过 (synced) |
| 仅云端更新 | ✅ | ❌ | ❌ | 自动下载 |
| 仅本地更新 | ❌ | ✅ | ❌ | 自动上传 |
| 双向冲突 | ❌ | ❌ | ❌ | 智能合并或人工解决 |

### 1.2 智能合并逻辑（Smart Merge）

**触发条件**: L != S && C != S (双向都修改了)

**合并策略**:
1. **基于行的合并**: 使用 `diff-match-patch` 算法
2. **时间戳优先**: 闪念笔记按时间戳自动排序合并
3. **待办状态合并**: 合并 Markdown Checkbox 状态

**伪代码**:
```javascript
function smartMerge(localContent, cloudContent, syncedContent) {
  // 1. 计算差异
  const localDiff = diffLines(syncedContent, localContent);
  const cloudDiff = diffLines(syncedContent, cloudContent);

  // 2. 检测冲突
  const conflicts = detectConflicts(localDiff, cloudDiff);

  if (conflicts.length > 0) {
    // 存在不可自动合并的冲突
    return { success: false, conflicts };
  }

  // 3. 应用补丁
  let merged = syncedContent;
  merged = applyPatch(merged, localDiff);
  merged = applyPatch(merged, cloudDiff);

  return { success: true, content: merged };
}
```

**实际实现位置**: `src/utils/mergeUtils.ts`

---

## 2. 乐观锁机制（Optimistic Locking）

### 2.1 ETag 工作原理

**ETag (Entity Tag)**: 云端文件的哈希值，每次修改后变化

**上传时携带 ETag**:
```javascript
// 上传时读取本地存储的 etag
const metadata = fileMetadataStore.getMetadata(path);
const lastKnownEtag = metadata?.etag;

await cloudService.uploadFile(path, content, {
  ifMatch: lastKnownEtag  // ← 乐观锁条件
});
```

**云端检查**:
- 如果云端当前 ETag == `ifMatch` → 允许上传 (正常)
- 如果云端当前 ETag != `ifMatch` → 拒绝上传 (PreconditionFailed 412)

### 2.2 冲突恢复流程

```
用户保存文件
    ↓
上传到云端 (携带 etag: "abc123")
    ↓
    ├─ 【成功】 (etag 匹配)
    │   ↓
    │   更新本地 etag: "def456"
    │   uploadState: null
    │
    └─ 【失败】 (412 PreconditionFailed)
        ↓
        uploadState: 'conflict-failed'  ← ① 标记状态
        ↓
        下次同步触发 Stage 2 救援
        ↓
        尝试智能合并
        ↓
        ├─ 【合并成功】
        │   ↓
        │   自动上传合并后内容
        │   用户无感知
        │
        └─ 【合并失败】
            ↓
            显示冲突 Banner
            提供 [使用云端] [使用本地] [存为副本] 选项
```

---

## 3. 闪念笔记格式规范

### 3.1 标准格式

```markdown
## 2025-01-19 14:30:00
这是第一条闪念内容。

可以有多行。

## 2025-01-18 10:15:00
这是第二条闪念内容。
```

**规则**:
- 每条闪念以 `## YYYY-MM-DD HH:mm:ss` 开头
- 时间戳必须精确到秒
- 时间戳行下方为内容，直到下一个时间戳

### 3.2 解析逻辑

**正则表达式**:
```javascript
const FLASH_NOTE_REGEX = /^## (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})$/gm;
```

**解析流程**:
```javascript
function parseFlashNotes(content: string): FlashNote[] {
  const notes: FlashNote[] = [];
  const lines = content.split('\n');
  let currentNote: FlashNote | null = null;

  for (const line of lines) {
    const match = line.match(/^## (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})$/);

    if (match) {
      // 遇到新的时间戳
      if (currentNote) {
        notes.push(currentNote);
      }
      currentNote = {
        timestamp: new Date(match[1]),
        content: ''
      };
    } else if (currentNote) {
      // 累积内容
      currentNote.content += line + '\n';
    }
  }

  if (currentNote) {
    notes.push(currentNote);
  }

  // 按时间倒序排序
  return notes.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
}
```

**实现位置**: `src/screens/FlashScreen.tsx`

### 3.3 追加写入逻辑

**FlashNoteService.appendNote()**:
```javascript
async function appendNote(content: string): Promise<void> {
  // 1. 读取现有文件
  const existingContent = await fsService.readFile(FLASH_NOTE_PATH);

  // 2. 生成时间戳
  const timestamp = formatDateTime(new Date()); // "2025-01-19 14:30:00"

  // 3. 拼接新内容（插入到文件头部）
  const newEntry = `## ${timestamp}\n${content}\n\n`;
  const updatedContent = newEntry + existingContent;

  // 4. 写入文件
  await fsService.writeFile(FLASH_NOTE_PATH, updatedContent);

  // 5. 触发上传（Write-Through）
  await cloudService.uploadFile(FLASH_NOTE_PATH);
}
```

---

## 4. 待办解析器 (TodoParser)

### 4.1 支持的 Markdown 语法

```markdown
- [ ] 未完成的待办
- [x] 已完成的待办
- [X] 已完成的待办（大写也支持）
* [ ] 使用星号也可以
+ [ ] 使用加号也可以
  - [ ] 支持缩进（子任务）
```

### 4.2 解析算法

**正则表达式**:
```javascript
const TODO_REGEX = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.+)$/;
```

**解析逻辑**:
```javascript
function parseTodos(content: string): Todo[] {
  const todos: Todo[] = [];
  const lines = content.split('\n');

  lines.forEach((line, index) => {
    const match = line.match(TODO_REGEX);

    if (match) {
      const [, indent, status, text] = match;
      todos.push({
        id: `${index}-${text}`,
        text: text.trim(),
        completed: status.toLowerCase() === 'x',
        indent: indent.length,
        lineNumber: index
      });
    }
  });

  return todos;
}
```

**实现位置**: `src/utils/TodoParser.ts`

### 4.3 状态更新流程

```
用户点击待办 Checkbox
    ↓
TodoParser.toggleTodo(content, lineNumber)
    ↓
    ├─ [ ] → [x]  (标记完成)
    └─ [x] → [ ]  (取消完成)
    ↓
更新文件内容
    ↓
保存到本地
    ↓
触发上传（Write-Through）
    ↓
同步到云端
```

---

## 5. 云端文件列表缓存策略

### 5.1 缓存机制

**目标**: 首屏秒开，后台静默更新

**流程**:
```
NoteScreen 加载
    ↓
① 从 AsyncStorage 读取缓存列表（毫秒级）
    ↓
② 立即渲染列表（用户看到内容）
    ↓
③ 后台调用 cloudService.listFiles()
    ↓
④ 获取最新列表后覆盖缓存
    ↓
⑤ 更新视图（如有变化）
```

**实现位置**: `src/store/useFileListStore.ts`

### 5.2 缓存更新时机

| 触发场景 | 更新操作 | 说明 |
|---------|---------|------|
| 页面获得焦点 | 全量刷新 | `useFocusEffect` 触发 |
| 用户下拉刷新 | 全量刷新 | 手动触发 |
| 上传新文件 | 增量添加 | 直接插入缓存 |
| 删除文件 | 增量删除 | 从缓存移除 |
| 重命名文件 | 增量更新 | 更新缓存项 |

### 5.3 禁止行为

❌ **严禁在加载列表时扫描本地文件系统**

**错误示例**:
```javascript
// ❌ 禁止这样做
const localFiles = await fsService.listFiles('notes/');
const cloudFiles = await cloudService.listFiles('notes/');
const mergedList = [...localFiles, ...cloudFiles]; // 禁止合并
```

**正确示例**:
```javascript
// ✅ 唯一真相来源：云端
const cloudFiles = await cloudService.listFiles('notes/');
setFileList(cloudFiles); // 直接使用云端列表
```

**原因**: 遵循"云优先"架构原则（参见 `docs/BrowerScreen_cloud_first.md`）

---

## 6. 上传队列管理

### 6.1 队列数据结构

```typescript
interface QueueItem {
  path: string;           // 文件路径
  status: 'pending' | 'uploading' | 'failed' | 'success';
  retryCount: number;     // 重试次数
  lastError?: string;     // 上次错误信息
  addedAt: number;        // 加入队列时间戳
}
```

### 6.2 重试策略

**重试条件**:
- `uploadState === 'failed'` (非乐观锁冲突)
- `retryCount < MAX_RETRY_COUNT` (默认 3 次)

**重试间隔**: 指数退避
```javascript
const retryDelay = Math.min(1000 * Math.pow(2, retryCount), 30000);
// retryCount = 0: 1秒
// retryCount = 1: 2秒
// retryCount = 2: 4秒
// retryCount >= 5: 30秒（上限）
```

**自动重试流程**:
```
Stage 2 扫描发现 uploadState === 'failed'
    ↓
检查 retryCount < MAX_RETRY_COUNT
    ↓
    ├─ 【未超限】
    │   ↓
    │   等待 retryDelay
    │   ↓
    │   执行上传
    │   ↓
    │   ├─ 成功: uploadState = null, retryCount = 0
    │   └─ 失败: retryCount++
    │
    └─ 【已超限】
        ↓
        加入 uploadErrorFiles 列表
        ↓
        显示 Banner: "上传失败: xxx.md"
        ↓
        提供 [重试] 按钮（手动触发，重置 retryCount）
```

**实现位置**: `src/store/useSyncStore.ts`

---

## 7. 状态横幅优先级管理

### 7.1 优先级规则

**StatusBannerContainer** 按以下顺序显示 Banner（高到低）:

1. **Offline** (离线模式) - 最高优先级
2. **Not Configured** (未配置云服务)
3. **Upload Errors** (`uploadErrorFiles.length > 0`)
4. **Conflicts** (`conflictedFiles.length > 0`)

### 7.2 逐一击破策略

**场景**: 同时存在 3 个上传失败文件

**显示**:
```
┌──────────────────────────────────────────┐
│ ⚠️ 上传失败: flash_notes.md (+2)         │
│                              [重试] [忽略] │
└──────────────────────────────────────────┘
```

**交互流程**:
```
用户点击 [重试]
    ↓
重试 flash_notes.md
    ↓
    ├─ 【成功】
    │   ↓
    │   从 uploadErrorFiles 移除
    │   ↓
    │   Banner 自动更新显示下一个:
    │   "上传失败: todo.md (+1)"
    │
    └─ 【失败】
        ↓
        仍显示: "上传失败: flash_notes.md (+2)"
        ↓
        提示: "重试失败，请检查网络"
```

**实现位置**: `src/components/StatusBannerContainer.tsx`

---

## 8. AI 对话流式响应

### 8.1 流式传输机制

**目标**: 逐字显示 AI 回复，提升用户体验

**实现方式**: Server-Sent Events (SSE) 或 Streaming JSON

**流程**:
```
用户发送消息
    ↓
LLMService.streamChat(messages)
    ↓
开启 HTTP 流式连接
    ↓
持续接收 delta 数据
    ↓
    ┌────────────────────────┐
    │ data: {"delta": "你"}   │ → 显示: "你"
    │ data: {"delta": "好"}   │ → 显示: "你好"
    │ data: {"delta": "！"}   │ → 显示: "你好！"
    │ data: {"done": true}   │ → 完成
    └────────────────────────┘
    ↓
保存完整回复到对话历史
```

### 8.2 实现代码示例

```javascript
async function* streamChat(messages: Message[]): AsyncGenerator<string> {
  const response = await fetch(API_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, stream: true })
  });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();

    if (done) break;

    const chunk = decoder.decode(value, { stream: true });
    const lines = chunk.split('\n');

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = JSON.parse(line.slice(6));
        if (data.delta) {
          yield data.delta;  // ← 逐字返回
        }
      }
    }
  }
}
```

**使用示例**:
```javascript
// AgentScreen.tsx
const stream = LLMService.streamChat(conversationHistory);

for await (const delta of stream) {
  setCurrentResponse(prev => prev + delta);  // 累积显示
}
```

**实现位置**: `src/services/LLMService.ts`

---

## 9. 分享内容处理 (Share Extension)

### 9.1 接收分享流程

```
用户从其他应用分享文本/图片到 MDNote
    ↓
原生层接收 Intent/Share Extension
    ↓
触发事件: SHARE_RECEIVED_EVENT
    ↓
GlobalShareHandler 监听事件
    ↓
存储到 useShareStore
    ↓
自动打开 FlashNoteInputModal
    ↓
预填充分享内容
    ↓
用户确认/编辑后保存
```

### 9.2 支持的分享类型

| 类型 | 处理方式 | 示例 |
|-----|---------|------|
| 纯文本 | 直接填充到闪念输入框 | "这是分享的文本" |
| URL 链接 | 自动生成 Markdown 链接 | `[标题](https://example.com)` |
| 图片 | 保存到 assets/ 并插入引用 | `![图片](assets/share_123.jpg)` |
| 文件 | 复制到 notes/ 目录 | `[文件名](notes/shared_file.pdf)` |

### 9.3 实现位置

- 原生接收: `android/app/src/main/java/.../ShareActivity.java`
- React Native 处理: `src/utils/GlobalShareHandler.tsx`
- 状态存储: `src/store/useShareStore.ts`

---

## 10. 影子文件系统 (Shadow File)

### 10.1 设计目的

**问题**: 三路合并需要 "上次同步的版本 (S)"，但本地文件会被覆盖

**解决方案**: 每次成功同步后，保存一份 "影子文件" 作为基准

### 10.2 存储结构

```
DocumentDirectoryPath/
├── notes/
│   └── test.md              ← 当前版本 (L)
└── .shadow/
    └── notes/
        └── test.md          ← 上次同步版本 (S)
```

### 10.3 同步时机

| 操作 | 更新影子文件 | 说明 |
|-----|------------|------|
| 上传成功 | ✅ | 复制当前版本到影子目录 |
| 下载成功 | ✅ | 复制下载内容到影子目录 |
| 智能合并成功 | ✅ | 复制合并结果到影子目录 |
| 本地修改 | ❌ | 不更新，保持基准不变 |
| 上传失败 | ❌ | 不更新，等待重试 |

### 10.4 实现位置

`src/services/ShadowFileService.ts`

**核心方法**:
```javascript
class ShadowFileService {
  // 保存影子文件
  async saveShadow(path: string, content: string): Promise<void>;

  // 读取影子文件
  async readShadow(path: string): Promise<string | null>;

  // 删除影子文件
  async deleteShadow(path: string): Promise<void>;

  // 检查影子文件是否存在
  async shadowExists(path: string): Promise<boolean>;
}
```

---

## 11. 冲突解决用户选项

### 11.1 三种解决方式

当智能合并失败时，提供以下选项:

| 选项 | 操作 | 结果 |
|-----|------|------|
| **使用云端版本** | 下载云端文件覆盖本地 | 本地修改丢失，以云端为准 |
| **使用本地版本** | 强制上传本地文件（忽略 ETag） | 云端修改丢失，以本地为准 |
| **保存为副本** | 本地重命名为 `xxx_conflict_时间戳.md`<br>下载云端文件 | 两个版本都保留，用户手动合并 |

### 11.2 实现逻辑

**使用云端版本**:
```javascript
async function useCloudVersion(path: string) {
  // 1. 下载云端文件
  await cloudService.downloadFile(path);

  // 2. 更新元数据
  const cloudMetadata = await cloudService.headFile(path);
  fileMetadataStore.setMetadata(path, {
    etag: cloudMetadata.etag,
    syncedHash: await calculateHash(localPath),
    uploadState: null
  });

  // 3. 更新影子文件
  await shadowFileService.saveShadow(path, localContent);

  // 4. 从冲突列表移除
  removeFromConflictedFiles(path);
}
```

**使用本地版本**:
```javascript
async function useLocalVersion(path: string) {
  // 1. 强制上传（不携带 etag）
  const result = await cloudService.uploadFile(path, localContent, {
    ifMatch: undefined  // ← 跳过乐观锁检查
  });

  // 2. 更新元数据
  fileMetadataStore.setMetadata(path, {
    etag: result.etag,
    syncedHash: await calculateHash(localPath),
    uploadState: null
  });

  // 3. 更新影子文件
  await shadowFileService.saveShadow(path, localContent);

  // 4. 从冲突列表移除
  removeFromConflictedFiles(path);
}
```

**保存为副本**:
```javascript
async function saveAsConflictCopy(path: string) {
  // 1. 生成副本文件名
  const timestamp = formatDateTime(new Date(), 'YYYYMMDDHHmmss');
  const copyPath = path.replace(/(\.\w+)$/, `_conflict_${timestamp}$1`);
  // 例: notes/test.md → notes/test_conflict_20250119143000.md

  // 2. 复制本地文件到副本
  await fsService.copyFile(path, copyPath);

  // 3. 下载云端文件覆盖原路径
  await cloudService.downloadFile(path);

  // 4. 更新元数据
  const cloudMetadata = await cloudService.headFile(path);
  fileMetadataStore.setMetadata(path, {
    etag: cloudMetadata.etag,
    syncedHash: await calculateHash(path),
    uploadState: null
  });

  // 5. 更新影子文件
  await shadowFileService.saveShadow(path, await fsService.readFile(path));

  // 6. 从冲突列表移除
  removeFromConflictedFiles(path);

  // 7. 提示用户
  showToast(`冲突副本已保存至: ${copyPath}`);
}
```

**实现位置**: `src/services/SyncService.ts`

---

## 12. 编码规范执行要点

### 12.1 DRY 原则实践

**❌ 反面示例**: 在多个页面重复编写同步逻辑
```javascript
// FlashScreen.tsx
const syncFlash = async () => {
  const local = await fsService.readFile('flash_notes.md');
  const cloud = await cloudService.headFile('flash_notes.md');
  if (local.hash !== cloud.etag) { /* 冲突处理 */ }
};

// TodoScreen.tsx
const syncTodo = async () => {
  const local = await fsService.readFile('todo.md');
  const cloud = await cloudService.headFile('todo.md');
  if (local.hash !== cloud.etag) { /* 冲突处理 */ }  // ❌ 重复逻辑
};
```

**✅ 正面示例**: 封装到服务层
```javascript
// src/services/SyncService.ts
class SyncService {
  async syncFile(path: string): Promise<SyncResult> {
    const local = await fsService.readFile(path);
    const cloud = await cloudService.headFile(path);
    // 统一冲突检测逻辑
    if (local.hash !== cloud.etag) {
      return this.handleConflict(path, local, cloud);
    }
    return { status: 'synced' };
  }
}

// FlashScreen.tsx
const syncResult = await syncService.syncFile('flash_notes.md');

// TodoScreen.tsx
const syncResult = await syncService.syncFile('todo.md');
```

### 12.2 服务层下沉原则

**规则**: UI 组件（Screens/Components）禁止直接编写业务逻辑

**分界线**:
- ✅ UI 层: 状态显示、用户交互、导航跳转
- ✅ 服务层: 文件操作、云同步、冲突检测、数据解析

**检查清单**:
- [ ] UI 组件中是否存在 `cloudService.uploadFile()` 直接调用？→ 应封装到服务
- [ ] UI 组件中是否存在复杂的冲突检测逻辑？→ 应下沉到 `SyncService`
- [ ] UI 组件中是否存在文件哈希计算？→ 应封装到 `FileSystemService`

---

## 13. 性能优化要点

### 13.1 避免不必要的文件读取

**❌ 低效做法**:
```javascript
// 每次渲染都读取文件
useEffect(() => {
  fsService.readFile('notes/list.json').then(setNotes);
}, []); // 页面每次显示都重新读取
```

**✅ 优化方案**:
```javascript
// 使用 Zustand 存储 + 缓存
const cachedNotes = useFileListStore(state => state.notes);

useEffect(() => {
  if (cachedNotes.length === 0) {
    // 仅首次读取
    loadNotesFromCache();
  }
}, []);
```

### 13.2 批量操作优化

**❌ 低效做法**:
```javascript
// 逐个上传文件
for (const file of files) {
  await cloudService.uploadFile(file);  // 串行，慢
}
```

**✅ 优化方案**:
```javascript
// 并发上传（限制并发数）
const uploadPromises = files.map(file =>
  cloudService.uploadFile(file)
);
await Promise.all(uploadPromises);  // 并行，快
```

### 13.3 大文件分块传输

**场景**: 上传超过 5MB 的文件

**实现**: 使用腾讯 COS 的分块上传 API
```javascript
if (fileSize > 5 * 1024 * 1024) {
  // 使用分块上传
  await cosProvider.sliceUploadFile(path, {
    SliceSize: 1024 * 1024  // 1MB 每块
  });
} else {
  // 普通上传
  await cosProvider.uploadFile(path);
}
```

**实现位置**: `src/services/TencentCOSProvider.ts`
