# React Native 新架构分享功能修复方案

## 问题概述

在 React Native 0.82.1 应用中，从其他应用分享内容到 MDNote 时，在热启动状态下首次分享功能失败，无法将分享内容传递到 JavaScript 层。

### 环境信息
- React Native 版本：0.82.1
- 新架构状态：已启用 (`newArchEnabled=true`)
- 测试设备：小米手机
- 问题场景：热启动状态下首次分享

## 问题演进过程

### 第一阶段：IllegalStateException 崩溃

**问题表现**：
```
java.lang.IllegalStateException: Cannot get ReactInstanceManager without a ReactNativeHost.
```

**原因分析**：
在 `MainActivity.kt` 中尝试直接访问 `reactInstanceManager`，但该 API 在 React Native 新架构中已被废弃。

**初步尝试的代码**：
```kotlin
val reactContext = reactInstanceManager?.currentReactContext
```

### 第二阶段：使用 reactNativeHost 仍然失败

**修改方案**：
```kotlin
val reactContext = reactNativeHost?.reactInstanceManager?.currentReactContext
```

**问题表现**：
```
Cannot access ReactInstanceManager: You should not use ReactNativeHost directly in the New Architecture
React context not available, caching share content
Retry share event, attempt 1-30
Failed to send share event after 30 attempts
```

**分析**：
- 代码不再崩溃，异常被正确捕获
- 但触发了新架构的警告
- ReactContext 在 3 秒（30 次重试）内始终无法获取
- 说明访问方式本身就是错误的

### 第三阶段：官方解决方案

**调研发现**：
1. React Native 0.82 是首个完全运行在新架构上的版本
2. `reactInstanceManager` API 已被官方废弃
3. React Native 团队在 [PR #47659](https://github.com/facebook/react-native/pull/47659) 中添加了新的迁移 API
4. 官方推荐使用 `getCurrentReactContext()` 方法

## 最终解决方案

### 代码修改

在 `MainActivity.kt` 中，将所有访问 ReactContext 的代码从：

```kotlin
// ❌ 错误方式 - 新架构中不支持
val reactContext = reactNativeHost?.reactInstanceManager?.currentReactContext
```

改为：

```kotlin
// ✅ 正确方式 - 新架构官方 API
val reactContext = reactActivityDelegate?.getCurrentReactContext()
```

### 修改位置

需要修改两处：

1. **sendEventToReactNative 方法**（第 88 行）
2. **retryShareEvent 方法**（第 123 行）

### 完整代码示例

```kotlin
private fun sendEventToReactNative(data: String) {
  try {
    // Use new architecture compatible method to get React context
    val reactContext = try {
      reactActivityDelegate?.getCurrentReactContext()
    } catch (e: Exception) {
      android.util.Log.w("MainActivity", "Cannot access ReactContext: ${e.message}")
      null
    }

    if (reactContext != null) {
      android.util.Log.d("MainActivity", "Sending share event to React Native")
      reactContext
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        ?.emit("onShareReceived", data)
    } else {
      android.util.Log.w("MainActivity", "React context not available, caching share content")
      // Cache the share content and retry
      pendingShareText = data
      retryShareEvent()
    }
  } catch (e: Exception) {
    android.util.Log.e("MainActivity", "Error sending share event", e)
    // Cache and retry even on error
    pendingShareText = data
    retryShareEvent()
  }
}

private fun retryShareEvent() {
  var attempts = 0
  val maxAttempts = 30 // Try for 3 seconds

  val retryRunnable = object : Runnable {
    override fun run() {
      attempts++

      // Use new architecture compatible method to get React context
      val reactContext = try {
        reactActivityDelegate?.getCurrentReactContext()
      } catch (e: Exception) {
        null
      }

      if (reactContext != null && pendingShareText != null) {
        android.util.Log.d("MainActivity", "React context ready after $attempts attempts, sending cached share event")
        try {
          reactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            ?.emit("onShareReceived", pendingShareText)
          pendingShareText = null // Clear after successful send
        } catch (e: Exception) {
          android.util.Log.e("MainActivity", "Error sending cached share event", e)
        }
      } else if (attempts < maxAttempts) {
        android.util.Log.d("MainActivity", "Retry share event, attempt $attempts")
        handler.postDelayed(this, 100) // Retry after 100ms
      } else {
        android.util.Log.e("MainActivity", "Failed to send share event after $maxAttempts attempts")
        pendingShareText = null // Clear after max attempts
      }
    }
  }

  handler.postDelayed(retryRunnable, 100)
}
```

## 技术要点总结

### React Native 新架构关键变化

1. **API 废弃**
   - ❌ `reactInstanceManager` - 完全废弃
   - ❌ `reactNativeHost.reactInstanceManager` - 不推荐使用
   - ✅ `reactActivityDelegate.getCurrentReactContext()` - 官方推荐

2. **时间线**
   - React Native 0.76+：添加 `getCurrentReactContext()` API
   - React Native 0.82：首个完全基于新架构的版本
   - 2024年11月：官方修复合并（Issue #47647, PR #47659）

3. **兼容性考虑**
   - 新架构强制使用新的 API
   - 旧的访问方式会触发警告或返回 null
   - 需要通过 `getCurrentReactContext()` 获取上下文

### 调试方法论

1. **日志分析**
   - 使用 `adb logcat MainActivity:D *:S` 查看原生日志
   - 区分 JavaScript 日志和 Android 原生日志
   - 注意警告信息中的关键提示

2. **网络调研**
   - 搜索 GitHub Issues 和 Discussions
   - 查阅官方文档和发布说明
   - Stack Overflow 社区经验

3. **渐进式修复**
   - 先修复崩溃问题（try-catch）
   - 再优化实现方式（正确 API）
   - 最后验证功能完整性

### 防御性编程实践

代码中实现了多层防护机制：

1. **Try-Catch 包裹**：捕获 API 调用异常
2. **Null 检查**：验证 ReactContext 是否可用
3. **重试机制**：Context 未就绪时自动重试
4. **超时保护**：最多重试 30 次（3 秒）
5. **重复检测**：1 秒内避免处理相同 Intent

## 参考资料

### 官方文档
- [React Native 0.82 Release Notes](https://reactnative.dev/blog/2025/10/08/react-native-0.82)
- [React Native New Architecture Guide](https://reactnative.dev/docs/the-new-architecture/landing-page)

### 社区资源
- [GitHub Issue #47647: Unable to get reactContext in MainActivity.kt](https://github.com/facebook/react-native/issues/47647)
- [GitHub PR #47659: Expose getCurrentReactContext on ReactDelegate](https://github.com/facebook/react-native/pull/47659)
- [GitHub Discussion #176: How to send data from MainActivity to React Native](https://github.com/reactwg/react-native-new-architecture/discussions/176)
- [Stack Overflow: Sending events in new architecture](https://stackoverflow.com/questions/79689576/how-to-send-event-from-mainactivity-to-react-native-in-new-architecture-bridgel)

## 经验教训

1. **及时更新知识**：React Native 新架构带来了重大 API 变化，需要及时学习官方文档
2. **遵循官方指引**：使用官方推荐的迁移路径，避免使用废弃 API
3. **重视警告信息**：日志中的警告往往指向问题的根本原因
4. **社区力量**：遇到问题时，GitHub Issues 和社区讨论是宝贵资源
5. **防御性编程**：在 React Native 桥接层实现健壮的错误处理和重试机制

## 验证测试

修复后的预期行为：

1. ✅ 热启动状态下首次分享成功
2. ✅ 无 `IllegalStateException` 错误
3. ✅ 无新架构警告信息
4. ✅ 应用自动切换到前台并打开 Timeline
5. ✅ 编辑 Modal 预填充分享内容

测试命令：
```bash
# 监控原生日志
adb logcat MainActivity:D *:S

# 编译安装
cd android && ./gradlew clean assembleDebug installDebug
```

---

**文档版本**：1.0
**创建日期**：2025-11-26
**最后更新**：2025-11-26
**作者**：Claude Code
**适用版本**：React Native 0.82.1+（新架构启用）
