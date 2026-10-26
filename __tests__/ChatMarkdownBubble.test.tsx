import React from 'react';
import { StyleSheet, Text, View, type TextStyle, type ViewStyle } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import { ChatMarkdownBubble } from '../src/components/ChatMarkdownBubble';
import { FONT_SIZE_METRICS } from '../src/utils/fontSize';

// Exercise the actual markdown-display parser/rules, not a text-only Markdown mock.
// ReactTestRenderer does not run Yoga: these are layout-contract regressions, not device measurements.
describe('ChatMarkdownBubble', () => {
    let renderer: ReactTestRenderer.ReactTestRenderer;
    afterEach(async () => {
        await ReactTestRenderer.act(async () => renderer?.unmount());
    });
    const render = async (text: string, metrics = FONT_SIZE_METRICS.standard) => {
        await ReactTestRenderer.act(async () => {
            renderer = ReactTestRenderer.create(
                <View style={{ width: 300, alignItems: 'flex-start' }}>
                    <ChatMarkdownBubble text={text} time="12:05" metrics={metrics} testID="rich-bubble" />
                </View>,
            );
        });
    };
    const textNodes = () => renderer.root.findAllByType(Text);
    const leaf = (content: string) => textNodes().find((node) => node.props.children === content)!;

    it('gives list/paragraph measurement a definite width and keeps the clock below normal-flow content', async () => {
        await render('Intro **bold** and `inline`\n\n- first long list item\n- second\n  - nested item\n\nLast paragraph');
        const bubble = renderer.root.findByProps({ testID: 'rich-bubble' });
        const nativeBubble = bubble.findAllByType(View)[0];
        expect(StyleSheet.flatten(nativeBubble.props.style)).toMatchObject({ width: '100%', maxWidth: '100%', flexShrink: 0 });
        const markdown = renderer.root.find((node) => Boolean(node.props.rules?.code_block && node.props.style?.body));
        expect(markdown.props.style.body).toMatchObject({ width: '100%', flexShrink: 0 });
        const renderedBody = markdown.findAllByType(View)[0];
        expect(StyleSheet.flatten(renderedBody.props.style)).toMatchObject({ width: '100%', flexShrink: 0 });
        // The dependency still uses full-width row paragraphs and flexible list content.
        const viewStyles = renderedBody.findAllByType(View).map((node) => StyleSheet.flatten(node.props.style) as ViewStyle);
        expect(viewStyles.some((style) => style.width === '100%' && style.flexDirection === 'row')).toBe(true);
        expect(viewStyles.some((style) => style.flex === 1)).toBe(true);
        const clock = renderer.root.findByProps({ testID: 'markdown-bubble-time' });
        expect(clock.props.selectable).toBe(false);
        expect(clock.parent).toBe(markdown.parent);
        expect(clock.parent?.children.at(-1)).toBe(clock);
        for (const node of [nativeBubble, renderedBody, clock]) {
            const style = StyleSheet.flatten(node.props.style) as ViewStyle;
            expect(style.position).not.toBe('absolute');
            expect(style.height).toBeUndefined();
            expect(style.maxHeight).toBeUndefined();
            expect(style.overflow).not.toBe('hidden');
        }
        expect(leaf('bold').props.selectable).toBe(true);
        expect(StyleSheet.flatten(leaf('bold').props.style)).toMatchObject({ fontWeight: '700' });
        expect(leaf('inline').props.selectable).toBe(true);
        expect(leaf('Last paragraph')).toBeDefined();
    });

    it.each(['small', 'standard', 'large'] as const)('preserves %s dynamic typography, nested formatting and code copying', async (size) => {
        const metrics = FONT_SIZE_METRICS[size];
        await render('# Heading\n\n1. **bold `command`**\n\n```sh\nprintf "exact"\n```\n\n    indented code\n', metrics);
        expect(StyleSheet.flatten(leaf('Heading').props.style)).toMatchObject({ fontSize: metrics.chatHeading1 });
        expect(StyleSheet.flatten(leaf('command').props.style)).toMatchObject({ fontWeight: '700', fontSize: metrics.chatCode });
        for (const content of ['printf "exact"', 'indented code']) {
            expect(leaf(content).props.selectable).toBe(true);
            expect(StyleSheet.flatten(leaf(content).props.style)).toMatchObject({ fontSize: metrics.chatCode });
        }
        const style = renderer.root.find((node) => Boolean(node.props.rules?.code_block && node.props.style?.body)).props.style;
        expect(style.body).toMatchObject({ fontSize: metrics.chatBody, lineHeight: metrics.chatLineHeight });
    });

    it('retains table rendering and updates complete content without fixed-height caches', async () => {
        await render('| Header | Other |\n| --- | --- |\n| **cell** | `value` |');
        expect(leaf('Header').props.selectable).toBe(true);
        expect(leaf('cell').props.selectable).toBe(true);
        expect(leaf('value').props.selectable).toBe(true);
        await ReactTestRenderer.act(async () => {
            renderer.update(<ChatMarkdownBubble text={'- first\n- new final item'} time="12:06" metrics={FONT_SIZE_METRICS.large} testID="rich-bubble" />);
        });
        expect(leaf('new final item').props.selectable).toBe(true);
        expect(StyleSheet.flatten(leaf('new final item').props.style) as TextStyle).toMatchObject({ fontSize: FONT_SIZE_METRICS.large.chatBody });
        expect(renderer.root.findByProps({ testID: 'markdown-bubble-time' }).props.children).toBe('12:06');
    });
});
