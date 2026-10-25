import { AssistantClient } from '../src/services/AssistantClient';
import { useAssistantStore } from '../src/store/useAssistantStore';
import { ServerMessage } from '../src/types/assistantProtocol';

describe('AssistantClient 离线乐观排队与服务端优雅升级感知', () => {
    let client: AssistantClient;

    beforeEach(() => {
        client = AssistantClient.getInstance();
        useAssistantStore.setState({
            serverUrl: 'http://127.0.0.1:3000',
            serverToken: 'test-token',
            connectionState: 'disconnected',
            isServerUpgrading: false,
            messages: [],
            pendingSendQueue: [],
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

        // 第一条任务处理中 (processing) 时，不发送第二条
        useAssistantStore.setState({ taskState: 'processing' });
        client.flushPendingSendQueue();
        expect(sendRawSpy).toHaveBeenCalledTimes(1);

        // 第一条任务完成终态，自动触发补发第二条消息
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

    test('收到不可恢复的终态失败回执时，移出队列并自动推进下一条排队消息', () => {
        const handleServerMessage = (client as unknown as {
            handleServerMessage: (msg: ServerMessage) => void;
        }).handleServerMessage.bind(client);

        useAssistantStore.setState({
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

        const sendRawSpy = jest.spyOn(client as unknown as { sendRaw: () => boolean }, 'sendRaw').mockReturnValue(true);

        // 收到服务端终态错误回执（如存储写满/内部异常）
        handleServerMessage({
            type: 'message_ack',
            messageId: 'm-fail-1',
            seq: 0,
            status: 'error',
            error: 'disk_full',
        });

        const state = useAssistantStore.getState();
        // 1. 失败消息标红
        const failedMsg = state.messages.find((m) => m.id === 'm-fail-1');
        expect(failedMsg?.status).toBe('error');
        expect(failedMsg?.errorMessage).toBe('disk_full');

        // 2. 失败消息被移出待发队列，释放队首
        expect(state.pendingSendQueue.length).toBe(1);
        expect(state.pendingSendQueue[0].messageId).toBe('m-pending-2');

        // 3. 自动触发推进队列中的下一条消息
        expect(sendRawSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'chat',
                messageId: 'm-pending-2',
                content: '排在后面的消息',
            })
        );

        sendRawSpy.mockRestore();
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

    test('重水化附件失败时标记错误并移出待发队列，不发送残缺指令', async () => {
        const sendRawSpy = jest.spyOn(client as unknown as { sendRaw: () => boolean }, 'sendRaw').mockReturnValue(true);

        useAssistantStore.setState({
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

        await client.flushPendingSendQueue();

        const state = useAssistantStore.getState();
        // 1. 绝不发送残缺消息
        expect(sendRawSpy).not.toHaveBeenCalled();
        // 2. 消息标记为失败状态以供重试
        expect(state.messages[0].status).toBe('error');
        expect(state.messages[0].errorMessage).toMatch(/失效|无法重新发送|Attachment file is no longer available/);
        // 3. 移出队列释放队首
        expect(state.pendingSendQueue.length).toBe(0);

        sendRawSpy.mockRestore();
    });

    test('重水化附件失败时若会话已被清空，不复活旧失败消息', async () => {
        const sendRawSpy = jest.spyOn(client as unknown as { sendRaw: () => boolean }, 'sendRaw').mockReturnValue(true);

        useAssistantStore.setState({
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

        // 离线撤销
        const success = client.cancelQueued('m-offline-cancel');
        expect(success).toBe(false);

        let state = useAssistantStore.getState();
        expect(state.messages.find((m) => m.id === 'm-offline-cancel')).toBeUndefined();
        expect(state.pendingCancelQueue).toEqual(['m-offline-cancel']);

        // 模拟恢复连接并触发补发
        client.flushPendingCancelQueue();

        state = useAssistantStore.getState();
        expect(state.pendingCancelQueue.length).toBe(0);
        expect(sendRawSpy).toHaveBeenCalledTimes(2);

        sendRawSpy.mockRestore();
    });

    test('收到 sync_result 携带 deletedMessageIds 时增量剔除本地对应消息', () => {
        const handleServerMessage = (client as unknown as {
            handleServerMessage: (msg: ServerMessage) => void;
        }).handleServerMessage.bind(client);

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
    });
});
