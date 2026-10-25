import React from 'react';
import { Text } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import { ToolCallsCard } from '../src/screens/ChatScreen';
import { ToolCallState } from '../src/types/assistantProtocol';

describe('ToolCallsCard', () => {
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
