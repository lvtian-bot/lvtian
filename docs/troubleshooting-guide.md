# MDNote 故障排查指南

> **适用场景**: 当遇到错误、异常行为或需要调试时查阅此文档

---

## 1. 同步问题排查

### 1.1 上传一直失败

**症状**: Banner 显示 "上传失败: xxx.md"，点击重试仍失败

**排查步骤**:

| 步骤 | 检查项 | 命令/位置 | 预期结果 |
|-----|--------|----------|---------|
| ① | 网络连接 | 查看设备网络状态 | 已连接 Wi-Fi/4G |
| ② | 云服务配置 | 设置 → 云存储配置 | Bucket/Region 正确 |
| ③ | 凭证有效性 | 尝试下载文件 | 能成功下载说明凭证有效 |
| ④ | 文件权限 | 检查文件是否存在 | `fsService.exists(path)` 返回 true |
| ⑤ | 查看错误日志 | `fileMetadataStore.getMetadata(path).lastError` | 查看具体错误信息 |

**常见原因与解决方案**:

| 错误信息 | 原因 | 解决方案 |
|---------|------|---------|
| `NetworkError` | 网络不稳定 | 切换网络或稍后重试 |
| `AccessDenied` | SecretKey 错误或过期 | 重新配置云服务凭证 |
| `NoSuchBucket` | Bucket 名称错误 | 检查设置中的 Bucket 配置 |
| `InvalidRegion` | Region 配置错误 | 检查 Region 是否与 Bucket 匹配 |
| `PreconditionFailed` | 乐观锁冲突 | 已自动进入冲突解决流程 |

### 1.2 文件显示"冲突"状态无法解除

**症状**: Banner 持续显示 "本地和云端已同时修改"

**排查步骤**:

1. **检查冲突文件路径**:
   ```javascript
   // 在 FlashScreen/TodoScreen 中查看
   console.log(conflictedFiles);  // 应包含具体文件路径
   ```

2. **手动查看文件内容**:
   - 本地版本: 使用编辑器打开文件
   - 云端版本: 在云存储控制台下载对比

3. **尝试三种解决方式**:
   - **使用云端版本**: 如果本地修改不重要
   - **使用本地版本**: 如果云端修改不重要
   - **保存为副本**: 两个版本都重要，手动合并

**特殊情况**: 如果智能合并不断失败

可能原因: 文件格式损坏或编码问题

解决方案:
```bash
# 检查文件编码
file -I "DocumentDirectoryPath/flash_notes.md"
# 预期: text/markdown; charset=utf-8

# 如果编码异常,手动转换为 UTF-8
iconv -f <source-encoding> -t UTF-8 flash_notes.md > flash_notes_fixed.md
```

### 1.3 同步状态一直显示"正在检查"

**症状**: 标题栏图标一直转圈，同步永不完成

**排查步骤**:

1. **检查是否有挂起的上传**:
   ```javascript
   const metadata = fileMetadataStore.getMetadata(path);
   console.log(metadata.uploadState);  // 如果是 'uploading',说明卡住了
   ```

2. **检查同步队列**:
   ```javascript
   const queue = useSyncStore.getState().queue;
   console.log(queue);  // 查看是否有 status='uploading' 的项
   ```

3. **强制重置状态**:
   ```javascript
   // 清除卡住的上传状态
   fileMetadataStore.setUploadState(path, null);
   useSyncStore.removeFromQueue(path);

   // 重新触发同步
   syncService.syncFile(path);
   ```

---

## 2. 编辑器问题排查

### 2.1 编辑器无法加载

**症状**: 打开编辑器页面显示空白或错误

**排查步骤**:

| 步骤 | 检查项 | 预期结果 |
|-----|--------|---------|
| ① | WebView 资源 | `assets/codemirror.bundle.js` 文件存在且大小 > 100KB |
| ② | 文件路径 | 传入 EditorScreen 的 `filePath` 参数有效 |
| ③ | WebView 控制台 | 启用 WebView 调试,查看 console.error |

**启用 WebView 调试**:
```javascript
// EditorScreen.tsx
<WebView
  source={{ uri: editorHtml }}
  onMessage={handleMessage}
  onError={(syntheticEvent) => {
    const { nativeEvent } = syntheticEvent;
    console.error('WebView error:', nativeEvent);  // ← 添加错误日志
  }}
  // 开发模式开启调试
  {...(__DEV__ && { webviewDebuggingEnabled: true })}
/>
```

然后在 Chrome 中访问: `chrome://inspect` → 找到 WebView 实例 → 查看 Console

### 2.2 编辑器修改后重新构建无效

**症状**: 修改了 `editor-bundler/src/editor.js`，运行 `npm run build` 后，应用中仍显示旧版本

**原因**: Metro Bundler 缓存了旧的 bundle.js

**解决方案**:
```bash
# 1. 清除 Metro 缓存
npx expo start --clear

# 2. 如果仍无效,手动删除缓存
rm -rf node_modules/.cache
rm -rf .expo

# 3. 重新构建编辑器
cd editor-bundler
npm run build

# 4. 确认产物已更新
ls -lh ../assets/codemirror.bundle.js  # 检查修改时间

# 5. 重启应用
npx expo run:android
```

### 2.3 编辑器中文输入异常

**症状**: 在 Android 上使用中文输入法时,字符显示错乱或重复

**原因**: CodeMirror 的 `compositionstart/compositionend` 事件处理问题

**解决方案**: 在 `editor-bundler/src/editor.js` 中添加输入法事件处理
```javascript
// 禁用拼写检查,避免与输入法冲突
view = new EditorView({
  // ...
  parent: document.body,
  // 添加扩展
  extensions: [
    // ...原有扩展
    EditorView.contentAttributes.of({ spellcheck: "false" })
  ]
});
```

重新构建后生效

---

## 3. Android 构建问题排查

### 3.1 Prebuild 后应用无法启动

**症状**: 运行 `npx expo run:android` 后应用崩溃或黑屏

**排查步骤**:

1. **查看 Logcat 日志**:
   ```bash
   adb logcat | grep -i "error\|exception"
   ```

2. **常见错误与解决方案**:

| 错误信息 | 原因 | 解决方案 |
|---------|------|---------|
| `java.lang.ClassNotFoundException` | 原生模块未正确链接 | 清除构建缓存: `cd android && ./gradlew clean` |
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | 签名不一致 | 卸载旧版应用后重新安装 |
| `Unable to load script` | Metro Bundler 未运行 | 确保 `npx expo start` 在运行 |
| `OutOfMemoryError` | 构建内存不足 | 增加 `android/gradle.properties` 中的堆内存 |

**增加构建内存**:
```properties
# android/gradle.properties
org.gradle.jvmargs=-Xmx4096m -XX:MaxPermSize=512m
```

### 3.2 自定义插件不生效

**症状**: 在 `app.config.js` 中添加了自定义插件，但 Prebuild 后原生代码未改变

**排查步骤**:

1. **确认插件路径正确**:
   ```javascript
   // app.config.js
   plugins: [
     './plugins/withDisablePredictiveBack.js',  // ← 确保路径存在
   ]
   ```

2. **检查插件语法**:
   ```javascript
   // plugins/withDisablePredictiveBack.js
   const { withAndroidManifest } = require('@expo/config-plugins');

   module.exports = function withDisablePredictiveBack(config) {
     return withAndroidManifest(config, async (config) => {
       // 确保返回 config
       return config;
     });
   };
   ```

3. **强制清除 Prebuild**:
   ```bash
   npx expo prebuild --clean  # ← 注意 --clean 参数
   ```

4. **验证插件执行**:
   ```bash
   # 临时添加调试日志
   console.log('[withDisablePredictiveBack] Plugin executed');

   # 运行 Prebuild 并查看输出
   npx expo prebuild 2>&1 | grep "Plugin executed"
   ```

### 3.3 Keystore 签名问题

**症状**: 构建 Release 版本时提示签名错误

**排查步骤**:

1. **检查 Keystore 文件**:
   ```bash
   ls -l android/app/my-release-key.keystore
   # 如果不存在,需要生成
   ```

2. **生成 Keystore** (如果需要):
   ```bash
   keytool -genkeypair -v \
     -keystore android/app/my-release-key.keystore \
     -alias my-key-alias \
     -keyalg RSA \
     -keysize 2048 \
     -validity 10000
   ```

3. **检查 gradle.properties**:
   ```properties
   # android/gradle.properties
   MYAPP_RELEASE_STORE_FILE=my-release-key.keystore
   MYAPP_RELEASE_KEY_ALIAS=my-key-alias
   MYAPP_RELEASE_STORE_PASSWORD=<your-password>
   MYAPP_RELEASE_KEY_PASSWORD=<your-password>
   ```

4. **检查 build.gradle**:
   ```gradle
   // android/app/build.gradle
   android {
       signingConfigs {
           release {
               storeFile file(MYAPP_RELEASE_STORE_FILE)
               storePassword MYAPP_RELEASE_STORE_PASSWORD
               keyAlias MYAPP_RELEASE_KEY_ALIAS
               keyPassword MYAPP_RELEASE_KEY_PASSWORD
           }
       }
   }
   ```

---

## 4. 状态存储问题排查

### 4.1 设置未持久化

**症状**: 修改设置后重启应用,设置恢复默认值

**排查步骤**:

1. **检查 Zustand Persist 配置**:
   ```typescript
   // src/store/useSettingsStore.ts
   export const useSettingsStore = create<SettingsState>()(
     persist(
       (set, get) => ({
         // ...
       }),
       {
         name: 'settings-storage',  // ← 确保有唯一名称
         storage: createJSONStorage(() => AsyncStorage)  // ← 使用 AsyncStorage
       }
     )
   );
   ```

2. **手动检查 AsyncStorage**:
   ```javascript
   import AsyncStorage from '@react-native-async-storage/async-storage';

   // 查看存储的键
   AsyncStorage.getAllKeys().then(console.log);

   // 查看具体值
   AsyncStorage.getItem('settings-storage').then(console.log);
   ```

3. **清除损坏的存储**:
   ```javascript
   // 如果数据损坏,手动清除
   await AsyncStorage.removeItem('settings-storage');
   // 然后重启应用,会使用默认值
   ```

### 4.2 FileMetadata 丢失

**症状**: 文件同步状态显示异常,ETag 丢失

**排查步骤**:

1. **检查 Store Hydration**:
   ```typescript
   // App.tsx
   const hasHydrated = useFileMetadataStore(state => state.hasHydrated);

   if (!hasHydrated) {
     return <LoadingScreen />;  // ← 确保 Hydrate 完成后才渲染主界面
   }
   ```

2. **手动查看元数据**:
   ```javascript
   const allMetadata = useFileMetadataStore.getState().metadata;
   console.log(allMetadata);  // 查看所有文件的元数据
   ```

3. **重建元数据**:
   ```javascript
   // 紧急修复:遍历所有文件重新获取元数据
   async function rebuildMetadata() {
     const files = await cloudService.listFiles('');

     for (const file of files) {
       const metadata = await cloudService.headFile(file.path);
       fileMetadataStore.setMetadata(file.path, {
         etag: metadata.etag,
         lastModified: metadata.lastModified,
         syncedHash: null,  // 初始同步需要重新计算
         uploadState: null
       });
     }
   }
   ```

---

## 5. 性能问题排查

### 5.1 应用启动缓慢

**症状**: 从点击图标到显示界面超过 5 秒

**排查步骤**:

1. **添加性能日志**:
   ```javascript
   // App.tsx
   console.time('App Init');

   useEffect(() => {
     console.timeEnd('App Init');  // 查看初始化耗时
   }, []);

   // i18n.ts
   console.time('i18n Init');
   i18next.init({...}).then(() => {
     console.timeEnd('i18n Init');
   });
   ```

2. **分析耗时操作**:
   - 国际化加载 (`i18n.init`) - 预期 < 100ms
   - Zustand Hydrate - 预期 < 200ms
   - 云服务初始化 - 预期 < 50ms (不涉及网络)

3. **优化策略**:
   - **延迟加载**: 非关键模块延迟初始化
   - **代码分割**: 使用 `React.lazy` 和 `Suspense`
   - **减少同步操作**: 启动时避免大量文件读取

### 5.2 列表滚动卡顿

**症状**: FlashScreen/TodoScreen 滚动时掉帧

**排查步骤**:

1. **启用性能监视器**:
   ```bash
   npx expo start
   # 在应用中摇晃设备 → 开发菜单 → Show Perf Monitor
   ```

2. **检查列表实现**:
   ```javascript
   // ❌ 低效实现
   <ScrollView>
     {notes.map(note => <NoteItem key={note.id} note={note} />)}
   </ScrollView>

   // ✅ 高效实现
   <FlatList
     data={notes}
     renderItem={({ item }) => <NoteItem note={item} />}
     keyExtractor={item => item.id}
     removeClippedSubviews={true}  // ← 启用视图回收
     maxToRenderPerBatch={10}      // ← 限制单次渲染数量
   />
   ```

3. **优化 NoteItem 组件**:
   ```javascript
   // 使用 React.memo 避免不必要的重渲染
   const NoteItem = React.memo(({ note }) => {
     return <View>...</View>;
   });
   ```

### 5.3 内存占用过高

**症状**: 应用在后台被系统杀死，或长时间使用后变慢

**排查步骤**:

1. **检查内存泄漏**:
   - 使用 React DevTools Profiler
   - 检查是否有未清理的 `useEffect` 监听器

2. **常见泄漏点**:
   ```javascript
   // ❌ 忘记清理监听器
   useEffect(() => {
     DeviceEventEmitter.addListener('event', handler);
     // 缺少 return cleanup
   }, []);

   // ✅ 正确清理
   useEffect(() => {
     const listener = DeviceEventEmitter.addListener('event', handler);
     return () => listener.remove();  // ← 清理监听器
   }, []);
   ```

3. **释放大文件缓存**:
   ```javascript
   // 在 useFileListStore 中添加清理方法
   clearCache: () => set({ fileList: [], lastFetch: null })

   // 在应用进入后台时清理
   AppState.addEventListener('change', (nextAppState) => {
     if (nextAppState === 'background') {
       useFileListStore.getState().clearCache();
     }
   });
   ```

---

## 6. 网络问题排查

### 6.1 云服务请求超时

**症状**: 上传/下载操作长时间无响应,最后超时失败

**排查步骤**:

1. **检查网络连接**:
   ```javascript
   import NetInfo from '@react-native-community/netinfo';

   NetInfo.fetch().then(state => {
     console.log('Connection type', state.type);
     console.log('Is connected?', state.isConnected);
     console.log('Is internet reachable?', state.isInternetReachable);
   });
   ```

2. **测试云服务连通性**:
   ```javascript
   // 简单的 Ping 测试
   async function testCloudConnectivity() {
     try {
       const startTime = Date.now();
       await cloudService.listFiles('');  // 列表操作最轻量
       const latency = Date.now() - startTime;
       console.log(`Cloud service latency: ${latency}ms`);
       return latency < 5000;  // 5秒内响应视为正常
     } catch (error) {
       console.error('Cloud service unreachable:', error);
       return false;
     }
   }
   ```

3. **调整超时配置**:
   ```typescript
   // src/services/TencentCOSProvider.ts
   const cos = new COS({
     SecretId: secretId,
     SecretKey: secretKey,
     Timeout: 60000,  // ← 默认 60 秒,可根据网络情况调整
   });
   ```

### 6.2 WebDAV 连接失败

**症状**: 配置 WebDAV 后无法连接（如坚果云）

**排查步骤**:

1. **检查 URL 格式**:
   ```
   ✅ 正确: https://dav.jianguoyun.com/dav/
   ❌ 错误: http://dav.jianguoyun.com (缺少 https)
   ❌ 错误: https://dav.jianguoyun.com (缺少 /dav/ 路径)
   ```

2. **验证凭证**:
   - 坚果云需使用"应用密码",而非登录密码
   - 在坚果云网页端: 账户信息 → 安全选项 → 第三方应用管理 → 添加应用密码

3. **测试连接**:
   ```javascript
   // src/services/WebDAVProvider.ts
   async function testConnection(): Promise<boolean> {
     try {
       const response = await axios({
         method: 'PROPFIND',
         url: this.serverUrl,
         auth: { username: this.username, password: this.password },
         headers: { 'Depth': '0' }
       });
       return response.status === 207;  // WebDAV 成功响应
     } catch (error) {
       console.error('WebDAV connection failed:', error.response?.status);
       return false;
     }
   }
   ```

4. **常见错误码**:

| HTTP 状态码 | 含义 | 解决方案 |
|-----------|------|---------|
| 401 | 未授权 | 检查用户名/密码或应用密码 |
| 403 | 禁止访问 | 检查路径权限 |
| 404 | 路径不存在 | 检查 serverUrl 是否包含正确路径 |
| 500 | 服务器错误 | 检查 WebDAV 服务是否正常运行 |

---

## 7. 日志收集与错误报告

### 7.1 开启详细日志

**开发环境**:
```javascript
// App.tsx
if (__DEV__) {
  // 启用详细日志
  LogBox.ignoreAllLogs(false);

  // 拦截所有云服务调用
  const originalUpload = cloudService.uploadFile;
  cloudService.uploadFile = async (...args) => {
    console.log('[CloudService] Upload:', args[0]);
    try {
      const result = await originalUpload.apply(cloudService, args);
      console.log('[CloudService] Upload success:', result);
      return result;
    } catch (error) {
      console.error('[CloudService] Upload failed:', error);
      throw error;
    }
  };
}
```

**生产环境**: 集成 Sentry 或 Bugsnag
```javascript
import * as Sentry from '@sentry/react-native';

Sentry.init({
  dsn: 'your-sentry-dsn',
  enableInExpoDevelopment: false,
});

// 捕获云服务错误
try {
  await cloudService.uploadFile(path);
} catch (error) {
  Sentry.captureException(error, {
    tags: { operation: 'upload', path },
  });
  throw error;
}
```

### 7.2 导出诊断信息

**提供用户报告功能**:
```javascript
// src/utils/diagnostics.ts
export async function generateDiagnosticReport(): Promise<string> {
  const report = {
    timestamp: new Date().toISOString(),
    appVersion: Constants.manifest?.version,
    platform: Platform.OS,
    settings: useSettingsStore.getState(),
    syncQueue: useSyncStore.getState().queue,
    fileMetadata: useFileMetadataStore.getState().metadata,
    netInfo: await NetInfo.fetch(),
  };

  return JSON.stringify(report, null, 2);
}

// 在设置页添加"导出诊断信息"按钮
async function handleExportDiagnostics() {
  const report = await generateDiagnosticReport();
  await Share.share({ message: report });
}
```

---

## 8. 常见错误代码速查表

| 错误代码 | 位置 | 含义 | 解决方案 |
|---------|------|------|---------|
| `SYNC_001` | FlashNoteService | 闪念文件不存在 | 自动创建空文件 |
| `SYNC_002` | SyncService | 乐观锁冲突 | 触发智能合并 |
| `SYNC_003` | SyncService | 智能合并失败 | 用户手动解决冲突 |
| `CLOUD_001` | CloudService | 未配置云服务 | 引导用户配置 |
| `CLOUD_002` | CloudService | 凭证无效 | 重新输入 SecretKey |
| `CLOUD_003` | TencentCOSProvider | Bucket 不存在 | 检查 Bucket 名称 |
| `CLOUD_004` | WebDAVProvider | WebDAV 连接失败 | 检查 URL 和凭证 |
| `FS_001` | FileSystemService | 文件读取失败 | 检查文件权限 |
| `FS_002` | FileSystemService | 文件写入失败 | 检查存储空间 |
| `EDITOR_001` | EditorScreen | WebView 加载失败 | 检查 bundle.js 是否存在 |
| `EDITOR_002` | EditorScreen | 消息通信失败 | 检查 postMessage 格式 |

**使用示例**:
```javascript
throw new Error('[CLOUD_002] Invalid credentials: Please check your SecretId and SecretKey');
```

在日志或错误报告中搜索错误代码，快速定位问题。
