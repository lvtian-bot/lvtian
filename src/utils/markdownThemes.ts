
import { theme } from './theme';

export type MarkdownThemeKey = 'default' | 'github' | 'solarized' | 'night';

export interface MarkdownTheme {
    body: any;
    heading1: any;
    heading2: any;
    heading3: any;
    heading4: any;
    heading5: any;
    heading6: any;
    hr: any;
    strong: any;
    em: any;
    s: any;
    blockquote: any;
    bullet_list: any;
    ordered_list: any;
    list_item: any;
    code_inline: any;
    code_block: any;
    fence: any;
    table: any;
    thead: any;
    tbody: any;
    th: any;
    tr: any;
    td: any;
    link: any;
    blocklink: any;
    image: any;
    text: any;
    textgroup: any;
    paragraph: any;
    hardbreak: any;
    softbreak: any;
    pre: any;
    inline: any;
    span: any;
}

const baseTheme = {
    body: {
        fontSize: 16,
        lineHeight: 24,
    },
    heading1: {
        fontSize: 24,
        fontWeight: 'bold',
        marginBottom: 10,
        marginTop: 20,
    },
    heading2: {
        fontSize: 20,
        fontWeight: 'bold',
        marginBottom: 10,
        marginTop: 20,
    },
    heading3: {
        fontSize: 18,
        fontWeight: 'bold',
        marginBottom: 10,
        marginTop: 20,
    },
    paragraph: {
        marginBottom: 10,
    },
    link: {
        textDecorationLine: 'underline',
    },
    list_item: {
        marginBottom: 5,
    },
};

export const markdownThemes: Record<MarkdownThemeKey, Partial<MarkdownTheme>> = {
    default: {
        ...baseTheme,
        body: { ...baseTheme.body, color: theme.colors.text },
        heading1: { ...baseTheme.heading1, color: theme.colors.primary },
        heading2: { ...baseTheme.heading2, color: theme.colors.primaryDark },
        heading3: { ...baseTheme.heading3, color: theme.colors.text },
        link: { ...baseTheme.link, color: theme.colors.primary },
        code_inline: {
            backgroundColor: '#f0f0f0',
            borderRadius: 4,
            paddingHorizontal: 4,
            fontFamily: 'monospace',
        },
        fence: {
            backgroundColor: '#f0f0f0',
            padding: 10,
            borderRadius: 4,
            fontFamily: 'monospace',
        },
    },
    github: {
        ...baseTheme,
        body: { ...baseTheme.body, color: '#24292e' },
        heading1: { ...baseTheme.heading1, borderBottomWidth: 1, borderBottomColor: '#eaecef', paddingBottom: 0.3 },
        heading2: { ...baseTheme.heading2, borderBottomWidth: 1, borderBottomColor: '#eaecef', paddingBottom: 0.3 },
        blockquote: {
            borderLeftWidth: 4,
            borderLeftColor: '#dfe2e5',
            paddingLeft: 16,
            color: '#6a737d',
        },
        code_inline: {
            backgroundColor: 'rgba(27,31,35,0.05)',
            borderRadius: 3,
            paddingHorizontal: 4,
            fontFamily: 'monospace',
        },
        fence: {
            backgroundColor: '#f6f8fa',
            padding: 16,
            borderRadius: 3,
            fontFamily: 'monospace',
        },
        table: {
            borderWidth: 1,
            borderColor: '#dfe2e5',
            borderRadius: 3,
        },
        th: {
            backgroundColor: '#f6f8fa',
            borderWidth: 1,
            borderColor: '#dfe2e5',
            padding: 6,
            fontWeight: 'bold',
        },
        td: {
            borderWidth: 1,
            borderColor: '#dfe2e5',
            padding: 6,
        },
    },
    solarized: {
        ...baseTheme,
        body: { ...baseTheme.body, color: '#657b83', backgroundColor: '#fdf6e3' },
        heading1: { ...baseTheme.heading1, color: '#b58900' },
        heading2: { ...baseTheme.heading2, color: '#cb4b16' },
        heading3: { ...baseTheme.heading3, color: '#dc322f' },
        link: { ...baseTheme.link, color: '#268bd2' },
        code_inline: {
            backgroundColor: '#eee8d5',
            color: '#d33682',
            fontFamily: 'monospace',
        },
        fence: {
            backgroundColor: '#eee8d5',
            padding: 10,
            color: '#657b83',
            fontFamily: 'monospace',
        },
        blockquote: {
            borderLeftColor: '#eee8d5',
            borderLeftWidth: 4,
            paddingLeft: 10,
            color: '#93a1a1',
        },
    },
    night: {
        ...baseTheme,
        body: { ...baseTheme.body, color: '#c9d1d9', backgroundColor: '#0d1117' },
        heading1: { ...baseTheme.heading1, color: '#58a6ff' },
        heading2: { ...baseTheme.heading2, color: '#58a6ff' },
        heading3: { ...baseTheme.heading3, color: '#58a6ff' },
        link: { ...baseTheme.link, color: '#58a6ff' },
        blockquote: {
            borderLeftColor: '#30363d',
            borderLeftWidth: 4,
            paddingLeft: 10,
            color: '#8b949e',
        },
        code_inline: {
            backgroundColor: 'rgba(110,118,129,0.4)',
            borderRadius: 6,
            paddingHorizontal: 4,
            fontFamily: 'monospace',
            color: '#c9d1d9',
        },
        fence: {
            backgroundColor: '#161b22',
            padding: 16,
            borderRadius: 6,
            fontFamily: 'monospace',
            color: '#c9d1d9',
        },
        th: {
            backgroundColor: '#161b22',
            borderColor: '#30363d',
            borderWidth: 1,
            padding: 6,
            color: '#c9d1d9',
        },
        td: {
            borderColor: '#30363d',
            borderWidth: 1,
            padding: 6,
            color: '#c9d1d9',
        },
    },
};
