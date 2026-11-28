import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { FlatList, Keyboard, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import * as Reanimated from 'react-native-reanimated';
import { ChatBubbleReveal } from '../src/components/ChatBubbleReveal';
import { ChatMessageMenu } from '../src/components/ChatMessageMenu';
import { TypingIndicator } from '../src/components/TypingIndicator';
import * as Clipboard from 'expo-clipboard';
import { ChatScreen } from '../src/screens/ChatScreen';
import { useAssistantStore } from '../src/store/useAssistantStore';
import { AssistantClient } from '../src/services/AssistantClient';
import i18n from '../src/i18n';
import * as chatNotifications from '../src/services/chatNotifications';

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

    it('opens and copies the exact older reply when its notification is tapped', async () => {
        const serverUrl = 'http://localhost:8080';
        const serverToken = 'selected-server';
        const target = { messageId: 'from-notification',
            serverIdentity: chatNotifications.chatServerIdentity(serverUrl, serverToken) };
        const older = { id: target.messageId, role: 'assistant', status: 'done',
            content: 'The exact reply', seq: 1, timestamp: 1 } as const;
        const recent = { ...older, id: 'more-recent', seq: 2, timestamp: 2 };
        const getReply = jest.spyOn(chatNotifications, 'readNotificationReply').mockResolvedValue(older);
        const scroll = jest.spyOn(FlatList.prototype, 'scrollToIndex').mockImplementation(() => {});
        const copy = jest.spyOn(Clipboard, 'setStringAsync').mockResolvedValue(true);
        await ReactTestRenderer.act(async () => {
            useAssistantStore.setState({ serverUrl, serverToken, credentialsStatus: 'ready', messages: [recent] });
            currentRenderer = ReactTestRenderer.create(<ChatScreen route={{
                name: 'ChatScreen', key: 'main-chat', params: { notificationTarget: target },
            }} />);
        });
        expect(getReply).toHaveBeenCalledWith(target, expect.anything());
        expect(currentRenderer!.root.findByType(FlatList).props.data).toEqual([recent, older]);
        await ReactTestRenderer.act(async () => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
        expect(scroll).toHaveBeenCalledWith({ index: 1, viewPosition: 0.5, animated: false });
        const root = currentRenderer!.root;
        const renderRow = () => root.findByType(FlatList).props.renderItem({ item: older, index: 1 });
        let row!: ReactTestRenderer.ReactTestRenderer;
        await ReactTestRenderer.act(async () => { row = ReactTestRenderer.create(renderRow()); });
        const press = () => ReactTestRenderer.act(async () => row.root
            .findAll(node => typeof node.props.onLongPress === 'function')[0]
            .props.onLongPress({ nativeEvent: { pageX: 50, pageY: 75 } }));
        await press();
        await ReactTestRenderer.act(async () => root.findByType(ChatMessageMenu).props.choose('copy'));
        expect(copy).toHaveBeenCalledWith(older.content);
        await press();
        await ReactTestRenderer.act(async () => root.findByType(ChatMessageMenu).props.choose('select'));
        await ReactTestRenderer.act(async () => row.update(renderRow()));
        expect(row.root.findAllByType(Text).some(node => node.props.selectable && node.props.children === older.content)).toBe(true);
        await ReactTestRenderer.act(async () => row.unmount());
    });

    it('长按待发气泡可编辑，收件后菜单即时更新，整条复制与局部选择共享原文', async () => {
        const content = '第一段\n\n`code`';
        const outgoing = { id: 'menu-test', seq: 0, role: 'user', status: 'sending', content, timestamp: 1 } as const;
        const copy = jest.spyOn(Clipboard, 'setStringAsync').mockResolvedValue(true);
        await ReactTestRenderer.act(async () => {
            useAssistantStore.setState({
                connectionState: 'disconnected', messages: [outgoing],
                pendingSendQueue: [{ sessionId: 'main', messageId: outgoing.id, content, attempted: false }],
            });
            currentRenderer = ReactTestRenderer.create(<ChatScreen />);
        });
        const root = currentRenderer!.root;
        // The Jest keyboard scroll host does not mount virtualized cells.
        const renderRow = () => root.findByType(FlatList).props.renderItem({
            item: useAssistantStore.getState().messages[0], index: 0,
        });
        let row!: ReactTestRenderer.ReactTestRenderer;
        await ReactTestRenderer.act(async () => { row = ReactTestRenderer.create(renderRow()); });
        const open = () => ReactTestRenderer.act(async () => row.root.findAll(node => typeof node.props.onLongPress === 'function')[0]
            .props.onLongPress({ nativeEvent: { pageX: 50, pageY: 75 } }));
        const actions = () => root.findByType(ChatMessageMenu).findAllByType(Text).map(node => node.props.children);
        const bubbleOpacity = () => StyleSheet.flatten(row.root.findAll(node => typeof node.props.onLongPress === 'function')[0].props.style).opacity;
        expect(bubbleOpacity()).toBe(0.5);
        await open();
        expect(actions()).toEqual(['copy', 'select', 'cancel', 'edit'].map(key => i18n.t('common.' + key)));
        await ReactTestRenderer.act(async () => {
            useAssistantStore.getState().setConnectionState('connected');
        });
        await ReactTestRenderer.act(async () => row.update(renderRow()));
        expect(bubbleOpacity()).toBe(0.5);
        await ReactTestRenderer.act(async () => {
            const store = useAssistantStore.getState();
            store.addToPendingSendQueue({ ...store.pendingSendQueue[0], attempted: true });
        });
        await ReactTestRenderer.act(async () => row.update(renderRow()));
        expect(bubbleOpacity()).toBeUndefined();
        await ReactTestRenderer.act(async () => {
            useAssistantStore.getState().setConnectionState('reconnecting');
        });
        await ReactTestRenderer.act(async () => row.update(renderRow()));
        expect(bubbleOpacity()).toBeUndefined();
        await ReactTestRenderer.act(async () => {
            useAssistantStore.getState().removeFromPendingSendQueue(outgoing.id);
            useAssistantStore.getState().addOrUpdateMessage({ ...outgoing, status: 'sent' });
        });
        expect(actions()).toEqual(['copy', 'select'].map(key => i18n.t('common.' + key)));
        await ReactTestRenderer.act(async () => root.findByType(ChatMessageMenu).props.choose('copy'));
        expect(copy).toHaveBeenCalledWith(content);
        await open();
        await ReactTestRenderer.act(async () => root.findByType(ChatMessageMenu).props.choose('select'));
        await ReactTestRenderer.act(async () => row.update(renderRow()));
        expect(row.root.findAllByType(Text).filter(node => node.props.selectable && node.props.children === content)).toHaveLength(1);
        await ReactTestRenderer.act(async () => row.unmount());
    });

    it('选择保留原 Markdown 节点、链接样式与时间，并将选词手势交给系统', async () => {
        const content = ['# 标题', '一段**加粗文字**', '- 列表项', '```js\nvalue\n```', '[链接](https://example.com)'].join('\n\n');
        const item = { id: 'rich-select', seq: 1, role: 'assistant', status: 'done', content, timestamp: 1 } as const;
        const copy = jest.spyOn(Clipboard, 'setStringAsync').mockResolvedValue(true);
        await ReactTestRenderer.act(async () => {
            useAssistantStore.setState({ messages: [item] });
            currentRenderer = ReactTestRenderer.create(<ChatScreen />);
        });
        const root = currentRenderer!.root;
        const renderRow = () => root.findByType(FlatList).props.renderItem({ item, index: 0 });
        let row!: ReactTestRenderer.ReactTestRenderer;
        await ReactTestRenderer.act(async () => { row = ReactTestRenderer.create(renderRow()); });
        const textNodes = () => row.root.findAllByType(Text);
        const leaves = textNodes().filter(node => ['标题', '加粗文字', '列表项', 'value', '链接'].includes(node.props.children));
        expect(leaves).toHaveLength(5);
        const link = textNodes().find(node => node.props.onLongPress)!;
        const clock = row.root.findByProps({ testID: 'markdown-bubble-time' });
        expect(leaves.every(node => node.props.selectable === false)).toBe(true);

        const open = () => ReactTestRenderer.act(async () =>
            link.props.onLongPress({ nativeEvent: { pageX: 10, pageY: 10 } }));
        await open();
        await ReactTestRenderer.act(async () => root.findByType(ChatMessageMenu).props.choose('copy'));
        expect(copy).toHaveBeenCalledWith(content);
        await open();
        await ReactTestRenderer.act(async () => root.findByType(ChatMessageMenu).props.choose('select'));
        await ReactTestRenderer.act(async () => row.update(renderRow()));

        expect(root.findAllByType(ChatMessageMenu)).toHaveLength(0);
        expect(row.root.findAll(node => typeof node.props.onPointerDown === 'function')[0].props.disabled).toBe(true);
        for (const leaf of leaves) {
            expect(textNodes()).toContain(leaf);
            expect(leaf.props.selectable).toBe(true);
        }
        expect(link.props.onLongPress).toBeUndefined();
        expect(link.props.onPress).toBeUndefined();
        expect(row.root.findByProps({ testID: 'markdown-bubble-time' })).toBe(clock);
        expect(clock.props.selectable).toBe(false);
        await ReactTestRenderer.act(async () => row.unmount());
    });

    it('渲染加号按钮和灰色禁用发送按钮，不渲染麦克风图标，输入上限为5000', async () => {
        await ReactTestRenderer.act(async () => {
            currentRenderer = ReactTestRenderer.create(<ChatScreen />);
        });

        const root = currentRenderer!.root;

        // MaterialIcons mock 会将 props.name 作为文字渲染
        const allTexts = root.findAllByType(Text).map((node) => node.props.children);
        expect(allTexts).toContain('add');
        expect(allTexts).not.toContain('mic');
        expect(allTexts).toContain('arrow-upward');
        expect(root.findByType(TextInput).props.maxLength).toBe(5000);
        const sendButton = root.findAllByType(TouchableOpacity).find((button) =>
            /^(发送|Send)$/.test(button.props.accessibilityLabel));
        expect(sendButton?.props.disabled).toBe(true);
        expect(sendButton?.props.onPress).toBeUndefined();
        expect(sendButton?.props.accessibilityState).toEqual({ disabled: true });
        expect(StyleSheet.flatten(sendButton!.props.style)).toMatchObject({
            width: 32, height: 32, backgroundColor: '#C4CBD6',
        });
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

    it('输入文字后启用蓝色发送按钮，清空或仅空白时恢复灰色禁用状态', async () => {
        await ReactTestRenderer.act(async () => {
            currentRenderer = ReactTestRenderer.create(<ChatScreen />);
        });

        const root = currentRenderer!.root;
        const textInput = root.findByType(TextInput);

        await ReactTestRenderer.act(async () => {
            textInput.props.onChangeText('你好，绿天');
        });

        const sendButton = () => root.findAllByType(TouchableOpacity).find((button) =>
            /^(发送|Send)$/.test(button.props.accessibilityLabel))!;
        expect(sendButton().props.disabled).not.toBe(true);
        expect(typeof sendButton().props.onPress).toBe('function');
        expect(StyleSheet.flatten(sendButton().props.style).backgroundColor).toBe('#60A5FA');

        for (const text of ['', '  \n\t']) {
            await ReactTestRenderer.act(async () => {
                textInput.props.onChangeText(text);
            });
            expect(sendButton().props.disabled).toBe(true);
            expect(StyleSheet.flatten(sendButton().props.style).backgroundColor).toBe('#C4CBD6');
        }
    });

    it('5000字符长消息完整交给客户端，发送后恢复禁用按钮', async () => {
        const send = jest.spyOn(AssistantClient.getInstance(), 'sendMessage').mockReturnValue('long-message');
        await ReactTestRenderer.act(async () => {
            currentRenderer = ReactTestRenderer.create(<ChatScreen />);
        });
        const root = currentRenderer!.root;
        const text = '日志'.repeat(2499) + '末尾';
        expect(text.length).toBe(5000);
        await ReactTestRenderer.act(async () => {
            root.findByType(TextInput).props.onChangeText(text);
        });
        const sendButton = () => root.findAllByType(TouchableOpacity).find((button) =>
            /^(发送|Send)$/.test(button.props.accessibilityLabel))!;
        await ReactTestRenderer.act(async () => {
            sendButton().props.onPress();
        });
        expect(send).toHaveBeenCalledWith(text, undefined);
        expect(root.findByType(TextInput).props.value).toBe('');
        expect(sendButton().props.disabled).toBe(true);
    });

    it.each([
        { offset: 0, reduced: false, enter: true },
        { offset: 0, reduced: true, enter: false },
        { offset: 160, reduced: false, enter: false },
    ])('发送过渡按当前列表位置和减少动态效果决定（%o）', async ({ offset, reduced, enter }) => {
        jest.spyOn(Reanimated, 'useReducedMotion').mockReturnValue(reduced);
        const scroll = jest.spyOn(FlatList.prototype, 'scrollToOffset').mockImplementation(() => {});
        const prev = { id: 'old', seq: 1, role: 'user', content: '上一条', status: 'sent', timestamp: Date.now() } as const;
        await ReactTestRenderer.act(async () => {
            useAssistantStore.setState({ messages: [prev], pendingSendQueue: [] });
            currentRenderer = ReactTestRenderer.create(<ChatScreen />);
        });
        const root = currentRenderer!.root;
        const list = () => root.findByType(FlatList);
        await ReactTestRenderer.act(async () => {
            list().props.onScroll({ nativeEvent: { contentOffset: { x: 0, y: offset } } });
            root.findByType(TextInput).props.onChangeText('好');
        });
        const send = root.findAllByType(TouchableOpacity).find(button =>
            /^(发送|Send)$/.test(button.props.accessibilityLabel) && typeof button.props.onPress === 'function')!;
        await ReactTestRenderer.act(async () => send.props.onPress());

        if (offset === 0) expect(scroll).not.toHaveBeenCalled();
        else expect(scroll).toHaveBeenCalledWith({ offset: 0, animated: true });
        expect(list().props.ListHeaderComponent).toBeUndefined();
        expect(list().props.data.map((message: { content: string }) => message.content)).toEqual(['好', '上一条']);

        const rows = () => root.findAllByType(ChatBubbleReveal);
        expect(rows()).toHaveLength(2);
        expect(typeof rows()[0].props.consumeEntrance === 'function').toBe(enter);
        expect(rows()[1].props.consumeEntrance).toBeUndefined();

        await ReactTestRenderer.act(async () => {
            const confirmed = { ...list().props.data[0], status: 'sent', seq: 2 } as const;
            useAssistantStore.getState().addOrUpdateMessage(confirmed);
            useAssistantStore.getState().removeFromPendingSendQueue(confirmed.id);
        });
        expect(rows()[0].props.consumeEntrance).toBeUndefined();
    });

    it.each(['processing', 'queued', 'error', 'disconnected'] as const)('在线发送保持箭头底色，按实际状态 %s 恢复操作', async (outcome) => {
        const outgoing = { id: 'submitted', role: 'user', content: '你好', status: 'sending', seq: 0, timestamp: Date.now() } as const;
        jest.spyOn(AssistantClient.getInstance(), 'sendMessage').mockImplementation(() => {
            useAssistantStore.getState().addOrUpdateMessage(outgoing);
            return outgoing.id;
        });
        await ReactTestRenderer.act(async () => {
            currentRenderer = ReactTestRenderer.create(<ChatScreen />);
        });
        const root = currentRenderer!.root;
        const sendButton = () => root.findAllByType(TouchableOpacity).find(button =>
            /^(发送|Send)$/.test(button.props.accessibilityLabel))!;
        const color = () => StyleSheet.flatten(sendButton().props.style).backgroundColor;
        await ReactTestRenderer.act(async () => root.findByType(TextInput).props.onChangeText(outgoing.content));
        await ReactTestRenderer.act(async () => sendButton().props.onPress());
        expect(sendButton().props.disabled).toBe(true);
        expect(sendButton().props.onPress).toBeUndefined();
        expect(color()).toBe('#60A5FA');
        if (outcome === 'processing') {
            await ReactTestRenderer.act(async () => useAssistantStore.getState().addOrUpdateMessage({ ...outgoing, status: 'sent' }));
            expect(color()).toBe('#60A5FA');
            await ReactTestRenderer.act(async () => useAssistantStore.getState().setTaskState('processing'));
            expect(root.findAllByType(TouchableOpacity).some(button => /停止执行|Stop/i.test(button.props.accessibilityLabel))).toBe(true);
        } else {
            await ReactTestRenderer.act(async () => {
                if (outcome === 'disconnected') useAssistantStore.getState().setConnectionState(outcome);
                else useAssistantStore.getState().addOrUpdateMessage({ ...outgoing, status: outcome });
            });
            expect(color()).toBe('#C4CBD6');
        }
    });

    it('服务端开始处理满 1 秒才显示三点，短任务结束后不会出现旧提示', async () => {
        jest.useFakeTimers();
        try {
            await ReactTestRenderer.act(async () => {
                currentRenderer = ReactTestRenderer.create(<ChatScreen />);
            });
            const header = () => currentRenderer!.root.findByType(FlatList).props.ListHeaderComponent;
            const setTaskState = (state: 'processing' | 'completed') => ReactTestRenderer.act(async () => {
                useAssistantStore.getState().setTaskState(state);
            });
            const advanceTime = (duration: number) => ReactTestRenderer.act(async () => {
                jest.advanceTimersByTime(duration);
            });

            expect(header()).toBeUndefined();
            await setTaskState('processing');
            await advanceTime(999);
            expect(header()).toBeUndefined();
            await setTaskState('completed');
            await setTaskState('processing');
            await advanceTime(999);
            expect(header()).toBeUndefined();
            await advanceTime(1);
            expect(header()?.type).toBe(TypingIndicator);
            await setTaskState('completed');
            expect(header()).toBeUndefined();
        } finally {
            jest.useRealTimers();
        }
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
        expect(StyleSheet.flatten(stopButton!.props.style)).toMatchObject({
            width: 32, height: 32, borderRadius: 16, backgroundColor: '#60A5FA',
        });
        const square = stopButton!.findAllByType(View).find((node) =>
            StyleSheet.flatten(node.props.style)?.width === 12);
        expect(square).toBeDefined();
        expect(StyleSheet.flatten(square!.props.style)).toMatchObject({
            width: 12, height: 12, borderRadius: 2, backgroundColor: '#FFFFFF',
        });

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

    it('任务超时沿用本地化错误提示，不向用户显示内部错误码', async () => {
        await ReactTestRenderer.act(async () => {
            useAssistantStore.setState({
                taskState: 'error',
                messages: [{
                    id: 'timeout-message',
                    seq: 1,
                    role: 'assistant',
                    content: '',
                    timestamp: Date.now(),
                    status: 'error',
                    errorMessage: 'task_timeout',
                }],
            });
            currentRenderer = ReactTestRenderer.create(<ChatScreen />);
        });
        const texts = currentRenderer!.root.findAllByType(Text).map((node) => node.props.children);
        expect(texts).not.toContain('task_timeout');
        expect(texts).toContain(i18n.t('assistant.errorEngineError'));
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

    it('键入 / 弹出斜杠建议菜单（包含 /new 与技能列表），点击 /new 触发会话重置并展示 Toast', async () => {
        const resetSpy = jest.spyOn(AssistantClient.getInstance(), 'resetSession').mockResolvedValue(true);

        await ReactTestRenderer.act(async () => {
            useAssistantStore.setState({
                skills: [
                    { name: 'vps-ops', description: 'VPS 运维规程' },
                    { name: 'expo-app-release', description: 'Expo 发版' },
                ],
            });
            currentRenderer = ReactTestRenderer.create(<ChatScreen />);
        });

        const root = currentRenderer!.root;
        const input = root.findByType(TextInput);

        // 未输入时不显示斜杠菜单
        expect(root.findAll((node) => node.props.style && node.props.style.maxHeight === 220).length).toBe(0);

        // 键入 /
        await ReactTestRenderer.act(async () => {
            input.props.onChangeText('/');
        });

        // 包含 /new、/vps-ops、/expo-app-release
        const allTextsAfterSlash = root.findAllByType(Text).map((node) => node.props.children);
        expect(allTextsAfterSlash).toContain('/new');
        expect(allTextsAfterSlash).toContain('/vps-ops');
        expect(allTextsAfterSlash).toContain('/expo-app-release');

        // 点击 /new 菜单项
        const newMenuItem = root.findAllByType(TouchableOpacity).find((touch) => {
            return touch.findAllByType(Text).some((t) => t.props.children === '/new');
        });
        expect(newMenuItem).toBeDefined();

        await ReactTestRenderer.act(async () => {
            newMenuItem!.props.onPress();
        });

        expect(resetSpy).toHaveBeenCalledWith();
        // 浮动 Toast 气泡弹出
        const allTextsAfterReset = root.findAllByType(Text).map((node) => String(node.props.children));
        expect(allTextsAfterReset.some((txt) => /上下文已重置|Context has been reset/i.test(txt))).toBe(true);
    });

    it('直接在输入框输入 /new 并点击发送，拦截为重置会话，不作为普通文本发送', async () => {
        const resetSpy = jest.spyOn(AssistantClient.getInstance(), 'resetSession').mockResolvedValue(true);
        const sendSpy = jest.spyOn(AssistantClient.getInstance(), 'sendMessage');

        await ReactTestRenderer.act(async () => {
            currentRenderer = ReactTestRenderer.create(<ChatScreen />);
        });

        const root = currentRenderer!.root;
        const input = root.findByType(TextInput);

        await ReactTestRenderer.act(async () => {
            input.props.onChangeText('/new');
        });

        const sendBtn = root.findAllByType(TouchableOpacity).find((btn) => {
            return /发送|Send/i.test(btn.props.accessibilityLabel);
        });
        expect(sendBtn).toBeDefined();

        await ReactTestRenderer.act(async () => {
            sendBtn!.props.onPress();
        });

        expect(resetSpy).toHaveBeenCalled();
        expect(sendSpy).not.toHaveBeenCalled();
        const allTexts = root.findAllByType(Text).map((node) => String(node.props.children));
        expect(allTexts.some((txt) => /上下文已重置|Context has been reset/i.test(txt))).toBe(true);
    });

    it('点击技能卡片自动补全命令名称及空格', async () => {
        await ReactTestRenderer.act(async () => {
            useAssistantStore.setState({
                skills: [{ name: 'vps-ops', description: 'VPS 运维规程' }],
            });
            currentRenderer = ReactTestRenderer.create(<ChatScreen />);
        });

        const root = currentRenderer!.root;
        const input = root.findByType(TextInput);

        await ReactTestRenderer.act(async () => {
            input.props.onChangeText('/vp');
        });

        const skillMenuItem = root.findAllByType(TouchableOpacity).find((touch) => {
            return touch.findAllByType(Text).some((t) => t.props.children === '/vps-ops');
        });
        expect(skillMenuItem).toBeDefined();

        await ReactTestRenderer.act(async () => {
            skillMenuItem!.props.onPress();
        });

        expect(input.props.value).toBe('/vps-ops ');
    });

    it('/new 重置失败时提示失败 Toast，不误报成功', async () => {
        jest.spyOn(AssistantClient.getInstance(), 'resetSession').mockResolvedValue(false);

        await ReactTestRenderer.act(async () => {
            currentRenderer = ReactTestRenderer.create(<ChatScreen />);
        });

        const root = currentRenderer!.root;
        const input = root.findByType(TextInput);

        await ReactTestRenderer.act(async () => {
            input.props.onChangeText('/new');
        });

        const sendBtn = root.findAllByType(TouchableOpacity).find((btn) => {
            return /发送|Send/i.test(btn.props.accessibilityLabel);
        });

        await ReactTestRenderer.act(async () => {
            sendBtn!.props.onPress();
        });

        const allTexts = root.findAllByType(Text).map((node) => String(node.props.children));
        expect(allTexts.some((txt) => /重置上下文失败|Failed to reset context/i.test(txt))).toBe(true);
        expect(allTexts.some((txt) => /上下文已重置|Context has been reset/i.test(txt))).toBe(false);
    });

    it('发送失败维持气泡原颜色，仅在气泡外下方显示重发且长按菜单一致', async () => {
        const outgoing = { id: 'user-failed', seq: 0, role: 'user', status: 'error', content: '待重发消息', timestamp: 1 } as const;
        const beforeFirstSend = { ...outgoing, id: 'user-failed-before-send' };
        const retrySpy = jest.spyOn(AssistantClient.getInstance(), 'retryPendingMessage')
            .mockResolvedValueOnce({ ok: false, errorMessage: i18n.t('chat.retryAttachmentFailed') })
            .mockResolvedValueOnce({ ok: true });

        await ReactTestRenderer.act(async () => {
            useAssistantStore.setState({
                messages: [
                    outgoing,
                    { id: 'user-sending', seq: 0, role: 'user', status: 'sending', content: '发送中', timestamp: 2 },
                    { id: 'user-sent', seq: 1, role: 'user', status: 'sent', content: '已发送', timestamp: 3 },
                    { id: 'user-stopped', seq: 2, role: 'user', status: 'error', errorMessage: 'task_stopped', content: '被停止', timestamp: 4 },
                    beforeFirstSend,
                ],
                pendingSendQueue: [
                    { sessionId: 'main', messageId: outgoing.id, content: outgoing.content, failed: true, attempted: true },
                    { sessionId: 'main', messageId: 'user-sending', content: '发送中', submittedOnline: true, attempted: false },
                    { sessionId: 'main', messageId: beforeFirstSend.id, content: beforeFirstSend.content, failed: true, attempted: false },
                ],
            });
            currentRenderer = ReactTestRenderer.create(<ChatScreen />);
        });

        const root = currentRenderer!.root;
        const renderItem = root.findByType(FlatList).props.renderItem;
        let failedRow!: ReactTestRenderer.ReactTestRenderer;
        await ReactTestRenderer.act(async () => {
            failedRow = ReactTestRenderer.create(renderItem({ item: outgoing, index: 0 }));
        });

        // 发送过的失败气泡保持正常颜色，重发按钮位于气泡外下方。
        const pressable = failedRow.root.findAll(node => typeof node.props.onLongPress === 'function')[0];
        expect(StyleSheet.flatten(pressable.props.style).opacity).toBeUndefined();
        const bubble = failedRow.root.findByProps({ testID: `user-bubble-${outgoing.id}` });
        expect(bubble.findAllByType(Text).map(n => n.props.children)).not.toContain(i18n.t('chat.resend'));
        expect(bubble.findAllByType(Text).map(n => n.props.children)).not.toContain(i18n.t('chat.retryAttachmentFailed'));

        const resendBtn = failedRow.root.findByProps({ testID: `resend-message-${outgoing.id}` });
        expect(resendBtn.findAllByType(Text).map(n => n.props.children)).toEqual([i18n.t('chat.resend')]);

        // 长按仍打开包含 copy / select / cancel / edit 的完整菜单
        await ReactTestRenderer.act(async () => {
            pressable.props.onLongPress({ nativeEvent: { pageX: 40, pageY: 80 } });
        });
        const menuLabels = root.findByType(ChatMessageMenu).findAllByType(Text).map(node => node.props.children);
        expect(menuLabels).toEqual(['copy', 'select', 'cancel', 'edit'].map(key => i18n.t(`common.${key}`)));
        await ReactTestRenderer.act(async () => {
            root.findByType(ChatMessageMenu).props.close();
        });

        // 点击重发：若附件损坏则弹轻提示，气泡仍不动
        await ReactTestRenderer.act(async () => {
            await resendBtn.props.onPress();
        });
        expect(retrySpy).toHaveBeenCalledWith(outgoing.id);
        expect(root.findAllByType(Text).map(n => n.props.children)).toContain(i18n.t('chat.retryAttachmentFailed'));

        // 第二次点击重发成功
        await ReactTestRenderer.act(async () => {
            await resendBtn.props.onPress();
        });
        expect(retrySpy).toHaveBeenCalledTimes(2);
        await ReactTestRenderer.act(async () => failedRow.unmount());

        let unsentRow!: ReactTestRenderer.ReactTestRenderer;
        await ReactTestRenderer.act(async () => {
            unsentRow = ReactTestRenderer.create(renderItem({ item: beforeFirstSend, index: 0 }));
        });
        const unsentBubble = unsentRow.root.findAll(node => typeof node.props.onLongPress === 'function')[0];
        expect(StyleSheet.flatten(unsentBubble.props.style).opacity).toBe(0.5);
        expect(unsentRow.root.findByProps({ testID: `resend-message-${beforeFirstSend.id}` })).toBeDefined();
        await ReactTestRenderer.act(async () => unsentRow.unmount());

        // 发送中、已发送及服务端已受理但被停止的用户消息均不显示重发按钮
        for (const msg of useAssistantStore.getState().messages.slice(1, -1)) {
            let otherRow!: ReactTestRenderer.ReactTestRenderer;
            await ReactTestRenderer.act(async () => {
                otherRow = ReactTestRenderer.create(renderItem({ item: msg, index: 0 }));
            });
            const otherBubble = otherRow.root.findAll(node => typeof node.props.onLongPress === 'function')[0];
            expect(StyleSheet.flatten(otherBubble.props.style).opacity).toBeUndefined();
            expect(otherRow.root.findAllByProps({ testID: `resend-message-${msg.id}` })).toHaveLength(0);
            await ReactTestRenderer.act(async () => otherRow.unmount());
        }
    });

});
