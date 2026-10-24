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
});
