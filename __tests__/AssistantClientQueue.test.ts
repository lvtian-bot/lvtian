import AsyncStorage from '@react-native-async-storage/async-storage';
import { AssistantClient } from '../src/services/AssistantClient';
import { readOutbox, writeOutbox } from '../src/services/chatOutbox';
import { fsService } from '../src/services/FileSystemService';
import { readOperationReports, resetOperationDiagnosticsState } from '../src/services/operationDiagnostics';
import { useAssistantStore } from '../src/store/useAssistantStore';
import { AssistantMessage, ServerMessage } from '../src/types/assistantProtocol';
import i18n from '../src/i18n';

describe('AssistantClient 离线乐观排队与服务端优雅升级感知', () => {
    let client: AssistantClient;

    beforeEach(() => {
        client = AssistantClient.getInstance();
        useAssistantStore.setState({
            serverUrl: 'http://127.0.0.1:3000',
            serverToken: 'test-token',
            credentialsStatus: 'ready',
            credentialsError: null,
            outboxStatus: 'ready',
            connectionState: 'disconnected',
            isServerUpgrading: false,
            messages: [],
            pendingSendQueue: [],
            pendingCancelQueue: [],
            currentSeq: 0,
            clearedSeq: 0,
        });
    });

    afterEach(() => {
        client.disconnect();
    });

    test('离线或升级期间 sendMessage 乐观上屏且进入 pendingSendQueue，绝不标错', () => {
        // 处于 disconnected 状态
        const msgId = client.sendMessage('离线发送的消息');

        const state = useAssistantStore.getState();
        expect(state.messages.length).toBe(1);
        const localMsg = state.messages[0];
        expect(localMsg.id).toBe(msgId);
        expect(localMsg.content).toBe('离线发送的消息');
        expect(localMsg.status).toBe('sending');
        expect(localMsg.errorMessage).toBeUndefined();

        // 验证已进入待发队列
        expect(state.pendingSendQueue.length).toBe(1);
        expect(state.pendingSendQueue[0].messageId).toBe(msgId);
        expect(state.pendingSendQueue[0].content).toBe('离线发送的消息');
    });

    test('5000字符长消息离线入队并在重连后完整补发', () => {
        const content = '日志'.repeat(2499) + '末尾';
        const messageId = client.sendMessage(content);
        expect(useAssistantStore.getState().messages[0].content).toBe(content);
        expect(useAssistantStore.getState().pendingSendQueue[0].content).toBe(content);
        const sendRaw = jest.spyOn(client as unknown as { sendRaw: () => boolean }, 'sendRaw')
            .mockReturnValue(true);
        try {
            useAssistantStore.setState({ connectionState: 'connected', taskState: 'idle' });
            client.flushPendingSendQueue();
            expect(sendRaw).toHaveBeenCalledWith(expect.objectContaining({
                type: 'chat', messageId, content,
            }));
            expect(useAssistantStore.getState().pendingSendQueue[0].content).toBe(content);
        } finally {
            sendRaw.mockRestore();
        }
    });

    test('收到 service_upgrading 报文时设置 isServerUpgrading=true', () => {
        const handleServerMessage = (client as unknown as {
            handleServerMessage: (msg: ServerMessage) => void;
        }).handleServerMessage.bind(client);

        expect(useAssistantStore.getState().isServerUpgrading).toBe(false);

        handleServerMessage({
            type: 'service_upgrading',
            estimatedSeconds: 5,
            targetVersion: 'v0.3.5',
        });

        expect(useAssistantStore.getState().isServerUpgrading).toBe(true);
    });

    test('收到 sync_result 时解除升级态、保持待发消息 sending 状态并自动补发第一条', () => {
        const handleServerMessage = (client as unknown as {
            handleServerMessage: (msg: ServerMessage) => void;
        }).handleServerMessage.bind(client);

        // 模拟升级期间用户发送了两条消息并处于排队中
        useAssistantStore.setState({
            isServerUpgrading: true,
            connectionState: 'connected',
        });

        const msgId1 = client.sendMessage('第一条消息');
        const msgId2 = client.sendMessage('第二条消息');
        expect(useAssistantStore.getState().pendingSendQueue.length).toBe(2);

        // 模拟 mock sendRaw 监控补发情况
        const sendRawSpy = jest.spyOn(client as unknown as { sendRaw: () => boolean }, 'sendRaw').mockReturnValue(true);

        // 服务端重启就绪，下发 sync_result 对账报文
        handleServerMessage({
            type: 'sync_result',
            sessionId: 'main',
            messages: [], // 服务端尚未持久化该排队消息
            taskState: 'idle',
            currentSeq: 10,
        });

        // 1. 验证 isServerUpgrading 已自动恢复为 false
        expect(useAssistantStore.getState().isServerUpgrading).toBe(false);

        // 2. 验证本地消息没有被错误地标记为 error（仍为 sending 等待补发完成）
        const localMsg1 = useAssistantStore.getState().messages.find((m) => m.id === msgId1);
        expect(localMsg1?.status).toBe('sending');

        // 3. 遵循单会话串行执行约束：仅补发第一条消息，不并发抢占会话
        expect(sendRawSpy).toHaveBeenCalledTimes(1);
        expect(sendRawSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'chat',
                sessionId: 'main',
                messageId: msgId1,
                content: '第一条消息',
            })
        );

        // 4. 发送但尚未收到回执前，队列依然保留该消息（防丢包），等待 message_ack 确认出队
        expect(useAssistantStore.getState().pendingSendQueue.length).toBe(2);

        // 收到第一条消息的确认回执，第一条出队
        handleServerMessage({
            type: 'message_ack',
            messageId: msgId1,
            seq: 11,
            status: 'sent',
            role: 'user',
        });
        expect(useAssistantStore.getState().pendingSendQueue.length).toBe(1);
        expect(useAssistantStore.getState().pendingSendQueue[0].messageId).toBe(msgId2);

        // 第一条已受理，执行期间立即发送第二条，同时抑制重复推进。
        useAssistantStore.setState({ taskState: 'processing' });
        client.flushPendingSendQueue();
        expect(sendRawSpy).toHaveBeenCalledTimes(2);

        // 第一条任务结束的迟到通知不能重复发送第二条。
        handleServerMessage({
            type: 'task_status',
            seq: 12,
            sessionId: 'main',
            state: 'completed',
        });

        expect(sendRawSpy).toHaveBeenCalledTimes(2);
        expect(sendRawSpy).toHaveBeenLastCalledWith(
            expect.objectContaining({
                type: 'chat',
                sessionId: 'main',
                messageId: msgId2,
                content: '第二条消息',
            })
        );

        sendRawSpy.mockRestore();
    });

    test('连接看似正常但消息没有到达时，重连保留两条原始消息并先补发第一条', async () => {
        const transport = client as unknown as {
            ws: { readyState: number; send: jest.Mock; close: jest.Mock } | null;
            handleServerMessage: (message: ServerMessage) => void;
        };
        const socket = { readyState: WebSocket.OPEN, send: jest.fn(), close: jest.fn() };
        transport.ws = socket;
        try {
            useAssistantStore.setState({ connectionState: 'connected', taskState: 'idle', outboxStatus: 'ready' });
            const first = client.sendMessage('第一条');
            useAssistantStore.setState({ connectionState: 'disconnected' });
            const second = client.sendMessage('第二条');
            socket.send.mockClear();
            transport.handleServerMessage({
                type: 'sync_result', sessionId: 'main', messages: [], currentSeq: 1, taskState: 'idle',
            });
            await Promise.resolve();
            const state = useAssistantStore.getState();
            expect(state.pendingSendQueue.map(message => message.messageId)).toEqual([first, second]);
            expect(state.messages.find(message => message.id === first)?.status).toBe('sending');
            const frames = socket.send.mock.calls.map(([raw]) => JSON.parse(raw) as { type: string; messageId?: string });
            expect(frames.find(frame => frame.type === 'chat')?.messageId).toBe(first);
        } finally {
            transport.ws = null;
        }
    });

    test.each(['accepted', 'unreceived'] as const)('编辑途中核对已尝试投递的原消息 %s', result => {
        const id = 'pending-edit';
        const receive = (client as unknown as { handleServerMessage(msg: ServerMessage): void });
        const store = useAssistantStore.getState();
        store.addToPendingSendQueue({ sessionId: 'main', messageId: id, content: '原文', attempted: true });
        store.addOrUpdateMessage({ id, seq: 0, role: 'user', status: 'sending', timestamp: 1, content: '原文' });
        client.withdrawPending(id, 'edit');
        expect(useAssistantStore.getState().pendingSendQueue[0].withdrawal).toBe('edit');
        if (result === 'accepted') {
            receive.handleServerMessage({ type: 'message_ack', messageId: id, seq: 1, status: 'sent' });
            expect(useAssistantStore.getState().pendingSendQueue).toHaveLength(0);
            expect(useAssistantStore.getState().messages[0].status).toBe('sent');
        } else {
            receive.handleServerMessage({ type: 'message_deleted', sessionId: 'main', messageId: id });
            expect(useAssistantStore.getState().pendingSendQueue[0].withdrawal).toBe('draft');
        }
    });

    test('收到 message_ack 时移出 pendingSendQueue', () => {
        const handleServerMessage = (client as unknown as {
            handleServerMessage: (msg: ServerMessage) => void;
        }).handleServerMessage.bind(client);

        useAssistantStore.setState({
            pendingSendQueue: [{ sessionId: 'main', messageId: 'm-ack-1', content: 'test' }],
        });

        handleServerMessage({
            type: 'message_ack',
            messageId: 'm-ack-1',
            seq: 15,
            status: 'sent',
            role: 'user',
        });

        expect(useAssistantStore.getState().pendingSendQueue.length).toBe(0);
    });

    test('收到 error 为 service_upgrading 的 message_ack 时，保持 sending 态并重新加入 pendingSendQueue', () => {
        const handleServerMessage = (client as unknown as {
            handleServerMessage: (msg: ServerMessage) => void;
        }).handleServerMessage.bind(client);

        useAssistantStore.setState({
            messages: [
                {
                    id: 'm-drain-1',
                    seq: 0,
                    role: 'user',
                    content: '排空期在途消息',
                    timestamp: 1000,
                    status: 'sending',
                },
            ],
            pendingSendQueue: [],
            isServerUpgrading: false,
        });

        // 收到服务端排空期拒绝回执
        handleServerMessage({
            type: 'message_ack',
            messageId: 'm-drain-1',
            seq: 0,
            status: 'error',
            error: 'service_upgrading',
        });

        const state = useAssistantStore.getState();
        // 1. 触发升级感知
        expect(state.isServerUpgrading).toBe(true);

        // 2. 消息气泡绝不展示为 error，保持 sending 等待重试
        const msg = state.messages.find((m) => m.id === 'm-drain-1');
        expect(msg?.status).toBe('sending');
        expect(msg?.errorMessage).toBeUndefined();

        // 3. 消息被安全补入 pendingSendQueue，等待对账恢复后自动补发
        expect(state.pendingSendQueue.length).toBe(1);
        expect(state.pendingSendQueue[0].messageId).toBe('m-drain-1');
        expect(state.pendingSendQueue[0].content).toBe('排空期在途消息');
    });

    test('addToPendingSendQueue 保留既有项在 FIFO 队列中的原始位置（原位更新而非追加到队尾）', () => {
        useAssistantStore.setState({
            pendingSendQueue: [
                { sessionId: 'main', messageId: 'm-first', content: '第一条' },
                { sessionId: 'main', messageId: 'm-second', content: '第二条' },
            ],
        });

        // 重新对已在队列第一位的 m-first 触发入队
        useAssistantStore.getState().addToPendingSendQueue({
            sessionId: 'main',
            messageId: 'm-first',
            content: '第一条更新内容',
        });

        const queue = useAssistantStore.getState().pendingSendQueue;
        expect(queue.length).toBe(2);
        // 关键断言：m-first 必须依然排在 m-second 前面
        expect(queue[0].messageId).toBe('m-first');
        expect(queue[0].content).toBe('第一条更新内容');
        expect(queue[1].messageId).toBe('m-second');
    });

    test('收到 error 为 session_busy 的 message_ack 时，排队消息维持 sending 状态且绝不标红报错', () => {
        const handleServerMessage = (client as unknown as {
            handleServerMessage: (msg: ServerMessage) => void;
        }).handleServerMessage.bind(client);

        useAssistantStore.setState({
            messages: [
                {
                    id: 'm-busy-1',
                    seq: 0,
                    role: 'user',
                    content: '排队消息',
                    timestamp: 2000,
                    status: 'sending',
                },
            ],
            pendingSendQueue: [],
        });

        handleServerMessage({
            type: 'message_ack',
            messageId: 'm-busy-1',
            seq: 0,
            status: 'error',
            error: 'session_busy',
        });

        const state = useAssistantStore.getState();
        const msg = state.messages.find((m) => m.id === 'm-busy-1');
        expect(msg?.status).toBe('sending');
        expect(msg?.errorMessage).toBeUndefined();
        expect(state.pendingSendQueue.length).toBe(1);
        expect(state.pendingSendQueue[0].messageId).toBe('m-busy-1');
    });

    test('任务被停止或审批超时时，助手消息落为失败终态而非完成', () => {
        const handleServerMessage = (client as unknown as {
            handleServerMessage: (msg: ServerMessage) => void;
        }).handleServerMessage.bind(client);

        useAssistantStore.setState({
            messages: [
                {
                    id: 'asst-stop-1',
                    seq: 3,
                    role: 'assistant',
                    content: '已经查了一半',
                    timestamp: 3000,
                    status: 'processing',
                },
            ],
            taskState: 'processing',
        });

        handleServerMessage({
            type: 'task_status',
            seq: 4,
            sessionId: 'main',
            state: 'stopped',
            error: 'task_stopped',
        });

        // 服务端同一条消息存的是 error，客户端必须一致，否则工作记录先显示完成、重连后又变未完成
        let asst = useAssistantStore.getState().messages.find((m) => m.id === 'asst-stop-1');
        expect(asst?.status).toBe('error');
        expect(asst?.errorMessage).toBe('task_stopped');

        useAssistantStore.setState({
            messages: [
                {
                    id: 'asst-timeout-1',
                    seq: 5,
                    role: 'assistant',
                    content: '',
                    timestamp: 4000,
                    status: 'processing',
                },
            ],
            taskState: 'processing',
        });

        handleServerMessage({
            type: 'task_status',
            seq: 6,
            sessionId: 'main',
            state: 'stopped',
            error: 'approval_timeout',
        });

        asst = useAssistantStore.getState().messages.find((m) => m.id === 'asst-timeout-1');
        expect(asst?.status).toBe('error');
        expect(asst?.errorMessage).toBe('approval_timeout');
    });

    test('服务端尚未保存时最多重试 3 次后转失败并放行后续消息', async () => {
        jest.useFakeTimers();
        await resetOperationDiagnosticsState();
        const handleServerMessage = (client as unknown as {
            handleServerMessage: (msg: ServerMessage) => void;
        }).handleServerMessage.bind(client);

        useAssistantStore.setState({
            connectionState: 'connected',
            messages: [
                {
                    id: 'm-fail-1',
                    seq: 0,
                    role: 'user',
                    content: '将失败的消息',
                    timestamp: 1000,
                    status: 'sending',
                },
                {
                    id: 'm-pending-2',
                    seq: 0,
                    role: 'user',
                    content: '排在后面的消息',
                    timestamp: 1001,
                    status: 'sending',
                },
            ],
            pendingSendQueue: [
                { sessionId: 'main', messageId: 'm-fail-1', content: '将失败的消息' },
                { sessionId: 'main', messageId: 'm-pending-2', content: '排在后面的消息' },
            ],
        });

        (client as unknown as { ws: { readyState: number } }).ws = { readyState: WebSocket.OPEN };
        const sendRawSpy = jest.spyOn(client as unknown as { sendRaw: (msg: { messageId?: string }) => boolean }, 'sendRaw').mockReturnValue(true);
        try {
            // 首次触发：发 m-fail-1
            await client.flushPendingSendQueue();
            expect(sendRawSpy).toHaveBeenCalledTimes(1);

            // 收到 3 次 seq=0 拒绝（3s -> 6s -> 10s 退避期间，新 sendMessage 不绕过退避重发）
            for (const delay of [3000, 6000, 10000]) {
                handleServerMessage({
                    type: 'message_ack',
                    messageId: 'm-fail-1',
                    seq: 0,
                    status: 'error',
                    error: 'disk_full',
                });
                expect(useAssistantStore.getState().messages.find(m => m.id === 'm-fail-1')?.status).toBe('sending');
                const callsBefore = sendRawSpy.mock.calls.length;
                if (delay === 3000) {
                    client.sendMessage('新插队消息');
                    expect(sendRawSpy).toHaveBeenCalledTimes(callsBefore);
                }
                jest.advanceTimersByTime(delay);
                await Promise.resolve();
                expect(sendRawSpy).toHaveBeenCalledTimes(callsBefore + 1);
                expect(sendRawSpy).toHaveBeenLastCalledWith(expect.objectContaining({ messageId: 'm-fail-1' }));
            }

            // 第 4 次拒绝超过上限（3 次重试耗尽）：标失败并立刻发送 m-pending-2
            handleServerMessage({
                type: 'message_ack',
                messageId: 'm-fail-1',
                seq: 0,
                status: 'error',
                error: 'disk_full',
            });

            const state = useAssistantStore.getState();
            expect(state.messages.find(m => m.id === 'm-fail-1')?.status).toBe('error');
            expect(state.pendingSendQueue.find(item => item.messageId === 'm-fail-1')?.failed).toBe(true);
            expect(sendRawSpy).toHaveBeenLastCalledWith(expect.objectContaining({ messageId: 'm-pending-2' }));

            // 确认 m-pending-2 与插队消息后，再过很久也不会重试已失败的 m-fail-1
            handleServerMessage({ type: 'message_ack', messageId: 'm-pending-2', seq: 1, status: 'sent', role: 'user' });
            const thirdSend = sendRawSpy.mock.calls[sendRawSpy.mock.calls.length - 1]?.[0];
            expect(thirdSend?.messageId).toBeDefined();
            handleServerMessage({ type: 'message_ack', messageId: thirdSend.messageId!, seq: 2, status: 'sent', role: 'user' });
            const callsAfterAck = sendRawSpy.mock.calls.length;
            jest.advanceTimersByTime(60000);
            expect(sendRawSpy).toHaveBeenCalledTimes(callsAfterAck);
            const reports = (await readOperationReports()).map(line => JSON.parse(line));
            expect(reports).toEqual(expect.arrayContaining([
                expect.objectContaining({ operation: 'chat_send', outcome: 'server_rejected' }),
            ]));
        } finally {
            (client as unknown as { ws: null }).ws = null;
            sendRawSpy.mockRestore();
            jest.useRealTimers();
        }
    });

    test('升级排空期被拒(service_upgrading)的消息自动重排队并完整保留附件', () => {
        const handleServerMessage = (client as unknown as {
            handleServerMessage: (msg: ServerMessage) => void;
        }).handleServerMessage.bind(client);

        const sampleAttachment = {
            type: 'image' as const,
            name: 'diag.png',
            data: 'base64diag',
        };

        useAssistantStore.setState({
            messages: [
                {
                    id: 'm-upg-att',
                    seq: 1,
                    role: 'user',
                    content: '带图指令',
                    timestamp: Date.now(),
                    status: 'sending',
                    attachments: [sampleAttachment],
                },
            ],
            pendingSendQueue: [],
        });

        handleServerMessage({
            type: 'message_ack',
            messageId: 'm-upg-att',
            seq: 1,
            status: 'error',
            error: 'service_upgrading',
        });

        const state = useAssistantStore.getState();
        expect(state.isServerUpgrading).toBe(true);
        expect(state.pendingSendQueue.length).toBe(1);
        expect(state.pendingSendQueue[0].messageId).toBe('m-upg-att');
        expect(state.pendingSendQueue[0].attachments?.[0].name).toBe('diag.png');
        expect(state.messages[0].attachments?.[0].name).toBe('diag.png');
    });

    test('附件不可读时立即标记失败、停止自动重试并保留完整待发项', async () => {
        jest.useFakeTimers();
        const sendRawSpy = jest.spyOn(client as unknown as { sendRaw: () => boolean }, 'sendRaw').mockReturnValue(true);

        useAssistantStore.setState({
            connectionState: 'connected',
            messages: [
                {
                    id: 'm-att-missing',
                    seq: 1,
                    role: 'user',
                    content: '丢失附件的消息',
                    timestamp: Date.now(),
                    status: 'sending',
                    attachments: [
                        {
                            type: 'image',
                            name: 'gone.png',
                            uri: 'file:///non-existent-image.png',
                        },
                    ],
                },
            ],
            pendingSendQueue: [
                {
                    sessionId: 'main',
                    messageId: 'm-att-missing',
                    content: '丢失附件的消息',
                    attachments: [
                        {
                            type: 'image',
                            name: 'gone.png',
                            uri: 'file:///non-existent-image.png',
                        },
                    ],
                },
            ],
            isServerUpgrading: false,
            taskState: 'idle',
        });

        try {
            await client.flushPendingSendQueue();

            const state = useAssistantStore.getState();
            // 1. 绝不发送残缺消息
            expect(sendRawSpy).not.toHaveBeenCalled();
            // 2. 立即转失败终态，停止后台空转
            expect(state.messages[0].status).toBe('error');
            expect(state.pendingSendQueue).toHaveLength(1);
            expect(state.pendingSendQueue[0].failed).toBe(true);

            jest.advanceTimersByTime(60000);
            expect(sendRawSpy).not.toHaveBeenCalled();
        } finally {
            sendRawSpy.mockRestore();
            jest.useRealTimers();
        }
    });

    test('重水化附件失败时若会话已被清空，不复活旧失败消息', async () => {
        const sendRawSpy = jest.spyOn(client as unknown as { sendRaw: () => boolean }, 'sendRaw').mockReturnValue(true);

        useAssistantStore.setState({
            connectionState: 'connected',
            messages: [
                {
                    id: 'm-cleared',
                    seq: 1,
                    role: 'user',
                    content: '已被清空的消息',
                    timestamp: Date.now(),
                    status: 'sending',
                    attachments: [
                        {
                            type: 'image',
                            name: 'gone.png',
                            uri: 'file:///non-existent-image.png',
                        },
                    ],
                },
            ],
            pendingSendQueue: [
                {
                    sessionId: 'main',
                    messageId: 'm-cleared',
                    content: '已被清空的消息',
                    attachments: [
                        {
                            type: 'image',
                            name: 'gone.png',
                            uri: 'file:///non-existent-image.png',
                        },
                    ],
                },
            ],
            isServerUpgrading: false,
            taskState: 'idle',
        });

        // 启动异步补发同时清空会话
        const flushPromise = client.flushPendingSendQueue();
        useAssistantStore.getState().clearChat();
        await flushPromise;

        const state = useAssistantStore.getState();
        expect(sendRawSpy).not.toHaveBeenCalled();
        // 验证被清空后没有旧消息被复活写回
        expect(state.messages.length).toBe(0);
        expect(state.pendingSendQueue.length).toBe(0);

        sendRawSpy.mockRestore();
    });

    test('cancelQueued 立即从本地消息列表与待发队列中物理移除该排队消息', () => {
        const sendRawSpy = jest.spyOn(client as unknown as { sendRaw: (msg: unknown) => boolean }, 'sendRaw').mockReturnValue(true);

        useAssistantStore.setState({
            messages: [
                {
                    id: 'm-queued',
                    seq: 1,
                    role: 'user',
                    content: '排队中的指令',
                    timestamp: Date.now(),
                    status: 'queued',
                },
            ],
            pendingSendQueue: [
                {
                    sessionId: 'main',
                    messageId: 'm-queued',
                    content: '排队中的指令',
                },
            ],
        });

        const success = client.cancelQueued('m-queued');
        expect(success).toBe(true);
        expect(sendRawSpy).toHaveBeenCalledWith({
            type: 'cancel_queued',
            sessionId: 'main',
            messageId: 'm-queued',
        });

        const state = useAssistantStore.getState();
        expect(state.messages.find((m) => m.id === 'm-queued')).toBeUndefined();
        expect(state.pendingSendQueue.find((q) => q.messageId === 'm-queued')).toBeUndefined();

        sendRawSpy.mockRestore();
    });

    test('收到服务端 message_deleted 广播时移除对应消息', () => {
        const handleServerMessage = (client as unknown as {
            handleServerMessage: (msg: ServerMessage) => void;
        }).handleServerMessage.bind(client);

        useAssistantStore.setState({
            messages: [
                {
                    id: 'm-to-delete',
                    seq: 2,
                    role: 'user',
                    content: '待删除的消息',
                    timestamp: Date.now(),
                    status: 'queued',
                },
            ],
        });

        handleServerMessage({
            type: 'message_deleted',
            sessionId: 'main',
            messageId: 'm-to-delete',
        });

        const state = useAssistantStore.getState();
        expect(state.messages.find((m) => m.id === 'm-to-delete')).toBeUndefined();
    });

    test('收到服务端 task_status processing 时更新 taskState 为 processing', () => {
        const handleServerMessage = (client as unknown as {
            handleServerMessage: (msg: ServerMessage) => void;
        }).handleServerMessage.bind(client);

        useAssistantStore.setState({
            taskState: 'idle',
        });

        handleServerMessage({
            type: 'task_status',
            seq: 10,
            sessionId: 'main',
            state: 'processing',
        });

        const state = useAssistantStore.getState();
        expect(state.taskState).toBe('processing');
        expect(state.currentSeq).toBe(10);
    });

    test('离线时 cancelQueued 自动入队 pendingCancelQueue，恢复后静默补发并移除', () => {
        const sendRawSpy = jest.spyOn(client as unknown as { sendRaw: (msg: unknown) => boolean }, 'sendRaw')
            .mockReturnValueOnce(false) // 首次离线发送失败
            .mockReturnValueOnce(true);  // 重连后补发成功

        useAssistantStore.setState({
            messages: [
                {
                    id: 'm-offline-cancel',
                    seq: 1,
                    role: 'user',
                    content: '离线时撤销的排队消息',
                    timestamp: Date.now(),
                    status: 'queued',
                },
            ],
            pendingCancelQueue: [],
        });

        // 离线撤销：无条件入队 pendingCancelQueue 并从本地 messages 移除
        const success = client.cancelQueued('m-offline-cancel');
        expect(success).toBe(false);

        let state = useAssistantStore.getState();
        expect(state.messages.find((m) => m.id === 'm-offline-cancel')).toBeUndefined();
        expect(state.pendingCancelQueue).toEqual(['m-offline-cancel']);

        // 模拟恢复连接并触发补发
        client.flushPendingCancelQueue();

        state = useAssistantStore.getState();
        // 补发调用后不盲目出队，依然保持在队列中，杜绝半开连接假死时丢失撤销
        expect(state.pendingCancelQueue).toEqual(['m-offline-cancel']);
        expect(sendRawSpy).toHaveBeenCalledTimes(2);

        // 收到服务端确认回执后才安全出队
        const handleServerMessage = (client as unknown as {
            handleServerMessage: (msg: ServerMessage) => void;
        }).handleServerMessage.bind(client);
        handleServerMessage({
            type: 'message_deleted',
            sessionId: 'main',
            messageId: 'm-offline-cancel',
        });

        state = useAssistantStore.getState();
        expect(state.pendingCancelQueue.length).toBe(0);

        sendRawSpy.mockRestore();
    });

    test('收到 sync_result 携带 deletedMessageIds 时增量剔除本地对应消息、清理待发队列与暂存备份', () => {
        const handleServerMessage = (client as unknown as {
            handleServerMessage: (msg: ServerMessage) => void;
        }).handleServerMessage.bind(client);

        const cancellingMap = (client as unknown as { cancellingMessages: Map<string, unknown> }).cancellingMessages;
        cancellingMap.set('m-deleted-remote', { id: 'm-deleted-remote', content: '待释放的暂存消息' });

        useAssistantStore.setState({
            messages: [
                {
                    id: 'm-keep',
                    seq: 1,
                    role: 'user',
                    content: '保留的消息',
                    timestamp: Date.now() - 1000,
                    status: 'sent',
                },
                {
                    id: 'm-deleted-remote',
                    seq: 2,
                    role: 'user',
                    content: '在其他端已撤销的消息',
                    timestamp: Date.now(),
                    status: 'queued',
                },
            ],
            pendingCancelQueue: ['m-deleted-remote'],
            pendingSendQueue: [
                { sessionId: 'main', messageId: 'm-deleted-remote', content: '在其他端已撤销的消息' },
                { sessionId: 'main', messageId: 'm-keep-send', content: '正常待发' },
            ],
        });

        handleServerMessage({
            type: 'sync_result',
            sessionId: 'main',
            currentSeq: 5,
            taskState: 'idle',
            messages: [],
            deletedMessageIds: ['m-deleted-remote'],
        });

        const state = useAssistantStore.getState();
        expect(state.messages.find((m) => m.id === 'm-deleted-remote')).toBeUndefined();
        expect(state.messages.find((m) => m.id === 'm-keep')).toBeDefined();
        expect(state.pendingCancelQueue.includes('m-deleted-remote')).toBe(false);
        expect(state.pendingSendQueue.some((q) => q.messageId === 'm-deleted-remote')).toBe(false);
        expect(state.pendingSendQueue.some((q) => q.messageId === 'm-keep-send')).toBe(true);
        expect(cancellingMap.has('m-deleted-remote')).toBe(false);
    });

    test('收到 message_deleted 广播时同步剔除待发队列中的残留', () => {
        const handleServerMessage = (client as unknown as {
            handleServerMessage: (msg: ServerMessage) => void;
        }).handleServerMessage.bind(client);

        useAssistantStore.setState({
            messages: [
                {
                    id: 'm-broadcast-del',
                    seq: 2,
                    role: 'user',
                    content: '被广播删除的消息',
                    timestamp: Date.now(),
                    status: 'queued',
                },
            ],
            pendingCancelQueue: ['m-broadcast-del'],
            pendingSendQueue: [
                { sessionId: 'main', messageId: 'm-broadcast-del', content: '被广播删除的消息' },
            ],
        });

        handleServerMessage({
            type: 'message_deleted',
            sessionId: 'main',
            messageId: 'm-broadcast-del',
        });

        const state = useAssistantStore.getState();
        expect(state.messages.find((m) => m.id === 'm-broadcast-del')).toBeUndefined();
        expect(state.pendingCancelQueue.includes('m-broadcast-del')).toBe(false);
        expect(state.pendingSendQueue.some((q) => q.messageId === 'm-broadcast-del')).toBe(false);
    });

    test('收到 cancel_failed 回执时清理 pendingCancelQueue 并安全恢复暂存的消息', () => {
        const handleServerMessage = (client as unknown as {
            handleServerMessage: (msg: ServerMessage) => void;
        }).handleServerMessage.bind(client);

        const testMsg: AssistantMessage = {
            id: 'm-race-cancel',
            seq: 20,
            role: 'user',
            content: '竞态开始执行的消息',
            timestamp: Date.now(),
            status: 'queued',
        };

        useAssistantStore.setState({
            messages: [testMsg],
            pendingCancelQueue: [],
        });

        // 模拟用户触发撤销（带备份消息暂存）
        client.cancelQueued(testMsg.id, testMsg);

        // 本地立即从 messages 移除
        expect(useAssistantStore.getState().messages.find((m) => m.id === testMsg.id)).toBeUndefined();

        // 服务端返回 cancel_failed（例如原因已开始执行 already_started）
        handleServerMessage({
            type: 'cancel_failed',
            sessionId: 'main',
            messageId: testMsg.id,
            reason: 'already_started',
        });

        const afterState = useAssistantStore.getState();
        // 1. 待撤销队列必须被清理，不无限补发
        expect(afterState.pendingCancelQueue.includes(testMsg.id)).toBe(false);
        // 2. 消息必须被恢复回 messages 列表，避免被凭空丢弃
        const restored = afterState.messages.find((m) => m.id === testMsg.id);
        expect(restored).toBeDefined();
        expect(restored?.content).toBe('竞态开始执行的消息');
    });

    test('收到 cancel_failed 且 reason 为 not_found 时，保持删除状态不复活旧气泡', () => {
        const handleServerMessage = (client as unknown as {
            handleServerMessage: (msg: ServerMessage) => void;
        }).handleServerMessage.bind(client);

        const testMsg: AssistantMessage = {
            id: 'm-already-deleted',
            seq: 21,
            role: 'user',
            content: '另一端已撤销的消息',
            timestamp: Date.now(),
            status: 'queued',
        };

        useAssistantStore.setState({
            messages: [testMsg],
            pendingCancelQueue: [],
        });

        // 模拟本地点击撤销
        client.cancelQueued(testMsg.id, testMsg);
        expect(useAssistantStore.getState().messages.find((m) => m.id === testMsg.id)).toBeUndefined();

        // 服务端返回 cancel_failed(not_found)，说明服务端早已被删除
        handleServerMessage({
            type: 'cancel_failed',
            sessionId: 'main',
            messageId: testMsg.id,
            reason: 'not_found',
        });

        const afterState = useAssistantStore.getState();
        // 1. 待撤销队列必须出队
        expect(afterState.pendingCancelQueue.includes(testMsg.id)).toBe(false);
        // 2. 消息绝不复活，保持为 undefined
        expect(afterState.messages.find((m) => m.id === testMsg.id)).toBeUndefined();
    });

    test('fetchSkills 在请求返回前服务器发生变更时丢弃响应，不覆盖新服务器状态', async () => {
        useAssistantStore.setState({
            serverUrl: 'https://server-old.example.com',
            serverToken: 'token-old',
            skills: [],
        });

        // 模拟旧服务器响应延迟返回
        let resolveFetch: (val: unknown) => void;
        const fetchPromise = new Promise((resolve) => {
            resolveFetch = resolve;
        });

        const originalFetch = global.fetch;
        global.fetch = jest.fn().mockReturnValue(fetchPromise);

        try {
            const fetchSkillsPromise = client.fetchSkills();

            // 在 fetchPending 期间，用户切换了服务器
            useAssistantStore.setState({
                serverUrl: 'https://server-new.example.com',
                serverToken: 'token-new',
                skills: [],
            });

            // 旧请求返回
            resolveFetch!({
                ok: true,
                json: async () => ({ skills: [{ name: 'stale-skill', description: '旧服务器技能' }] }),
            });

            const result = await fetchSkillsPromise;
            expect(result).toEqual([]);
            expect(useAssistantStore.getState().skills).toEqual([]);
        } finally {
            global.fetch = originalFetch;
        }
    });

    test('resetSession 在 WS 已连接时仅通过 WS 等待回执，超时不发起二次 HTTP 请求', async () => {
        jest.useFakeTimers();
        const sendRawSpy = jest.spyOn(client as unknown as { sendRaw: (msg: unknown) => boolean }, 'sendRaw').mockReturnValue(true);
        const originalFetch = global.fetch;
        const fetchSpy = jest.fn();
        global.fetch = fetchSpy;

        // 模拟 ws 为 OPEN
        (client as unknown as { ws: { readyState: number } }).ws = {
            readyState: 1, // WebSocket.OPEN
        };

        try {
            const resetPromise = client.resetSession();
            expect(sendRawSpy).toHaveBeenCalledWith({
                type: 'reset_session',
                sessionId: 'main',
            });

            // 快进 60 秒触发超时（与修改权限模式统一放宽至 60 秒）
            jest.advanceTimersByTime(60000);

            const ok = await resetPromise;
            expect(ok).toBe(false);
            // 绝不触发 HTTP 兜底
            expect(fetchSpy).not.toHaveBeenCalled();
        } finally {
            (client as unknown as { ws: null }).ws = null;
            sendRawSpy.mockRestore();
            global.fetch = originalFetch;
            jest.useRealTimers();
        }
    });

    test('发出后无回执最多自动重试 3 次（6s/6s/8s/10s）后转失败并放行后续消息', async () => {
        jest.useFakeTimers();
        await resetOperationDiagnosticsState();
        const sendRawSpy = jest.spyOn(client as unknown as { sendRaw: () => boolean }, 'sendRaw').mockReturnValue(true);
        useAssistantStore.setState({
            connectionState: 'connected',
            outboxStatus: 'ready',
            messages: [
                { id: 'm-timeout', seq: 0, role: 'user', content: '无回执消息', timestamp: 1000, status: 'sending' },
                { id: 'm-next', seq: 0, role: 'user', content: '后续消息', timestamp: 1001, status: 'sending' },
            ],
            pendingSendQueue: [
                { sessionId: 'main', messageId: 'm-timeout', content: '无回执消息' },
                { sessionId: 'main', messageId: 'm-next', content: '后续消息' },
            ],
        });

        try {
            await client.flushPendingSendQueue();
            expect(sendRawSpy).toHaveBeenCalledTimes(1);

            for (const timeout of [6000, 6000, 8000]) {
                jest.advanceTimersByTime(timeout - 1);
                const before = sendRawSpy.mock.calls.length;
                jest.advanceTimersByTime(1);
                await Promise.resolve();
                expect(sendRawSpy).toHaveBeenCalledTimes(before + 1);
                expect(sendRawSpy).toHaveBeenLastCalledWith(expect.objectContaining({ messageId: 'm-timeout' }));
                expect(useAssistantStore.getState().messages.find(m => m.id === 'm-timeout')?.status).toBe('sending');
            }

            // 第 4 段（10s）超时后达到上限，标记失败并立刻放行 m-next
            jest.advanceTimersByTime(10000);
            await Promise.resolve();
            const state = useAssistantStore.getState();
            expect(state.messages.find(m => m.id === 'm-timeout')?.status).toBe('error');
            expect(state.pendingSendQueue.find(q => q.messageId === 'm-timeout')?.failed).toBe(true);
            expect(sendRawSpy).toHaveBeenLastCalledWith(expect.objectContaining({ messageId: 'm-next' }));
            const reports = (await readOperationReports()).map(line => JSON.parse(line));
            expect(reports).toEqual(expect.arrayContaining([
                expect.objectContaining({ operation: 'chat_send', outcome: 'send_ack_timeout' }),
            ]));
        } finally {
            sendRawSpy.mockRestore();
            jest.useRealTimers();
        }
    });

    test('在途报文遭遇 WS 1009 超限断开立即标失败；升级中不计失败，普通闪断最多 3 次', async () => {
        jest.useFakeTimers();
        await resetOperationDiagnosticsState();
        const originalWebSocket = global.WebSocket;
        class MockSocket {
            static readonly CONNECTING = 0;
            static readonly OPEN = 1;
            static readonly CLOSED = 3;
            static instances: MockSocket[] = [];
            readyState = MockSocket.CONNECTING;
            onopen: (() => void) | null = null;
            onmessage: ((event: { data: string }) => void) | null = null;
            onerror: (() => void) | null = null;
            onclose: ((event?: { code?: number }) => void) | null = null;
            readonly send = jest.fn();
            readonly close = jest.fn(() => { this.readyState = MockSocket.CLOSED; });
            constructor() { MockSocket.instances.push(this); }
            open() { this.readyState = MockSocket.OPEN; this.onopen?.(); }
            receive(msg: ServerMessage) { this.onmessage?.({ data: JSON.stringify(msg) }); }
            drop(code = 1006) { this.readyState = MockSocket.CLOSED; this.onclose?.({ code }); }
        }
        global.WebSocket = MockSocket as unknown as typeof WebSocket;
        const skillsSpy = jest.spyOn(client, 'fetchSkills').mockResolvedValue([]);

        try {
            const connectAndSync = async (idx: number) => {
                const ws = MockSocket.instances[idx];
                ws.open();
                ws.receive({ type: 'auth_result', success: true });
                ws.receive({ type: 'sync_result', sessionId: 'main', messages: [], taskState: 'idle', currentSeq: 0 });
                await Promise.resolve();
                return ws;
            };

            await client.connect();
            const ws0 = await connectAndSync(0);
            const tooBigId = client.sendMessage('超大消息');
            expect(ws0.send.mock.calls.some(([raw]) => JSON.parse(raw as string).messageId === tooBigId)).toBe(true);
            ws0.drop(1009);
            expect(useAssistantStore.getState().messages.find(m => m.id === tooBigId)?.status).toBe('error');
            expect(useAssistantStore.getState().pendingSendQueue.find(q => q.messageId === tooBigId)?.failed).toBe(true);

            // 重连后不应再自动重发 1009 失败消息
            jest.advanceTimersByTime(1000);
            const ws1 = await connectAndSync(1);
            expect(ws1.send.mock.calls.some(([raw]) => JSON.parse(raw as string).messageId === tooBigId)).toBe(false);
            const reports = (await readOperationReports()).map(line => JSON.parse(line));
            expect(reports).toEqual(expect.arrayContaining([
                expect.objectContaining({ operation: 'chat_send', outcome: 'message_too_big' }),
            ]));

            // 升级中掉线不消耗重试次数；普通 1006 掉线累计超过 3 次后转失败
            useAssistantStore.setState({ messages: [], pendingSendQueue: [] });
            const flakyId = client.sendMessage('闪断测试');
            ws1.receive({ type: 'service_upgrading', estimatedSeconds: 5 });
            ws1.drop(1006);
            expect(useAssistantStore.getState().pendingSendQueue[0].failed).toBeUndefined();
            jest.advanceTimersByTime(1000);
            let currentWs = await connectAndSync(2);

            for (let attempt = 1; attempt <= 3; attempt += 1) {
                expect(currentWs.send.mock.calls.some(([raw]) => JSON.parse(raw as string).messageId === flakyId)).toBe(true);
                currentWs.drop(1006);
                expect(useAssistantStore.getState().messages.find(m => m.id === flakyId)?.status).toBe('sending');
                jest.advanceTimersByTime(1000);
                currentWs = await connectAndSync(2 + attempt);
            }
            // 第 4 次在途掉线超过 3 次上限，标记失败
            expect(currentWs.send.mock.calls.some(([raw]) => JSON.parse(raw as string).messageId === flakyId)).toBe(true);
            currentWs.drop(1006);
            expect(useAssistantStore.getState().messages.find(m => m.id === flakyId)?.status).toBe('error');
            expect(useAssistantStore.getState().pendingSendQueue[0].failed).toBe(true);
        } finally {
            client.disconnect();
            skillsSpy.mockRestore();
            global.WebSocket = originalWebSocket;
            jest.useRealTimers();
        }
    });

    test('retryPendingMessage 沿用原 ID 重发、拦截失效附件并支持离线后重连补发', async () => {
        jest.useFakeTimers();
        const sendRawSpy = jest.spyOn(client as unknown as { sendRaw: () => boolean }, 'sendRaw').mockReturnValue(true);
        const connectSpy = jest.spyOn(client, 'connect').mockResolvedValue();

        try {
            // 1. 在线重发沿用原 ID 并重置重试预算
            (client as unknown as { ws: { readyState: number } }).ws = { readyState: WebSocket.OPEN };
            useAssistantStore.setState({
                connectionState: 'connected',
                outboxStatus: 'ready',
                messages: [{ id: 'failed-1', seq: 0, role: 'user', content: '重发消息', timestamp: 1, status: 'error' }],
                pendingSendQueue: [{ sessionId: 'main', messageId: 'failed-1', content: '重发消息', failed: true, attempted: true }],
            });
            const okRes = await client.retryPendingMessage('failed-1');
            expect(okRes).toEqual({ ok: true });
            expect(useAssistantStore.getState().messages[0].status).toBe('sending');
            expect(useAssistantStore.getState().pendingSendQueue[0].failed).toBeUndefined();
            expect(sendRawSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'chat', messageId: 'failed-1' }));

            // 2. 附件失效时保留失败态并返回本地化错误信息
            sendRawSpy.mockClear();
            jest.spyOn(fsService, 'readAttachment').mockRejectedValueOnce(new Error('ATTACHMENT_NOT_FOUND'));
            const badAtt = [{ type: 'image' as const, name: 'gone.jpg', uri: 'file:///gone.jpg' }];
            useAssistantStore.setState({
                messages: [{ id: 'failed-att', seq: 0, role: 'user', content: '坏图', timestamp: 2, status: 'error', attachments: badAtt }],
                pendingSendQueue: [{ sessionId: 'main', messageId: 'failed-att', content: '坏图', attachments: badAtt, failed: true }],
            });
            const badRes = await client.retryPendingMessage('failed-att');
            expect(badRes).toEqual({ ok: false, errorMessage: i18n.t('chat.retryAttachmentFailed') });
            expect(useAssistantStore.getState().pendingSendQueue[0].failed).toBe(true);
            expect(useAssistantStore.getState().messages[0].status).toBe('error');
            expect(sendRawSpy).not.toHaveBeenCalled();

            // 3. 离线点重发后切回 sending 并触发 connect，sync_result 到达后自动按原 ID 补发
            (client as unknown as { ws: null }).ws = null;
            useAssistantStore.setState({
                connectionState: 'disconnected',
                messages: [{ id: 'failed-offline', seq: 0, role: 'user', content: '离线重发', timestamp: 3, status: 'error' }],
                pendingSendQueue: [{ sessionId: 'main', messageId: 'failed-offline', content: '离线重发', failed: true }],
            });
            const offRes = await client.retryPendingMessage('failed-offline');
            expect(offRes).toEqual({ ok: true });
            expect(connectSpy).toHaveBeenCalled();
            expect(useAssistantStore.getState().messages[0].status).toBe('sending');
            expect(useAssistantStore.getState().pendingSendQueue[0].failed).toBeUndefined();

            const handleServerMessage = (client as unknown as {
                handleServerMessage: (msg: ServerMessage) => void;
            }).handleServerMessage.bind(client);
            handleServerMessage({ type: 'sync_result', sessionId: 'main', messages: [], taskState: 'idle', currentSeq: 0 });
            expect(sendRawSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'chat', messageId: 'failed-offline' }));
        } finally {
            (client as unknown as { ws: null }).ws = null;
            sendRawSpy.mockRestore();
            connectSpy.mockRestore();
            jest.useRealTimers();
        }
    });

    test('失败消息支持长按取消与编辑，且 outbox 持久化与读取保留 failed 状态', async () => {
        const sendRawSpy = jest.spyOn(client as unknown as { sendRaw: () => boolean }, 'sendRaw').mockReturnValue(true);
        const handleServerMessage = (client as unknown as {
            handleServerMessage: (msg: ServerMessage) => void;
        }).handleServerMessage.bind(client);

        try {
            // attempted: false 时本地直接取消和转草稿
            useAssistantStore.setState({
                messages: [
                    { id: 'fail-cancel-local', seq: 0, role: 'user', content: '本地取消', timestamp: 1, status: 'error' },
                    { id: 'fail-edit-local', seq: 0, role: 'user', content: '本地编辑', timestamp: 2, status: 'error' },
                ],
                pendingSendQueue: [
                    { sessionId: 'main', messageId: 'fail-cancel-local', content: '本地取消', attempted: false, failed: true },
                    { sessionId: 'main', messageId: 'fail-edit-local', content: '本地编辑', attempted: false, failed: true },
                ],
            });
            client.withdrawPending('fail-cancel-local', 'cancel');
            expect(useAssistantStore.getState().messages.some(m => m.id === 'fail-cancel-local')).toBe(false);
            expect(useAssistantStore.getState().pendingSendQueue.some(q => q.messageId === 'fail-cancel-local')).toBe(false);

            client.withdrawPending('fail-edit-local', 'edit');
            expect(useAssistantStore.getState().pendingSendQueue.find(q => q.messageId === 'fail-edit-local')).toMatchObject({
                withdrawal: 'draft', failed: undefined,
            });

            // attempted: true 时先向服务端核对 withdraw_unreceived，收到 message_deleted 后进入 draft
            useAssistantStore.setState({
                messages: [{ id: 'fail-edit-remote', seq: 0, role: 'user', content: '远端编辑', timestamp: 3, status: 'error' }],
                pendingSendQueue: [{ sessionId: 'main', messageId: 'fail-edit-remote', content: '远端编辑', attempted: true, failed: true }],
            });
            client.withdrawPending('fail-edit-remote', 'edit');
            expect(sendRawSpy).toHaveBeenCalledWith({
                type: 'withdraw_unreceived', sessionId: 'main', messageId: 'fail-edit-remote',
            });
            handleServerMessage({ type: 'message_deleted', sessionId: 'main', messageId: 'fail-edit-remote' });
            expect(useAssistantStore.getState().pendingSendQueue[0].withdrawal).toBe('draft');

            // writeOutbox / readOutbox 往返保留 failed 字段并校验类型
            await writeOutbox('test-outbox-failed', {
                pendingSendQueue: [{ sessionId: 'main', messageId: 'persisted-fail', content: '内容', failed: true }],
                pendingCancelQueue: [],
            });
            await expect(readOutbox('test-outbox-failed')).resolves.toEqual({
                pendingSendQueue: [{ sessionId: 'main', messageId: 'persisted-fail', content: '内容', failed: true }],
                pendingCancelQueue: [],
            });
            await AsyncStorage.setItem('test-outbox-invalid-failed', JSON.stringify({
                pendingSendQueue: [{ sessionId: 'main', messageId: 'bad', content: 'x', failed: 'yes' }],
                pendingCancelQueue: [],
            }));
            await expect(readOutbox('test-outbox-invalid-failed')).rejects.toThrow('invalid_outbox');
        } finally {
            sendRawSpy.mockRestore();
        }
    });

    test('升级等待期间不消耗重试预算也不误标失败，对账恢复后按原 ID 自动补发', async () => {
        jest.useFakeTimers();
        const socket = { readyState: WebSocket.OPEN, send: jest.fn(), close: jest.fn() };
        (client as unknown as { ws: typeof socket | null }).ws = socket;
        const sendRawSpy = jest.spyOn(
            client as unknown as { sendRaw: (msg: { messageId?: string }) => boolean },
            'sendRaw'
        ).mockReturnValue(true);
        const handleServerMessage = (client as unknown as {
            handleServerMessage: (msg: ServerMessage) => void;
        }).handleServerMessage.bind(client);

        useAssistantStore.setState({
            connectionState: 'connected',
            outboxStatus: 'ready',
            isServerUpgrading: false,
            messages: [
                { id: 'm-upg-wait', seq: 0, role: 'user', content: '升级等待消息', timestamp: 1000, status: 'sending' },
            ],
            pendingSendQueue: [
                { sessionId: 'main', messageId: 'm-upg-wait', content: '升级等待消息' },
            ],
        });

        try {
            await client.flushPendingSendQueue();
            expect(sendRawSpy).toHaveBeenCalledTimes(1);

            // 耗尽前 3 次回执超时窗口（6s / 6s / 8s），进入第 4 段 10s 等待窗口
            for (const timeout of [6000, 6000, 8000]) {
                jest.advanceTimersByTime(timeout);
                await Promise.resolve();
            }
            expect(sendRawSpy).toHaveBeenCalledTimes(4);

            // 排空期通知到达：经过超过 ack 超时的 30s 等待也不消耗剩余预算或误标失败
            handleServerMessage({ type: 'service_upgrading', estimatedSeconds: 30 });
            jest.advanceTimersByTime(30000);
            await Promise.resolve();
            expect(sendRawSpy).toHaveBeenCalledTimes(4);
            expect(useAssistantStore.getState().messages[0].status).toBe('sending');
            expect(useAssistantStore.getState().pendingSendQueue[0].failed).toBeUndefined();

            // 服务端恢复并下发 sync_result：解除升级态并按原 ID 自动补发
            handleServerMessage({
                type: 'sync_result',
                sessionId: 'main',
                messages: [],
                taskState: 'idle',
                currentSeq: 20,
            });
            await Promise.resolve();
            expect(useAssistantStore.getState().isServerUpgrading).toBe(false);
            expect(sendRawSpy).toHaveBeenCalledTimes(5);
            expect(sendRawSpy).toHaveBeenLastCalledWith(expect.objectContaining({
                type: 'chat',
                messageId: 'm-upg-wait',
            }));

            handleServerMessage({
                type: 'message_ack',
                messageId: 'm-upg-wait',
                seq: 21,
                status: 'sent',
                role: 'user',
            });
            expect(useAssistantStore.getState().messages[0].status).toBe('sent');
            expect(useAssistantStore.getState().pendingSendQueue).toHaveLength(0);
        } finally {
            client.disconnect();
            sendRawSpy.mockRestore();
            jest.useRealTimers();
        }
    });

    test('在途消息收到 message_deleted 后立即释放发送锁并推进后续消息', async () => {
        jest.useFakeTimers();
        const socket = { readyState: WebSocket.OPEN, send: jest.fn(), close: jest.fn() };
        (client as unknown as { ws: typeof socket | null }).ws = socket;
        const sendRawSpy = jest.spyOn(
            client as unknown as { sendRaw: (msg: { messageId?: string }) => boolean },
            'sendRaw'
        ).mockReturnValue(true);
        const handleServerMessage = (client as unknown as {
            handleServerMessage: (msg: ServerMessage) => void;
        }).handleServerMessage.bind(client);

        useAssistantStore.setState({
            connectionState: 'connected',
            outboxStatus: 'ready',
            messages: [
                { id: 'm-del-1', seq: 0, role: 'user', content: '将被删除的重发消息', timestamp: 1000, status: 'sending' },
                { id: 'm-del-2', seq: 0, role: 'user', content: '排在后面的消息', timestamp: 1001, status: 'sending' },
            ],
            pendingSendQueue: [
                { sessionId: 'main', messageId: 'm-del-1', content: '将被删除的重发消息' },
                { sessionId: 'main', messageId: 'm-del-2', content: '排在后面的消息' },
            ],
        });

        try {
            await client.flushPendingSendQueue();
            expect(sendRawSpy).toHaveBeenCalledTimes(1);
            expect(sendRawSpy).toHaveBeenLastCalledWith(expect.objectContaining({ messageId: 'm-del-1' }));

            // 服务端反馈原消息已删除：立刻清除发送锁并发送 m-del-2
            handleServerMessage({ type: 'message_deleted', sessionId: 'main', messageId: 'm-del-1' });
            await Promise.resolve();
            const stateAfterDelete = useAssistantStore.getState();
            expect(stateAfterDelete.messages.some(m => m.id === 'm-del-1')).toBe(false);
            expect(stateAfterDelete.pendingSendQueue.some(q => q.messageId === 'm-del-1')).toBe(false);
            expect(sendRawSpy).toHaveBeenCalledTimes(2);
            expect(sendRawSpy).toHaveBeenLastCalledWith(expect.objectContaining({ messageId: 'm-del-2' }));

            handleServerMessage({ type: 'message_ack', messageId: 'm-del-2', seq: 10, status: 'sent', role: 'user' });
            expect(useAssistantStore.getState().pendingSendQueue).toHaveLength(0);
            const callsAfterAck = sendRawSpy.mock.calls.length;
            jest.advanceTimersByTime(60000);
            expect(sendRawSpy).toHaveBeenCalledTimes(callsAfterAck);
        } finally {
            client.disconnect();
            sendRawSpy.mockRestore();
            jest.useRealTimers();
        }
    });

    test('在途消息被 cancelQueued 或从队列移除时不死锁后续消息', async () => {
        jest.useFakeTimers();
        const socket = { readyState: WebSocket.OPEN, send: jest.fn(), close: jest.fn() };
        (client as unknown as { ws: typeof socket | null }).ws = socket;
        const sendRawSpy = jest.spyOn(
            client as unknown as { sendRaw: (msg: { type?: string; messageId?: string }) => boolean },
            'sendRaw'
        ).mockReturnValue(true);
        const handleServerMessage = (client as unknown as {
            handleServerMessage: (msg: ServerMessage) => void;
        }).handleServerMessage.bind(client);

        try {
            // 1. cancelQueued 取消正在发送的 m1，立即发送 cancel_queued 并放行 m2
            useAssistantStore.setState({
                connectionState: 'connected',
                outboxStatus: 'ready',
                messages: [
                    { id: 'm-cq-1', seq: 0, role: 'user', content: '取消中', timestamp: 1000, status: 'sending' },
                    { id: 'm-cq-2', seq: 0, role: 'user', content: '后续消息', timestamp: 1001, status: 'sending' },
                ],
                pendingSendQueue: [
                    { sessionId: 'main', messageId: 'm-cq-1', content: '取消中' },
                    { sessionId: 'main', messageId: 'm-cq-2', content: '后续消息' },
                ],
            });
            await client.flushPendingSendQueue();
            expect(sendRawSpy).toHaveBeenCalledTimes(1);

            client.cancelQueued('m-cq-1');
            await Promise.resolve();
            expect(sendRawSpy).toHaveBeenNthCalledWith(2, { type: 'cancel_queued', sessionId: 'main', messageId: 'm-cq-1' });
            expect(sendRawSpy).toHaveBeenNthCalledWith(3, expect.objectContaining({ type: 'chat', messageId: 'm-cq-2' }));
            handleServerMessage({ type: 'message_ack', messageId: 'm-cq-2', seq: 1, status: 'sent', role: 'user' });

            // 2. 在途消息从 pendingSendQueue 意外消失时，回执超时回调清理锁并放行下一条
            sendRawSpy.mockClear();
            useAssistantStore.setState({
                connectionState: 'connected',
                outboxStatus: 'ready',
                pendingCancelQueue: [],
                messages: [
                    { id: 'm-rm-3', seq: 0, role: 'user', content: '将被外部移除', timestamp: 1002, status: 'sending' },
                    { id: 'm-rm-4', seq: 0, role: 'user', content: '等待放行', timestamp: 1003, status: 'sending' },
                ],
                pendingSendQueue: [
                    { sessionId: 'main', messageId: 'm-rm-3', content: '将被外部移除' },
                    { sessionId: 'main', messageId: 'm-rm-4', content: '等待放行' },
                ],
            });
            await client.flushPendingSendQueue();
            expect(sendRawSpy).toHaveBeenCalledTimes(1);
            expect(sendRawSpy).toHaveBeenLastCalledWith(expect.objectContaining({ messageId: 'm-rm-3' }));

            useAssistantStore.getState().removeMessage('m-rm-3');
            jest.advanceTimersByTime(6000);
            await Promise.resolve();
            expect(sendRawSpy).toHaveBeenCalledTimes(2);
            expect(sendRawSpy).toHaveBeenLastCalledWith(expect.objectContaining({ messageId: 'm-rm-4' }));
            handleServerMessage({ type: 'message_ack', messageId: 'm-rm-4', seq: 2, status: 'sent', role: 'user' });
        } finally {
            client.disconnect();
            sendRawSpy.mockRestore();
            jest.useRealTimers();
        }
    });
});
