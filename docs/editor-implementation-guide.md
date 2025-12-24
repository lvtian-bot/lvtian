# MDNote 编辑器实现指南
该文档详细介绍了 MDNote 中 Markdown 编辑器的技术实现，它利用了 **CodeMirror 6** 并嵌入到 React Native 的 **WebView** 中。

## 1. 架构概述
编辑器采用分层架构构建：

1.  **React Native 层 (`src/screens/EditorScreen.tsx`)**:
    *   管理屏幕 UI（标题栏、返回/保存按钮）。
    *   托管 `<WebView>` 组件。
    *   处理文件 I/O（读写本地文件）。
    *   通过 `postMessage` (发送内容) 和 `onMessage` (接收自动保存/日志) 与 WebView 通信。

2.  **WebView 层 (`android/app/src/main/assets/editor_cm6.html`)**:
    *   WebView 加载的宿主 HTML 文件。
    *   加载打包后的编辑器脚本 (`codemirror.bundle.js`)。
    *   初始化 CodeMirror 编辑器实例。
    *   定义 **关键 CSS 覆盖** 用于样式（字体、边距、行高）。
    *   搭建 CodeMirror 事件与 React Native 之间的通信桥梁。

3.  **编辑器核心层 (`editor-bundler/entry.js` -> `codemirror.bundle.js`)**:
    *   使用 **CodeMirror 6** (ES Modules) 构建。
    *   使用 **Rollup** 打包成单个 IIFE 文件 (`codemirror.bundle.js`)，用于离线 WebView 兼容性。
    *   包含自定义插件用于 Front Matter 检测和语法高亮。

## 2. 构建系统
由于 CodeMirror 6 是模块化的，并且以 ES Modules 形式发布，因此无法在本地 WebView 中直接通过 `<script>` 标签加载。我们使用专门的构建步骤。

### 目录结构
*   `editor-bundler/`: 包含构建配置和源代码。
    *   `package.json`: 依赖项 (`@codemirror/view`, `@codemirror/state`, `@codemirror/lang-markdown` 等)。
    *   `rollup.config.mjs`: Rollup 配置，将所有内容打包到 `../android/app/src/main/assets/codemirror.bundle.js`。
    *   `entry.js`: 入口点，将 `createEditor` API 导出为全局变量。

### 构建命令
在修改 `entry.js` 后重建编辑器 bundle：
```bash
cd editor-bundler
npm install # 仅首次需要
npm run build
```

**注意：** 重建 bundle 或修改 HTML 后，必须重新编译 Android 应用 (`npm run android`) 以更新 APK 中的资源。JS 热重载是不够的。

## 3. 核心实现细节

### 3.1. CodeMirror 配置 (`entry.js`)
我们手动构建了一个轻量级配置 (`mySetup`)，而不是使用 `basic-setup`，以便进行细粒度控制（例如，移除行号）。

```javascript
const mySetup = [
  highlightSpecialChars(),
  history(),
  drawSelection(),
  dropCursor(),
  EditorState.allowMultipleSelections.of(true),
  syntaxHighlighting(customHighlightStyle), // 使用我们的自定义样式
  syntaxHighlighting(defaultHighlightStyle),
  bracketMatching(),
  keymap.of([...defaultKeymap, ...historyKeymap])
]
```

### 3.2. Front Matter 处理
CodeMirror 的默认 Markdown 解析器将 YAML Front Matter (`---`) 视为 Setext Heading 2。为了修复这个问题，我们在 `entry.js` 中实现了一个自定义 **ViewPlugin** (`frontMatterPlugin`)。

*   **检测**: 使用正则表达式 `/^(?:---\s*[\r\n]+)([\s\S]*?)(?:[\r\n]+---\s*[\r\n]+|$)/` 查找区块。
*   **装饰**:
    *   遍历区块中的行并应用行装饰器: `.cm-frontmatter-line`。
    *   将标记装饰器应用于 `---` 分隔符: `.cm-frontmatter-delimiter`。
*   **排序**: 至关重要的是，在创建 Decoration 集合之前，必须按位置对小部件进行排序，以防止崩溃。

### 3.3. 自定义高亮样式
我们使用 `HighlightStyle.define` 明确将 Markdown 标签映射到 CSS 类。这确保了我们可以在 CSS 中可靠地定位标题。

```javascript
const customHighlightStyle = HighlightStyle.define([
  { tag: tags.heading1, class: "cm-header-1" },
  { tag: tags.heading2, class: "cm-header-2" },
  // ...
])
```

## 4. 样式定制 (`editor_cm6.html`)
样式主要通过 HTML 文件中的 CSS 注入来处理。我们使用 `!important` 和特定选择器来覆盖 CodeMirror 的默认主题。

### 关键样式策略:

1.  **全局行高**:
    *   `.cm-line { line-height: 1.5 !important; }` 设置基础文本间距。

2.  **标题**:
    *   通过 `span.cm-header-X` 定位。
    *   `line-height: 2 !important` 为标题提供呼吸空间。
    *   `border-bottom: none` 移除默认下划线样式。
    *   字体大小是显式设置的 (例如，H1 = 24px, H2 = 20px)。

3.  **Front Matter "过度" (修复)**:
    *   为了强制 Front Matter（解析器认为是标题）看起来像元数据，我们使用了一个高特异性的选择器:
    ```css
    .cm-content .cm-frontmatter-line,
    .cm-content .cm-frontmatter-line *,
    .cm-content .cm-frontmatter-line span {
        font-size: 14px !important;
        font-weight: normal !important;
        color: #888 !important;
        /* ... */
    }
    ```
    这会覆盖 Front Matter 区块内文本上应用的任何语法高亮 (如 `.cm-header-2`)。

4.  **内边距**:
    *   `.cm-content { padding: 12px !important; }` 在文本周围添加一个 gutter。

## 5. 故障排除

*   **"Unrecognized extension value" 错误**: 由多个 `@codemirror/state` 实例引起。通过使用 Rollup 将所有内容打包到单个文件中解决。
*   **"CodeMirror plugin crashed"**: 由 `ViewPlugin` 中的小部件排序不正确或对字符串内容访问行属性引起。通过修复循环逻辑和排序小部件解决。
*   **样式不更新**: Android `assets` 被打包到 APK 中。**始终运行 `npm run android`** 在修改 `editor_cm6.html` 或 `codemirror.bundle.js` 之后。JS 热重载是不够的。
*   **Front Matter 仍然看起来像标题**: CSS 特异性问题。确保 Front Matter CSS 选择器比标题选择器更具特异性 (使用父类 + `!important`)。

## 6. 未来改进 (TODO)

*   **自动保存草稿**: 当前，自动保存会覆盖文件。实现草稿机制 (保存到 `.draft` 文件) 将允许 "放弃更改"。
*   **动态主题**: 从 React Native (`markdownThemes.ts`) 注入主题 CSS，而不是在 HTML 中硬编码样式。
*   **图片处理**: 在 CodeMirror 中实现处理图片上传/粘贴的桥梁。
