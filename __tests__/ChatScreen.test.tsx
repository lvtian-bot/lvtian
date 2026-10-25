import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { FlatList, Keyboard, Text, TextInput, TouchableOpacity } from 'react-native';
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

    it('点击加号展开轻量悬浮气泡菜单，渲染图片与文件选项；再次点击或选择后收起', async () => {
        await ReactTestRenderer.act(async () => {
            currentRenderer = ReactTestRenderer.create(<ChatScreen />);
        });

        const root = currentRenderer!.root;
        const plusButton = root.findAllByType(TouchableOpacity).find(
            (btn) => btn.props.accessibilityLabel === '添加内容' || btn.props.accessibilityLabel === 'Add Content'
        );
        expect(plusButton).toBeDefined();

        // 默认未展开气泡
        let texts = root.findAllByType(Text).map((node) => node.props.children);
        expect(texts.some((t) => typeof t === 'string' && /图片|Image/.test(t))).toBe(false);

        // 点击加号展开气泡
        await ReactTestRenderer.act(async () => {
            plusButton!.props.onPress();
        });

        texts = root.findAllByType(Text).map((node) => node.props.children);
        expect(texts.some((t) => typeof t === 'string' && /图片|Image/.test(t))).toBe(true);
        expect(texts.some((t) => typeof t === 'string' && /文件|File/.test(t))).toBe(true);

        // 再次点击加号（此时呈关闭状态）后收起气泡
        await ReactTestRenderer.act(async () => {
            plusButton!.props.onPress();
        });

        texts = root.findAllByType(Text).map((node) => node.props.children);
        expect(texts.some((t) => typeof t === 'string' && /图片|Image/.test(t))).toBe(false);
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

        // 2. 验证右侧存在停止正方形按钮，且呈现浅蓝色圆形背景与内部白色方块
        const buttons = root.findAllByType(TouchableOpacity);
        const stopButton = buttons.find((btn) => /停止执行|Stop/i.test(btn.props.accessibilityLabel));
        expect(stopButton).toBeDefined();
        expect(stopButton!.props.style).toEqual(
            expect.objectContaining({
                backgroundColor: '#60A5FA',
                borderRadius: 16,
            })
        );
        const squareChild = stopButton!.props.children;
        expect(squareChild.props.style).toEqual(
            expect.objectContaining({
                backgroundColor: '#FFFFFF',
                borderRadius: 2,
            })
        );

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
    it('键盘位移不显示回底箭头，连续主动上滑达到距离才显示并可回底隐藏', async () => {
        const keyboardCallbacks = new Map<string, () => void>();
        jest.spyOn(Keyboard, 'addListener').mockImplementation((name, callback) => {
            keyboardCallbacks.set(name, callback as () => void);
            return { remove: jest.fn() };
        });
        await ReactTestRenderer.act(async () => {
            currentRenderer = ReactTestRenderer.create(<ChatScreen />);
        });
        const root = currentRenderer!.root;
        const list = () => root.findByType(FlatList);
        const event = (y: number) => ({ nativeEvent: { contentOffset: { y } } });
        const hasArrow = () => root.findAllByType(Text).some((node) => node.props.children === 'arrow-downward');
        await ReactTestRenderer.act(async () => {
            keyboardCallbacks.get('keyboardDidShow')?.();
            list().props.onScroll(event(320));
        });
        expect(hasArrow()).toBe(false);
        await ReactTestRenderer.act(async () => {
            list().props.onScrollBeginDrag(event(320));
            list().props.onScroll(event(380));
            list().props.onScrollEndDrag();
        });
        expect(hasArrow()).toBe(false);
        await ReactTestRenderer.act(async () => {
            list().props.onScrollBeginDrag(event(380));
            list().props.onScroll(event(430));
            list().props.onScrollEndDrag();
        });
        expect(hasArrow()).toBe(true);
        await ReactTestRenderer.act(async () => {
            keyboardCallbacks.get('keyboardDidHide')?.();
            list().props.onScroll(event(200));
        });
        expect(hasArrow()).toBe(true);
        const arrowButton = root.findAllByType(TouchableOpacity).find((button) =>
            button.findAllByType(Text).some((node) => node.props.children === 'arrow-downward'));
        await ReactTestRenderer.act(async () => arrowButton!.props.onPress());
        expect(hasArrow()).toBe(false);

        // Interactive dismissal must rebase keyboard movement, not cancel the ongoing drag.
        await ReactTestRenderer.act(async () => {
            list().props.onScrollBeginDrag(event(0));
            keyboardCallbacks.get('keyboardWillHide')?.();
            list().props.onScroll(event(320));
            keyboardCallbacks.get('keyboardDidHide')?.();
            list().props.onScroll(event(350));
        });
        expect(hasArrow()).toBe(false);
        await ReactTestRenderer.act(async () => list().props.onScroll(event(451)));
        expect(hasArrow()).toBe(true);
        await ReactTestRenderer.act(async () => {
            list().props.onScrollEndDrag();
            list().props.onScroll(event(0));
        });
        expect(hasArrow()).toBe(false);
    });

});
