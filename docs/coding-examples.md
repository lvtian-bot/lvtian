# MDNote 代码示例集

> **适用场景**: 当需要参考具体代码实现、设计模式时查阅此文档

---

## 1. 添加新的云服务提供商

### 1.1 实现 ICloudProvider 接口

**场景**: 添加对 阿里云 OSS 的支持

**步骤 1**: 创建 Provider 类

```typescript
// src/services/AliyunOSSProvider.ts
import OSS from 'ali-oss';
import { ICloudProvider, UploadResult, FileMetadata, CloudFileItem } from './CloudService';

export class AliyunOSSProvider implements ICloudProvider {
  private client: OSS | null = null;
  private bucket: string = '';
  private region: string = '';

  constructor() {}

  // 配置检查
  isConfigured(): boolean {
    return this.client !== null && this.bucket !== '';
  }

  // 初始化客户端
  async configure(config: {
    bucket: string;
    region: string;
    accessKeyId: string;
    accessKeySecret: string;
  }): Promise<void> {
    this.bucket = config.bucket;
    this.region = config.region;

    this.client = new OSS({
      region: config.region,
      accessKeyId: config.accessKeyId,
      accessKeySecret: config.accessKeySecret,
      bucket: config.bucket,
    });
  }

  // 上传文件
  async uploadFile(
    cloudPath: string,
    localPath: string,
    options?: { ifMatch?: string }
  ): Promise<UploadResult> {
    if (!this.client) throw new Error('[CLOUD_001] OSS not configured');

    try {
      const fileContent = await fsService.readFile(localPath);

      // 携带乐观锁条件
      const headers: Record<string, string> = {};
      if (options?.ifMatch) {
        headers['If-Match'] = options.ifMatch;
      }

      const result = await this.client.put(cloudPath, Buffer.from(fileContent), {
        headers,
      });

      return {
        etag: result.res.headers.etag.replace(/"/g, ''),  // 去除引号
        lastModified: new Date(result.res.headers['last-modified']),
      };
    } catch (error: any) {
      if (error.status === 412) {
        throw new Error('[SYNC_002] PreconditionFailed');
      }
      throw error;
    }
  }

  // 下载文件
  async downloadFile(cloudPath: string, localPath: string): Promise<void> {
    if (!this.client) throw new Error('[CLOUD_001] OSS not configured');

    const result = await this.client.get(cloudPath);
    await fsService.writeFile(localPath, result.content.toString());
  }

  // 获取文件元数据
  async headFile(cloudPath: string): Promise<FileMetadata> {
    if (!this.client) throw new Error('[CLOUD_001] OSS not configured');

    const result = await this.client.head(cloudPath);

    return {
      etag: result.res.headers.etag.replace(/"/g, ''),
      lastModified: new Date(result.res.headers['last-modified']),
      size: parseInt(result.res.headers['content-length'], 10),
    };
  }

  // 列出文件
  async listFiles(prefix: string): Promise<CloudFileItem[]> {
    if (!this.client) throw new Error('[CLOUD_001] OSS not configured');

    const result = await this.client.list({
      prefix,
      'max-keys': 1000,
    });

    return (result.objects || []).map(obj => ({
      path: obj.name,
      etag: obj.etag,
      lastModified: new Date(obj.lastModified),
      size: obj.size,
    }));
  }

  // 删除文件
  async deleteFile(cloudPath: string): Promise<void> {
    if (!this.client) throw new Error('[CLOUD_001] OSS not configured');

    await this.client.delete(cloudPath);
  }
}
```

**步骤 2**: 在 CloudService 中注册

```typescript
// src/services/CloudService.ts
import { AliyunOSSProvider } from './AliyunOSSProvider';

class CloudService {
  async initProvider(providerType: string, config: any): Promise<void> {
    switch (providerType) {
      case 'tencent-cos':
        this.provider = new TencentCOSProvider();
        break;
      case 'webdav':
        this.provider = new WebDAVProvider();
        break;
      case 'aliyun-oss':  // ← 新增
        this.provider = new AliyunOSSProvider();
        break;
      default:
        throw new Error(`Unknown provider: ${providerType}`);
    }

    await this.provider.configure(config);
  }
}
```

**步骤 3**: 添加 UI 配置项

```typescript
// src/screens/CloudRepoConfigScreen.tsx
const CLOUD_PROVIDERS = [
  { label: '腾讯云 COS', value: 'tencent-cos' },
  { label: 'WebDAV (坚果云)', value: 'webdav' },
  { label: '阿里云 OSS', value: 'aliyun-oss' },  // ← 新增
];

// 根据 providerType 显示不同的配置表单
{providerType === 'aliyun-oss' && (
  <>
    <TextInput
      label="Bucket"
      value={bucket}
      onChangeText={setBucket}
    />
    <TextInput
      label="Region"
      value={region}
      onChangeText={setRegion}
    />
    <TextInput
      label="Access Key ID"
      value={accessKeyId}
      onChangeText={setAccessKeyId}
    />
    <TextInput
      label="Access Key Secret"
      value={accessKeySecret}
      onChangeText={setAccessKeySecret}
      secureTextEntry
    />
  </>
)}
```

---

## 2. 添加新的同步页面

### 2.1 创建 NotebookScreen (笔记本页面)

**场景**: 添加一个新页面，管理 `notebooks/` 目录下的笔记本

**步骤 1**: 定义导航类型

```typescript
// src/types/navigation.ts
export type MainTabParamList = {
  // ...现有路由
  NotebookTab: undefined;  // ← 新增
};
```

**步骤 2**: 创建屏幕组件

```typescript
// src/screens/NotebookScreen.tsx
import React, { useEffect, useState } from 'react';
import { View, FlatList, Text, StyleSheet } from 'react-native';
import { useFlashNoteList } from '@/hooks/useFlashNoteList';
import { StatusBannerContainer } from '@/components/StatusBannerContainer';
import { FlashNoteService } from '@/services/FlashNoteService';

export function NotebookScreen() {
  const {
    notes,
    syncStatus,
    uploadErrorFiles,
    conflictedFiles,
    refreshNotes,
  } = useFlashNoteList('notebooks/');  // ← 复用 Hook，传入不同路径

  useEffect(() => {
    refreshNotes();
  }, []);

  return (
    <View style={styles.container}>
      {/* 状态横幅 */}
      <StatusBannerContainer
        syncStatus={syncStatus}
        uploadErrorFiles={uploadErrorFiles}
        conflictedFiles={conflictedFiles}
        onRetryUpload={(path) => FlashNoteService.retryUpload(path)}
        onResolveConflict={(path, resolution) =>
          FlashNoteService.resolveConflict(path, resolution)
        }
      />

      {/* 笔记本列表 */}
      <FlatList
        data={notes}
        keyExtractor={(item) => item.path}
        renderItem={({ item }) => (
          <NotebookItem
            notebook={item}
            onPress={() => navigation.navigate('NoteList', { path: item.path })}
          />
        )}
        onRefresh={refreshNotes}
        refreshing={syncStatus === 'checking'}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
});
```

**步骤 3**: 添加到导航器

```typescript
// src/navigation/TabNavigator.tsx
import { NotebookScreen } from '@/screens/NotebookScreen';

<Tab.Navigator>
  {/* ...现有 Tab */}
  <Tab.Screen
    name="NotebookTab"
    component={NotebookScreen}
    options={{
      tabBarLabel: t('tabs.notebook'),
      tabBarIcon: ({ color }) => <Icon name="book" color={color} />,
    }}
  />
</Tab.Navigator>
```

**步骤 4**: 添加国际化

```json
// src/locales/zh.json
{
  "tabs": {
    "flash": "闪念",
    "note": "笔记",
    "todo": "待办",
    "notebook": "笔记本",  // ← 新增
    "settings": "设置"
  }
}
```

---

## 3. 实现自定义同步 Hook

### 3.1 创建 useCloudSync Hook

**场景**: 封装通用的云同步逻辑，供多个页面复用

```typescript
// src/hooks/useCloudSync.ts
import { useState, useCallback } from 'react';
import { cloudService } from '@/services/CloudService';
import { fsService } from '@/services/FileSystemService';
import { useFileMetadataStore } from '@/store/useFileMetadataStore';

export type SyncStatus = 'idle' | 'checking' | 'synced' | 'conflict' | 'error' | 'offline';

export function useCloudSync(filePath: string) {
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const fileMetadata = useFileMetadataStore(state => state.metadata[filePath]);
  const setMetadata = useFileMetadataStore(state => state.setMetadata);

  // 检查同步状态
  const checkSync = useCallback(async () => {
    setSyncStatus('checking');
    setErrorMessage(null);

    try {
      // 1. 检查网络
      const netInfo = await NetInfo.fetch();
      if (!netInfo.isConnected) {
        setSyncStatus('offline');
        return;
      }

      // 2. 检查配置
      if (!cloudService.isConfigured()) {
        setSyncStatus('error');
        setErrorMessage('未配置云服务');
        return;
      }

      // 3. 获取本地和云端哈希
      const localContent = await fsService.readFile(filePath);
      const localHash = calculateHash(localContent);

      const cloudMetadata = await cloudService.headFile(filePath);
      const cloudHash = cloudMetadata.etag;

      // 4. 三路比对
      if (localHash === cloudHash) {
        // 已同步
        setSyncStatus('synced');
        setMetadata(filePath, {
          etag: cloudHash,
          syncedHash: localHash,
          uploadState: null,
        });
      } else {
        // 不同步，检查冲突
        const syncedHash = fileMetadata?.syncedHash;

        if (localHash === syncedHash) {
          // 仅云端变化，自动下载
          await cloudService.downloadFile(filePath, filePath);
          setSyncStatus('synced');
        } else if (cloudHash === syncedHash) {
          // 仅本地变化，自动上传
          await cloudService.uploadFile(filePath, filePath);
          setSyncStatus('synced');
        } else {
          // 双向冲突
          setSyncStatus('conflict');
        }
      }
    } catch (error: any) {
      setSyncStatus('error');
      setErrorMessage(error.message);
    }
  }, [filePath, fileMetadata]);

  // 强制上传
  const forceUpload = useCallback(async () => {
    try {
      await cloudService.uploadFile(filePath, filePath, { ifMatch: undefined });
      await checkSync();
    } catch (error: any) {
      setErrorMessage(error.message);
    }
  }, [filePath, checkSync]);

  // 强制下载
  const forceDownload = useCallback(async () => {
    try {
      await cloudService.downloadFile(filePath, filePath);
      await checkSync();
    } catch (error: any) {
      setErrorMessage(error.message);
    }
  }, [filePath, checkSync]);

  return {
    syncStatus,
    errorMessage,
    checkSync,
    forceUpload,
    forceDownload,
  };
}
```

**使用示例**:

```typescript
// src/screens/PreviewScreen.tsx
function PreviewScreen({ route }) {
  const { filePath } = route.params;
  const { syncStatus, errorMessage, checkSync, forceUpload, forceDownload } =
    useCloudSync(filePath);

  useEffect(() => {
    checkSync();
  }, []);

  return (
    <View>
      {syncStatus === 'conflict' && (
        <Banner>
          <Text>文件冲突</Text>
          <Button onPress={forceUpload}>使用本地版本</Button>
          <Button onPress={forceDownload}>使用云端版本</Button>
        </Banner>
      )}

      <MarkdownViewer filePath={filePath} />
    </View>
  );
}
```

---

## 4. 添加新的 Zustand Store

### 4.1 创建 useNotebookStore

**场景**: 管理笔记本的收藏、标签等状态

```typescript
// src/store/useNotebookStore.ts
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

export interface Notebook {
  id: string;
  name: string;
  path: string;
  color: string;
  tags: string[];
  isFavorite: boolean;
  createdAt: number;
  updatedAt: number;
}

interface NotebookState {
  notebooks: Record<string, Notebook>;  // key: notebook.id
  tags: string[];

  // Actions
  addNotebook: (notebook: Notebook) => void;
  updateNotebook: (id: string, updates: Partial<Notebook>) => void;
  deleteNotebook: (id: string) => void;
  toggleFavorite: (id: string) => void;
  addTag: (tag: string) => void;
  removeTag: (tag: string) => void;
}

export const useNotebookStore = create<NotebookState>()(
  persist(
    (set, get) => ({
      notebooks: {},
      tags: [],

      // 添加笔记本
      addNotebook: (notebook) =>
        set((state) => ({
          notebooks: {
            ...state.notebooks,
            [notebook.id]: {
              ...notebook,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
          },
        })),

      // 更新笔记本
      updateNotebook: (id, updates) =>
        set((state) => ({
          notebooks: {
            ...state.notebooks,
            [id]: {
              ...state.notebooks[id],
              ...updates,
              updatedAt: Date.now(),
            },
          },
        })),

      // 删除笔记本
      deleteNotebook: (id) =>
        set((state) => {
          const { [id]: removed, ...rest } = state.notebooks;
          return { notebooks: rest };
        }),

      // 切换收藏
      toggleFavorite: (id) =>
        set((state) => ({
          notebooks: {
            ...state.notebooks,
            [id]: {
              ...state.notebooks[id],
              isFavorite: !state.notebooks[id].isFavorite,
              updatedAt: Date.now(),
            },
          },
        })),

      // 添加标签
      addTag: (tag) =>
        set((state) => ({
          tags: state.tags.includes(tag) ? state.tags : [...state.tags, tag],
        })),

      // 删除标签
      removeTag: (tag) =>
        set((state) => ({
          tags: state.tags.filter((t) => t !== tag),
        })),
    }),
    {
      name: 'notebook-storage',
      storage: createJSONStorage(() => AsyncStorage),
    }
  )
);
```

**使用示例**:

```typescript
// src/screens/NotebookListScreen.tsx
function NotebookListScreen() {
  const notebooks = useNotebookStore(state => Object.values(state.notebooks));
  const toggleFavorite = useNotebookStore(state => state.toggleFavorite);

  // 筛选收藏的笔记本
  const favoriteNotebooks = notebooks.filter(nb => nb.isFavorite);

  return (
    <FlatList
      data={favoriteNotebooks}
      renderItem={({ item }) => (
        <NotebookItem
          notebook={item}
          onFavoritePress={() => toggleFavorite(item.id)}
        />
      )}
    />
  );
}
```

---

## 5. 实现拖拽排序

### 5.1 待办列表拖拽排序

**场景**: 用户可以长按待办项进行拖拽排序

```typescript
// src/components/DraggableTodoList.tsx
import React from 'react';
import { View } from 'react-native';
import DraggableFlatList, {
  ScaleDecorator,
  RenderItemParams,
} from 'react-native-draggable-flatlist';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Todo } from '@/types/todo';

interface Props {
  todos: Todo[];
  onReorder: (newOrder: Todo[]) => void;
}

export function DraggableTodoList({ todos, onReorder }: Props) {
  const renderItem = ({ item, drag, isActive }: RenderItemParams<Todo>) => {
    return (
      <ScaleDecorator>
        <TouchableOpacity
          onLongPress={drag}  // ← 长按触发拖拽
          disabled={isActive}
          style={[
            styles.todoItem,
            isActive && styles.todoItemActive,
          ]}
        >
          <Checkbox
            value={item.completed}
            onValueChange={() => toggleTodo(item.id)}
          />
          <Text>{item.text}</Text>
        </TouchableOpacity>
      </ScaleDecorator>
    );
  };

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <DraggableFlatList
        data={todos}
        renderItem={renderItem}
        keyExtractor={(item) => item.id}
        onDragEnd={({ data }) => onReorder(data)}  // ← 排序完成回调
      />
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  todoItem: {
    padding: 16,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
    flexDirection: 'row',
    alignItems: 'center',
  },
  todoItemActive: {
    backgroundColor: '#f0f0f0',
    elevation: 5,
  },
});
```

**使用示例**:

```typescript
// src/screens/TodoScreen.tsx
function TodoScreen() {
  const [todos, setTodos] = useState<Todo[]>([]);

  const handleReorder = async (newOrder: Todo[]) => {
    setTodos(newOrder);

    // 保存新顺序到文件
    const content = TodoParser.todosToMarkdown(newOrder);
    await fsService.writeFile('todo.md', content);
    await cloudService.uploadFile('todo.md');
  };

  return (
    <DraggableTodoList
      todos={todos}
      onReorder={handleReorder}
    />
  );
}
```

---

## 6. 实现滑动删除

### 6.1 闪念条目滑动删除

**场景**: 用户可以左滑闪念条目显示删除按钮

```typescript
// src/components/SwipeableFlashNote.tsx
import React, { useRef } from 'react';
import { View, Text, Animated, StyleSheet } from 'react-native';
import { RectButton, Swipeable } from 'react-native-gesture-handler';

interface Props {
  note: FlashNote;
  onDelete: () => void;
}

export function SwipeableFlashNote({ note, onDelete }: Props) {
  const swipeableRef = useRef<Swipeable>(null);

  // 右侧操作按钮（左滑显示）
  const renderRightActions = (
    progress: Animated.AnimatedInterpolation<number>,
    dragX: Animated.AnimatedInterpolation<number>
  ) => {
    const scale = dragX.interpolate({
      inputRange: [-80, 0],
      outputRange: [1, 0],
      extrapolate: 'clamp',
    });

    return (
      <Animated.View style={[styles.rightAction, { transform: [{ scale }] }]}>
        <RectButton
          style={styles.deleteButton}
          onPress={() => {
            swipeableRef.current?.close();
            onDelete();
          }}
        >
          <Text style={styles.deleteButtonText}>删除</Text>
        </RectButton>
      </Animated.View>
    );
  };

  return (
    <Swipeable
      ref={swipeableRef}
      friction={2}
      rightThreshold={40}
      renderRightActions={renderRightActions}
    >
      <View style={styles.noteContainer}>
        <Text style={styles.timestamp}>
          {formatDateTime(note.timestamp)}
        </Text>
        <Text style={styles.content}>{note.content}</Text>
      </View>
    </Swipeable>
  );
}

const styles = StyleSheet.create({
  noteContainer: {
    padding: 16,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  timestamp: {
    fontSize: 12,
    color: '#999',
    marginBottom: 4,
  },
  content: {
    fontSize: 14,
    color: '#333',
  },
  rightAction: {
    justifyContent: 'center',
    alignItems: 'flex-end',
  },
  deleteButton: {
    backgroundColor: '#ff3b30',
    justifyContent: 'center',
    alignItems: 'center',
    width: 80,
    height: '100%',
  },
  deleteButtonText: {
    color: '#fff',
    fontWeight: 'bold',
  },
});
```

**使用示例**:

```typescript
// src/screens/FlashScreen.tsx
function FlashScreen() {
  const [notes, setNotes] = useState<FlashNote[]>([]);

  const handleDeleteNote = async (noteId: string) => {
    // 1. 从列表移除
    const updatedNotes = notes.filter(n => n.id !== noteId);
    setNotes(updatedNotes);

    // 2. 更新文件
    const content = FlashNoteParser.notesToMarkdown(updatedNotes);
    await fsService.writeFile('flash_notes.md', content);

    // 3. 同步到云端
    await cloudService.uploadFile('flash_notes.md');
  };

  return (
    <FlatList
      data={notes}
      renderItem={({ item }) => (
        <SwipeableFlashNote
          note={item}
          onDelete={() => handleDeleteNote(item.id)}
        />
      )}
    />
  );
}
```

---

## 7. 实现 AI 流式对话

### 7.1 创建 LLMService

```typescript
// src/services/LLMService.ts
import { useAIStore } from '@/store/useAIStore';

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

class LLMService {
  private apiEndpoint: string = '';
  private apiKey: string = '';

  configure(endpoint: string, apiKey: string) {
    this.apiEndpoint = endpoint;
    this.apiKey = apiKey;
  }

  // 流式对话
  async* streamChat(messages: Message[]): AsyncGenerator<string, void, unknown> {
    const response = await fetch(this.apiEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        stream: true,
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n').filter(line => line.trim() !== '');

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);

          if (data === '[DONE]') {
            return;
          }

          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta?.content;

            if (delta) {
              yield delta;  // ← 逐字返回
            }
          } catch (e) {
            console.warn('Failed to parse SSE data:', data);
          }
        }
      }
    }
  }

  // 普通对话（非流式）
  async chat(messages: Message[]): Promise<string> {
    let fullResponse = '';

    for await (const delta of this.streamChat(messages)) {
      fullResponse += delta;
    }

    return fullResponse;
  }
}

export const llmService = new LLMService();
```

### 7.2 在 AgentScreen 中使用

```typescript
// src/screens/AgentScreen.tsx
function AgentScreen() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [currentResponse, setCurrentResponse] = useState('');

  const handleSend = async () => {
    if (!input.trim()) return;

    // 添加用户消息
    const userMessage: Message = {
      role: 'user',
      content: input,
      timestamp: Date.now(),
    };
    setMessages(prev => [...prev, userMessage]);
    setInput('');

    // 开始流式响应
    setIsStreaming(true);
    setCurrentResponse('');

    const assistantMessage: Message = {
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
    };

    try {
      // 调用流式 API
      const stream = llmService.streamChat([...messages, userMessage]);

      for await (const delta of stream) {
        setCurrentResponse(prev => prev + delta);  // ← 逐字累积显示
        assistantMessage.content += delta;
      }

      // 流式完成，添加到消息列表
      setMessages(prev => [...prev, assistantMessage]);
    } catch (error: any) {
      console.error('Stream chat failed:', error);
      assistantMessage.content = `错误: ${error.message}`;
      setMessages(prev => [...prev, assistantMessage]);
    } finally {
      setIsStreaming(false);
      setCurrentResponse('');
    }
  };

  return (
    <View style={styles.container}>
      {/* 消息列表 */}
      <FlatList
        data={messages}
        renderItem={({ item }) => (
          <MessageBubble message={item} />
        )}
        keyExtractor={(item, index) => `${item.timestamp}-${index}`}
      />

      {/* 流式响应中的临时消息 */}
      {isStreaming && currentResponse && (
        <MessageBubble
          message={{
            role: 'assistant',
            content: currentResponse,
            timestamp: Date.now(),
          }}
          isStreaming
        />
      )}

      {/* 输入框 */}
      <View style={styles.inputContainer}>
        <TextInput
          value={input}
          onChangeText={setInput}
          placeholder="输入消息..."
          style={styles.input}
        />
        <Button
          title="发送"
          onPress={handleSend}
          disabled={isStreaming}
        />
      </View>
    </View>
  );
}
```

---

## 8. 实现本地搜索功能

### 8.1 全文搜索服务

```typescript
// src/services/SearchService.ts
import { fsService } from './FileSystemService';
import { cloudService } from './CloudService';

export interface SearchResult {
  filePath: string;
  fileName: string;
  matchedLine: string;
  lineNumber: number;
  score: number;  // 相关度评分
}

class SearchService {
  // 搜索本地文件
  async searchLocal(query: string, directory: string = ''): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    const files = await fsService.listFiles(directory);

    for (const file of files) {
      if (file.isDirectory) {
        // 递归搜索子目录
        const subResults = await this.searchLocal(query, file.path);
        results.push(...subResults);
      } else if (file.name.endsWith('.md')) {
        // 搜索 Markdown 文件
        const content = await fsService.readFile(file.path);
        const lines = content.split('\n');

        lines.forEach((line, index) => {
          if (line.toLowerCase().includes(query.toLowerCase())) {
            results.push({
              filePath: file.path,
              fileName: file.name,
              matchedLine: line.trim(),
              lineNumber: index + 1,
              score: this.calculateScore(line, query),
            });
          }
        });
      }
    }

    // 按评分排序
    return results.sort((a, b) => b.score - a.score);
  }

  // 计算相关度评分
  private calculateScore(line: string, query: string): number {
    const lowerLine = line.toLowerCase();
    const lowerQuery = query.toLowerCase();

    let score = 0;

    // 完全匹配 +10 分
    if (lowerLine === lowerQuery) {
      score += 10;
    }

    // 包含完整查询词 +5 分
    if (lowerLine.includes(lowerQuery)) {
      score += 5;
    }

    // 标题中出现 +3 分
    if (line.startsWith('#') && lowerLine.includes(lowerQuery)) {
      score += 3;
    }

    // 词频
    const matches = lowerLine.split(lowerQuery).length - 1;
    score += matches;

    return score;
  }
}

export const searchService = new SearchService();
```

### 8.2 搜索页面实现

```typescript
// src/screens/SearchScreen.tsx
function SearchScreen() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  // 防抖搜索
  const debouncedSearch = useMemo(
    () =>
      debounce(async (searchQuery: string) => {
        if (!searchQuery.trim()) {
          setResults([]);
          return;
        }

        setIsSearching(true);
        try {
          const searchResults = await searchService.searchLocal(searchQuery);
          setResults(searchResults);
        } catch (error) {
          console.error('Search failed:', error);
        } finally {
          setIsSearching(false);
        }
      }, 300),  // 300ms 防抖
    []
  );

  useEffect(() => {
    debouncedSearch(query);
  }, [query, debouncedSearch]);

  return (
    <View style={styles.container}>
      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder="搜索笔记..."
        style={styles.searchInput}
        autoFocus
      />

      {isSearching && <ActivityIndicator />}

      <FlatList
        data={results}
        renderItem={({ item }) => (
          <SearchResultItem
            result={item}
            onPress={() =>
              navigation.navigate('Preview', { filePath: item.filePath })
            }
          />
        )}
        keyExtractor={(item, index) => `${item.filePath}-${index}`}
        ListEmptyComponent={
          !isSearching && query ? (
            <Text style={styles.emptyText}>未找到匹配的结果</Text>
          ) : null
        }
      />
    </View>
  );
}

// 搜索结果项组件
function SearchResultItem({ result, onPress }: { result: SearchResult; onPress: () => void }) {
  // 高亮匹配文本
  const highlightedLine = result.matchedLine.replace(
    new RegExp(query, 'gi'),
    (match) => `**${match}**`
  );

  return (
    <TouchableOpacity onPress={onPress} style={styles.resultItem}>
      <Text style={styles.fileName}>{result.fileName}</Text>
      <Markdown>{highlightedLine}</Markdown>
      <Text style={styles.lineNumber}>第 {result.lineNumber} 行</Text>
    </TouchableOpacity>
  );
}
```

---

## 9. 实现离线队列同步

### 9.1 后台同步任务

```typescript
// src/services/BackgroundSyncService.ts
import BackgroundFetch from 'react-native-background-fetch';
import { useSyncStore } from '@/store/useSyncStore';
import { cloudService } from './CloudService';

class BackgroundSyncService {
  async configure() {
    BackgroundFetch.configure(
      {
        minimumFetchInterval: 15,  // 15 分钟
        stopOnTerminate: false,
        startOnBoot: true,
      },
      async (taskId) => {
        console.log('[BackgroundSync] Task started:', taskId);

        try {
          await this.processSyncQueue();
          BackgroundFetch.finish(taskId, BackgroundFetch.FETCH_RESULT_NEW_DATA);
        } catch (error) {
          console.error('[BackgroundSync] Failed:', error);
          BackgroundFetch.finish(taskId, BackgroundFetch.FETCH_RESULT_FAILED);
        }
      },
      (taskId) => {
        console.warn('[BackgroundSync] Task timeout:', taskId);
        BackgroundFetch.finish(taskId);
      }
    );
  }

  async processSyncQueue() {
    const queue = useSyncStore.getState().queue;
    const pendingItems = queue.filter(item => item.status === 'pending');

    console.log(`[BackgroundSync] Processing ${pendingItems.length} items`);

    for (const item of pendingItems) {
      try {
        await cloudService.uploadFile(item.path);
        useSyncStore.getState().updateQueueItem(item.path, {
          status: 'success',
          retryCount: 0,
        });
      } catch (error: any) {
        useSyncStore.getState().updateQueueItem(item.path, {
          status: 'failed',
          retryCount: item.retryCount + 1,
          lastError: error.message,
        });
      }
    }
  }
}

export const backgroundSyncService = new BackgroundSyncService();
```

**在 App.tsx 中初始化**:

```typescript
// App.tsx
useEffect(() => {
  backgroundSyncService.configure();
}, []);
```

---

以上示例涵盖了 MDNote 项目中最常见的代码模式和扩展场景。在实际开发中，请严格遵循项目的架构原则和编码规范。
