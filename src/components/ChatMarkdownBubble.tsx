import React, { useMemo, type ReactNode } from 'react';
import { Platform, StyleSheet, Text, View, type TextStyle, type ViewStyle } from 'react-native';
import Markdown, { MarkdownIt, type ASTNode } from 'react-native-markdown-display';
import { auxFontSizes, type FontSizeMetrics } from '../utils/fontSize';
import { theme } from '../utils/theme';
import { ChatBubbleText } from './ChatBubbleText';
import { useBubbleLayoutPolicy } from './ChatBubbleReveal';

interface ChatMarkdownBubbleProps {
    text: string;
    /** 聊天气泡底部的时钟；不传时不渲染时间行（如工作记录详情）。 */
    time?: string;
    metrics: FontSizeMetrics;
    testID?: string;
    /** 去掉气泡底色和圆角，用于非聊天的正文阅读区。 */
    plain?: boolean;
}

type RuleStyles = Record<string, TextStyle & ViewStyle>;

// Match preview's safe common syntax, without HTML, plugins or a second scroll host.
// Keep the parser stable across streaming updates; code contents remain untouched.
const chatMarkdown = MarkdownIt({ html: false, breaks: true, linkify: true, typographer: true });

/** Keep the library's inline Text tree (including bold/link inheritance) selectable. */
const markdownRules = {
    text: (node: ASTNode, _children: ReactNode[], _parent: ASTNode[], styles: RuleStyles, inherited: TextStyle = {}) => (
        <Text key={node.key} style={[inherited, styles.text]} selectable>{node.content}</Text>
    ),
    textgroup: (node: ASTNode, children: ReactNode[], _parent: ASTNode[], styles: RuleStyles) => (
        <Text key={node.key} style={styles.textgroup} selectable>{children}</Text>
    ),
    code_inline: (node: ASTNode, _children: ReactNode[], _parent: ASTNode[], styles: RuleStyles, inherited: TextStyle = {}) => (
        <Text key={node.key} style={[inherited, styles.code_inline]} selectable>{node.content}</Text>
    ),
    code_block: renderCodeBlock,
    fence: renderCodeBlock,
};

function renderCodeBlock(node: ASTNode, _children: ReactNode[], _parent: ASTNode[], styles: RuleStyles, inherited: TextStyle = {}) {
    // markdown-it adds one trailing newline; do not otherwise alter copyable code.
    const content = node.content.endsWith('\n') ? node.content.slice(0, -1) : node.content;
    return (
        <Text key={node.key} style={[inherited, styles[node.type]]} selectable>{content}</Text>
    );
}

const terminalContainers = new Set(['body', 'paragraph', 'bullet_list', 'ordered_list', 'list_item']);

/** Only ordinary terminal paragraphs/list children are safe. Never infer geometry
 * from Markdown source, or move the clock past a later code block/table/image. */
function terminalTextGroup(node: ASTNode): ASTNode | undefined {
    if (node.type === 'textgroup') {
        const hasImage = (child: ASTNode): boolean => child.type === 'image' || child.type === 'blocklink'
            || child.children.some(hasImage);
        return node.children.some(hasImage) ? undefined : node;
    }
    const last = node.children.at(-1);
    return terminalContainers.has(node.type) && last ? terminalTextGroup(last) : undefined;
}

/** Rich text needs a definite width before Yoga measures paragraphs and list rows.
 * Do not nest this inside the shrink-to-content plain-text bubble.
 */
export function ChatMarkdownBubble({ text, time, metrics, testID, plain = false }: ChatMarkdownBubbleProps) {
    const { streaming } = useBubbleLayoutPolicy();
    const markdownStyles = useMemo(() => getMarkdownStyles(metrics), [metrics]);
    const rules = useMemo(() => createClockRules(text, time, metrics, streaming), [text, time, metrics, streaming]);
    return (
        <View testID={testID} style={plain ? layoutStyles.plain : layoutStyles.bubble}>
            <Markdown markdownit={chatMarkdown} style={markdownStyles} rules={rules}>{text}</Markdown>
        </View>
    );
}

function createClockRules(text: string, time: string | undefined, metrics: FontSizeMetrics, streaming: boolean) {
    return {
        ...markdownRules,
        body: (node: ASTNode, children: ReactNode[], _parent: ASTNode[], styles: RuleStyles) => (
            <View key={node.key} style={styles._VIEW_SAFE_body}>
                {children}
                {time && !streaming && !terminalTextGroup(node) ? <Text testID="markdown-bubble-time"
                    style={layoutStyles.time} selectable={false} accessible={false}>{time}</Text> : null}
            </View>
        ),
        textgroup: (node: ASTNode, children: ReactNode[], parents: ASTNode[], styles: RuleStyles) => {
            const root = parents.at(-1);
            if (time && root && terminalTextGroup(root)?.key === node.key) {
                return <ChatBubbleText key={node.key} text={text} time={time}
                    textStyle={[styles.textgroup, { fontSize: metrics.chatBody, lineHeight: metrics.chatLineHeight }]}
                    fullWidth clockTestID="markdown-bubble-time">{children}</ChatBubbleText>;
            }
            return markdownRules.textgroup(node, children, parents, styles);
        },
    };
}

const getMarkdownStyles = (metrics: FontSizeMetrics) => StyleSheet.create({
    body: {
        width: '100%',
        flexShrink: 0,
        color: theme.colors.text,
        fontSize: metrics.chatBody,
        lineHeight: metrics.chatLineHeight,
    },
    // Preview uses GitHub-style hierarchy; retain chat's user-selected size ladder.
    heading1: { color: theme.colors.text, fontSize: metrics.chatHeading1, lineHeight: Math.ceil(metrics.chatHeading1 * 1.3), fontWeight: '700', marginTop: 16, marginBottom: 8, paddingBottom: 6, borderBottomWidth: 1, borderColor: theme.colors.border },
    heading2: { color: theme.colors.text, fontSize: metrics.chatHeading2, lineHeight: Math.ceil(metrics.chatHeading2 * 1.3), fontWeight: '700', marginTop: 14, marginBottom: 8, paddingBottom: 6, borderBottomWidth: 1, borderColor: theme.colors.border },
    heading3: { color: theme.colors.text, fontSize: metrics.chatHeading3, lineHeight: Math.ceil(metrics.chatHeading3 * 1.3), fontWeight: '700', marginTop: 12, marginBottom: 6 },
    heading4: { color: theme.colors.text, fontSize: metrics.chatBody, lineHeight: metrics.chatLineHeight, fontWeight: '700', marginTop: 10, marginBottom: 6 },
    heading5: { color: theme.colors.text, fontSize: metrics.chatCode, lineHeight: metrics.chatLineHeight, fontWeight: '700', marginTop: 10, marginBottom: 6 },
    heading6: { color: theme.colors.textSecondary, fontSize: metrics.chatCode, lineHeight: metrics.chatLineHeight, fontWeight: '700', marginTop: 10, marginBottom: 6 },
    paragraph: { marginTop: 0, marginBottom: 8 },
    list_item: { marginVertical: 2 },
    bullet_list: { marginTop: 0, marginBottom: 8 },
    ordered_list: { marginTop: 0, marginBottom: 8 },
    bullet_list_icon: { marginLeft: 4, marginRight: 8 },
    ordered_list_icon: { marginLeft: 4, marginRight: 8 },
    blockquote: {
        backgroundColor: 'transparent', borderColor: theme.colors.border, borderLeftWidth: 4,
        marginLeft: 0, marginVertical: 8, paddingHorizontal: 12, color: theme.colors.textSecondary,
    },
    code_inline: {
        color: theme.colors.text, backgroundColor: theme.colors.border, borderRadius: 4,
        borderWidth: 0, padding: 0, paddingHorizontal: 4, paddingVertical: 2, fontSize: metrics.chatCode,
        fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
    },
    fence: {
        backgroundColor: 'rgba(128, 128, 128, 0.05)', borderRadius: 8, padding: 12,
        fontSize: metrics.chatCode, lineHeight: Math.ceil(metrics.chatCode * 1.5), fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
        color: theme.colors.text, marginVertical: 8, borderWidth: 1, borderColor: 'rgba(128, 128, 128, 0.2)',
    },
    code_block: {
        backgroundColor: 'rgba(128, 128, 128, 0.05)', borderRadius: 8, padding: 12,
        fontSize: metrics.chatCode, lineHeight: Math.ceil(metrics.chatCode * 1.5), fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
        color: theme.colors.text, marginVertical: 8, borderWidth: 1, borderColor: 'rgba(128, 128, 128, 0.2)',
    },
    // Keep tables in normal flow with wrapping cells, rather than nesting a horizontal
    // ScrollView inside chat. Preview's wide-table scrolling is intentionally not copied.
    table: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 6, marginVertical: 8 },
    thead: { backgroundColor: theme.colors.inputBg },
    th: { padding: 8, borderRightWidth: 1, borderColor: theme.colors.border, fontWeight: '700' },
    tr: { borderBottomWidth: 1, borderColor: theme.colors.border },
    td: { padding: 8, borderRightWidth: 1, borderColor: theme.colors.border },
    link: { color: theme.colors.primaryDark, textDecorationLine: 'underline' },
    hr: { backgroundColor: theme.colors.border, height: 1, marginVertical: 12 },
    strong: { fontWeight: '700', color: theme.colors.text },
});

const layoutStyles = StyleSheet.create({
    plain: {
        width: '100%',
        maxWidth: '100%',
        alignSelf: 'flex-start',
        flexShrink: 0,
    },
    bubble: {
        width: '100%',
        maxWidth: '100%',
        alignSelf: 'flex-start',
        flexShrink: 0,
        borderRadius: 20,
        paddingHorizontal: 16,
        paddingVertical: 12,
        backgroundColor: theme.colors.background,
    },
    time: { alignSelf: 'flex-end', flexShrink: 0, fontSize: auxFontSizes.badge, color: theme.colors.textSecondary, marginTop: 2 },
});
