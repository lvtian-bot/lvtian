import React from 'react';
import { FlatList, Text, TouchableOpacity, View } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import type { TFunction } from 'i18next';
import { ChatScreen, ToolCallsCard, formatToolSummaryLocalized } from '../src/screens/ChatScreen';
import { ToolCallState } from '../src/types/assistantProtocol';
import { useAssistantStore } from '../src/store/useAssistantStore';
import { AssistantClient } from '../src/services/AssistantClient';

jest.mock('@react-navigation/native', () => ({
    ...jest.requireActual('@react-navigation/native'),
    useNavigation: () => ({ navigate: jest.fn() }),
}));

const translations: Record<string, string> = {
    'assistant.toolActionRead': 'Read',
    'assistant.toolActionWrite': 'Write',
    'assistant.toolActionEdit': 'Edit',
    'assistant.toolActionSearch': 'Search',
    'assistant.toolActionFetch': 'Fetch',
};
const translate = ((key: string, options?: { defaultValue?: string }) =>
    translations[key] || options?.defaultValue || key) as unknown as TFunction;
const command: ToolCallState = {
    id: 'command', name: 'bash', status: 'running', summary: '$ git status -s',
    input: { description: 'Check repository changes', command: 'git status -s' },
    output: 'line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9\n',
};
const read: ToolCallState = {
    id: 'read', name: 'read', status: 'done', summary: 'read: old path',
    input: { file_path: '/home/ubuntu/project/docs/architecture.md', offset: 1, limit: 200 },
    output: 'read result',
};

describe('ToolCallsCard', () => {
    let renderer: ReactTestRenderer.ReactTestRenderer | undefined;
    const texts = () => renderer!.root.findAllByType(Text).map((node) => node.props.children).flat();
    const buttons = () => renderer!.root.findAllByType(TouchableOpacity);
    afterEach(async () => {
        await ReactTestRenderer.act(async () => renderer?.unmount());
        jest.restoreAllMocks();
    });

    it('preserves localized legacy summary formatting and unknown fallbacks', () => {
        expect(formatToolSummaryLocalized({ summary: 'read: docs/tech.md' }, translate)).toBe('Read docs/tech.md');
        expect(formatToolSummaryLocalized({ summary: 'write: src/index.ts' }, translate)).toBe('Write src/index.ts');
        expect(formatToolSummaryLocalized({ summary: 'search: "Expo"' }, translate)).toBe('Search "Expo"');
        expect(formatToolSummaryLocalized({ summary: 'fetch: https://example.com' }, translate)).toBe('Fetch https://example.com');
        expect(formatToolSummaryLocalized({ summary: '$ git pull' }, translate)).toBe('$ git pull');
        expect(formatToolSummaryLocalized({ name: 'custom', summary: 'Custom summary' }, translate)).toBe('Custom summary');
        expect(formatToolSummaryLocalized({ name: 'custom' }, translate)).toBe('custom');
    });

    it('prefers command descriptions and read paths from structured input', () => {
        expect(formatToolSummaryLocalized(command, translate)).toBe('Check repository changes');
        expect(formatToolSummaryLocalized({ ...command, name: 'functions.bash' }, translate)).toBe('Check repository changes');
        expect(formatToolSummaryLocalized({ ...command, input: { description: ' ', command: 'git diff' } }, translate)).toBe('$ git diff');
        expect(formatToolSummaryLocalized(read, translate)).toBe('Read /home/ubuntu/project/docs/architecture.md');
        expect(formatToolSummaryLocalized({ ...command, name: 'EXECUTE' }, translate)).toBe('Check repository changes');
        expect(formatToolSummaryLocalized({ ...read, name: 'READ_FILE', input: { filePath: 'docs/guide.md' } }, translate)).toBe('Read docs/guide.md');
        expect(formatToolSummaryLocalized({ ...command, input: { cmd: '$ git diff' } }, translate)).toBe('$ git diff');
        expect(formatToolSummaryLocalized({ ...command, input: { description: 5 } }, translate)).toBe('$ git status -s');
    });

    it('starts even a single tool collapsed; expands raw summary, input and untruncated output', async () => {
        await ReactTestRenderer.act(async () => { renderer = ReactTestRenderer.create(<ToolCallsCard toolCalls={[command]} />); });
        expect(buttons()[0].props.accessibilityState).toEqual({ expanded: false });
        expect(texts()).toContain('Check repository changes');
        expect(texts()).not.toContain(command.summary);
        expect(texts()).not.toContain(command.output);
        await ReactTestRenderer.act(async () => buttons()[0].props.onPress());
        expect(texts()).toContain(command.summary);
        expect(texts()).toContain(JSON.stringify(command.input, null, 2));
        expect(texts()).toContain(command.output);
        const output = renderer!.root.findAllByType(Text).find((node) => node.props.children === command.output)!;
        expect(output.props.selectable).toBe(true);
        expect(output.props.numberOfLines).toBeUndefined();
        const title = renderer!.root.findAllByType(Text).find((node) => node.props.children === 'Check repository changes')!;
        expect(title.props.numberOfLines).toBeUndefined();
        await ReactTestRenderer.act(async () => buttons()[0].props.onPress());
        expect(texts()).not.toContain(command.output);
    });

    it('keeps disclosures independent across streaming appends, status updates and reordering', async () => {
        await ReactTestRenderer.act(async () => { renderer = ReactTestRenderer.create(<ToolCallsCard toolCalls={[command, read]} isProcessing />); });
        expect(buttons().map((button) => button.props.accessibilityState.expanded)).toEqual([false, false]);
        await ReactTestRenderer.act(async () => buttons()[0].props.onPress());
        expect(texts()).toContain(command.output);
        expect(texts()).not.toContain(read.output);
        const failed = { ...command, status: 'failed' as const };
        await ReactTestRenderer.act(async () => renderer!.update(<ToolCallsCard toolCalls={[read, failed, { ...read, id: 'new' }]} />));
        expect(buttons().map((button) => button.props.accessibilityState.expanded)).toEqual([false, true, false]);
        expect(texts()).toContain(command.output);
        expect(buttons()[1].props.accessibilityLabel).toMatch(/失败|Failed/);
        expect(buttons()[0].props.accessibilityLabel).toMatch(/已完成|Completed/);
    });

    it('renders empty tool lists safely', async () => {
        await ReactTestRenderer.act(async () => { renderer = ReactTestRenderer.create(<ToolCallsCard toolCalls={[]} />); });
        expect(buttons()).toHaveLength(0);
    });

    it('renders tools beside, never inside, the prose bubble, without empty tool-only prose', async () => {
        jest.spyOn(AssistantClient.getInstance(), 'connect').mockImplementation(async () => {});
        await ReactTestRenderer.act(async () => {
            useAssistantStore.setState({ serverUrl: 'http://localhost:8080', connectionState: 'connected', messages: [], pendingApprovals: [] });
            renderer = ReactTestRenderer.create(<ChatScreen />);
        });
        const renderItem = renderer!.root.findByType(FlatList).props.renderItem;
        const item = { id: 'message', role: 'assistant', content: 'Assistant prose', status: 'processing', timestamp: 0, toolCalls: [command] };
        await ReactTestRenderer.act(async () => renderer!.update(renderItem({ item })));
        const prose = renderer!.root.findByProps({ testID: 'assistant-prose-message-text-0' });
        expect(prose.findAllByType(ToolCallsCard)).toHaveLength(0);
        const group = prose.parent!;
        expect(group.findAllByType(ToolCallsCard)).toHaveLength(1);
        await ReactTestRenderer.act(async () => renderer!.update(renderItem({ item: { ...item, content: '' } })));
        expect(renderer!.root.findAllByProps({ testID: 'assistant-prose-message-text-0' })).toHaveLength(0);
        expect(renderer!.root.findAllByType(ToolCallsCard)).toHaveLength(1);
    });

    it('renders text-tool-text-tool-text bubbles in order and preserves an open tool on updates', async () => {
        jest.spyOn(AssistantClient.getInstance(), 'connect').mockImplementation(async () => {});
        await ReactTestRenderer.act(async () => {
            useAssistantStore.setState({ serverUrl: 'http://localhost:8080', connectionState: 'connected', messages: [], pendingApprovals: [] });
            renderer = ReactTestRenderer.create(<ChatScreen />);
        });
        const renderItem = renderer!.root.findByType(FlatList).props.renderItem;
        const item = {
            id: 'timeline', role: 'assistant', content: 'beforemiddletail', status: 'processing', timestamp: 0,
            toolCalls: [command, read],
            toolCallPositions: [{ toolCallId: command.id, textOffset: 6 }, { toolCallId: read.id, textOffset: 12 }],
        };
        await ReactTestRenderer.act(async () => renderer!.update(renderItem({ item })));
        const order = () => renderer!.root.findAll((node) =>
            node.type === ToolCallsCard ||
            (typeof node.props.testID === 'string' && node.props.testID.startsWith('assistant-prose-timeline-'))
        ).filter((node) => node.type === ToolCallsCard || node.type === View)
            .map((node) => node.type === ToolCallsCard ? `tool:${node.props.toolCalls[0].id}` : node.props.testID);
        expect(order()).toEqual([
            'assistant-prose-timeline-text-0', 'tool:command',
            'assistant-prose-timeline-text-6', 'tool:read', 'assistant-prose-timeline-text-12',
        ]);
        await ReactTestRenderer.act(async () => buttons()[0].props.onPress());
        expect(texts()).toContain(command.output);
        await ReactTestRenderer.act(async () => renderer!.update(renderItem({ item: {
            ...item, content: item.content + ' more', toolCalls: [{ ...command, status: 'done' }, read],
        } })));
        expect(buttons()[0].props.accessibilityState.expanded).toBe(true);
        expect(texts()).toContain(command.output);
        expect(order()).toHaveLength(5);
    });
});
