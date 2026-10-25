import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { Alert, Text, TextInput, TouchableOpacity } from 'react-native';
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
    let activeRenderer: ReactTestRenderer.ReactTestRenderer | undefined;

    beforeEach(async () => {
        jest.clearAllMocks();
        activeRenderer = undefined;
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
        if (activeRenderer) {
            await ReactTestRenderer.act(async () => {
                activeRenderer?.unmount();
            });
            activeRenderer = undefined;
        }
        jest.restoreAllMocks();
    });

    it('不渲染麦克风图标和加号图标，未输入时不渲染发送按钮', async () => {
        await ReactTestRenderer.act(async () => {
            activeRenderer = ReactTestRenderer.create(<ChatScreen />);
        });

        const root = activeRenderer!.root;

        // MaterialIcons mock 会将 props.name 作为文字渲染
        const allTexts = root.findAllByType(Text).map((node) => node.props.children);
        expect(allTexts).not.toContain('mic');
        expect(allTexts).not.toContain('add');
        expect(allTexts).not.toContain('arrow-upward');
    });

    it('输入文字后渲染发送按钮，清空后隐藏', async () => {
        await ReactTestRenderer.act(async () => {
            activeRenderer = ReactTestRenderer.create(<ChatScreen />);
        });

        const root = activeRenderer!.root;
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

    it('连接存在时通过 navigation.setOptions 挂载 headerRight 更多菜单', async () => {
        const alertSpy = jest.spyOn(Alert, 'alert');
        await ReactTestRenderer.act(async () => {
            activeRenderer = ReactTestRenderer.create(<ChatScreen />);
        });
        expect(activeRenderer).toBeDefined();

        expect(mockSetOptions).toHaveBeenCalled();
        const lastCall = mockSetOptions.mock.calls[mockSetOptions.mock.calls.length - 1][0];
        expect(typeof lastCall.headerRight).toBe('function');

        // 渲染 headerRight 组件并点击
        let headerRightRenderer: ReactTestRenderer.ReactTestRenderer | undefined;
        await ReactTestRenderer.act(async () => {
            headerRightRenderer = ReactTestRenderer.create(lastCall.headerRight());
        });
        const button = headerRightRenderer!.root.findByType(TouchableOpacity);

        await ReactTestRenderer.act(async () => {
            button.props.onPress();
        });

        expect(alertSpy).toHaveBeenCalledWith(
            expect.stringMatching(/操作|Quick Actions/i),
            undefined,
            expect.arrayContaining([
                expect.objectContaining({ text: expect.stringMatching(/清空聊天记录|Clear Chat History/i) }),
                expect.objectContaining({ text: expect.stringMatching(/助理服务配置|Assistant Connection/i) }),
            ]),
        );
        await ReactTestRenderer.act(async () => {
            headerRightRenderer?.unmount();
        });
        alertSpy.mockRestore();
    });

    it('未配置 serverUrl 时不挂载 headerRight', async () => {
        await ReactTestRenderer.act(async () => {
            useAssistantStore.setState({
                serverUrl: '',
            });
        });

        await ReactTestRenderer.act(async () => {
            activeRenderer = ReactTestRenderer.create(<ChatScreen />);
        });
        expect(activeRenderer).toBeDefined();

        expect(mockSetOptions).toHaveBeenCalled();
        const lastCall = mockSetOptions.mock.calls[mockSetOptions.mock.calls.length - 1][0];
        expect(lastCall.headerRight).toBeUndefined();
    });

    it('处于服务端升级状态时展示温和升级横幅，隐藏常规断开条', async () => {
        await ReactTestRenderer.act(async () => {
            useAssistantStore.setState({
                serverUrl: 'http://localhost:8080',
                connectionState: 'disconnected',
                isServerUpgrading: true,
            });
        });

        await ReactTestRenderer.act(async () => {
            activeRenderer = ReactTestRenderer.create(<ChatScreen />);
        });

        const root = activeRenderer!.root;
        const allTexts = root.findAllByType(Text).map((node) => node.props.children);
        expect(allTexts.some((t) => typeof t === 'string' && /服务端正在升级|Server is updating/.test(t))).toBe(true);
        expect(allTexts.some((t) => typeof t === 'string' && /服务未连接|Disconnected/.test(t))).toBe(false);
    });
});
