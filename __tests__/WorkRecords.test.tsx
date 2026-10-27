import React from 'react';
import { SectionList, Text } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';

import { WorkRecordDetail, WorkRecordsScreen } from '../src/screens/WorkRecordsScreen';
import { useAssistantStore } from '../src/store/useAssistantStore';
import type { AssistantMessage } from '../src/types/assistantProtocol';
import { buildChatTurns } from '../src/utils/chatTurns';
import i18n from '../src/i18n';

jest.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const message = (patch: Partial<AssistantMessage> & { id: string; role: AssistantMessage['role'] }): AssistantMessage => ({
    seq: 0,
    content: '',
    timestamp: 0,
    status: 'done',
    ...patch,
});

const texts = (renderer: ReactTestRenderer.ReactTestRenderer) =>
    renderer.root.findAllByType(Text).map((node) => node.props.children).flat(Infinity);

describe('工作记录页面', () => {
    let renderer: ReactTestRenderer.ReactTestRenderer | undefined;
    beforeEach(() => {
        const now = Date.now();
        useAssistantStore.setState({
            messages: [
                message({ id: 'u1', role: 'user', seq: 1, content: '整理发票', timestamp: now - 4000 }),
                message({
                    id: 'a1', role: 'assistant', seq: 2, timestamp: now - 3000,
                    completedAt: now - 1000, content: '已整理 3 张发票，合计 286 元。',
                    toolCalls: [{ id: 't1', name: 'bash', status: 'done', summary: '整理交通发票' }],
                }),
                message({ id: 'u2', role: 'user', seq: 3, content: '查一下磁盘', timestamp: now - 500, status: 'sent' }),
                message({
                    id: 'a2', role: 'assistant', seq: 4, timestamp: now, status: 'processing',
                    toolCalls: [{ id: 't2', name: 'bash', status: 'running', summary: 'df -h' }],
                }),
            ],
        } as never);
    });

    afterEach(async () => {
        await ReactTestRenderer.act(async () => renderer?.unmount());
        renderer = undefined;
        jest.restoreAllMocks();
    });

    it('按轮次倒序聚合并给出标题、结果摘要和时间', async () => {
        await ReactTestRenderer.act(async () => { renderer = ReactTestRenderer.create(<WorkRecordsScreen />); });
        const list = renderer!.root.findByType(SectionList);
        const sections = list.props.sections;
        expect(sections).toHaveLength(1);
        expect(sections[0].data.map((turn: { id: string }) => turn.id)).toEqual(['u2', 'u1']);

        const running = sections[0].data[0];
        const done = sections[0].data[1];
        let row: ReactTestRenderer.ReactTestRenderer | undefined;
        await ReactTestRenderer.act(async () => {
            row = ReactTestRenderer.create(list.props.renderItem({ item: running }));
        });
        expect(texts(row!)).toContain('查一下磁盘');
        expect(texts(row!).some((value) => typeof value === 'string' && value.includes(i18n.t('workRecords.running')))).toBe(true);
        expect(texts(row!)).toContain(i18n.t('workRecords.toolCount', { count: 1 }));
        await ReactTestRenderer.act(async () => {
            row!.update(list.props.renderItem({ item: done }));
        });
        expect(texts(row!)).toContain('整理发票');
        expect(texts(row!)).toContain('已整理 3 张发票，合计 286 元。');
        await ReactTestRenderer.act(async () => { row?.unmount(); });
    });

    it('详情依次给出工作过程、工具流水和完整结论', async () => {
        const turn = buildChatTurns(useAssistantStore.getState().messages)[1];
        await ReactTestRenderer.act(async () => {
            renderer = ReactTestRenderer.create(<WorkRecordDetail turn={turn} onClose={jest.fn()} />);
        });
        expect(renderer!.root.findAllByProps({ testID: 'work-record-detail' }).length).toBeGreaterThan(0);
        expect(renderer!.root.findAllByProps({ testID: 'tool-card-t1' }).length).toBeGreaterThan(0);
        expect(renderer!.root.findAllByProps({ testID: 'work-record-conclusion' }).length).toBeGreaterThan(0);
        expect(texts(renderer!)).toContain(i18n.t('workRecords.steps'));
        expect(texts(renderer!)).toContain(i18n.t('workRecords.conclusion'));
        expect(JSON.stringify(renderer!.toJSON())).toContain('已整理 3 张发票，合计 286 元。');
    });

    it('详情展示完整请求，不只给列表用的截断标题', async () => {
        const question = '把上季度的销售发票按客户拆分，并核对每一笔的税额是否一致。\n第二行补充：差异超过一元的单独列出来。';
        const turn = buildChatTurns([
            message({ id: 'u9', role: 'user', seq: 9, content: question, timestamp: Date.now() }),
            message({ id: 'a9', role: 'assistant', seq: 10, replyTo: 'u9', content: '已核对。', timestamp: Date.now() }),
        ])[0];
        await ReactTestRenderer.act(async () => {
            renderer = ReactTestRenderer.create(<WorkRecordDetail turn={turn} onClose={jest.fn()} />);
        });
        expect(turn.title).not.toBe(question);
        expect(texts(renderer!)).toContain(question);
    });
});
