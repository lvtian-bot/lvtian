import type { AssistantMessage, ToolCallState } from '../types/assistantProtocol';

export type AssistantMessagePart =
    | { type: 'text'; key: string; text: string }
    | { type: 'tool'; key: string; tool: ToolCallState };

/** Derive display bubbles without duplicating the canonical text or tool payloads. */
export function getAssistantMessageParts(message: AssistantMessage): AssistantMessagePart[] {
    const tools = new Map(message.toolCalls?.map((tool) => [tool.id, tool]));
    const positions = message.toolCallPositions ?? [];
    const offsets = new Map(positions.map((position) => [position.toolCallId, position.textOffset]));
    // Old history has no order information: preserve its existing tools-before-text fallback.
    const ordered = [...tools.values()].map((tool, index) => ({
        tool,
        index,
        offset: Math.min(message.content.length, Math.max(0,
            Number.isFinite(offsets.get(tool.id)) ? offsets.get(tool.id)! : 0)),
    })).sort((a, b) => a.offset - b.offset || a.index - b.index);
    const parts: AssistantMessagePart[] = [];
    let cursor = 0;
    const appendText = (end: number) => {
        const text = message.content.slice(cursor, end);
        if (text.trim()) parts.push({ type: 'text', key: `text-${cursor}`, text });
        cursor = end;
    };
    for (const { tool, offset } of ordered) {
        appendText(offset);
        parts.push({ type: 'tool', key: `tool-${tool.id}`, tool });
    }
    appendText(message.content.length);
    return parts;
}
