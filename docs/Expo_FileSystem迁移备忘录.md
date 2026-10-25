# Expo_FileSystem 迁移备忘录

> 本文档规范项目内部 `expo-file-system` API 的混用规则、Scoped Storage 适配底线及统一迁移路径。

---

## 1. 核心现状与原则

1. **唯一 IO 入口铁律**：应用内所有文件读写、创建、删除、目录枚举操作，**严禁直接调用第三方库（如 react-native-fs）或在 UI 组件中随意调用文件 API**，必须统一通过 `src/services/FileSystemService.ts` 进行下沉封装。
2. **新老 API 混用状态**：
   - Expo SDK 演进过程中，`expo-file-system` 推出了基于现代化对象式的文件系统新 API（如 `File`, `Directory` 等），同时保留了经典的静态异步方法（如 `FileSystem.readAsStringAsync`, `FileSystem.writeAsStringAsync`, `FileSystem.getInfoAsync`）。
   - 当前应用处于混合过渡期。业务逻辑核心依赖成熟的静态异步方法，辅以部分新语法。
3. **安全防护规则**：
   - 禁止在未确认生产环境兼容性和单元测试覆盖的情况下，贸然重构 `FileSystemService.ts`。
   - 所有文件操作必须处理 Android Scoped Storage（分区存储）的沙盒路径限制，统一使用 `FileSystem.documentDirectory` 作为安全根路径。

---

## 2. 关键接口与实现对照

| 功能场景 | 现行稳定调用（FileSystemService 内部） | 新版 API 目标调用 | 注意事项 |
|---------|------------------------------------|-------------------|---------|
| 检查文件存在性 | `FileSystem.getInfoAsync(uri)` | `new File(uri).exists` | 需判断 `exists` 字段及 `isDirectory` |
| 读取文本内容 | `FileSystem.readAsStringAsync(uri, { encoding: UTF8 })` | `new File(uri).text()` | 必须保证 UTF-8 编码，防止中文乱码 |
| 写入文本内容 | `FileSystemService.writeFile()` 内部使用 `await file.write(content)` | `await new File(uri).write(content)` | SDK 58 的 `File.write()` 返回 Promise；必须等待写入完成才可报告成功或开始同步，异步失败由服务层捕获并向调用方抛出；写入前确保父级目录已递归建立 |
| 删除文件/目录 | `FileSystem.deleteAsync(uri, { idempotent: true })` | `new File(uri).delete()` | 开启幂等，文件不存在时不抛异常 |
| 递归创建目录 | `FileSystem.makeDirectoryAsync(uri, { intermediates: true })` | `new Directory(uri).create({ intermediates: true })` | 必须开启 `intermediates: true` |

---

## 3. 影子文件系统与特殊路径

- **影子副本存储**：位于 `${FileSystem.documentDirectory}.shadows/`，用于三路合并基准比对。
- **临时构建/下载路径**：位于 `${FileSystem.cacheDirectory}`，用于流式下载中转与图片预览缓存。
- **清理约束**：缓存目录允许随系统清理，但 `.shadows/` 与主文档目录严禁被随意清空。
