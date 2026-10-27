import type { AssistantMessage, ToolCallState } from '../types/assistantProtocol';

/** 一轮“工作”：用户一次请求，加上它引发的全部工具与产出。 */
export interface ChatTurn {
    /** 以用户消息 id 作为这一轮的身份，稳定且与排序无关 */
    id: string;
    question: string;
    answer: string;
    title: string;
    summary: string;
    tools: ToolCallState[];
    startedAt: number;
    completedAt: number;
    status: 'running' | 'done' | 'error';
}

/** 按本地日历日聚合后的工作记录分段。 */
export interface TurnDayGroup {
    key: string;
    /** 该日任意时刻的时间戳，供界面按当前语言格式化日期标题 */
    date: number;
    data: ChatTurn[];
}

const TITLE_MAX = 28;
const SUMMARY_MAX = 60;

/** 取首行有效文字，去掉 Markdown 标记与多余空白，超长省略。 */
export function firstMeaningfulLine(text: string, maxLength: number): string {
    const line = text
        .split(/\r?\n/)
        .map((item) => item
            .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, '')
            .replace(/[*`_]/g, '')
            .trim())
        .find((item) => item.length > 0);
    if (!line) return '';
    return line.length > maxLength ? `${line.slice(0, maxLength).trimEnd()}…` : line;
}

/**
 * 按“用户一次请求”切分历史消息。
 * 助手回复优先按 replyTo 归回它实际回答的请求；旧历史没有该字段时，回退到到达顺序。
 * 工具归属到它所在的那一轮。
 */
export function buildChatTurns(messages: AssistantMessage[]): ChatTurn[] {
    const turns: ChatTurn[] = [];
    const turnsById = new Map<string, ChatTurn>();
    let current: ChatTurn | undefined;

    for (const message of messages) {
        if (message.role === 'user') {
            current = {
                id: message.id,
                question: message.content,
                answer: '',
                title: firstMeaningfulLine(message.content, TITLE_MAX),
                summary: '',
                tools: [],
                startedAt: message.timestamp,
                completedAt: message.timestamp,
                status: message.status === 'error' ? 'error' : 'running',
            };
            turns.push(current);
            turnsById.set(current.id, current);
            continue;
        }
        // 定时任务的后台汇报不是对当前用户请求的回答，不能并进上一轮。
        if (message.source === 'native_task_report') continue;
        if (message.role !== 'assistant') continue;
        const target = message.replyTo ? turnsById.get(message.replyTo) : current;
        if (!target) continue;

        if (message.content.trim()) {
            target.answer = target.answer
                ? `${target.answer}\n\n${message.content}`
                : message.content;
            // 列表摘要取最后一次正文的首行：过程性开场白不应盖过最终结论。
            target.summary = firstMeaningfulLine(message.content, SUMMARY_MAX);
        }
        if (message.toolCalls?.length) {
            // 同一轮内按工具首次出现的正文锚点排序；缺失锚点时保持服务端数组顺序。
            const offsets = new Map(
                (message.toolCallPositions ?? []).map((item) => [item.toolCallId, item.textOffset]),
            );
            const orderedTools = offsets.size > 0
                ? [...message.toolCalls].sort((a, b) =>
                    (offsets.get(a.id) ?? Number.MAX_SAFE_INTEGER)
                    - (offsets.get(b.id) ?? Number.MAX_SAFE_INTEGER))
                : message.toolCalls;
            for (const tool of orderedTools) {
                const index = target.tools.findIndex((item) => item.id === tool.id);
                if (index >= 0) target.tools[index] = tool;
                else target.tools.push(tool);
            }
        }
        target.completedAt = Math.max(target.completedAt, message.completedAt ?? message.timestamp);
        if (message.status === 'error') target.status = 'error';
        else if (message.status === 'processing' && target.status !== 'error') target.status = 'running';
        else if (message.status === 'done' && target.status !== 'error') target.status = 'done';
    }

    for (const turn of turns) {
        if (!turn.summary) turn.summary = firstMeaningfulLine(turn.answer, SUMMARY_MAX);
    }

    return turns.reverse();
}

/** 按本地日历日分组；标题由界面按当前语言生成。 */
export function groupTurnsByDay(turns: ChatTurn[]): TurnDayGroup[] {
    const groups: TurnDayGroup[] = [];

    for (const turn of turns) {
        const date = new Date(turn.completedAt);
        if (Number.isNaN(date.getTime())) continue;
        const start = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
        const key = String(start);
        let group = groups[groups.length - 1];
        if (!group || group.key !== key) {
            group = { key, date: start, data: [] };
            groups.push(group);
        }
        group.data.push(turn);
    }
    return groups;
}
