import React, { useMemo, type ReactNode } from 'react';
import { Platform, StyleSheet, Text, View, type TextStyle, type ViewStyle } from 'react-native';
import Markdown, { type ASTNode } from 'react-native-markdown-display';
import type { FontSizeMetrics } from '../utils/fontSize';

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

/** Rich text needs a definite width before Yoga measures paragraphs and list rows.
 * Do not nest this inside the shrink-to-content plain-text bubble.
 */
export function ChatMarkdownBubble({ text, time, metrics, testID, plain = false }: ChatMarkdownBubbleProps) {
    const markdownStyles = useMemo(() => getMarkdownStyles(metrics), [metrics]);
    return (
        <View testID={testID} style={plain ? layoutStyles.plain : layoutStyles.bubble}>
            <Markdown style={markdownStyles} rules={markdownRules}>{text}</Markdown>
            {time ? <Text testID="markdown-bubble-time" style={layoutStyles.time} selectable={false}>{time}</Text> : null}
        </View>
    );
}

const getMarkdownStyles = (metrics: FontSizeMetrics) => StyleSheet.create({
    body: {
        width: '100%',
        flexShrink: 0,
        color: '#111827',
        fontSize: metrics.chatBody,
        lineHeight: metrics.chatLineHeight,
    },
    heading1: { color: '#111827', fontSize: metrics.chatHeading1, fontWeight: '700', marginTop: 10, marginBottom: 6 },
    heading2: { color: '#111827', fontSize: metrics.chatHeading2, fontWeight: '700', marginTop: 8, marginBottom: 4 },
    heading3: { color: '#111827', fontSize: metrics.chatHeading3, fontWeight: '700', marginTop: 6, marginBottom: 4 },
    paragraph: { marginTop: 2, marginBottom: 4 },
    list_item: { marginVertical: 2 },
    bullet_list: { marginVertical: 4 },
    ordered_list: { marginVertical: 4 },
    code_inline: {
        color: '#111827', backgroundColor: '#E5E7EB', borderRadius: 4,
        paddingHorizontal: 5, paddingVertical: 2, fontSize: metrics.chatCode,
        fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
    },
    fence: {
        backgroundColor: '#E5E7EB', borderRadius: 8, padding: 10,
        fontSize: metrics.chatCode, fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
        color: '#111827', marginVertical: 6, borderWidth: 0,
    },
    code_block: {
        backgroundColor: '#E5E7EB', borderRadius: 8, padding: 10,
        fontSize: metrics.chatCode, fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
        color: '#111827', marginVertical: 6, borderWidth: 0,
    },
    hr: { backgroundColor: '#E5E7EB', height: 1, marginVertical: 8 },
    strong: { fontWeight: '700', color: '#111827' },
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
        backgroundColor: '#F0F2F5',
    },
    time: { alignSelf: 'flex-end', flexShrink: 0, fontSize: 10, color: '#6B7280', marginTop: 2 },
});
