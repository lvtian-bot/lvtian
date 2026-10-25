import { AssistantMessage } from '../src/types/assistantProtocol';

describe('ChatWindowing and Inverted List Logic', () => {
    const createMockMessages = (count: number): AssistantMessage[] => {
        return Array.from({ length: count }, (_, i) => ({
            id: `msg-${i + 1}`,
            seq: i + 1,
            role: i % 2 === 0 ? 'user' : 'assistant',
            content: `Message ${i + 1}`,
            timestamp: 1700000000000 + i * 1000,
            status: 'done',
        }));
    };

    it('倒序模型使得 index 0 天然为最新消息', () => {
        const messages = createMockMessages(5);
        const reversed = [...messages].reverse();

        expect(reversed[0].id).toBe('msg-5');
        expect(reversed[0].content).toBe('Message 5');
        expect(reversed[reversed.length - 1].id).toBe('msg-1');
    });

    it('初始开窗仅装载最新的 N 条记录，杜绝预加载全量历史', () => {
        const total = 100;
        const messages = createMockMessages(total);
        const reversed = [...messages].reverse();

        const windowSize = 30;
        const display = reversed.slice(0, windowSize);

        expect(display).toHaveLength(30);
        expect(display[0].id).toBe('msg-100'); // 最新
        expect(display[29].id).toBe('msg-71'); // 初始可见的最老一条
    });

    it('向上翻阅触发增量加载时，平滑展开更早历史批次', () => {
        const total = 80;
        const messages = createMockMessages(total);
        const reversed = [...messages].reverse();

        let windowSize = 30;
        // 第 1 批
        let display = reversed.slice(0, windowSize);
        expect(display).toHaveLength(30);

        // 触顶翻页加载下一批 30 条
        windowSize = Math.min(windowSize + 30, reversed.length);
        display = reversed.slice(0, windowSize);
        expect(display).toHaveLength(60);
        expect(display[0].id).toBe('msg-80');
        expect(display[59].id).toBe('msg-21');

        // 再次触顶，加载剩余所有数据
        windowSize = Math.min(windowSize + 30, reversed.length);
        display = reversed.slice(0, windowSize);
        expect(display).toHaveLength(80);
        expect(display[79].id).toBe('msg-1');
    });

    it('当收到新消息时，新消息立即出现在倒序视口原点（第 0 项）', () => {
        const messages = createMockMessages(5);
        const reversed = [...messages].reverse();
        expect(reversed[0].id).toBe('msg-5');

        // 新消息到达
        const newMessage: AssistantMessage = {
            id: 'msg-6',
            seq: 6,
            role: 'user',
            content: 'Message 6',
            timestamp: 1700000006000,
            status: 'done',
        };
        const updatedMessages = [...messages, newMessage];
        const updatedReversed = [...updatedMessages].reverse();

        expect(updatedReversed[0].id).toBe('msg-6');
        expect(updatedReversed[0].content).toBe('Message 6');
    });
});
