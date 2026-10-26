import React from 'react';
import Renderer, { act } from 'react-test-renderer';
import { ActivityIndicator, AppState, FlatList, Text, TouchableOpacity } from 'react-native';
import { TodoScreen } from '../src/screens/TodoScreen';
import { automaticTaskService as service, AutomaticTaskError } from '../src/services/AutomaticTaskService';
import { useAssistantStore } from '../src/store/useAssistantStore';
import type { AutomaticTask, AutomaticTaskResult, AutomaticTaskResponse } from '../src/types/automaticTasks';

const mockNavigation = { setOptions: jest.fn() };
const mockNetwork = { listener: (_state: { isConnected: boolean }) => {}, remove: jest.fn() };
jest.mock('@react-navigation/native', () => ({
    useNavigation: () => mockNavigation,
    useFocusEffect: (callback: () => (() => void)) => { require('react').useEffect(callback, [callback]); },
}));
jest.mock('expo-network', () => ({ addNetworkStateListener: (listener: typeof mockNetwork.listener) => {
    mockNetwork.listener = listener; return { remove: mockNetwork.remove };
} }));
jest.mock('../src/services/AutomaticTaskService', () => ({
    AutomaticTaskError: class extends Error { readonly code: string; constructor(code: string) { super(code); this.code = code; } },
    automaticTaskService: { generation: 0, catalog: jest.fn(), history: jest.fn(), getResult: jest.fn() },
}));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, options?: Record<string, unknown>) => {
    const dictionary = require('../src/locales/zh.json').automaticTasks as Record<string, string>;
    let text = dictionary[key.replace('automaticTasks.', '')] ?? key;
    Object.entries(options ?? {}).forEach(([name, value]) => { text = text.replace(`{{${name}}}`, String(value)); });
    return text;
} }) }));

const task: AutomaticTask = { id: 'a', sessionId: 'session-a', title: '服务器任务', prompt: '真实执行指令',
    status: 'active', kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai', scheduledAt: '2026-11-01T09:00:00+08:00' };
const delivery = { messageId: 'm1', scheduledAt: task.scheduledAt, deliveredAt: '2026-11-01T01:00:01Z' };
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}

describe('TodoScreen 服务器只读自动任务', () => {
    let renderer: Renderer.ReactTestRenderer;
    const catalog = jest.mocked(service.catalog);
    const history = jest.mocked(service.history);
    const result = jest.mocked(service.getResult);
    const texts = () => renderer.root.findAllByType(Text).map(node => node.props.children).filter(value => typeof value === 'string');
    const press = async (label: string, index = 0) => {
        await act(async () => { renderer.root.findAllByType(TouchableOpacity).filter(node => node.props.accessibilityLabel === label)[index].props.onPress(); });
    };
    const mount = async () => { await act(async () => { renderer = Renderer.create(<TodoScreen />); }); };
    beforeEach(() => {
        jest.clearAllMocks();
        Object.defineProperty(service, 'generation', { configurable: true, value: 0 });
        useAssistantStore.setState({ serverUrl: 'http://server-a', serverToken: 'a', hasHydrated: true, connectionState: 'connected' });
        catalog.mockReset().mockResolvedValue({ tasks: [task], generation: 0 });
        history.mockReset(); result.mockReset();
    });
    afterEach(async () => { if (renderer) await act(async () => { renderer.unmount(); }); jest.restoreAllMocks(); });

    it('只显示查询入口、原始规则/时区/时间和排程状态，不提供管理操作', async () => {
        catalog.mockResolvedValue({ tasks: [task, { ...task, id: 'b', title: '已结束排程', status: 'inactive' }], generation: 0 });
        await mount();
        expect(mockNavigation.setOptions).toHaveBeenCalledWith({ title: '自动任务' });
        expect(texts()).toEqual(expect.arrayContaining(['服务器任务', '真实执行指令', '每天 09:00', '时区：Asia/Shanghai', `原生计划时间：${task.scheduledAt}`, '排程有效', '排程已结束（不代表执行完成）']));
        expect(texts()).not.toContain('已完成');
        expect(renderer.root.findAllByType(TouchableOpacity).map(node => node.props.accessibilityLabel))
            .toEqual(['刷新', '触发记录', '查看结果', '触发记录', '查看结果']);
        expect(history).not.toHaveBeenCalled(); expect(result).not.toHaveBeenCalled();
        expect(Object.keys(service)).toEqual(expect.arrayContaining(['catalog', 'history', 'getResult']));
    });

    it('加载不伪装空列表，真正成功空列表才显示暂无任务', async () => {
        const pending = deferred<AutomaticTaskResponse<{ tasks: AutomaticTask[] }>>();
        catalog.mockReturnValueOnce(pending.promise);
        await mount();
        expect(renderer.root.findAllByType(ActivityIndicator)).toHaveLength(1);
        expect(texts()).not.toContain('暂无自动任务');
        await act(async () => { pending.resolve({ tasks: [], generation: 0 }); });
        expect(texts()).toContain('暂无自动任务');
    });

    it('连接失败可重试，未启用与空列表区别明确', async () => {
        catalog.mockRejectedValueOnce(new AutomaticTaskError('network'));
        await mount();
        expect(texts().some(text => text.includes('无法读取服务器任务'))).toBe(true);
        expect(texts()).not.toContain('暂无自动任务');
        catalog.mockRejectedValueOnce(new AutomaticTaskError('native_tasks_unavailable'));
        await press('重试');
        expect(texts()).toContain('服务器尚未启用自动任务。');
        catalog.mockResolvedValueOnce({ tasks: [], generation: 0 });
        await press('重试');
        expect(texts()).toContain('暂无自动任务');
    });

    it('刷新失败保留上次内容，不将断网当作成功空列表', async () => {
        await mount();
        catalog.mockRejectedValueOnce(new AutomaticTaskError('network'));
        await act(async () => { renderer.root.findByType(FlatList).props.onRefresh(); });
        expect(texts()).toContain(task.title);
        expect(texts().some(text => text.includes('无法读取服务器任务'))).toBe(true);
        expect(texts()).not.toContain('暂无自动任务');
    });

    it.each([
        ['ended', 'completed', '已完成'], ['ended', 'failed', '执行已结束，未确认完成'],
        ['unknown', 'completed', '尚未确认执行结果'], ['not_delivered', undefined, '尚未投递'],
        ['running', undefined, '尚未确认执行结果'],
    ] as const)('仅真实 ended+completed 表示完成：%s/%s', async (status, endReason, expected) => {
        const value: AutomaticTaskResult = { taskId: task.id, status, endReason, assistantText: ['真实 assistant 内容'], truncated: true, delivery };
        result.mockResolvedValueOnce({ result: value, generation: 0 });
        await mount(); await press('查看结果');
        expect(texts()).toContain(expected);
        if (expected !== '已完成') expect(texts()).not.toContain('已完成');
        expect(texts()).toContain('真实 assistant 内容');
        expect(texts()).toContain('结果较长，仅展示部分内容。');
        expect(texts()).not.toContain('执行成功');
    });

    it('触发记录展示投递事实、保留范围并按nextBefore分页', async () => {
        const page = { id: task.id, records: [delivery], retention: { days: 30, records: 100 }, earlierRecordsUnavailable: false, earlierRecordsPruned: true, nextBefore: 'cursor-1' };
        history.mockResolvedValueOnce({ history: page, generation: 0 })
            .mockResolvedValueOnce({ history: { ...page, records: [{ ...delivery, messageId: 'm2' }], nextBefore: undefined }, generation: 0 });
        await mount(); await press('触发记录');
        expect(texts()).toContain('记录仅表示已投递，不代表执行成功。');
        expect(texts()).toContain('记录保留范围：30 天，最多 100 条。');
        expect(texts()).toContain('更早的记录已清理或不可用。');
        await press('加载更早记录');
        expect(history).toHaveBeenLastCalledWith(task.id, { limit: 20, before: 'cursor-1' }, { signal: expect.any(AbortSignal) });
        expect(texts().filter(text => text === '已投递')).toHaveLength(2);
        expect(texts()).not.toContain('已完成');
    });

    it('身份切换取消旧请求，旧服务器迟到响应不能覆盖新列表', async () => {
        const pending = deferred<AutomaticTaskResponse<{ tasks: AutomaticTask[] }>>();
        catalog.mockReturnValueOnce(pending.promise);
        await mount();
        const signal = catalog.mock.calls[0][0]!.signal!;
        Object.defineProperty(service, 'generation', { configurable: true, value: 1 });
        catalog.mockResolvedValueOnce({ tasks: [{ ...task, title: '新服务器任务' }], generation: 1 });
        await act(async () => { useAssistantStore.setState({ serverUrl: 'http://server-b', serverToken: 'b' }); });
        expect(signal.aborted).toBe(true);
        await act(async () => { pending.resolve({ tasks: [task], generation: 0 }); });
        expect(texts()).toContain('新服务器任务'); expect(texts()).not.toContain(task.title);
    });

    it('generation过期响应不应用', async () => {
        catalog.mockResolvedValueOnce({ tasks: [task], generation: 99 });
        await mount();
        expect(texts()).not.toContain(task.title);
        expect(texts()).not.toContain('暂无自动任务');
    });

    it('关闭结果弹层取消读取，迟到结果不能重新显示', async () => {
        const pending = deferred<AutomaticTaskResponse<{ result: AutomaticTaskResult }>>();
        result.mockReturnValueOnce(pending.promise);
        await mount(); await press('查看结果');
        const signal = result.mock.calls[0][1]!.signal!;
        await press('关闭');
        expect(signal.aborted).toBe(true);
        await act(async () => { pending.resolve({ result: { taskId: task.id, status: 'ended', endReason: 'completed', assistantText: ['过期内容'], truncated: false }, generation: 0 }); });
        expect(texts()).not.toContain('过期内容');
    });

    it('App回前台、网络恢复和连接恢复重新查询，卸载清理监听及请求', async () => {
        let appListener: ((state: import('react-native').AppStateStatus) => void) | undefined;
        const removeApp = jest.fn();
        jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => { appListener = listener; return { remove: removeApp }; });
        await mount();
        await act(async () => { appListener!('background'); appListener!('active'); });
        await act(async () => { mockNetwork.listener({ isConnected: false }); mockNetwork.listener({ isConnected: true }); });
        await act(async () => { useAssistantStore.setState({ connectionState: 'disconnected' }); useAssistantStore.setState({ connectionState: 'connected' }); });
        expect(catalog).toHaveBeenCalledTimes(4);
        const signal = catalog.mock.calls[3][0]!.signal!;
        await act(async () => { renderer.unmount(); });
        expect(signal.aborted).toBe(true); expect(removeApp).toHaveBeenCalled(); expect(mockNetwork.remove).toHaveBeenCalled();
    });
});
