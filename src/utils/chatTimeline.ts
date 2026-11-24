import type { AssistantMessage } from '../types/assistantProtocol';

/** A display-only slice. Canonical messages remain intact for sync, copy and work records. */
export interface ChatTimelineMessage extends AssistantMessage {
    timelineKey?: string;
    timelineTimestamp?: number;
}

/** Project chronological messages before reversing or paginating the chat list. */
export function getChatTimeline(messages: AssistantMessage[]): ChatTimelineMessage[] {
    const indices = new Map(messages.map((message, index) => [message.id, index]));
    const rows: Array<{ message: ChatTimelineMessage; position: number }> = [];
    messages.forEach((message, index) => {
        const boundaries = message.role === 'assistant' ? message.supplementBoundaries ?? [] : [];
        if (!boundaries.length) {
            rows.push({ message, position: index });
            return;
        }
        const firstRow = rows.length;
        let start = 0;
        let position = index;
        let timestamp = message.timestamp;
        const append = (end: number, final: boolean) => {
            const content = message.content.slice(start, end);
            // Keep terminal/attachment-only rows, but never introduce empty intermediate rows.
            if (!content.trim() && !final) return;
            rows.push({ position, message: {
                ...message, content,
                timelineKey: start === 0 ? message.id : `${message.id}:supplement:${start}`,
                timelineTimestamp: timestamp,
                completedAt: final ? message.completedAt : undefined,
                attachments: final ? message.attachments : undefined,
                errorMessage: final ? message.errorMessage : undefined,
                stopReason: final ? message.stopReason : undefined,
                toolCallPositions: message.toolCallPositions?.map(anchor => ({ ...anchor,
                    textOffset: Math.min(end - start, Math.max(0, anchor.textOffset - start)),
                })),
            } });
        };
        for (const boundary of boundaries) {
            if (!Number.isInteger(boundary.textOffset) || boundary.textOffset < start
                || boundary.textOffset > message.content.length || !Number.isFinite(boundary.timestamp)) continue;
            append(boundary.textOffset, false);
            start = boundary.textOffset;
            const anchorIndex = indices.get(boundary.messageId);
            // The stored timestamp keeps an off-page/deleted anchor in its original day.
            const nextIndex = messages.findIndex(candidate => candidate.seq === 0 || candidate.timestamp > boundary.timestamp);
            position = anchorIndex !== undefined ? anchorIndex + 0.5
                : nextIndex < 0 ? messages.length : nextIndex - 0.5;
            timestamp = boundary.timestamp;
        }
        append(message.content.length, true);
        // Consumption may be followed only by tools/whitespace. Keep the completion
        // clock on the last actual prose without moving it or inventing an answer.
        for (let i = rows.length - 1; i >= firstRow; i--) {
            if (rows[i].message.content.trim()) {
                rows[i].message.completedAt = message.completedAt;
                break;
            }
        }
    });
    return rows.sort((a, b) => a.position - b.position).map(row => row.message);
}
