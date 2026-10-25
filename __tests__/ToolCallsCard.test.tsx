import React from 'react';
import { Text } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import type { TFunction } from 'i18next';
import { ToolCallsCard, formatToolSummaryLocalized } from '../src/screens/ChatScreen';
import { ToolCallState } from '../src/types/assistantProtocol';

describe('ToolCallsCard', () => {
    it('formatToolSummaryLocalized 客户端多语言格式化动作', () => {
        const mockT_zh = ((key: string, options?: { defaultValue?: string }) => {
            const map: Record<string, string> = {
                'assistant.toolActionRead': '读取',
                'assistant.toolActionWrite': '写入',
                'assistant.toolActionSearch': '搜索',
                'assistant.toolActionFetch': '访问',
            };
            return map[key] || options?.defaultValue || key;
        }) as unknown as TFunction;

        const mockT_en = ((key: string, options?: { defaultValue?: string }) => {
            const map: Record<string, string> = {
                'assistant.toolActionRead': 'Read',
                'assistant.toolActionWrite': 'Write',
                'assistant.toolActionSearch': 'Search',
                'assistant.toolActionFetch': 'Fetch',
            };
            return map[key] || options?.defaultValue || key;
        }) as unknown as TFunction;

        // 中文本地化
        expect(formatToolSummaryLocalized({ summary: 'read: docs/tech.md' }, mockT_zh)).toBe('读取 docs/tech.md');
        expect(formatToolSummaryLocalized({ summary: 'write: src/index.ts' }, mockT_zh)).toBe('写入 src/index.ts');
        expect(formatToolSummaryLocalized({ summary: 'search: "Expo"' }, mockT_zh)).toBe('搜索 "Expo"');
        expect(formatToolSummaryLocalized({ summary: 'fetch: https://example.com' }, mockT_zh)).toBe('访问 https://example.com');
        expect(formatToolSummaryLocalized({ summary: '$ git pull' }, mockT_zh)).toBe('$ git pull');

        // 英文本地化
        expect(formatToolSummaryLocalized({ summary: 'read: docs/tech.md' }, mockT_en)).toBe('Read docs/tech.md');
        expect(formatToolSummaryLocalized({ summary: 'write: src/index.ts' }, mockT_en)).toBe('Write src/index.ts');
        expect(formatToolSummaryLocalized({ summary: 'search: "Expo"' }, mockT_en)).toBe('Search "Expo"');
        expect(formatToolSummaryLocalized({ summary: 'fetch: https://example.com' }, mockT_en)).toBe('Fetch https://example.com');
    });

    it('单工具调用时正确渲染命令明细', async () => {
        const toolCalls: ToolCallState[] = [
            {
                id: 'tc-1',
                name: 'bash',
                status: 'done',
                summary: '$ git status -s',
            },
        ];

        let renderer: ReactTestRenderer.ReactTestRenderer | undefined;
        await ReactTestRenderer.act(async () => {
            renderer = ReactTestRenderer.create(<ToolCallsCard toolCalls={toolCalls} />);
        });

        const root = renderer!.root;
        const textNodes = root.findAllByType(Text);
        const textContents = textNodes.map((n) => n.props.children).flat();

        expect(textContents).toContain('$ git status -s');
    });

    it('多工具调用时默认聚合折叠，点击后可展开明细', async () => {
        const toolCalls: ToolCallState[] = [
            {
                id: 'tc-1',
                name: 'bash',
                status: 'done',
                summary: '$ git fetch origin',
            },
            {
                id: 'tc-2',
                name: 'bash',
                status: 'done',
                summary: '$ git reset --hard origin/master',
            },
        ];

        let renderer: ReactTestRenderer.ReactTestRenderer | undefined;
        await ReactTestRenderer.act(async () => {
            renderer = ReactTestRenderer.create(<ToolCallsCard toolCalls={toolCalls} />);
        });

        const root = renderer!.root;
        const headerText = root.findAllByType(Text).find((n) => typeof n.props.children === 'string' && n.props.children.includes('2'));
        expect(headerText).toBeDefined();

        // 默认折叠：不显示明细项中的具体命令
        let allTexts = root.findAllByType(Text).map((n) => n.props.children).flat();
        expect(allTexts).not.toContain('$ git fetch origin');

        // 点击头部展开
        const touchable = root.findByProps({ activeOpacity: 0.7 });
        await ReactTestRenderer.act(async () => {
            touchable.props.onPress();
        });

        // 展开后显示完整的具体命令
        allTexts = root.findAllByType(Text).map((n) => n.props.children).flat();
        expect(allTexts).toContain('$ git fetch origin');
        expect(allTexts).toContain('$ git reset --hard origin/master');
    });
});
