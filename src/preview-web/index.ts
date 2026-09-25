/// <reference lib="dom" />
import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js';
import 'github-markdown-css/github-markdown.css';
import 'highlight.js/styles/github.css';

// --- Global Error Handling ---
window.onerror = function (message, source, lineno, colno) {
    sendMessage('ERROR', `Preview JS Error: ${message} at ${source}:${lineno}:${colno}`);
};

// --- Bridge Protocol ---
declare global {
    interface Window {
        ReactNativeWebView: {
            postMessage: (message: string) => void;
        };
    }
}

function sendMessage(type: string, payload?: unknown) {
    if (window.ReactNativeWebView) {
        window.ReactNativeWebView.postMessage(JSON.stringify({ type, payload }));
    }
}

// --- Markdown-it Configuration ---
const md = new MarkdownIt({
    html: false,
    xhtmlOut: false,
    breaks: true,
    langPrefix: 'language-',
    linkify: true,
    typographer: true,
    highlight: function (str: string, lang: string) {
        const validLang = lang && hljs.getLanguage(lang) ? lang : '';
        let highlighted = '';
        try {
            if (validLang) {
                highlighted = hljs.highlight(str, { language: validLang, ignoreIllegals: true }).value;
            } else {
                highlighted = md.utils.escapeHtml(str);
            }
        } catch (_) {
            highlighted = md.utils.escapeHtml(str);
        }

        const langDisplay = validLang || 'text';
        const encodedCode = encodeURIComponent(str);

        return `<div class="code-block-wrapper">` +
            `<div class="code-block-header">` +
            `<span class="code-lang">${langDisplay}</span>` +
            `<button class="code-copy-btn" data-code="${encodedCode}">复制</button>` +
            `</div>` +
            `<pre><code class="hljs ${validLang ? 'language-' + validLang : ''}">${highlighted}</code></pre>` +
            `</div>`;
    }
});

// Custom Rule: GFM Task Lists ([ ] and [x])
md.core.ruler.after('inline', 'task-lists', function (state) {
    const tokens = state.tokens;
    for (let i = 2; i < tokens.length; i++) {
        if (tokens[i].type === 'inline' && tokens[i - 1].type === 'paragraph_open' && tokens[i - 2].type === 'list_item_open') {
            const textToken = tokens[i].children?.[0];
            if (textToken && textToken.type === 'text') {
                const text = textToken.content;
                if (/^\[[ xX]\]\s/.test(text)) {
                    const checked = text.startsWith('[x] ') || text.startsWith('[X] ');
                    textToken.content = text.slice(4);
                    tokens[i - 2].attrJoin('class', 'task-list-item');
                    // Prepend checkbox HTML
                    const checkboxToken = new state.Token('html_inline', '', 0);
                    checkboxToken.content = `<input type="checkbox" disabled ${checked ? 'checked' : ''} /> `;
                    tokens[i].children?.unshift(checkboxToken);
                }
            }
        }
    }
});

// Custom Rule: External Links open in system browser
const defaultRenderLink = md.renderer.rules.link_open || function (tokens, idx, options, _env, self) {
    return self.renderToken(tokens, idx, options);
};

md.renderer.rules.link_open = function (tokens, idx, options, env, self) {
    tokens[idx].attrSet('target', '_blank');
    tokens[idx].attrSet('rel', 'noopener noreferrer');
    return defaultRenderLink(tokens, idx, options, env, self);
};

// Custom Rule: Wrap tables in a scrollable container
const defaultTableOpen = md.renderer.rules.table_open || function (tokens, idx, options, _env, self) {
    return self.renderToken(tokens, idx, options);
};
const defaultTableClose = md.renderer.rules.table_close || function (tokens, idx, options, _env, self) {
    return self.renderToken(tokens, idx, options);
};

md.renderer.rules.table_open = function (tokens, idx, options, env, self) {
    return '<div class="table-wrapper">' + defaultTableOpen(tokens, idx, options, env, self);
};

md.renderer.rules.table_close = function (tokens, idx, options, env, self) {
    return defaultTableClose(tokens, idx, options, env, self) + '</div>';
};

// --- DOM Container & Rendering ---
const container = document.getElementById('preview');

function renderContent(rawContent: string) {
    if (!container) return;

    if (!rawContent || !rawContent.trim()) {
        container.innerHTML = '<div style="color: #888; text-align: center; margin-top: 40px;"># 空文件<br/><br/>点击右上角编辑按钮开始编写</div>';
        return;
    }

    let markdownText = rawContent;
    let frontMatterHtml = '';

    // Handle YAML FrontMatter
    const frontMatterRegex = /^(?:---\s*[\r\n]+)([\s\S]*?)(?:[\r\n]+---\s*[\r\n]+|$)/;
    const match = rawContent.match(frontMatterRegex);
    if (match) {
        const metadataContent = md.utils.escapeHtml(match[1].trim());
        frontMatterHtml = `<div class="frontmatter-card"><div class="frontmatter-title">元数据 (FrontMatter)</div><pre style="margin:0;padding:0;background:transparent;"><code>${metadataContent}</code></pre></div>`;
        markdownText = rawContent.substring(match[0].length);
    }

    const html = md.render(markdownText);
    container.innerHTML = frontMatterHtml + html;
}

// --- Delegate Click Events (Copy & Links) ---
document.addEventListener('click', function (e) {
    const target = e.target as HTMLElement | null;
    if (!target) return;

    // 1. Copy Code Button
    const copyBtn = target.closest('.code-copy-btn') as HTMLButtonElement | null;
    if (copyBtn) {
        e.preventDefault();
        e.stopPropagation();
        const encoded = copyBtn.getAttribute('data-code');
        if (encoded) {
            const code = decodeURIComponent(encoded);
            // Copy via navigator or message
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(code).catch(() => {});
            }
            sendMessage('COPY_CODE', code);

            const originalText = copyBtn.textContent || '复制';
            copyBtn.textContent = '✓ 已复制';
            copyBtn.classList.add('copied');
            setTimeout(() => {
                copyBtn.textContent = originalText;
                copyBtn.classList.remove('copied');
            }, 1600);
        }
        return;
    }

    // 2. Link Navigation Interception
    const link = target.closest('a') as HTMLAnchorElement | null;
    if (link && link.href) {
        e.preventDefault();
        sendMessage('LINK_CLICK', link.href);
    }
});

// --- Message Receiver ---
function handleMessage(event: MessageEvent) {
    try {
        const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
        if (!data || typeof data.type !== 'string') return;

        switch (data.type) {
            case 'SET_CONTENT': {
                const { content, theme } = data.payload || {};
                if (theme) {
                    document.body.setAttribute('data-theme', theme === 'night' || theme === 'dark' ? 'dark' : 'light');
                }
                renderContent(content || '');
                break;
            }
            case 'SET_THEME': {
                const theme = data.payload;
                document.body.setAttribute('data-theme', theme === 'night' || theme === 'dark' ? 'dark' : 'light');
                break;
            }
        }
    } catch (err) {
        sendMessage('ERROR', String(err));
    }
}

window.addEventListener('message', handleMessage);
// @ts-ignore
document.addEventListener('message', handleMessage);

// Notify RN WebView is ready
setTimeout(() => {
    sendMessage('ON_READY');
}, 50);
