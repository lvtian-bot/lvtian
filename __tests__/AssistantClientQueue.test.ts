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

    test('收到 sync_result 时解除升级态、保持待发消息 sending 状态并自动补发', () => {
        const handleServerMessage = (client as unknown as {
            handleServerMessage: (msg: ServerMessage) => void;
        }).handleServerMessage.bind(client);

        // 模拟升级期间用户发送了消息并处于排队中
        useAssistantStore.setState({
            isServerUpgrading: true,
            connectionState: 'connected',
        });

        const msgId = client.sendMessage('排队待补发消息');
        expect(useAssistantStore.getState().pendingSendQueue.length).toBe(1);

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
        const localMsg = useAssistantStore.getState().messages.find((m) => m.id === msgId);
        expect(localMsg).toBeDefined();
        expect(localMsg!.status).toBe('sending');

        // 3. 验证自动调用 sendRaw 静默补发了队列中的消息
        expect(sendRawSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'chat',
                sessionId: 'main',
                messageId: msgId,
                content: '排队待补发消息',
            })
        );

        // 4. 验证已从 pendingSendQueue 移出
        expect(useAssistantStore.getState().pendingSendQueue.length).toBe(0);

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
});
