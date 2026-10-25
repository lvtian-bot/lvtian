import React from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import { ChatBubbleText } from '../src/components/ChatBubbleText';
import { ChatScreen, ToolCallsCard } from '../src/screens/ChatScreen';
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
    it('reserves inline space in the same font before overlaying the visible clock', async () => {
        await ReactTestRenderer.act(async () => {
            renderer = ReactTestRenderer.create(<ChatBubbleText text="你好😀" time="12:05" textStyle={{ fontSize: 18, lineHeight: 27 }} />);
        });
        const clock = renderer!.root.findByProps({ testID: 'inline-bubble-time' });
        expect(clock.props.children).toBe('12:05');
        const reservation = renderer!.root.findAllByType(Text).find((node) => node.props.children === '   12:05')!;
        expect(StyleSheet.flatten(reservation.props.style)).toMatchObject({ color: 'transparent', fontSize: 10 });
        expect(StyleSheet.flatten(clock.props.style)).toMatchObject({ fontSize: 10, right: 0, bottom: 0 });
    });
    it('keeps complex blocks in Markdown, not a plain text fallback', () => {
        for (const source of ['```js\nx\n```', '| a | b |', '# heading', '- item', '1. item', '[link](https://example.com)', '**bold**']) {
            expect(isPlainChatText(source)).toBe(false);
        }
        expect(isPlainChatText('中文😀 https://example.com/very-long-path\nnext line')).toBe(true);
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
        expect(renderer!.root.findAllByType(ToolCallsCard)).toHaveLength(1);
        expect(renderer!.root.findAllByType(ChatBubbleText)).toHaveLength(0);
        expect(renderer!.root.findAllByType(Text).some((node) => node.props.children === '12:05')).toBe(false);
    });
});
