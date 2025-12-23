import { EditorView, keymap, highlightSpecialChars, drawSelection, dropCursor } from "@codemirror/view"
import { EditorState, Compartment } from "@codemirror/state"
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands"
import { markdown, markdownLanguage } from "@codemirror/lang-markdown"
import { languages } from "@codemirror/language-data"
import { oneDark } from "@codemirror/theme-one-dark"
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching, HighlightStyle } from "@codemirror/language"
import { yaml } from "@codemirror/lang-yaml"
import { Decoration, ViewPlugin } from "@codemirror/view"
import { tags } from "@lezer/highlight"

// 自定义高亮样式，明确指定标题的类名
const customHighlightStyle = HighlightStyle.define([
  { tag: tags.heading1, class: "cm-header-1" },
  { tag: tags.heading2, class: "cm-header-2" },
  { tag: tags.heading3, class: "cm-header-3" },
  { tag: tags.heading4, class: "cm-header-4" },
  { tag: tags.heading5, class: "cm-header-5" },
  { tag: tags.heading6, class: "cm-header-6" },
  { tag: tags.strong, class: "cm-strong" },
  { tag: tags.emphasis, class: "cm-em" },
  { tag: tags.monospace, class: "cm-code" },
  { tag: tags.link, class: "cm-link" }
])

// 手动构建一个类似于 basicSetup 但更轻量的 setup
const mySetup = [
  // lineNumbers(), // 移除行号
  highlightSpecialChars(),
  history(),
  drawSelection(),
  dropCursor(),
  EditorState.allowMultipleSelections.of(true),
  // 使用自定义高亮样式，并回退到默认样式以覆盖未定义的 tag
  syntaxHighlighting(customHighlightStyle),
  syntaxHighlighting(defaultHighlightStyle),
  bracketMatching(),
  keymap.of([
    ...defaultKeymap,
    ...historyKeymap,
  ])
]

// 用于动态切换主题
const themeCompartment = new Compartment()
// 用于动态切换只读状态
const readOnlyCompartment = new Compartment()

// 自定义 Front Matter 检测插件
const frontMatterPlugin = ViewPlugin.fromClass(class {
  constructor(view) {
    this.decorations = this.buildDecorations(view)
  }

  update(update) {
    if (update.docChanged || update.viewportChanged || update.selectionSet) {
      this.decorations = this.buildDecorations(update.view)
    }
  }

  buildDecorations(view) {
    const widgets = []
    const doc = view.state.doc
    const docText = doc.toString()
    
    console.log("[FrontMatterPlugin] - Checking for Front Matter...");
    console.log("[FrontMatterPlugin] - Doc text start:", docText.substring(0, 50).replace(/\n/g, "\\n").replace(/\r/g, "\\r"));

    const frontMatterRegex = /^(?:---\s*[\r\n]+)([\s\S]*?)(?:[\r\n]+---\s*[\r\n]+|$)/;
    const match = docText.match(frontMatterRegex);

    if (match) {
      console.log("[FrontMatterPlugin] - Match found!");
      console.log("[FrontMatterPlugin] - Full match:", match[0].replace(/\n/g, "\\n").replace(/\r/g, "\\r"));
      console.log("[FrontMatterPlugin] - Metadata content:", match[1].replace(/\n/g, "\\n").replace(/\r/g, "\\r"));

      const from = 0;
      const to = match[0].length; // 整个 front matter 块的结束位置

      // 遍历 Front Matter 范围内的每一行，添加行样式
      for (let pos = from; pos < to;) {
        const line = doc.lineAt(pos);
        widgets.push(Decoration.line({
            attributes: { class: "cm-frontmatter-line" }
        }).range(line.from));
        pos = line.to + 1; // 移动到下一行
      }

      // 进一步装饰 --- 分隔符
      // 第一个 ---
      const firstDelimiterEnd = docText.indexOf('\n', 0);
      if (firstDelimiterEnd !== -1) {
        widgets.push(Decoration.mark({ class: "cm-frontmatter-delimiter" }).range(from, Math.min(3, firstDelimiterEnd))); // 只高亮 '---' 本身
      }

      // 第二个 ---
      const secondDelimiterStart = docText.indexOf('\n---', firstDelimiterEnd + 1);
      if (secondDelimiterStart !== -1) {
        widgets.push(Decoration.mark({ class: "cm-frontmatter-delimiter" }).range(secondDelimiterStart + 1, secondDelimiterStart + 4)); // 只高亮 '---' 本身
      }
      
      // 重要：CodeMirror 要求 Decoration 必须按位置排序
      widgets.sort((a, b) => a.from - b.from || a.to - b.to);
      
      console.log("[FrontMatterPlugin] - Decorations pushed:", widgets.length);
    } else {
      console.log("[FrontMatterPlugin] - No Front Matter match.");
    }
    return Decoration.set(widgets)
  }
}, {
  decorations: v => v.decorations
})

// 暴露给全局的 API
export function createEditor(parentElement, initialContent, options = {}) {
  const {
    darkMode = false,
    readOnly = false,
    onUpdate = () => {}
  } = options

  // 准备 extensions
  const extensions = [
    mySetup,
    // 启用 Markdown，并支持 GitHub Flavored Markdown (GFM)
    // codeLanguages: languages 允许代码块高亮 (```js)
    markdown({
        base: markdownLanguage,
        codeLanguages: languages,
        addKeymap: true,
        extensions: [yaml()] // 尝试将 YAML 作为 Markdown 的一个扩展
    }),
    frontMatterPlugin, // <-- 添加自定义的 Front Matter 插件
    // 监听内容变化
    EditorView.updateListener.of((v) => {
      if (v.docChanged) {
        onUpdate(v.state.doc.toString())
      }
    }),
    // 主题控制
    themeCompartment.of(darkMode ? oneDark : []),
    // 只读控制
    readOnlyCompartment.of(EditorState.readOnly.of(readOnly)),
    // 自动换行
    EditorView.lineWrapping
  ]

  // 创建编辑器实例
  const view = new EditorView({
    state: EditorState.create({
      doc: initialContent,
      extensions: extensions
    }),
    parent: parentElement
  })

  // 返回控制对象
  return {
    view,
    // 设置内容
    setContent: (newContent) => {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: newContent }
      })
    },
    // 获取内容
    getContent: () => {
      return view.state.doc.toString()
    },
    // 切换主题
    setTheme: (isDark) => {
      view.dispatch({
        effects: themeCompartment.reconfigure(isDark ? oneDark : [])
      })
    },
    // 切换只读
    setReadOnly: (isReadOnly) => {
      view.dispatch({
        effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(isReadOnly))
      })
    },
    // 销毁
    destroy: () => {
      view.destroy()
    }
  }
}
