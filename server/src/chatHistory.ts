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

function compareHistory(a: ChatHistoryCursor, b: ChatHistoryCursor): number {
    return a.timestamp - b.timestamp || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** The oldest returned row is an exclusive, deletion-safe cursor. */
export function chatHistoryPage(
    messages: AssistantMessage[],
    clearedSeq: number,
    before?: ChatHistoryCursor,
): ChatHistoryPage {
    const eligible = messages
        .map((message, index) => ({ message, index }))
        .filter(({ message }) => message.seq > clearedSeq && (!before || compareHistory(message, before) < 0))
        .sort((a, b) => compareHistory(a.message, b.message));
    const page: typeof eligible = [];
    let bytes = 0;
    let remaining = eligible.length;
    while (remaining > 0 && page.length < PAGE_SIZE) {
        const { message: original, index } = eligible[remaining - 1];
        const message = compactChatMessage(original);
        const size = Buffer.byteLength(JSON.stringify(message)) + 1;
        // Always make progress, including for an individual large reply or image.
        if (page.length > 0 && bytes + size > CHAT_PAGE_BYTES) break;
        page.push({ message, index });
        bytes += size;
        remaining--;
    }
    const oldest = page.at(-1)?.message;
    return {
        messages: page.sort((a, b) => a.message.timestamp - b.message.timestamp || a.index - b.index)
            .map(({ message }) => message),
        historyBefore: remaining > 0 && oldest ? { id: oldest.id, timestamp: oldest.timestamp } : null,
    };
}
