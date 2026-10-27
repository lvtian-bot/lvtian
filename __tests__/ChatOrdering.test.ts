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
    id: 'a1', seq: 11, role: 'assistant', content: '回答', timestamp: 1100, status: 'done', ...patch,
});

describe('聊天位置按服务端时间排序', () => {
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

    test('按时间而非更新序号排序，seq 被后续更新改小也不影响位置', () => {
        // 助手消息因流式更新拿到比提问更小的 seq，但服务端时间仍在提问之后。
        useAssistantStore.setState({
            messages: [
                userMessage({}),
                assistantMessage({ seq: 5 }),
            ],
            currentSeq: 11,
        });

        handle(client)({
            type: 'sync_result',
            sessionId: 'main',
            messages: [assistantMessage({ seq: 5 })],
            taskState: 'idle',
            currentSeq: 11,
        });

        expect(useAssistantStore.getState().messages.map((m) => m.id)).toEqual(['u1', 'a1']);
    });

    test('尚未受理的本地消息不参与排序，按原顺序留在末尾', () => {
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
            messages: [assistantMessage({ id: 'a1', timestamp: 1200 })],
            taskState: 'idle',
            currentSeq: 11,
        });

        expect(useAssistantStore.getState().messages.map((m) => m.id)).toEqual(['u1', 'a1', 'pending']);
    });

    test('服务端补回的多条新增消息按服务端时间归位', () => {
        useAssistantStore.setState({ messages: [userMessage({})], currentSeq: 10 });

        handle(client)({
            type: 'sync_result',
            sessionId: 'main',
            messages: [
                assistantMessage({ id: 'a3', seq: 13, timestamp: 1200 }),
                assistantMessage({ id: 'a2', seq: 12, timestamp: 900 }),
            ],
            taskState: 'idle',
            currentSeq: 13,
        });

        expect(useAssistantStore.getState().messages.map((m) => m.id)).toEqual(['a2', 'u1', 'a3']);
    });

    test('同一毫秒按到达顺序稳定排列', () => {
        useAssistantStore.setState({
            messages: [
                userMessage({ timestamp: 1000 }),
                assistantMessage({ timestamp: 1000 }),
            ],
            currentSeq: 11,
        });

        handle(client)({
            type: 'sync_result',
            sessionId: 'main',
            messages: [
                assistantMessage({ id: 'a2', seq: 12, timestamp: 1000 }),
            ],
            taskState: 'idle',
            currentSeq: 12,
        });

        expect(useAssistantStore.getState().messages.map((m) => m.id)).toEqual(['u1', 'a1', 'a2']);
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
