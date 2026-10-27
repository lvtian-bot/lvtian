import { AssistantClient } from '../src/services/AssistantClient';
import { useAssistantStore } from '../src/store/useAssistantStore';
import type { AssistantMessage, ServerMessage, ToolCallState } from '../src/types/assistantProtocol';
import { getAssistantMessageParts } from '../src/utils/assistantMessageParts';

const tool = (id: string, status: ToolCallState['status'] = 'running'): ToolCallState => ({ id, name: 'read', status });
const message = (extra: Partial<AssistantMessage> = {}): AssistantMessage => ({
    id: 'reply', seq: 1, role: 'assistant', content: '', timestamp: 1, status: 'processing', ...extra,
});
const display = (msg: AssistantMessage) => getAssistantMessageParts(msg).map((part) =>
    part.type === 'text' ? part.text : `tool:${part.tool.id}:${part.tool.status}`);

beforeEach(() => {
    useAssistantStore.setState({ messages: [], clearedSeq: 0, currentSeq: 0, pendingSendQueue: [] });
});

test('alternates streamed prose and tools, preserving emoji and continuous text', () => {
    const store = useAssistantStore.getState();
    store.addOrUpdateMessage(message());
    store.appendDeltaToMessage('reply', '开始😀');
    store.appendDeltaToMessage('reply', '检查');
    store.setToolCallForMessage('reply', tool('first'));
    store.appendDeltaToMessage('reply', '发现问题');
    store.setToolCallForMessage('reply', tool('second'));
    store.appendDeltaToMessage('reply', '已完成');
    const previous = useAssistantStore.getState().messages[0];
    const keys = getAssistantMessageParts(previous).map((part) => part.key);
    store.setToolCallForMessage('reply', tool('first', 'done'));
    const current = useAssistantStore.getState().messages[0];
    expect(previous.toolCalls?.[0].status).toBe('running');
    expect(current.content).toBe('开始😀检查发现问题已完成');
    expect(current.toolCallPositions).toEqual([
        { toolCallId: 'first', textOffset: 6 }, { toolCallId: 'second', textOffset: 10 },
    ]);
    expect(display(current)).toEqual(['开始😀检查', 'tool:first:done', '发现问题', 'tool:second:running', '已完成']);
    expect(getAssistantMessageParts(current).map((part) => part.key)).toEqual(keys);
});

test('adjacent tools do not create empty prose and late updates never move their anchors', () => {
    const store = useAssistantStore.getState();
    store.addOrUpdateMessage(message());
    store.setToolCallForMessage('reply', tool('first'));
    store.setToolCallForMessage('reply', tool('second'));
    store.appendDeltaToMessage('reply', '结束');
    store.setToolCallForMessage('reply', tool('first', 'failed'));
    expect(display(useAssistantStore.getState().messages[0])).toEqual(['tool:first:failed', 'tool:second:running', '结束']);
});

test('legacy history keeps its tools-before-prose fallback and records only new tool positions', () => {
    const store = useAssistantStore.getState();
    const legacy = message({ content: '旧正文', toolCalls: [tool('old')] });
    expect(display(legacy)).toEqual(['tool:old:running', '旧正文']);
    store.addOrUpdateMessage(legacy);
    store.setToolCallForMessage('reply', tool('new'));
    store.appendDeltaToMessage('reply', '新正文');
    expect(display(useAssistantStore.getState().messages[0])).toEqual(['tool:old:running', '旧正文', 'tool:new:running', '新正文']);
});

test('plain text and whitespace-only replies have no unnecessary bubbles', () => {
    expect(display(message({ content: '连续的正文' }))).toEqual(['连续的正文']);
    expect(display(message({ content: ' \n' }))).toEqual([]);
    expect(display(message())).toEqual([]);
});

test('missing, duplicate and invalid anchors never drop text or duplicate tools', () => {
    const msg = message({ content: '完整正文', toolCalls: [tool('first'), tool('second')], toolCallPositions: [
        { toolCallId: 'first', textOffset: -10 },
        { toolCallId: 'first', textOffset: 2 },
        { toolCallId: 'second', textOffset: 1000 },
        { toolCallId: 'unknown', textOffset: 1 },
    ] });
    expect(display(msg)).toEqual(['完整', 'tool:first:running', '正文', 'tool:second:running']);
});

test('completed local persistence retains timeline metadata unchanged', () => {
    const msg = message({ content: '前后', status: 'done', toolCalls: [tool('first', 'done')],
        toolCallPositions: [{ toolCallId: 'first', textOffset: 1 }],
    });
    useAssistantStore.getState().setMessages([msg]);
    const persisted = useAssistantStore.persist.getOptions().partialize!(useAssistantStore.getState());
    const restored = JSON.parse(JSON.stringify(persisted)) as { messages: AssistantMessage[] };
    expect(display(restored.messages[0])).toEqual(['前', 'tool:first:done', '后']);
});

test('client streaming and reconnect reconciliation render the same ordered history', () => {
    const client = AssistantClient.getInstance();
    const receive = (client as unknown as { handleServerMessage: (msg: ServerMessage) => void }).handleServerMessage.bind(client);
    let seq = 0;
    const chunk = (data: { delta?: string; toolCall?: ToolCallState }) => receive({
        type: 'event_chunk', sessionId: 'main', messageId: 'reply', seq: ++seq, ...data,
    });
    chunk({ delta: '先检查' });
    chunk({ toolCall: tool('first') });
    chunk({ delta: '再修改' });
    chunk({ toolCall: tool('second') });
    chunk({ delta: '完成' });
    chunk({ toolCall: tool('first', 'done') });
    const live = useAssistantStore.getState().messages[0];
    const expected = ['先检查', 'tool:first:done', '再修改', 'tool:second:running', '完成'];
    expect(display(live)).toEqual(expected);
    useAssistantStore.setState({ messages: [] });
    receive({ type: 'sync_result', sessionId: 'main', messages: [JSON.parse(JSON.stringify(live)) as AssistantMessage],
        taskState: 'processing', currentSeq: seq,
    });
    expect(display(useAssistantStore.getState().messages[0])).toEqual(expected);
    chunk({ toolCall: tool('second', 'done') });
    chunk({ delta: '。' });
    expect(display(useAssistantStore.getState().messages[0])).toEqual(['先检查', 'tool:first:done', '再修改', 'tool:second:done', '完成。']);
});

test('assistant placeholder adopts the server creation time instead of the device clock', () => {
    const client = AssistantClient.getInstance();
    const receive = (client as unknown as { handleServerMessage: (msg: ServerMessage) => void }).handleServerMessage.bind(client);

    // 设备时钟落后于服务端：若客户端用 Date.now()，回答会被排到提问之前
    receive({
        type: 'event_chunk', sessionId: 'main', messageId: 'reply-server-time',
        seq: 8, delta: '', status: 'thinking', timestamp: 9000,
    });

    const msg = useAssistantStore.getState().messages.find((m) => m.id === 'reply-server-time');
    expect(msg?.timestamp).toBe(9000);

    // 后续增量不得覆盖创建时间
    receive({ type: 'event_chunk', sessionId: 'main', messageId: 'reply-server-time', seq: 9, delta: '正文' });
    expect(useAssistantStore.getState().messages.find((m) => m.id === 'reply-server-time')?.timestamp).toBe(9000);
});
