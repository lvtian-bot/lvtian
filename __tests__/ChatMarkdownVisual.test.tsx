import React from 'react';
import { ScrollView, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import { ChatMarkdownBubble } from '../src/components/ChatMarkdownBubble';
import { FONT_SIZE_METRICS } from '../src/utils/fontSize';
import { theme } from '../src/utils/theme';

jest.mock('react-native-fit-image', () => 'FitImage');

// Real parser and native render rules; native selection/scroll gestures still need device QA.
describe('chat Markdown lightweight preview alignment', () => {
    let renderer: ReactTestRenderer.ReactTestRenderer;
    afterEach(async () => { await ReactTestRenderer.act(async () => renderer?.unmount()); });
    const render = async (text: string, size: keyof typeof FONT_SIZE_METRICS = 'standard') => {
        await ReactTestRenderer.act(async () => {
            renderer = ReactTestRenderer.create(<ChatMarkdownBubble text={text} metrics={FONT_SIZE_METRICS[size]} plain />);
        });
    };
    const markdown = () => renderer.root.find((node) => Boolean(node.props.markdownit && node.props.rules?.fence));
    const leaf = (value: string) => renderer.root.findAllByType(Text).find((node) => node.props.children === value)!;

    it.each(['small', 'standard', 'large'] as const)('keeps %s chat typography while aligning headings, quote, code and table styles', async (size) => {
        await render('# Heading\n\n> quote\n\n```ts\nconst n = 1;\n```\n\n| Title | Value |\n| --- | --- |\n| a | b |', size);
        const styles = markdown().props.style;
        expect(styles.heading1).toMatchObject({ fontSize: FONT_SIZE_METRICS[size].chatHeading1, borderBottomWidth: 1 });
        expect(styles.heading6).toMatchObject({ fontSize: FONT_SIZE_METRICS[size].chatCode, color: theme.colors.textSecondary });
        expect(styles.blockquote).toMatchObject({ borderLeftWidth: 4, backgroundColor: 'transparent' });
        expect(styles.fence).toMatchObject({ borderWidth: 1, borderRadius: 8, padding: 12 });
        expect(styles.table).toMatchObject({ borderColor: theme.colors.border });
        expect(styles.th).toMatchObject({ fontWeight: '700', padding: 8 });
        expect(styles.link).toMatchObject({ color: theme.colors.primaryDark });
        expect(leaf('const n = 1;').props.selectable).toBe(true);
        expect(leaf('a').props.selectable).toBe(true);
    });

    it('matches safe preview line-break and autolink settings without enabling HTML', async () => {
        await render('first\nsecond\n\nhttps://example.com\n\n<script>alert(1)</script>');
        const parser = markdown().props.markdownit;
        expect(parser.options).toMatchObject({ html: false, breaks: true, linkify: true, typographer: true });
        const tokens = parser.parse('first\nsecond\n\nhttps://example.com\n\n<script>alert(1)</script>', {});
        const inline = tokens.flatMap((token: { children?: { type: string }[] }) => token.children || []);
        expect(inline.some((token: { type: string }) => token.type === 'link_open')).toBe(true);
        expect(inline.some((token: { type: string }) => token.type === 'html_inline')).toBe(false);
        expect(leaf('<script>alert(1)</script>').props.selectable).toBe(true);
    });

    it('keeps code verbatim, including quotes, URL and Markdown-looking content', async () => {
        const code = '  "quoted" -- https://example.com\n**not bold**\n';
        await render('```text\n' + code + '```');
        expect(leaf(code.slice(0, -1)).props.selectable).toBe(true);
    });

    it('updates incomplete streaming syntax immediately using the same parser', async () => {
        await render('```text\npartial');
        const parser = markdown().props.markdownit;
        expect(leaf('partial')).toBeDefined();
        await ReactTestRenderer.act(async () => {
            renderer.update(<ChatMarkdownBubble text={'```text\npartial complete\n```\n\nLast **word**'} metrics={FONT_SIZE_METRICS.standard} plain />);
        });
        expect(markdown().props.markdownit).toBe(parser);
        expect(leaf('partial complete').props.selectable).toBe(true);
        expect(leaf('word').props.selectable).toBe(true);
    });

    it('keeps long blocks and nested lists in unconstrained normal flow without another scroll host', async () => {
        await render('- first\n  - nested\n\n| Head | Other |\n| --- | --- |\n| ' + 'long '.repeat(80) + ' | value |');
        expect(renderer.root.findAllByType(ScrollView)).toHaveLength(0);
        for (const view of renderer.root.findAllByType(View)) {
            const style = StyleSheet.flatten(view.props.style) as ViewStyle | undefined;
            expect(style?.height).toBeUndefined();
            expect(style?.maxHeight).toBeUndefined();
            expect(style?.overflow).not.toBe('hidden');
        }
        expect(leaf('nested').props.selectable).toBe(true);
        expect(leaf('value').props.selectable).toBe(true);
    });
});
