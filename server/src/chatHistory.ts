import type { SessionData } from './sessionManager.js';
import type { AssistantMessage, ChatHistoryCursor, ChatHistoryPage, ToolCallState } from './protocol.js';

const PAGE_SIZE = 50;
export const CHAT_PAGE_BYTES = 128 * 1024;

export function compactChatTool({ input, output, ...tool }: ToolCallState, messageId: string): ToolCallState {
    return input !== undefined || output !== undefined ? { ...tool, detailMessageId: messageId } : tool;
}

export function compactChatMessage(message: AssistantMessage): AssistantMessage {
    if (!message.toolCalls?.some(tool => tool.input !== undefined || tool.output !== undefined)) return message;
    return {
        ...message,
        toolCalls: message.toolCalls.map(tool => compactChatTool(tool, message.id)),
    };
}

interface HistoryOrder {
    next: number;
    byId: Map<string, number>;
}

type HistoryPosition = Pick<ChatHistoryCursor, 'timestamp' | 'order'>;
type HistoryEntry = HistoryPosition & { message: AssistantMessage };
const historyOrders = new WeakMap<SessionData, HistoryOrder>();

function compareHistory(a: HistoryPosition, b: HistoryPosition): number {
    return a.timestamp - b.timestamp || a.order - b.order;
}

/** Keep creation order stable across edits and deletes within the same server epoch. */
function historyEntries(session: SessionData): HistoryEntry[] {
    const index = historyOrders.get(session) ?? { next: 0, byId: new Map<string, number>() };
    const seen = new Map<string, number>();
    const entries = session.messages.map(message => {
        const order = index.byId.get(message.id) ?? ++index.next;
        seen.set(message.id, order);
        return { message, order, timestamp: message.timestamp };
    });
    index.byId = seen;
    historyOrders.set(session, index);
    return entries;
}

export function chatHistoryPage(
    session: SessionData,
    clearedSeq: number,
    epoch: string,
    before?: ChatHistoryCursor,
): ChatHistoryPage {
    const eligible = historyEntries(session)
        .filter(entry => entry.message.seq > clearedSeq && (!before || compareHistory(entry, before) < 0))
        .sort(compareHistory);
    const page: HistoryEntry[] = [];
    let bytes = 0;
    let remaining = eligible.length;
    while (remaining > 0 && page.length < PAGE_SIZE) {
        const entry = eligible[remaining - 1];
        const message = compactChatMessage(entry.message);
        const size = Buffer.byteLength(JSON.stringify(message)) + 1;
        // Always make progress, including for an individual large reply or image.
        if (page.length > 0 && bytes + size > CHAT_PAGE_BYTES) break;
        page.push({ ...entry, message });
        bytes += size;
        remaining--;
    }

    const oldest = page.at(-1);
    if (!before) {
        // A reconnect must restore the full text prefix before future stream deltas.
        for (const entry of eligible.slice(0, remaining)) {
            if (entry.message.status === 'processing') {
                page.push({ ...entry, message: compactChatMessage(entry.message) });
            }
        }
    }

    return {
        messages: page.sort(compareHistory).map(({ message }) => message),
        historyBefore: remaining > 0 && oldest ? { epoch, timestamp: oldest.timestamp, order: oldest.order } : null,
    };
}
