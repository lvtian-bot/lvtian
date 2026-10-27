import { buildChatTurns, groupTurnsByDay, firstMeaningfulLine } from '../src/utils/chatTurns';
import { AssistantMessage } from '../src/types/assistantProtocol';

const message = (patch: Partial<AssistantMessage> & { id: string; role: AssistantMessage['role'] }): AssistantMessage => ({
    seq: 0,
    content: '',
    timestamp: 0,
    status: 'done',
    ...patch,
});

describe('工作记录按轮聚合', () => {
    test('一轮 = 一次用户请求与其后的全部助手产出，工具归属该轮', () => {
        const messages: AssistantMessage[] = [
            message({ id: 'u1', role: 'user', content: '清理 GitHub Actions 存储', timestamp: 1 }),
            message({
                id: 'a1', role: 'assistant', timestamp: 2, content: '先看一下存储占用。',
                toolCalls: [{ id: 't1', name: 'bash', status: 'done', summary: 'du -sh artifacts' }],
            }),
            message({
                id: 'a2', role: 'assistant', timestamp: 3, completedAt: 5, content: '删除了 11 个文件，腾出 440MB。',
                toolCalls: [{ id: 't2', name: 'bash', status: 'done', summary: 'gh api delete' }],
            }),
            message({ id: 'u2', role: 'user', content: '检查 Gmail CLI 命令', timestamp: 6 }),
            message({ id: 'a3', role: 'assistant', timestamp: 7, completedAt: 9, content: '命令可用。' }),
        ];

        const turns = buildChatTurns(messages);
        expect(turns).toHaveLength(2);
        // 最新一轮在前，供列表直接渲染
        expect(turns[0].title).toBe('检查 Gmail CLI 命令');
        expect(turns[1].title).toBe('清理 GitHub Actions 存储');
        expect(turns[1].tools.map((tool) => tool.id)).toEqual(['t1', 't2']);
        expect(turns[1].completedAt).toBe(5);
        expect(turns[1].summary).toContain('删除了 11 个文件');
    });

    test('只依赖到达顺序，时间戳颠倒也不改变轮次与归属', () => {
        const messages: AssistantMessage[] = [
            message({ id: 'u1', role: 'user', content: '第一个问题', timestamp: 900 }),
            message({ id: 'a1', role: 'assistant', content: '第一个回答', timestamp: 100 }),
            message({ id: 'u2', role: 'user', content: '第二个问题', timestamp: 50 }),
            message({ id: 'a2', role: 'assistant', content: '第二个回答', timestamp: 40 }),
        ];

        const turns = buildChatTurns(messages);
        expect(turns.map((turn) => turn.id)).toEqual(['u2', 'u1']);
        expect(turns[1].answer).toBe('第一个回答');
    });

    test('无助手正文但有工具时保留工具，摘要交由界面本地化', () => {
        const turns = buildChatTurns([
            message({ id: 'u1', role: 'user', content: '查一下磁盘', timestamp: 1 }),
            message({
                id: 'a1', role: 'assistant', status: 'processing', timestamp: 2,
                toolCalls: [{ id: 't1', name: 'bash', status: 'running', summary: 'df -h' }],
            }),
        ]);
        expect(turns[0].status).toBe('running');
        expect(turns[0].tools).toHaveLength(1);
        expect(turns[0].summary).toBe('');
    });

    test('连续排队时按 replyTo 把回答与工具归回各自请求', () => {
        const turns = buildChatTurns([
            message({ id: 'u1', role: 'user', content: '第一个问题', timestamp: 1 }),
            message({ id: 'a1', role: 'assistant', replyTo: 'u1', content: '答一', timestamp: 2, completedAt: 3 }),
            message({ id: 'u2', role: 'user', content: '第二个问题', timestamp: 4 }),
            message({ id: 'u3', role: 'user', content: '第三个问题', timestamp: 5 }),
            message({
                id: 'a2', role: 'assistant', replyTo: 'u2', content: '答二', timestamp: 6, completedAt: 8,
                toolCalls: [{ id: 't2', name: 'bash', status: 'done', summary: '处理第二个问题' }],
            }),
            message({ id: 'a3', role: 'assistant', replyTo: 'u3', content: '答三', timestamp: 7, completedAt: 9 }),
        ]);

        expect(turns.map((turn) => turn.id)).toEqual(['u3', 'u2', 'u1']);
        expect(turns[0].answer).toBe('答三');
        expect(turns[1].answer).toBe('答二');
        expect(turns[1].tools.map((tool) => tool.id)).toEqual(['t2']);
        expect(turns[1].status).toBe('done');
        expect(turns[2].answer).toBe('答一');
    });

    test('发送失败或排队中被终止的请求落为失败态，不永久进行中', () => {
        const turns = buildChatTurns([
            message({ id: 'u1', role: 'user', content: '没发出去', timestamp: 1, status: 'error' }),
            message({ id: 'u2', role: 'user', content: '排队后被停止', timestamp: 2, status: 'error' }),
            message({ id: 'a2', role: 'assistant', replyTo: 'u2', content: '', timestamp: 3, status: 'error' }),
        ]);

        expect(turns).toHaveLength(2);
        expect(turns.map((turn) => turn.status)).toEqual(['error', 'error']);
    });

    test('同一轮内工具按正文锚点先后排列，不按状态更新顺序', () => {
        const turns = buildChatTurns([
            message({ id: 'u1', role: 'user', content: '检查仓库', timestamp: 1 }),
            message({
                id: 'a1', role: 'assistant', timestamp: 2, content: '先看状态，再读文档。',
                toolCalls: [
                    { id: 't2', name: 'read', status: 'done', summary: 'read: docs/README.md' },
                    { id: 't1', name: 'bash', status: 'done', summary: '$ git status' },
                ],
                toolCallPositions: [
                    { toolCallId: 't1', textOffset: 0 },
                    { toolCallId: 't2', textOffset: 6 },
                ],
            }),
        ]);
        expect(turns[0].tools.map((tool) => tool.id)).toEqual(['t1', 't2']);
    });

    test('定时任务后台汇报不并入上一轮用户请求', () => {
        const turns = buildChatTurns([
            message({ id: 'u1', role: 'user', content: '查一下磁盘', timestamp: 1 }),
            message({ id: 'a1', role: 'assistant', content: '磁盘使用率 42%。', timestamp: 2, completedAt: 3 }),
            message({
                id: 'report', role: 'assistant', source: 'native_task_report',
                content: '定时任务已完成：备份。', timestamp: 4, completedAt: 5,
            }),
        ]);
        expect(turns).toHaveLength(1);
        expect(turns[0].answer).toBe('磁盘使用率 42%。');
        expect(turns[0].completedAt).toBe(3);
    });

    test('标题取首个有效行并去掉 Markdown 标记', () => {
        expect(firstMeaningfulLine('\n## 清理 artifacts\n第二行', 28)).toBe('清理 artifacts');
        expect(firstMeaningfulLine('- 修复排序bug', 28)).toBe('修复排序bug');
        expect(firstMeaningfulLine('很长'.repeat(30), 10)).toHaveLength(11);
    });

    test('按本地日历日分组，日期标题交由界面按语言生成', () => {
        const today = new Date(2026, 9, 27, 12, 0, 0).getTime();
        const yesterday = new Date(2026, 9, 26, 12, 0, 0).getTime();
        const groups = groupTurnsByDay([
            { id: 'a', question: '', answer: '', title: '今天的事', summary: '', tools: [], startedAt: today, completedAt: today, status: 'done' },
            { id: 'b', question: '', answer: '', title: '昨天的事', summary: '', tools: [], startedAt: yesterday, completedAt: yesterday, status: 'done' },
        ]);
        expect(groups).toHaveLength(2);
        expect(groups[0].data.map((turn) => turn.id)).toEqual(['a']);
        expect(groups[1].data.map((turn) => turn.id)).toEqual(['b']);
        expect(groups[0].date).toBe(new Date(2026, 9, 27).getTime());
    });

    test('跨午夜时同一天只生成一个分段，不出现今天、昨天、今天的重复', () => {
        const today = new Date(2026, 9, 27, 9, 0, 0).getTime();
        const yesterday = new Date(2026, 9, 26, 23, 30, 0).getTime();
        const groups = groupTurnsByDay([
            { id: 'u3', question: '', answer: '', title: '今早的请求', summary: '', tools: [], startedAt: today, completedAt: today, status: 'done' },
            { id: 'u2', question: '', answer: '', title: '昨晚排队的请求', summary: '', tools: [], startedAt: yesterday, completedAt: yesterday, status: 'done' },
            { id: 'u1', question: '', answer: '', title: '昨晚开始今天完成', summary: '', tools: [], startedAt: yesterday, completedAt: today, status: 'done' },
        ]);
        expect(groups.map((group) => group.key)).toEqual([String(new Date(2026, 9, 27).getTime()), String(new Date(2026, 9, 26).getTime())]);
        expect(groups[0].data.map((turn) => turn.id)).toEqual(['u3', 'u1']);
        expect(groups[1].data.map((turn) => turn.id)).toEqual(['u2']);
    });

    test('分段按日期倒序，不受轮次开始顺序影响', () => {
        const today = new Date(2026, 9, 27, 9, 0, 0).getTime();
        const yesterday = new Date(2026, 9, 26, 23, 0, 0).getTime();
        const groups = groupTurnsByDay([
            { id: 'y', question: '', answer: '', title: '昨天', summary: '', tools: [], startedAt: yesterday, completedAt: yesterday, status: 'done' },
            { id: 't', question: '', answer: '', title: '今天', summary: '', tools: [], startedAt: today, completedAt: today, status: 'done' },
        ]);
        expect(groups.map((group) => group.data.map((turn) => turn.id))).toEqual([['t'], ['y']]);
    });
});
