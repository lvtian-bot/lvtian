import { getChatTimeline } from '../src/utils/chatTimeline';
import { getAssistantDisplayParts } from '../src/utils/assistantMessageParts';
import { AssistantClient } from '../src/services/AssistantClient';
import { useAssistantStore } from '../src/store/useAssistantStore';
import type { AssistantMessage, ServerMessage } from '../src/types/assistantProtocol';

const user = (id: string, timestamp: number, replyTo?: string): AssistantMessage => ({
    id, timestamp, seq: timestamp, role: 'user', content: id, status: 'sent', replyTo,
});
const answer = (patch: Partial<AssistantMessage> = {}): AssistantMessage => ({
    id: 'a', timestamp: 2, seq: 20, role: 'assistant', content: 'answer', status: 'done',
    completedAt: 10, replyTo: 'u', ...patch,
});
const boundary = (id: string, timestamp: number, textOffset = 0) => ({ messageId: id, timestamp, textOffset });
const visible = (messages: AssistantMessage[]) => getChatTimeline(messages).filter(m => m.content.trim());

test.each([2, 4])('%i consumed supplements precede the answer; late next-turn input stays later', count => {
    const supplements = Array.from({ length: count }, (_, i) => user(`s${i}`, 3 + i, 'u'));
    const reply = answer({ supplementBoundaries: supplements.map(m => boundary(m.id, m.timestamp)) });
    const rows = visible([user('u', 1), reply, ...supplements, user('late', 9)]);
    expect(rows.map(m => m.id)).toEqual(['u', ...supplements.map(m => m.id), 'a', 'late']);
    expect(rows.find(m => m.id === 'a')?.completedAt).toBe(10);
    expect(reply.timestamp).toBe(2);
});

test('prose already streamed stays in place, with no tools required to split subsequent prose', () => {
    const reply = answer({ content: 'first😀middlelast', supplementBoundaries: [
        boundary('s1', 3, 7), boundary('s2', 4, 13),
    ] });
    const rows = visible([user('u', 1), reply, user('s1', 3, 'u'), user('s2', 4, 'u')]);
    expect(rows.map(m => m.content)).toEqual(['u', 'first😀', 's1', 'middle', 's2', 'last']);
    expect(rows.filter(m => m.id === 'a').map(m => m.completedAt)).toEqual([undefined, undefined, 10]);
    expect(rows.filter(m => m.id === 'a').map(m => m.timelineKey)).toEqual(['a', 'a:supplement:7', 'a:supplement:13']);
    expect(reply.content).toBe('first😀middlelast');
});

test('all tool-separated prose after consumption follows the supplement, including prose before the last tool', () => {
    const reply = answer({ content: 'beforeafterfinal', supplementBoundaries: [boundary('s', 3, 6)],
        toolCalls: [{ id: 'one', name: 'tool', status: 'done' }, { id: 'two', name: 'tool', status: 'done' }],
        toolCallPositions: [{ toolCallId: 'one', textOffset: 6 }, { toolCallId: 'two', textOffset: 11 }] });
    const rows = visible([user('u', 1), reply, user('s', 3, 'u')]);
    expect(rows.map(m => m.content)).toEqual(['u', 'before', 's', 'afterfinal']);
    expect(getAssistantDisplayParts(rows[3]).filter(p => p.type === 'text').map(p => p.text)).toEqual(['after', 'final']);
});

test('ordinary and legacy records keep their identity and order regardless of completion time', () => {
    const records = [user('u', 1), answer(), user('s', 3, 'u'), user('next', 4), answer({ id: 'next-a', completedAt: 5 })];
    const rows = getChatTimeline(records);
    expect(rows).toEqual(records);
    rows.forEach((row, i) => expect(row).toBe(records[i]));
});

test('same-millisecond anchor and cross-day pagination use the persisted position, not completion', () => {
    const midnight = new Date(2026, 10, 25).getTime();
    const reply = answer({ timestamp: midnight - 100, completedAt: midnight + 1000,
        supplementBoundaries: [boundary('s', midnight)] });
    const records = [user('u', midnight - 200), reply, user('s', midnight, 'u'), user('late', midnight)];
    const rows = visible(records);
    expect(rows.map(m => m.id)).toEqual(['u', 's', 'a', 'late']);
    expect(rows[2].timelineTimestamp).toBe(midnight);
    expect(rows[2].completedAt).toBe(midnight + 1000);
    const latest = rows.slice().reverse().slice(0, 2);
    expect(latest.map(m => m.id)).toEqual(['late', 'a']);
    expect(visible([reply, user('later', midnight + 10)]).map(m => m.id)).toEqual(['a', 'later']);
});

test('real-time boundary events and reconnect snapshots produce identical rows and completion time', () => {
    const client = AssistantClient.getInstance();
    const handle = (client as unknown as { handleServerMessage: (m: ServerMessage) => void }).handleServerMessage.bind(client);
    useAssistantStore.setState({ messages: [user('u', 1)], currentSeq: 1, clearedSeq: 0,
        pendingSendQueue: [], pendingCancelQueue: [], taskState: 'processing' });
    handle({ type: 'event_chunk', sessionId: 'main', messageId: 'a', seq: 2, timestamp: 2, replyTo: 'u', delta: 'before' });
    handle({ type: 'message_ack', messageId: 's', seq: 3, role: 'user', content: 's', timestamp: 3, replyTo: 'u', status: 'sent' });
    handle({ type: 'event_chunk', sessionId: 'main', messageId: 'a', seq: 4, supplementBoundaries: [boundary('s', 3, 6)] });
    handle({ type: 'event_chunk', sessionId: 'main', messageId: 'a', seq: 5, delta: 'after' });
    handle({ type: 'task_status', sessionId: 'main', seq: 6, state: 'completed', completedAt: 10 });
    const snapshot = structuredClone(useAssistantStore.getState().messages);
    const live = visible(snapshot);
    expect(live.map(m => m.content)).toEqual(['u', 'before', 's', 'after']);
    expect(live.at(-1)?.completedAt).toBe(10);
    useAssistantStore.setState({ messages: [], currentSeq: 0 });
    handle({ type: 'sync_result', sessionId: 'main', messages: snapshot, taskState: 'completed', currentSeq: 6, replaceCache: true });
    expect(visible(useAssistantStore.getState().messages)).toEqual(live);
    client.disconnect();
});
