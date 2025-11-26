# MDNote Editor Implementation Guide

This document details the technical implementation of the Markdown editor in MDNote, which utilizes **CodeMirror 6** embedded within a React Native **WebView**.

## 1. Architecture Overview

The editor is built using a layered architecture:

1.  **React Native Layer (`src/screens/EditorScreen.tsx`)**:
    *   Manages the screen UI (Header, Back/Save buttons).
    *   Hosts the `<WebView>`.
    *   Handles file I/O (reading/writing local files).
    *   Communicates with the WebView via `postMessage` (sending content) and `onMessage` (receiving auto-save/logs).

2.  **WebView Layer (`android/app/src/main/assets/editor_cm6.html`)**:
    *   The host HTML file loaded by the WebView.
    *   Loads the bundled editor script (`codemirror.bundle.js`).
    *   Initializes the CodeMirror editor instance.
    *   Defines **critical CSS overrides** for styling (fonts, margins, line-heights).
    *   Bridges the communication between CodeMirror events and React Native.

3.  **Editor Core Layer (`editor-bundler/entry.js` -> `codemirror.bundle.js`)**:
    *   Built with **CodeMirror 6** (ES Modules).
    *   Bundled using **Rollup** into a single IIFE file (`codemirror.bundle.js`) for offline WebView compatibility.
    *   Contains custom plugins for Front Matter detection and syntax highlighting.

## 2. Build System

Since CodeMirror 6 is modular and distributed as ES Modules, it cannot be directly loaded via `<script>` tags in a local WebView. We use a dedicated build step.

### Directory Structure
*   `editor-bundler/`: Contains the build configuration and source code.
    *   `package.json`: Dependencies (`@codemirror/view`, `@codemirror/state`, `@codemirror/lang-markdown`, etc.).
    *   `rollup.config.mjs`: Rollup config to bundle everything into `../android/app/src/main/assets/codemirror.bundle.js`.
    *   `entry.js`: The entry point that exports the `createEditor` API globally.

### Build Command
To rebuild the editor bundle after modifying `entry.js`:
```bash
cd editor-bundler
npm install # First time only
npm run build
```

**Note:** After rebuilding the bundle or modifying the HTML, you must recompile the Android app (`npm run android`) to update the assets in the APK. 

## 3. Core Implementation Details

### 3.1. CodeMirror Setup (`entry.js`)
We manually construct a lightweight setup (`mySetup`) instead of using `basic-setup` to have fine-grained control (e.g., removing line numbers).

```javascript
const mySetup = [
  highlightSpecialChars(),
  history(),
  drawSelection(),
  dropCursor(),
  EditorState.allowMultipleSelections.of(true),
  syntaxHighlighting(customHighlightStyle), // Use our custom style
  syntaxHighlighting(defaultHighlightStyle),
  bracketMatching(),
  keymap.of([...defaultKeymap, ...historyKeymap])
]
```

### 3.2. Front Matter Handling
CodeMirror's default Markdown parser treats YAML Front Matter (`---`) as a Setext Heading 2. To fix this, we implemented a custom **ViewPlugin** (`frontMatterPlugin`) in `entry.js`.

*   **Detection**: Uses Regex `/^(?:---\s*[\r\n]+)([\s\S]*?)(?:[\r\n]+---\s*[\r\n]+|$)/` to find the block.
*   **Decoration**:
    *   Iterates through lines in the block and applies a line decoration: `.cm-frontmatter-line`.
    *   Applies mark decorations to the `---` delimiters: `.cm-frontmatter-delimiter`.
*   **Sorting**: Crucially, widgets are sorted by position before creating the Decoration set to prevent crashes.

### 3.3. Custom Highlight Style
We use `HighlightStyle.define` to explicitly map Markdown tags to CSS classes. This ensures we can target headers reliably in CSS.

```javascript
const customHighlightStyle = HighlightStyle.define([
  { tag: tags.heading1, class: "cm-header-1" },
  { tag: tags.heading2, class: "cm-header-2" },
  // ...
])
```

## 4. Styling Customization (`editor_cm6.html`)

Styling is primarily handled via CSS injection in the HTML file. We use `!important` and specific selectors to override CodeMirror's default theme.

### Key Styling Strategies:

1.  **Global Line Height**:
    *   `.cm-line { line-height: 1.5 !important; }` sets the base text spacing.

2.  **Headers**:
    *   Targeted via `span.cm-header-X`.
    *   `line-height: 2 !important` gives headers breathing room.
    *   `border-bottom: none` removes the default underline style.
    *   Font sizes are set explicitly (e.g., H1 = 24px, H2 = 20px).

3.  **Front Matter "Overkill" (The Fix)**:
    *   To force the Front Matter (which the parser thinks is a Header) to look like metadata, we use a high-specificity selector:
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
    This overrides any syntax highlighting (like `.cm-header-2`) applied to the text within the Front Matter block.

4.  **Padding**:
    *   `.cm-content { padding: 12px !important; }` adds a gutter around the text.

## 5. Troubleshooting

*   **"Unrecognized extension value" Error**: Caused by multiple instances of `@codemirror/state`. Solved by bundling everything with Rollup into a single file.
*   **"CodeMirror plugin crashed"**: Caused by incorrect widget sorting in `ViewPlugin` or accessing line properties on string content. Solved by fixing the loop logic and sorting widgets.
*   **Styles not updating**: Android `assets` are packaged into the APK. **Always run `npm run android`** after modifying `editor_cm6.html` or `codemirror.bundle.js`. JS reloading is not enough.
*   **Front Matter still looks like a Header**: CSS specificity issue. Ensure the Front Matter CSS selector is more specific than the Header selector (use parent classes + `!important`).

## 6. Future Improvements (TODO)

*   **Auto-save Drafts**: Currently, auto-save overwrites the file. Implementing a draft mechanism (save to `.draft` file) would allow "Discard Changes".
*   **Dynamic Theme**: Injecting theme CSS from React Native (`markdownThemes.ts`) instead of hardcoding styles in HTML.
*   **Image Handling**: Implementing a bridge to handle image uploads/pasting within CodeMirror.
