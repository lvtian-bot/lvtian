
---

# 📘 产品需求与技术规格说明书 (PRD & Tech Spec)
**项目名称**: MD Notes (项目三)
**版本**: 4.0 (Final for Development)
**日期**: 2025年11月19日

---

## 1. 项目愿景 (Project Vision)
开发一款 **云端优先、本地加速** 的 Markdown 笔记应用。它不是 Obsidian 的简单复制品，而是一个轻量级、无状态但高可用的云端文件操作终端。
* **核心价值**: 任何设备，随时随地，直接读写云端笔记。
* **解决痛点**: 传统网盘不支持 MD 预览/编辑，本地笔记软件同步配置复杂。

---

## 2. 技术架构规格 (Technical Architecture)

### 2.1 开发环境约束 (Development Env)
开发人员必须在以下环境中构建项目，以确保兼容性：
* **操作系统**: Windows 10 / 11
* **命令行**: 必须兼容 **PowerShell** 和 **Git Bash** (脚本需提供双版本)。
* **Runtime**: Node.js (LTS v20+), JDK 17 (推荐)。
* **核心框架**: **React Native 0.82.1** (Bare Workflow)。
* **语言**: **TypeScript** 5.x (严格模式)。

### 2.2 目标平台 (Target Platforms)
* **Android**: API Level 24+ (Android 7.0+)。重点适配各种国产定制 ROM 的权限管理。
* **iOS**: iOS 15+ (虽然在 Windows 开发，但代码需保持跨平台兼容性，预留 iOS 适配接口)。

### 2.3 核心技术栈 (Tech Stack)

| 模块 | 技术选型 | 说明 |
| :--- | :--- | :--- |
| **导航路由** | React Navigation 6/7 | Native Stack + Bottom Tabs 组合。 |
| **状态管理** | React Context / Zustand | 轻量级管理，不使用 Redux。 |
| **本地存储** | `react-native-fs` | 处理文件读写、重命名、移动。 |
| **持久化** | `AsyncStorage` | 存储设置、Token、上传队列。 |
| **云端连接** | **Strategy Pattern (策略模式)** | 封装统一 `ICloudProvider` 接口。 |
| **云端实现** | `react-native-cos-sdk` (腾讯云) | V1.0 核心实现。 |
| **云端预留** | WebDAV / OSS / G-Drive | 架构预留，V1.0 仅做接口存根 (Stub)。 |
| **Markdown渲染** | `react-native-markdown-display` | 高性能原生渲染 (查看模式)。 |
| **代码/文本编辑** | `react-native-webview` | 加载 CodeMirror/EasyMDE (编辑模式)。 |
| **UI 组件** | `@gorhom/bottom-sheet` | 闪念笔记的弹窗交互。 |

---

## 3. 核心业务逻辑 (Core Logic)

### 3.1 同步机制：带缓存的乐观 UI
* **读取逻辑**: 本地缓存优先 (Cache First)。
    * 打开文件 -> 立即渲染本地缓存 -> 后台 `HEAD` 对比云端 -> 若云端更新 -> 顶部提示。
* **写入逻辑**: 写时复制 (Copy on Write)。
    * 保存 -> 写入本地文件 -> 加入 `UploadQueue` -> 后台静默上传 -> 成功移除队列 / 失败保留重试。

### 3.2 冲突解决：扁平化备份
* **原则**: 永不覆盖用户的未同步数据。
* **策略**: 当检测到云端版本更新时，用户选择“另存为副本”，系统将本地文件重命名为 `Filename_old_timestamp.md` 并保存在**当前目录**，然后触发上传。

### 3.3 闪念笔记 (Flash Note)
* **原子事务**: 下载目标文件 -> 解析内容 -> 内存追加 -> 上传覆盖。
* **离线兼容**: 若网络不可用，先保存在本地临时队列，网络恢复后自动执行追加逻辑。

---

## 4. 详细功能需求 (Functional Specs)

### 4.1 页面一：闪念 (Timeline)
* **UI**: 时间轴卡片流 (FlatList)。
* **FAB**: 右下角悬浮按钮，点击唤起 BottomSheet。
* **Input**: 原生 `TextInput`，支持多行，自动弹起键盘。

### 4.2 页面二：浏览 (Browser)
* **Header**: 动态任务栏。
    * 显示上传队列状态（同步中 / 待重试）。
* **List**: 混合数据源列表。
    * 显示 `Cloud Files` U `Local Pending Files`。
    * 图标区分：文件夹、MD 文档、图片、**未同步文件(橙色)**。
* **Viewer**: 全屏 Markdown 渲染。
    * 支持双击编辑 (可选) 或 右上角编辑按钮。
* **Editor**: WebView 编辑器。
    * 加载本地 `assets/editor.html`。
    * 支持基础 Markdown 语法高亮。

### 4.3 页面三：我的 (Settings)
* **云配置**: 腾讯云 COS 表单 (SecretId/Key/Bucket/Region)。
* **路径配置**: 闪念笔记目标路径设置。
* **工具**: 清除缓存、重置上传队列。

---

## 5. 安全与隐私规格 (Security Specs)

### 5.1 密钥存储
* **强制要求**: SecretId 和 SecretKey **严禁**明文存储在 `AsyncStorage` 或代码中。
* **实现**: 必须使用 `expo-secure-store` 或 `react-native-keychain` 进行加密存储。

### 5.2 网络安全
* 所有云端请求强制使用 **HTTPS**。
* 不收集任何用户笔记内容上传至第三方统计平台。

---

## 6. 交付标准与验收 (Deliverables)

### 6.1 代码交付
* Git 仓库结构清晰，包含 `README.md` 说明配置步骤。
* **关键**: 提供 `setup_project.ps1` (PowerShell) 和 `setup_project.sh` (Bash) 两个版本的初始化脚本。

### 6.2 验收测试用例 (QA Checklist)
1.  **冷启动**: 首次配置 COS 后，能正确列出文件。
2.  **弱网测试**: 开启飞行模式编辑文件，保存后恢复网络，文件能自动上传。
3.  **冲突测试**:
    * 设备 A 修改文件并上传。
    * 设备 B 打开旧版缓存，提示“有新版本”。
    * 设备 B 选择“另存副本”，云端出现两个文件。
4.  **闪念测试**: 连续快速发送 3 条闪念，云端文件内容完整，无覆盖丢失。

---

## 7. 开发路线图 (Roadmap)

* **Phase 1 (基础架构)**: 项目初始化，集成 RN 0.82，完成 COS 连接与基础文件列表展示。
* **Phase 2 (核心读写)**: 实现文件下载、本地缓存、Markdown 渲染、WebView 编辑器。
* **Phase 3 (同步大脑)**: 实现 `UploadQueue` (上传队列) 和冲突检测/重命名逻辑。
* **Phase 4 (闪念 & 优化)**: 实现闪念解析与录入，UI 细节打磨，发布 V1.0。

---
