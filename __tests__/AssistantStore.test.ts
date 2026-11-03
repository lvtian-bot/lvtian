import { useAssistantStore } from '../src/store/useAssistantStore';
import { AssistantMessage } from '../src/types/assistantProtocol';

describe('useAssistantStore persistence cursor and messages', () => {
    beforeEach(() => {
        useAssistantStore.getState().clearChat();
    });

    test('cache stores confirmed messages but no sync cursor', () => {
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

        expect(partial).not.toHaveProperty('currentSeq');
    });

    test('empty chat produces an empty disposable cache', () => {
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
        expect(partial).not.toHaveProperty('currentSeq');
        expect(partial).not.toHaveProperty('clearedSeq');
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

        // 切换到新服务器地址，验证 clearedSeq 与 currentSeq 一并重置归零，且技能列表清空
        store.setSkills([{ name: 'old-skill', description: '旧技能' }]);
        await store.setServerConfig('https://server-b.example.com', 'token-b');
        expect(useAssistantStore.getState().clearedSeq).toBe(0);
        expect(useAssistantStore.getState().currentSeq).toBe(0);
        expect(useAssistantStore.getState().skills).toEqual([]);
    });

    test('pendingSendQueue and isServerUpgrading lifecycle', async () => {
        const store = useAssistantStore.getState();

        expect(store.isServerUpgrading).toBe(false);
        expect(store.pendingSendQueue).toEqual([]);

        // 升级态设置
        store.setIsServerUpgrading(true);
        expect(useAssistantStore.getState().isServerUpgrading).toBe(true);

        // 消息排队与去重（包含大附件）
        store.addToPendingSendQueue({
            sessionId: 'main',
            messageId: 'm1',
            content: 'hello',
            attachments: [
                {
                    type: 'image',
                    name: 'photo.jpg',
                    uri: 'file:///photo.jpg',
                    data: 'huge-base64-payload',
                    content: 'raw-content',
                },
            ],
        });
        store.addToPendingSendQueue({ sessionId: 'main', messageId: 'm2', content: 'world' });
        store.addToPendingSendQueue({ sessionId: 'main', messageId: 'm1', content: 'hello updated' });

        const queue = useAssistantStore.getState().pendingSendQueue;
        expect(queue.length).toBe(2);
        expect(queue[0].messageId).toBe('m1');
        expect(queue[0].content).toBe('hello updated');
        expect(queue[1].messageId).toBe('m2');
        expect(queue[1].content).toBe('world');

        const partial = useAssistantStore.persist.getOptions().partialize!(useAssistantStore.getState());
        expect(partial).not.toHaveProperty('pendingSendQueue');

        // 出队
        store.removeFromPendingSendQueue('m2');
        expect(useAssistantStore.getState().pendingSendQueue.length).toBe(1);
        expect(useAssistantStore.getState().pendingSendQueue[0].messageId).toBe('m1');

        // 切换服务器清空队列与升级态
        await store.setServerConfig('https://server-c.example.com', 'token-c');
        expect(useAssistantStore.getState().isServerUpgrading).toBe(false);
        expect(useAssistantStore.getState().pendingSendQueue).toEqual([]);
    });

    test('disposable chat cache does not contain pending cancellations', () => {
        const store = useAssistantStore.getState();
        store.addToPendingCancelQueue('del-msg-1');
        store.addToPendingCancelQueue('del-msg-2');

        const persistOptions = (
            useAssistantStore as unknown as {
                persist: {
                    getOptions: () => {
                        partialize: (state: unknown) => {
                            pendingCancelQueue: string[];
                        };
                    };
                };
            }
        ).persist.getOptions();

        const partial = persistOptions.partialize(useAssistantStore.getState());
        expect(partial).not.toHaveProperty('pendingCancelQueue');
    });
});
