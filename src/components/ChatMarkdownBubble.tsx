import React, { useMemo, type ReactNode } from 'react';
import { Platform, StyleSheet, Text, View, type TextStyle, type ViewStyle } from 'react-native';
import Markdown, { type ASTNode } from 'react-native-markdown-display';
import { auxFontSizes, type FontSizeMetrics } from '../utils/fontSize';
import { theme } from '../utils/theme';

interface ChatMarkdownBubbleProps {
    text: string;
    time: string;
    metrics: FontSizeMetrics;
    testID?: string;
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
export function ChatMarkdownBubble({ text, time, metrics, testID }: ChatMarkdownBubbleProps) {
    const markdownStyles = useMemo(() => getMarkdownStyles(metrics), [metrics]);
    return (
        <View testID={testID} style={layoutStyles.bubble}>
            <Markdown style={markdownStyles} rules={markdownRules}>{text}</Markdown>
            <Text testID="markdown-bubble-time" style={layoutStyles.time} selectable={false}>{time}</Text>
        </View>
    );
}

const getMarkdownStyles = (metrics: FontSizeMetrics) => StyleSheet.create({
    body: {
        width: '100%',
        flexShrink: 0,
        color: theme.colors.text,
        fontSize: metrics.chatBody,
        lineHeight: metrics.chatLineHeight,
    },
    heading1: { color: theme.colors.text, fontSize: metrics.chatHeading1, fontWeight: '700', marginTop: 10, marginBottom: 6 },
    heading2: { color: theme.colors.text, fontSize: metrics.chatHeading2, fontWeight: '700', marginTop: 8, marginBottom: 4 },
    heading3: { color: theme.colors.text, fontSize: metrics.chatHeading3, fontWeight: '700', marginTop: 6, marginBottom: 4 },
    paragraph: { marginTop: 2, marginBottom: 4 },
    list_item: { marginVertical: 2 },
    bullet_list: { marginVertical: 4 },
    ordered_list: { marginVertical: 4 },
    code_inline: {
        color: theme.colors.text, backgroundColor: theme.colors.border, borderRadius: 4,
        paddingHorizontal: 5, paddingVertical: 2, fontSize: metrics.chatCode,
        fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
    },
    fence: {
        backgroundColor: theme.colors.border, borderRadius: 8, padding: 10,
        fontSize: metrics.chatCode, fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
        color: theme.colors.text, marginVertical: 6, borderWidth: 0,
    },
    code_block: {
        backgroundColor: theme.colors.border, borderRadius: 8, padding: 10,
        fontSize: metrics.chatCode, fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
        color: theme.colors.text, marginVertical: 6, borderWidth: 0,
    },
    hr: { backgroundColor: theme.colors.border, height: 1, marginVertical: 8 },
    strong: { fontWeight: '700', color: theme.colors.text },
});

const layoutStyles = StyleSheet.create({
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
