import { useAssistantStore } from '../src/store/useAssistantStore';
import { AssistantMessage } from '../src/types/assistantProtocol';

describe('useAssistantStore persistence cursor and messages', () => {
    beforeEach(() => {
        useAssistantStore.getState().clearChat();
    });

    test('partialize anchors currentSeq to durable persisted messages and filters processing', () => {
        const store = useAssistantStore.getState();

        const userMsg: AssistantMessage = {
            id: 'user-1',
            seq: 1,
            role: 'user',
            content: '你好',
            timestamp: Date.now(),
            status: 'sent',
        };

        const processingMsg: AssistantMessage = {
            id: 'asst-1',
            seq: 5,
            role: 'assistant',
            content: '思考中...',
            timestamp: Date.now(),
            status: 'processing',
        };

        store.addOrUpdateMessage(userMsg);
        store.addOrUpdateMessage(processingMsg);
        store.setCurrentSeq(5);

        const persistOptions = (
            useAssistantStore as unknown as {
                persist: {
                    getOptions: () => {
                        partialize: (state: unknown) => {
                            messages: AssistantMessage[];
                            currentSeq: number;
                        };
                    };
                };
            }
        ).persist.getOptions();

        const partial = persistOptions.partialize(useAssistantStore.getState());

        // 验证 processing 消息未被持久化
        expect(partial.messages.some((m) => m.status === 'processing')).toBe(false);
        expect(partial.messages.length).toBe(1);
        expect(partial.messages[0].id).toBe('user-1');

        // 验证 currentSeq 锚定在持久化消息集合的最大 seq (1)，杜绝冷启动 sync 跳过返回丢失流式消息
        expect(partial.currentSeq).toBe(1);
    });

    test('empty messages partialize currentSeq to 0 and records clearedSeq', () => {
        const store = useAssistantStore.getState();
        const userMsg: AssistantMessage = {
            id: 'user-1',
            seq: 12,
            role: 'user',
            content: '你好',
            timestamp: Date.now(),
            status: 'sent',
        };
        store.addOrUpdateMessage(userMsg);
        store.setCurrentSeq(12);

        store.clearChat();

        const persistOptions = (
            useAssistantStore as unknown as {
                persist: {
                    getOptions: () => {
                        partialize: (state: unknown) => {
                            messages: AssistantMessage[];
                            currentSeq: number;
                            clearedSeq: number;
                        };
                    };
                };
            }
        ).persist.getOptions();

        const partial = persistOptions.partialize(useAssistantStore.getState());
        expect(partial.messages.length).toBe(0);
        expect(partial.currentSeq).toBe(0);
        expect(partial.clearedSeq).toBe(12);
    });

    test('setServerConfig resets clearedSeq when switching to a different server', async () => {
        const store = useAssistantStore.getState();
        await store.setServerConfig('https://server-a.example.com', 'token-a');
        store.addOrUpdateMessage({
            id: 'user-1',
            seq: 100,
            role: 'user',
            content: 'test',
            timestamp: Date.now(),
            status: 'sent',
        });
        store.setCurrentSeq(100);
        store.clearChat();
        expect(useAssistantStore.getState().clearedSeq).toBe(100);

        // 切换到新服务器地址，验证 clearedSeq 与 currentSeq 一并重置归零
        await store.setServerConfig('https://server-b.example.com', 'token-b');
        expect(useAssistantStore.getState().clearedSeq).toBe(0);
        expect(useAssistantStore.getState().currentSeq).toBe(0);
    });

    test('pendingSendQueue and isServerUpgrading lifecycle', async () => {
        const store = useAssistantStore.getState();

        expect(store.isServerUpgrading).toBe(false);
        expect(store.pendingSendQueue).toEqual([]);

        // 升级态设置
        store.setIsServerUpgrading(true);
        expect(useAssistantStore.getState().isServerUpgrading).toBe(true);

        // 消息排队与去重
        store.addToPendingSendQueue({ sessionId: 'main', messageId: 'm1', content: 'hello' });
        store.addToPendingSendQueue({ sessionId: 'main', messageId: 'm2', content: 'world' });
        store.addToPendingSendQueue({ sessionId: 'main', messageId: 'm1', content: 'hello updated' });

        const queue = useAssistantStore.getState().pendingSendQueue;
        expect(queue.length).toBe(2);
        expect(queue[0].messageId).toBe('m2');
        expect(queue[1].messageId).toBe('m1');
        expect(queue[1].content).toBe('hello updated');

        // partialize 包含 pendingSendQueue
        const persistOptions = (
            useAssistantStore as unknown as {
                persist: {
                    getOptions: () => {
                        partialize: (state: unknown) => {
                            pendingSendQueue: Array<{ sessionId: string; messageId: string; content: string }>;
                        };
                    };
                };
            }
        ).persist.getOptions();

        const partial = persistOptions.partialize(useAssistantStore.getState());
        expect(partial.pendingSendQueue.length).toBe(2);

        // 出队
        store.removeFromPendingSendQueue('m2');
        expect(useAssistantStore.getState().pendingSendQueue.length).toBe(1);
        expect(useAssistantStore.getState().pendingSendQueue[0].messageId).toBe('m1');

        // 切换服务器清空队列与升级态
        await store.setServerConfig('https://server-c.example.com', 'token-c');
        expect(useAssistantStore.getState().isServerUpgrading).toBe(false);
        expect(useAssistantStore.getState().pendingSendQueue).toEqual([]);
    });
});
