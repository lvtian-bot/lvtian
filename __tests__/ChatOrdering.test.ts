import { AssistantClient } from '../src/services/AssistantClient';
import { useAssistantStore } from '../src/store/useAssistantStore';
import { AssistantMessage, ServerMessage } from '../src/types/assistantProtocol';

const handle = (client: AssistantClient) => (client as unknown as {
    handleServerMessage: (msg: ServerMessage) => void;
}).handleServerMessage.bind(client);

const userMessage = (patch: Partial<AssistantMessage>): AssistantMessage => ({
    id: 'u1', seq: 10, role: 'user', content: '问题', timestamp: 1000, status: 'sent', ...patch,
});
const assistantMessage = (patch: Partial<AssistantMessage>): AssistantMessage => ({
    id: 'a1', seq: 11, role: 'assistant', content: '回答', timestamp: 900, status: 'done', ...patch,
});

describe('聊天位置只认 seq，不按时间戳重排', () => {
    const client = AssistantClient.getInstance();

    beforeEach(() => {
        useAssistantStore.setState({
            serverUrl: 'http://127.0.0.1:3000',
            serverToken: 'test-token',
            connectionState: 'disconnected',
            messages: [],
            pendingSendQueue: [],
            pendingSendCancelQueue: [],
            currentSeq: 0,
            clearedSeq: 0,
        } as never);
    });

    afterEach(() => client.disconnect());

    test('对账时本地顺序不变，新增消息按 seq 排到正确位置', () => {
        // 故意让助手消息时间戳早于提问 100 毫秒，模拟设备/服务端时钟偏差
        useAssistantStore.setState({
            messages: [userMessage({}), assistantMessage({})],
            currentSeq: 11,
        });

        handle(client)({
            type: 'sync_result',
            sessionId: 'main',
            messages: [assistantMessage({ id: 'a2', seq: 12, content: '补充', timestamp: 800, completedAt: 1200 })],
            taskState: 'idle',
            currentSeq: 12,
        });

        expect(useAssistantStore.getState().messages.map((m) => m.id)).toEqual(['u1', 'a1', 'a2']);
    });

    test('离线期间产生的回复排在尚未受理的本地消息之前', () => {
        useAssistantStore.setState({
            messages: [
                userMessage({ id: 'u1', seq: 10 }),
                userMessage({ id: 'pending', seq: 0, status: 'sending', timestamp: 5000 }),
            ],
            currentSeq: 10,
        });

        handle(client)({
            type: 'sync_result',
            sessionId: 'main',
            messages: [assistantMessage({ id: 'a1', seq: 11, timestamp: 1200 })],
            taskState: 'idle',
            currentSeq: 11,
        });

        expect(useAssistantStore.getState().messages.map((m) => m.id)).toEqual(['u1', 'a1', 'pending']);
    });

    test('服务端补回的多条新增消息按 seq 排序后追回正确位置', () => {
        useAssistantStore.setState({ messages: [userMessage({})], currentSeq: 10 });

        handle(client)({
            type: 'sync_result',
            sessionId: 'main',
            messages: [
                assistantMessage({ id: 'a3', seq: 13, timestamp: 500 }),
                assistantMessage({ id: 'a2', seq: 12, timestamp: 900 }),
            ],
            taskState: 'idle',
            currentSeq: 13,
        });

        expect(useAssistantStore.getState().messages.map((m) => m.id)).toEqual(['u1', 'a2', 'a3']);
    });

    test('受理回执以服务端时间覆盖本地设备时间', () => {
        useAssistantStore.setState({
            messages: [userMessage({ timestamp: 1700000000000, status: 'sending' })],
            currentSeq: 10,
        });

        handle(client)({
            type: 'message_ack',
            messageId: 'u1',
            seq: 10,
            status: 'sent',
            role: 'user',
            content: '问题',
            timestamp: 1699999999000,
        });

        const stored = useAssistantStore.getState().messages[0];
        expect(stored.timestamp).toBe(1699999999000);
        expect(stored.status).toBe('sent');
    });
});
