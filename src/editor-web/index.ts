/// <reference lib="dom" />
import { EditorView, keymap, highlightSpecialChars, drawSelection, dropCursor, placeholder } from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { defaultKeymap, history, historyKeymap, undo, redo } from '@codemirror/commands';
import { languages } from '@codemirror/language-data';
import { oneDark } from '@codemirror/theme-one-dark';

// --- Global Error Handling (Must be first) ---
window.onerror = function (message, source, lineno, colno, error) {
    const errorMsg = JSON.stringify({
        type: 'ERROR',
        payload: `JS Error: ${message} at ${source}:${lineno}:${colno}`
    });
    if (window.ReactNativeWebView) {
        window.ReactNativeWebView.postMessage(errorMsg);
    } else {
        console.error('RNWebView not found, error:', errorMsg);
    }
};

// --- Logger Helper ---
function log(msg: string) {
    if (window.ReactNativeWebView) {
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'log', payload: msg }));
    } else {
        console.log(msg);
    }
}

log('Editor script starting...');

import { syntaxHighlighting, defaultHighlightStyle, bracketMatching, HighlightStyle } from '@codemirror/language';
import { yaml } from '@codemirror/lang-yaml';
import { Decoration, ViewPlugin, WidgetType } from '@codemirror/view';
import { tags } from '@lezer/highlight';

// --- Bridge Protocol ---
// Inbound: RN -> Web
type InboundMessage =
    | { type: 'SET_CONTENT'; payload: string }
    | { type: 'INITIAL_LOAD_DATA'; payload: { content: string; placeholder?: string; autoFocus?: boolean; theme?: 'light' | 'dark' } }
    | { type: 'GET_CONTENT' }
    | { type: 'INSERT_TEXT'; payload: string }
    | { type: 'UPDATE_SETTINGS'; payload: { theme: 'light' | 'dark'; fontSize?: number } }
    | { type: 'ACTION'; payload: 'undo' | 'redo' | 'focus' | 'blur' };

// Outbound: Web -> RN
declare global {
    interface Window {
        ReactNativeWebView: {
            postMessage: (message: string) => void;
        };
    }
}

function sendMessage(type: string, payload?: any) {
    if (window.ReactNativeWebView) {
        window.ReactNativeWebView.postMessage(JSON.stringify({ type, payload }));
    }
}

// --- Highlighting & Plugins ---

// Custom highlight style (from legacy entry.js)
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
]);

// FrontMatter Plugin (Ported from legacy entry.js)
const frontMatterPlugin = ViewPlugin.fromClass(class {
    decorations: any;

    constructor(view: EditorView) {
        this.decorations = this.buildDecorations(view);
    }

    update(update: any) {
        if (update.docChanged || update.viewportChanged || update.selectionSet) {
            this.decorations = this.buildDecorations(update.view);
        }
    }

    buildDecorations(view: EditorView) {
        const widgets: any[] = [];
        const doc = view.state.doc;
        const docText = doc.toString();

        const frontMatterRegex = /^(?:---\s*[\r\n]+)([\s\S]*?)(?:[\r\n]+---\s*[\r\n]+|$)/;
        const match = docText.match(frontMatterRegex);

        if (match) {
            const from = 0;
            const to = match[0].length; // End position of the entire front matter block

            // Decorate each line within Front Matter
            for (let pos = from; pos < to;) {
                const line = doc.lineAt(pos);
                // Ensure we don't go out of bounds
                if (line.from < doc.length) {
                    widgets.push(Decoration.line({
                        attributes: { class: "cm-frontmatter-line" }
                    }).range(line.from));
                }
                pos = line.to + 1;
            }

            // Decorate delimiters specifically
            // First '---'
            const firstDelimiterEnd = docText.indexOf('\n', 0);
            if (firstDelimiterEnd !== -1) {
                widgets.push(Decoration.mark({ class: "cm-frontmatter-delimiter" }).range(from, Math.min(3, firstDelimiterEnd)));
            }

            // Second '---' (closing)
            // match[0] includes the closing '---'
            // We need to find the last occurring '---' inside the match
            const closingMatch = match[0].lastIndexOf('---');
            if (closingMatch !== -1 && closingMatch > 3) { // Ensure it's not the first one
                widgets.push(Decoration.mark({ class: "cm-frontmatter-delimiter" }).range(closingMatch, closingMatch + 3));
            }

            // CodeMirror requires decorations to be sorted by position
            widgets.sort((a, b) => a.from - b.from || a.to - b.to);
        }
        return Decoration.set(widgets);
    }
}, {
    decorations: v => v.decorations
});


// --- Editor Setup ---

const themeConfig = new Compartment();
const fontSizeConfig = new Compartment();
let editor: EditorView | null = null;
let suppressOnChange = false;

function createEditor(initialContent: string, placeholderText: string = 'Start writing...', autoFocus: boolean = false) {
    const startState = EditorState.create({
        doc: initialContent,
        extensions: [
            highlightSpecialChars(),
            history(),
            drawSelection(),
            dropCursor(),
            EditorState.allowMultipleSelections.of(true),

            // Syntax Highlighting
            syntaxHighlighting(customHighlightStyle),
            syntaxHighlighting(defaultHighlightStyle),
            bracketMatching(),

            // Markdown & Language
            markdown({
                base: markdownLanguage,
                codeLanguages: languages,
                extensions: [yaml() as any] // Parse YAML inside markdown (for frontmatter attempt by parser)
            }),
            frontMatterPlugin, // Custom FrontMatter visualizer

            keymap.of([
                ...defaultKeymap,
                ...historyKeymap
            ]),

            EditorView.lineWrapping,

            // Theme & Configs
            themeConfig.of([]), // Default light
            fontSizeConfig.of(EditorView.theme({
                '.cm-content': { fontSize: '16px', lineHeight: '24px' }
            })),

            placeholder(placeholderText),

            // Listeners
            EditorView.updateListener.of((update) => {
                if (update.docChanged && !suppressOnChange) {
                    sendMessage('ON_CHANGE', update.state.doc.toString());
                }
            })
        ],
    });

    editor = new EditorView({
        state: startState,
        parent: document.getElementById('editor')!,
    });

    if (autoFocus) {
        requestAnimationFrame(() => {
            editor?.focus();
        });
    }
}

function handleMessage(event: MessageEvent) {
    try {
        const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
        if (!data || typeof data.type !== 'string') return;

        const { type, payload } = data;

        if (!editor && type !== 'SET_CONTENT' && type !== 'INITIAL_LOAD_DATA') return;

        switch (type) {
            case 'INITIAL_LOAD_DATA':
                suppressOnChange = true;
                if (payload.theme === 'dark') {
                    editor?.dispatch({
                        effects: themeConfig.reconfigure(oneDark)
                    });
                }
                if (editor) {
                    editor.dispatch({
                        changes: { from: 0, to: editor.state.doc.length, insert: payload.content }
                    });
                } else {
                    createEditor(payload.content, payload.placeholder, payload.autoFocus);
                    if (payload.theme === 'dark' && editor) {
                        (editor as EditorView).dispatch({ effects: themeConfig.reconfigure(oneDark) });
                    }
                }
                suppressOnChange = false;
                suppressOnChange = false;
                // DO NOT send ON_READY here, or it causes a loop with EditorScreen
                break;
            case 'SET_CONTENT':
                suppressOnChange = true;
                if (editor) {
                    editor.dispatch({
                        changes: { from: 0, to: editor.state.doc.length, insert: payload }
                    });
                } else {
                    createEditor(payload);
                }
                suppressOnChange = false;
                break;
            case 'GET_CONTENT':
                if (editor) sendMessage('CONTENT_RESULT', editor.state.doc.toString());
                break;
            case 'INSERT_TEXT':
                if (editor) {
                    editor.dispatch(editor.state.replaceSelection(payload));
                    editor.focus();
                }
                break;
            case 'UPDATE_SETTINGS':
                if (!editor) return;
                const effects: any[] = [];
                if (payload.theme === 'dark') {
                    effects.push(themeConfig.reconfigure(oneDark));
                } else {
                    effects.push(themeConfig.reconfigure([]));
                }
                if (payload.fontSize) {
                    effects.push(fontSizeConfig.reconfigure(EditorView.theme({
                        '.cm-content': { fontSize: `${payload.fontSize}px` }
                    })));
                }
                if (effects.length > 0) editor.dispatch({ effects });
                break;
            case 'ACTION':
                if (!editor) return;
                if (payload === 'undo') undo(editor);
                if (payload === 'redo') redo(editor);
                if (payload === 'focus') editor.focus();
                if (payload === 'blur') editor.contentDOM.blur();
                break;
        }
    } catch (e) {
        console.error('Web Editor Error:', e);
        sendMessage('ERROR', e instanceof Error ? e.message : String(e));
    }
}

window.addEventListener('message', handleMessage);
// @ts-ignore
document.addEventListener('message', handleMessage);

// Notify RN we are alive (load might be faster than RN listener setup, so RN should also poll or simply send INIT when ready)
// Notify RN we are alive (triggers INITIAL_LOAD_DATA)
setTimeout(() => {
    log('Sending initial ON_READY');
    sendMessage('ON_READY');
}, 100);
