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
    let currentRenderer: ReactTestRenderer.ReactTestRenderer | undefined;

    beforeEach(async () => {
        jest.clearAllMocks();
        currentRenderer = undefined;
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

    it('渲染加号按钮，不渲染麦克风图标，未输入时不渲染发送按钮', async () => {
        await ReactTestRenderer.act(async () => {
            currentRenderer = ReactTestRenderer.create(<ChatScreen />);
        });

        const root = currentRenderer!.root;

        // MaterialIcons mock 会将 props.name 作为文字渲染
        const allTexts = root.findAllByType(Text).map((node) => node.props.children);
        expect(allTexts).toContain('add');
        expect(allTexts).not.toContain('mic');
        expect(allTexts).not.toContain('arrow-upward');
    });

    it('点击加号弹出文件与图片选择菜单，且 options 支持 cancelable', async () => {
        const alertSpy = jest.spyOn(Alert, 'alert');
        await ReactTestRenderer.act(async () => {
            currentRenderer = ReactTestRenderer.create(<ChatScreen />);
        });

        const root = currentRenderer!.root;
        const buttons = root.findAllByType(TouchableOpacity);
        const plusButton = buttons.find((btn) => btn.props.accessibilityLabel === '添加内容' || btn.props.accessibilityLabel === 'Add Content');
        expect(plusButton).toBeDefined();

        await ReactTestRenderer.act(async () => {
            plusButton!.props.onPress();
        });

        expect(alertSpy).toHaveBeenCalledWith(
            expect.stringMatching(/添加内容|Add Content/i),
            undefined,
            expect.arrayContaining([
                expect.objectContaining({ text: expect.stringMatching(/图片|Image/i) }),
                expect.objectContaining({ text: expect.stringMatching(/文件|File/i) }),
            ]),
            { cancelable: true },
        );
        alertSpy.mockRestore();
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

    it('当 AI 执行任务中且输入框为空时，渲染停止正方形且不渲染黄色悬浮条；输入内容切换为发送箭头', async () => {
        const stopSpy = jest.spyOn(AssistantClient.getInstance(), 'stopExecution').mockReturnValue(true);
        await ReactTestRenderer.act(async () => {
            useAssistantStore.setState({
                taskState: 'processing',
            });
        });

        await ReactTestRenderer.act(async () => {
            currentRenderer = ReactTestRenderer.create(<ChatScreen />);
        });

        const root = currentRenderer!.root;

        // 1. 验证黄色悬浮条不再出现
        const allTexts = root.findAllByType(Text).map((node) => node.props.children);
        expect(allTexts.some((t) => typeof t === 'string' && /助理正在执行任务/.test(t))).toBe(false);

        // 2. 验证右侧存在停止正方形按钮
        const buttons = root.findAllByType(TouchableOpacity);
        const stopButton = buttons.find((btn) => /停止执行|Stop/i.test(btn.props.accessibilityLabel));
        expect(stopButton).toBeDefined();

        // 3. 点击停止按钮触发 stopExecution
        await ReactTestRenderer.act(async () => {
            stopButton!.props.onPress();
        });
        expect(stopSpy).toHaveBeenCalledTimes(1);

        // 4. 输入文字后切换为发送按钮，停止按钮暂时隐藏
        const textInput = root.findByType(TextInput);
        await ReactTestRenderer.act(async () => {
            textInput.props.onChangeText('新指令');
        });

        const updatedTexts = root.findAllByType(Text).map((node) => node.props.children);
        expect(updatedTexts).toContain('arrow-upward');

        const updatedButtons = root.findAllByType(TouchableOpacity);
        const updatedStopBtn = updatedButtons.find((btn) => /停止执行|Stop/i.test(btn.props.accessibilityLabel));
        expect(updatedStopBtn).toBeUndefined();

        // 5. 清空文字后，停止按钮重新恢复
        await ReactTestRenderer.act(async () => {
            textInput.props.onChangeText('');
        });
        const finalButtons = root.findAllByType(TouchableOpacity);
        const finalStopBtn = finalButtons.find((btn) => /停止执行|Stop/i.test(btn.props.accessibilityLabel));
        expect(finalStopBtn).toBeDefined();

        stopSpy.mockRestore();
    });

    it('页面始终不挂载多余的 headerRight 菜单，顶部保持纯粹', async () => {
        await ReactTestRenderer.act(async () => {
            currentRenderer = ReactTestRenderer.create(<ChatScreen />);
        });
        expect(currentRenderer).toBeDefined();

        expect(mockSetOptions).not.toHaveBeenCalled();
    });

    it('正确渲染消息气泡中的图片和文件附件', async () => {
        await ReactTestRenderer.act(async () => {
            useAssistantStore.setState({
                messages: [
                    {
                        id: 'msg-img',
                        seq: 1,
                        role: 'user',
                        content: '这是图片',
                        timestamp: Date.now(),
                        status: 'sent',
                        attachments: [
                            {
                                type: 'image',
                                name: 'photo.jpg',
                                mimeType: 'image/jpeg',
                                data: 'base64data',
                            },
                        ],
                    },
                    {
                        id: 'msg-file',
                        seq: 2,
                        role: 'user',
                        content: '这是文件',
                        timestamp: Date.now(),
                        status: 'sent',
                        attachments: [
                            {
                                type: 'file',
                                name: 'document.pdf',
                            },
                        ],
                    },
                ],
            });
            currentRenderer = ReactTestRenderer.create(<ChatScreen />);
        });

        const root = currentRenderer!.root;
        const allTexts = root.findAllByType(Text).map((node) => node.props.children);
        expect(allTexts).toContain('document.pdf');
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
            currentRenderer = ReactTestRenderer.create(<ChatScreen />);
        });

        const root = currentRenderer!.root;
        const allTexts = root.findAllByType(Text).map((node) => node.props.children);
        expect(allTexts.some((t) => typeof t === 'string' && /服务端正在升级|Server is updating/.test(t))).toBe(true);
        expect(allTexts.some((t) => typeof t === 'string' && /服务未连接|Disconnected/.test(t))).toBe(false);
    });
});
