import React from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import * as ReactNative from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import { ChatBubbleText } from '../src/components/ChatBubbleText';
import { ChatMarkdownBubble } from '../src/components/ChatMarkdownBubble';
import { ChatScreen } from '../src/screens/ChatScreen';
import { ToolCallsCard } from '../src/components/ToolCallsCard';
import { AssistantClient } from '../src/services/AssistantClient';
import { useAssistantStore } from '../src/store/useAssistantStore';
import { getAssistantDisplayParts } from '../src/utils/assistantMessageParts';
import { formatChatDate, formatChatTime, isPlainChatText, localDayKey, startsChatDay } from '../src/utils/chatDate';
import type { AssistantMessage, ToolCallState } from '../src/types/assistantProtocol';
import i18n from '../src/i18n';

jest.mock('@react-navigation/native', () => ({
    ...jest.requireActual('@react-navigation/native'),
    useNavigation: () => ({ navigate: jest.fn() }),
}));

const call = (id: string): ToolCallState => ({ id, name: 'read', status: 'done', input: { file_path: '/very/long/path/'.repeat(60) } });
const message = (extra: Partial<AssistantMessage> = {}): AssistantMessage => ({
    id: 'reply', seq: 1, role: 'assistant', content: 'firstlast', timestamp: new Date(2026, 9, 26, 12, 5).getTime(), status: 'done', ...extra,
});

describe('chat day boundaries', () => {
    const now = new Date(2026, 9, 26, 12).getTime();
    it('uses local calendar days, including midnight, year rollover and invalid input', () => {
        expect(startsChatDay(now)).toBe(true);
        expect(startsChatDay(now, now - 1000)).toBe(false);
        expect(startsChatDay(new Date(2026, 9, 26, 0).getTime(), new Date(2026, 9, 25, 23, 59).getTime())).toBe(true);
        expect(startsChatDay(new Date(2026, 0, 1).getTime(), new Date(2025, 11, 31).getTime())).toBe(true);
        expect(localDayKey(NaN)).toBeNull();
        expect(startsChatDay(NaN)).toBe(false);
        expect(formatChatTime(NaN)).toBe('');
        expect(formatChatTime(now, 'en')).toMatch(/^12:00$/);
    });
    it('formats today, yesterday, earlier dates and cross-year dates in both languages', () => {
        expect(formatChatDate(now, now, 'zh', i18n.t)).toBe(i18n.t('assistant.dateToday'));
        expect(formatChatDate(new Date(2026, 9, 25).getTime(), now, 'zh', i18n.t)).toBe(i18n.t('assistant.dateYesterday'));
        expect(formatChatDate(new Date(2026, 9, 1).getTime(), now, 'zh', i18n.t)).toBe('10月1日');
        expect(formatChatDate(new Date(2025, 9, 1).getTime(), now, 'en', i18n.t)).toBe('October 1, 2025');
        expect(formatChatDate(NaN, now, 'en', i18n.t)).toBe('');
    });
});

describe('bubble rendering', () => {
    let renderer: ReactTestRenderer.ReactTestRenderer | undefined;
    afterEach(async () => {
        await ReactTestRenderer.act(async () => renderer?.unmount());
        jest.restoreAllMocks();
    });
    it('groups adjacent calls without losing order or mutating message data', () => {
        const msg = message({ toolCalls: [call('a'), call('b'), call('c')], toolCallPositions: [
            { toolCallId: 'a', textOffset: 5 }, { toolCallId: 'b', textOffset: 5 }, { toolCallId: 'c', textOffset: 9 },
        ] });
        const parts = getAssistantDisplayParts(msg);
        expect(parts.map((part) => part.type)).toEqual(['text', 'tools', 'text', 'tools']);
        expect(parts[1]).toMatchObject({ key: 'tool-a', tools: [call('a'), call('b')] });
        expect(getAssistantDisplayParts(msg)).toEqual(parts);
        expect(msg.toolCalls).toHaveLength(3);
    });
    const bodyText = () => renderer!.root.findAllByType(Text).find((node) => node.props.selectable === true)!;
    const clockText = () => renderer!.root.findByProps({ testID: 'inline-bubble-time' });
    const layoutBubble = async (width: number, lineWidths: number[], clockWidth = 30, clockHeight = 12) => {
        await ReactTestRenderer.act(async () => {
            renderer!.root.findByType(View).props.onLayout({ nativeEvent: { layout: { width } } });
        });
        const lines = lineWidths.map((lineWidth, index) => ({ x: 0, y: index * 27, width: lineWidth, height: 27 }));
        await ReactTestRenderer.act(async () => { bodyText().props.onTextLayout({ nativeEvent: { lines } }); });
        // If the native row wrapped, measure again in its unconstrained body mode.
        await ReactTestRenderer.act(async () => {
            bodyText().props.onTextLayout({ nativeEvent: { lines } });
            clockText().props.onLayout({ nativeEvent: { layout: { width: clockWidth, height: clockHeight } } });
        });
    };
    it('keeps selectable commands, URLs and Unicode text exact, with a separate non-selectable clock', async () => {
        for (const text of ['npm run test', 'https://example.com/a?b=c&d=e', '你好😀', 'first\nlast\n']) {
            await ReactTestRenderer.act(async () => {
                const element = <ChatBubbleText text={text} time="12:05" textStyle={{ fontSize: 18, lineHeight: 27 }} />;
                if (renderer) renderer.update(element);
                else renderer = ReactTestRenderer.create(element);
            });
            expect(bodyText().props.children).toBe(text);
            expect(bodyText().findAllByType(Text)).toHaveLength(1);
            expect(clockText().props.children).toBe('12:05');
            expect(clockText().props.selectable).toBe(false);
            expect(StyleSheet.flatten(clockText().props.style).position).not.toBe('absolute');
        }
    });
    it('starts and stays in a native row for short text, before any async measurement', async () => {
        await ReactTestRenderer.act(async () => {
            renderer = ReactTestRenderer.create(<ChatBubbleText text="short" time="12:05" textStyle={{ fontSize: 18 }} />);
        });
        const assertRow = () => {
            expect(StyleSheet.flatten(renderer!.root.findByType(View).props.style)).toMatchObject({ flexDirection: 'row', maxWidth: '100%' });
            expect(StyleSheet.flatten(bodyText().props.style)).toMatchObject({ flexShrink: 1 });
            expect(StyleSheet.flatten(clockText().props.style)).toMatchObject({ marginLeft: 8, marginTop: 0, flexShrink: 0 });
            expect(StyleSheet.flatten(clockText().props.style).position).not.toBe('absolute');
            expect(bodyText().props.children).toBe('short');
        };
        assertRow();
        await layoutBubble(118.3, [80.1], 30.2);
        assertRow();
        expect(StyleSheet.flatten(renderer!.root.findByType(View).props.style).width).toBeUndefined();
    });
    it('shares a multiline trailing edge only when width and height allow, including resize and font scaling', async () => {
        await ReactTestRenderer.act(async () => {
            renderer = ReactTestRenderer.create(<ChatBubbleText text="first\nlast" time="12:05" textStyle={{ fontSize: 18 }} />);
        });
        await layoutBubble(200, [200, 80]);
        expect(StyleSheet.flatten(clockText().props.style)).toMatchObject({ position: 'absolute', top: 42 });
        await layoutBubble(110, [110, 80]);
        expect(StyleSheet.flatten(clockText().props.style).position).not.toBe('absolute');
        await layoutBubble(200, [200, 180]);
        expect(StyleSheet.flatten(clockText().props.style).position).not.toBe('absolute');
        await layoutBubble(200, [200, 80], 40, 32);
        expect(StyleSheet.flatten(clockText().props.style).position).not.toBe('absolute');
    });
    it('falls back safely until new streamed text and clock values have been measured', async () => {
        await ReactTestRenderer.act(async () => {
            renderer = ReactTestRenderer.create(<ChatBubbleText text="first\nlast" time="12:05" textStyle={{ fontSize: 18 }} />);
        });
        await layoutBubble(200, [200, 80]);
        const streamedBody = bodyText();
        const previousSourceCallback = bodyText().props.onTextLayout;
        await ReactTestRenderer.act(async () => {
            renderer!.update(<ChatBubbleText text="first\nlonger last" time="12:05" textStyle={{ fontSize: 18 }} />);
        });
        expect(StyleSheet.flatten(clockText().props.style)).toMatchObject({ position: 'absolute', opacity: 0 });
        expect(bodyText() === streamedBody).toBe(true);
        expect(StyleSheet.flatten(renderer!.root.findByType(View).props.style).flexDirection).toBeUndefined();
        await layoutBubble(200, [200, 100]);
        await ReactTestRenderer.act(async () => {
            previousSourceCallback({ nativeEvent: { lines: [{ x: 0, y: 0, width: 500, height: 27 }] } });
        });
        expect(StyleSheet.flatten(clockText().props.style).position).toBe('absolute');
        const previousClock = clockText();
        const previousBody = bodyText();
        await ReactTestRenderer.act(async () => {
            renderer!.update(<ChatBubbleText text="first\nlonger last" time="12:06" textStyle={{ fontSize: 18 }} />);
        });
        expect(StyleSheet.flatten(clockText().props.style)).toMatchObject({ position: 'absolute', opacity: 0 });
        // A new clock mounts even if the time's glyph widths are unchanged,
        // ensuring a native layout event without remounting selectable prose.
        expect(clockText()).not.toBe(previousClock);
        expect(bodyText()).toBe(previousBody);
        await ReactTestRenderer.act(async () => {
            clockText().props.onLayout({ nativeEvent: { layout: { width: 30, height: 12 } } });
        });
        expect(StyleSheet.flatten(clockText().props.style).position).toBe('absolute');
        await ReactTestRenderer.act(async () => {
            renderer!.update(<ChatBubbleText text="first\nlonger last" time="" textStyle={{ fontSize: 18 }} />);
        });
        expect(renderer!.root.findAllByType(Text)).toHaveLength(1);
    });
    it('retries native row layout when rotation or system font scaling changes', async () => {
        const dimensions = jest.spyOn(jest.requireActual<typeof ReactNative>('react-native'), 'useWindowDimensions');
        dimensions.mockReturnValue({ width: 200, height: 600, scale: 2, fontScale: 1.5 });
        const element = () => <ChatBubbleText text="previously wrapped" time="12:05" textStyle={{ fontSize: 18 }} />;
        await ReactTestRenderer.act(async () => { renderer = ReactTestRenderer.create(element()); });
        await layoutBubble(160, [160, 80]);
        expect(StyleSheet.flatten(renderer!.root.findByType(View).props.style).flexDirection).toBeUndefined();
        dimensions.mockReturnValue({ width: 600, height: 200, scale: 2, fontScale: 1.5 });
        await ReactTestRenderer.act(async () => { renderer!.update(element()); });
        expect(StyleSheet.flatten(renderer!.root.findByType(View).props.style).flexDirection).toBe('row');
        await layoutBubble(160, [160, 80]);
        dimensions.mockReturnValue({ width: 600, height: 200, scale: 2, fontScale: 1 });
        await ReactTestRenderer.act(async () => { renderer!.update(element()); });
        expect(StyleSheet.flatten(renderer!.root.findByType(View).props.style).flexDirection).toBe('row');
    });
    it('ignores out-of-order native callbacks after resize, clock and typography updates', async () => {
        const element = (time = '12:05', fontSize = 18, text = 'first\nlast') => <ChatBubbleText text={text} time={time} textStyle={{ fontSize }} fullWidth />;
        await ReactTestRenderer.act(async () => { renderer = ReactTestRenderer.create(element()); });
        await layoutBubble(200, [200, 80]);
        const oldBodyCallback = bodyText().props.onTextLayout;
        const oldClockCallback = clockText().props.onLayout;
        await layoutBubble(220, [220, 80]);
        await ReactTestRenderer.act(async () => { renderer!.update(element('12:06')); });
        const stableBody = bodyText();
        await ReactTestRenderer.act(async () => { clockText().props.onLayout({ nativeEvent: { layout: { width: 30, height: 12 } } }); });
        await ReactTestRenderer.act(async () => {
            oldBodyCallback({ nativeEvent: { lines: [{ x: 0, y: 0, width: 500, height: 27 }] } });
            oldClockCallback({ nativeEvent: { layout: { width: 500, height: 12 } } });
        });
        expect(bodyText()).toBe(stableBody);
        expect(StyleSheet.flatten(clockText().props.style).position).toBe('absolute');
        const previousBodyCallback = bodyText().props.onTextLayout;
        await ReactTestRenderer.act(async () => { renderer!.update(element('12:06', 24, 'new source')); });
        await ReactTestRenderer.act(async () => {
            previousBodyCallback({ nativeEvent: { lines: [{ x: 0, y: 0, width: 10, height: 27 }] } });
        });
        expect(StyleSheet.flatten(clockText().props.style)).toMatchObject({ position: 'absolute', opacity: 0 });
        expect(bodyText().props.children).toBe('new source');
    });
    it('keeps complex blocks in Markdown, not a plain text fallback', () => {
        for (const source of ['```js\nx\n```', '| a | b |', '# heading', '- item', '1. item', '[link](https://example.com)', '**bold**',
            '    const x = 1;', '\tconst x = 1;', '  \tconst x = 1;', 'intro\n\n    code',
            '&lt;', '&amp;', '&copy;', '&#60;', '&#x3c;', '&#X3C;']) {
            expect(isPlainChatText(source)).toBe(false);
        }
        expect(isPlainChatText('中文😀 https://example.com/very-long-path\nnext line')).toBe(true);
    });
    it('routes indented code and entities through the existing Markdown renderer in chat cells', async () => {
        jest.spyOn(AssistantClient.getInstance(), 'connect').mockImplementation(async () => {});
        await ReactTestRenderer.act(async () => {
            useAssistantStore.setState({ serverUrl: 'http://localhost:8080', connectionState: 'connected', messages: [], pendingApprovals: [] });
            renderer = ReactTestRenderer.create(<ChatScreen />);
        });
        const renderItem = renderer!.root.findByType(FlatList).props.renderItem;
        for (const content of ['    const x = 1;', '\tconst x = 1;', '&lt; &amp; &#60; &#x3c;']) {
            await ReactTestRenderer.act(async () => renderer!.update(renderItem({ item: message({ content }), index: 0 })));
            expect(renderer!.root.findAllByType(ChatMarkdownBubble)).toHaveLength(1);
            const rendered = JSON.stringify(renderer!.toJSON());
            if (content.startsWith('&')) {
                expect(rendered).toContain('< & < <');
                expect(rendered).not.toContain('&lt;');
            } else {
                expect(rendered).toContain('const x = 1;');
            }
        }
    });
    it('routes screenshot-style lists directly into the definite-width rich bubble without a shrink-wrap parent', async () => {
        jest.spyOn(AssistantClient.getInstance(), 'connect').mockImplementation(async () => {});
        await ReactTestRenderer.act(async () => {
            useAssistantStore.setState({ serverUrl: 'http://localhost:8080', connectionState: 'connected', messages: [], pendingApprovals: [] });
            renderer = ReactTestRenderer.create(<ChatScreen />);
        });
        const renderItem = renderer!.root.findByType(FlatList).props.renderItem;
        const content = '明白，调整方案：\n\n- **英文模板原文全部保留**，只调整中文部分。\n- 保留 `AGENTS.md`、Skill 的约定。\n- 最后一个完整列表段落。';
        await ReactTestRenderer.act(async () => renderer!.update(renderItem({ item: message({ content }), index: 0 })));
        const richBubble = renderer!.root.findByType(ChatMarkdownBubble);
        expect(StyleSheet.flatten(richBubble.parent!.props.style)).toMatchObject({ width: '92%', alignItems: 'flex-start' });
        expect(StyleSheet.flatten(richBubble.findAllByType(View)[0].props.style)).toMatchObject({ width: '100%', flexShrink: 0 });
        expect(renderer!.root.findByType(ChatBubbleText).props.fullWidth).toBe(true);
        expect(renderer!.root.findByProps({ testID: 'markdown-bubble-time' }).props.children).toBe('12:05');
        expect(JSON.stringify(renderer!.toJSON())).toContain('最后一个完整列表段落。');
    });
    it('keeps the same body clock across sending, queued, error and acknowledged user states', async () => {
        jest.spyOn(AssistantClient.getInstance(), 'connect').mockImplementation(async () => {});
        await ReactTestRenderer.act(async () => {
            useAssistantStore.setState({ serverUrl: 'http://localhost:8080', connectionState: 'connected', messages: [], pendingApprovals: [] });
            renderer = ReactTestRenderer.create(<ChatScreen />);
        });
        const renderItem = renderer!.root.findByType(FlatList).props.renderItem;
        let previousBody: ReactTestRenderer.ReactTestInstance | undefined;
        for (const status of ['sending', 'queued', 'error', 'sent'] as const) {
            await ReactTestRenderer.act(async () => renderer!.update(renderItem({
                item: message({ id: 'user', role: 'user', content: 'first\nlast', status }), index: 0,
            })));
            const bubble = renderer!.root.findByProps({ testID: 'user-bubble-user' });
            const text = bubble.findByType(ChatBubbleText);
            expect(text.props.text).toBe('first\nlast');
            expect(bubble.findAllByType(Text).filter(node => node.props.children === '12:05')).toHaveLength(1);
            const selectable = text.findAllByType(Text).find(node => node.props.selectable === true)!;
            if (previousBody) expect(selectable).toBe(previousBody);
            previousBody = selectable;
        }
    });
    it('renders grouped cards at a definite width with two-line summaries and independent detail state', async () => {
        await ReactTestRenderer.act(async () => { renderer = ReactTestRenderer.create(<ToolCallsCard toolCalls={[call('a'), call('b')]} />); });
        const group = renderer!.root.findByProps({ testID: 'tool-call-group' });
        expect(StyleSheet.flatten(group.props.style)).toMatchObject({ width: '100%' });
        for (const id of ['a', 'b']) {
            const card = renderer!.root.findByProps({ testID: `tool-card-${id}` });
            expect(StyleSheet.flatten(card.props.style)).toMatchObject({ width: '100%' });
            const title = card.findAllByType(Text).find((node) => node.props.numberOfLines === 2)!;
            expect(title.props.ellipsizeMode).toBe('tail');
        }
    });
    it('puts a date before the oldest same-day cell in newest-first data and no orphan reply clock', async () => {
        jest.spyOn(AssistantClient.getInstance(), 'connect').mockImplementation(async () => {});
        const earlier = message({ id: 'earlier' });
        const later = message({ id: 'later', timestamp: earlier.timestamp + 1000 });
        await ReactTestRenderer.act(async () => {
            useAssistantStore.setState({ serverUrl: 'http://localhost:8080', connectionState: 'connected', messages: [earlier, later], pendingApprovals: [] });
            renderer = ReactTestRenderer.create(<ChatScreen />);
        });
        const list = renderer!.root.findByType(FlatList);
        const renderItem = list.props.renderItem;
        expect(list.props.data.map((item: AssistantMessage) => item.id)).toEqual(['later', 'earlier']);
        await ReactTestRenderer.act(async () => renderer!.update(renderItem({ item: earlier, index: 1 })));
        expect(renderer!.root.findAllByType(View).some((node) => node.props.testID === 'chat-date-earlier')).toBe(true);
        expect(renderer!.root.findAllByType(ChatBubbleText)).toHaveLength(1);
        await ReactTestRenderer.act(async () => renderer!.update(renderItem({ item: later, index: 0 })));
        expect(renderer!.root.findAllByType(View).some((node) => node.props.testID === 'chat-date-later')).toBe(false);
        await ReactTestRenderer.act(async () => renderer!.update(renderItem({ item: message({ content: '', toolCalls: [call('a'), call('b')] }), index: 0 })));
        expect(renderer!.root.findAllByType(ToolCallsCard)).toHaveLength(0);
        expect(renderer!.root.findAllByProps({ testID: 'tool-call-group' })).toHaveLength(0);
        expect(renderer!.root.findAllByType(ChatBubbleText)).toHaveLength(0);
        expect(renderer!.root.findAllByType(Text).some((node) => node.props.children === '12:05')).toBe(false);
    });
    it('uses completedAt on the final assistant text bubble while earlier prose retains original timestamp', async () => {
        jest.spyOn(AssistantClient.getInstance(), 'connect').mockImplementation(async () => {});
        const firstText = '已开始查询，请稍候。';
        const secondText = '查询完毕，这是最终答复。';
        const item = message({
            content: `${firstText}${secondText}`,
            timestamp: new Date(2026, 9, 26, 12, 5).getTime(),
            completedAt: new Date(2026, 9, 26, 12, 11).getTime(),
            toolCalls: [call('t1')],
            toolCallPositions: [{ toolCallId: 't1', textOffset: firstText.length }],
        });
        await ReactTestRenderer.act(async () => {
            useAssistantStore.setState({ serverUrl: 'http://localhost:8080', connectionState: 'connected', messages: [item], pendingApprovals: [] });
            renderer = ReactTestRenderer.create(<ChatScreen />);
        });
        const renderItem = renderer!.root.findByType(FlatList).props.renderItem;
        await ReactTestRenderer.act(async () => renderer!.update(renderItem({ item, index: 0 })));

        const firstProse = renderer!.root.findByProps({ testID: 'assistant-prose-reply-text-0' });
        const secondProse = renderer!.root.findByProps({ testID: `assistant-prose-reply-text-${firstText.length}` });

        expect(firstProse).toBeTruthy();
        expect(secondProse).toBeTruthy();

        const firstClock = firstProse.findByProps({ testID: 'inline-bubble-time' });
        expect(firstClock.props.children).toBe('12:05');

        const secondClock = secondProse.findByProps({ testID: 'inline-bubble-time' });
        expect(secondClock.props.children).toBe('12:11');
    });
});
