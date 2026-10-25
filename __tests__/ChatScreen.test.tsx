import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { Text, TextInput } from 'react-native';
import { ChatScreen } from '../src/screens/ChatScreen';
import { useAssistantStore } from '../src/store/useAssistantStore';
import { AssistantClient } from '../src/services/AssistantClient';

const mockSetOptions = jest.fn();
const mockNavigate = jest.fn();

jest.mock('@react-navigation/native', () => {
    const actual = jest.requireActual('@react-navigation/native');
    return {
        ...actual,
        useNavigation: () => ({
            setOptions: mockSetOptions,
            navigate: mockNavigate,
        }),
    };
});

describe('ChatScreen 输入区与操作菜单', () => {
    let currentRenderer: ReactTestRenderer.ReactTestRenderer | undefined;

    beforeEach(async () => {
        jest.clearAllMocks();
        jest.spyOn(AssistantClient.getInstance(), 'connect').mockImplementation(async () => {});
        await ReactTestRenderer.act(async () => {
            useAssistantStore.setState({
                serverUrl: 'http://localhost:8080',
                connectionState: 'connected',
                messages: [],
                taskState: 'idle',
                pendingApprovals: [],
            });
        });
    });

    afterEach(async () => {
        if (currentRenderer) {
            await ReactTestRenderer.act(async () => {
                currentRenderer?.unmount();
            });
            currentRenderer = undefined;
        }
        jest.restoreAllMocks();
    });

    it('不渲染麦克风图标和加号图标，未输入时不渲染发送按钮', async () => {
        await ReactTestRenderer.act(async () => {
            currentRenderer = ReactTestRenderer.create(<ChatScreen />);
        });

        const root = currentRenderer!.root;

        // MaterialIcons mock 会将 props.name 作为文字渲染
        const allTexts = root.findAllByType(Text).map((node) => node.props.children);
        expect(allTexts).not.toContain('mic');
        expect(allTexts).not.toContain('add');
        expect(allTexts).not.toContain('arrow-upward');
    });

    it('输入文字后渲染发送按钮，清空后隐藏', async () => {
        await ReactTestRenderer.act(async () => {
            currentRenderer = ReactTestRenderer.create(<ChatScreen />);
        });

        const root = currentRenderer!.root;
        const textInput = root.findByType(TextInput);

        await ReactTestRenderer.act(async () => {
            textInput.props.onChangeText('你好，绿天');
        });

        let allTexts = root.findAllByType(Text).map((node) => node.props.children);
        expect(allTexts).toContain('arrow-upward');

        await ReactTestRenderer.act(async () => {
            textInput.props.onChangeText('');
        });

        allTexts = root.findAllByType(Text).map((node) => node.props.children);
        expect(allTexts).not.toContain('arrow-upward');
    });

    it('页面始终不挂载多余的 headerRight 菜单，顶部保持纯粹', async () => {
        await ReactTestRenderer.act(async () => {
            currentRenderer = ReactTestRenderer.create(<ChatScreen />);
        });
        expect(currentRenderer).toBeDefined();

        expect(mockSetOptions).not.toHaveBeenCalled();
    });
});
