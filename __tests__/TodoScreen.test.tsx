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
jest.mock('react-i18next', () => {
    const i18n = require('i18next').createInstance();
    i18n.init({ lng: 'zh-CN', fallbackLng: 'zh', initImmediate: false,
        resources: { zh: { translation: require('../src/locales/zh.json') } } });
    return { useTranslation: () => ({ t: i18n.t.bind(i18n), i18n }) };
});

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
        history.mockReset().mockResolvedValue({ history: { id: task.id, records: [], retention: { days: 30, records: 100 }, earlierRecordsUnavailable: false, earlierRecordsPruned: false }, generation: 0 });
        result.mockReset().mockResolvedValue({ result: { taskId: task.id, status: 'unknown', assistantText: [], truncated: false, delivery }, generation: 0 });
    });
    afterEach(async () => { if (renderer) await act(async () => { renderer.unmount(); }); jest.restoreAllMocks(); });

    it('标题与标签统一为任务，只显示开启任务且不提供管理操作', async () => {
        catalog.mockResolvedValue({ tasks: [task, { ...task, id: 'b', title: '已结束排程', status: 'inactive' }], generation: 0 });
        await mount();
        expect(mockNavigation.setOptions).toHaveBeenCalledWith({ title: '任务' });
        expect(texts()).toContain('服务器任务');
        expect(texts().some(text => text.startsWith('每天 09:00'))).toBe(true);
        expect(texts().some(text => text.includes('中国标准时间'))).toBe(true);
        expect(texts()).not.toContain(task.prompt);
        expect(texts()).not.toContain('已结束排程');
        expect(texts()).not.toContain('排程已结束（不代表执行完成）');
        expect(texts()).not.toContain('已完成');
        expect(renderer.root.findAllByType(TouchableOpacity).map(node => node.props.accessibilityLabel))
            .toEqual([task.title]);
        expect(renderer.root.findByType(FlatList).props.onRefresh).toEqual(expect.any(Function));
        expect(history).not.toHaveBeenCalled(); expect(result).not.toHaveBeenCalled();
        expect(Object.keys(service)).toEqual(expect.arrayContaining(['catalog', 'history', 'getResult']));
    });

    it('只有已结束任务时显示空列表，不读取历史也不删除服务器记录', async () => {
        catalog.mockResolvedValueOnce({ tasks: [{ ...task, status: 'inactive' }], generation: 0 });
        await mount();
        expect(texts()).toContain('暂无开启的任务');
        expect(texts()).not.toContain(task.title);
        expect(history).not.toHaveBeenCalled();
        expect(result).not.toHaveBeenCalled();
    });

    it('加载不伪装空列表，真正成功空列表才显示暂无任务', async () => {
        const pending = deferred<AutomaticTaskResponse<{ tasks: AutomaticTask[] }>>();
        catalog.mockReturnValueOnce(pending.promise);
        await mount();
        expect(renderer.root.findAllByType(ActivityIndicator)).toHaveLength(1);
        expect(texts()).not.toContain('暂无开启的任务');
        await act(async () => { pending.resolve({ tasks: [], generation: 0 }); });
        expect(texts()).toContain('暂无开启的任务');
    });

    it('连接失败可重试，未启用与空列表区别明确', async () => {
        catalog.mockRejectedValueOnce(new AutomaticTaskError('network'));
        await mount();
        expect(texts().some(text => text.includes('无法读取服务器任务'))).toBe(true);
        expect(texts()).not.toContain('暂无开启的任务');
        catalog.mockRejectedValueOnce(new AutomaticTaskError('native_tasks_unavailable'));
        await press('重试');
        expect(texts()).toContain('服务器尚未启用自动任务。');
        catalog.mockResolvedValueOnce({ tasks: [], generation: 0 });
        await press('重试');
        expect(texts()).toContain('暂无开启的任务');
    });

    it('刷新失败保留上次内容，不将断网当作成功空列表', async () => {
        await mount();
        catalog.mockRejectedValueOnce(new AutomaticTaskError('network'));
        await act(async () => { renderer.root.findByType(FlatList).props.onRefresh(); });
        expect(texts()).toContain(task.title);
        expect(texts().some(text => text.includes('无法读取服务器任务'))).toBe(true);
        expect(texts()).not.toContain('暂无开启的任务');
    });

    it.each([
        ['ended', 'completed', '已完成'], ['ended', 'failed', '执行失败'],
        ['unknown', 'completed', '尚未确认执行结果'], ['not_delivered', undefined, '尚未触发'],
        ['running', undefined, '尚未确认执行结果'],
    ] as const)('仅真实 ended+completed 表示完成：%s/%s', async (status, endReason, expected) => {
        const value: AutomaticTaskResult = { taskId: task.id, status, endReason, assistantText: ['真实 assistant 内容'], truncated: true, delivery };
        result.mockResolvedValueOnce({ result: value, generation: 0 });
        history.mockResolvedValueOnce({ history: { id: task.id, records: [delivery], retention: { days: 30, records: 100 }, earlierRecordsUnavailable: false, earlierRecordsPruned: false }, generation: 0 });
        await mount(); await press(task.title);
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
        await mount(); await press(task.title);
        expect(texts()).toEqual(expect.arrayContaining(['任务说明', task.prompt, '运行时间', '执行动态']));
        expect(result).toHaveBeenCalledWith(task.id, { messageId: 'm1', signal: expect.any(AbortSignal) });
        expect(texts()).not.toContain('更早的记录已清理或不可用。');
        await press('加载更早记录');
        expect(history).toHaveBeenLastCalledWith(task.id, { limit: 20, before: 'cursor-1' }, { signal: expect.any(AbortSignal) });
        expect(result).toHaveBeenCalledTimes(1);
        expect(texts()).toContain('已触发');
        expect(texts()).toContain('更早的记录已清理或不可用。');
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
        expect(texts()).not.toContain('暂无开启的任务');
    });

    it('关闭结果弹层取消读取，迟到结果不能重新显示', async () => {
        const pending = deferred<AutomaticTaskResponse<{ result: AutomaticTaskResult }>>();
        result.mockReturnValueOnce(pending.promise);
        history.mockResolvedValueOnce({ history: { id: task.id, records: [delivery], retention: { days: 30, records: 100 }, earlierRecordsUnavailable: false, earlierRecordsPruned: false }, generation: 0 });
        await mount(); await press(task.title);
        const signal = result.mock.calls[0][1]!.signal!;
        await press('返回');
        expect(signal.aborted).toBe(true);
        await act(async () => { pending.resolve({ result: { taskId: task.id, status: 'ended', endReason: 'completed', assistantText: ['过期内容'], truncated: false }, generation: 0 }); });
        expect(texts()).not.toContain('过期内容');
    });

    it('旧记录按messageId读取自己的结果，最新结果不出现在旧记录，支持展开收起', async () => {
        const older = { ...delivery, messageId: 'old', scheduledAt: '2026-10-31T01:00:00Z' };
        history.mockResolvedValueOnce({ history: { id: task.id, records: [delivery, older], retention: { days: 30, records: 100 }, earlierRecordsUnavailable: false, earlierRecordsPruned: false }, generation: 0 });
        result.mockResolvedValueOnce({ result: { taskId: task.id, status: 'ended', endReason: 'completed', assistantText: ['最新结果'], truncated: false, delivery }, generation: 0 });
        await mount(); await press(task.title);
        expect(result).toHaveBeenCalledTimes(1);
        expect(texts().filter(text => text === '最新结果')).toHaveLength(1);
        const latestText = renderer.root.findAllByType(Text).find(node => node.props.children === '最新结果')!;
        expect(latestText.props.numberOfLines).toBe(3);
        await press('展开结果');
        expect(renderer.root.findAllByType(Text).find(node => node.props.children === '最新结果')!.props.numberOfLines).toBeUndefined();
        await press('收起');
        result.mockResolvedValueOnce({ result: { taskId: task.id, status: 'ended', endReason: 'failed', assistantText: ['较早结果'], truncated: false, delivery: older }, generation: 0 });
        await press('查看结果');
        expect(result).toHaveBeenLastCalledWith(task.id, { messageId: 'old', signal: expect.any(AbortSignal) });
        expect(texts()).toEqual(expect.arrayContaining(['最新结果', '较早结果', '执行失败']));
    });

    it('详情下拉刷新同一投递，从未确认更新为完成，同时刷新已查看的旧记录', async () => {
        const older = { ...delivery, messageId: 'older' };
        const page = { id: task.id, records: [delivery, older], retention: { days: 30, records: 100 }, earlierRecordsUnavailable: false, earlierRecordsPruned: false };
        history.mockResolvedValue({ history: page, generation: 0 });
        await mount(); await press(task.title); await press('查看结果', 1);
        result.mockImplementation(async (_id, options) => ({ result: { taskId: task.id, status: 'ended', endReason: 'completed', assistantText: [`完成-${options?.messageId}`], truncated: false, delivery: options?.messageId === 'older' ? older : delivery }, generation: 0 }));
        const count = result.mock.calls.length;
        await act(async () => { renderer.root.findAllByType(FlatList)[1].props.onRefresh(); });
        expect(result.mock.calls.length).toBe(count + 2);
        expect(texts()).toEqual(expect.arrayContaining(['完成-m1', '完成-older']));
        expect(texts().filter(text => text === '已完成')).toHaveLength(2);
    });

    it('父列表刷新同一投递的新任务对象，详情重读历史和最终结果', async () => {
        const page = { id: task.id, records: [delivery], retention: { days: 30, records: 100 }, earlierRecordsUnavailable: false, earlierRecordsPruned: false };
        history.mockResolvedValue({ history: page, generation: 0 });
        await mount(); await press(task.title);
        expect(texts()).toContain('尚未确认执行结果');
        catalog.mockResolvedValueOnce({ tasks: [{ ...task }], generation: 0 });
        result.mockResolvedValue({ result: { taskId: task.id, status: 'ended', endReason: 'completed', assistantText: ['刷新完成结果'], truncated: false, delivery }, generation: 0 });
        await act(async () => { renderer.root.findAllByType(FlatList)[0].props.onRefresh(); });
        expect(history).toHaveBeenCalledTimes(2);
        expect(texts()).toContain('刷新完成结果');
        expect(texts()).toContain('已完成');
    });

    it('最新记录降为旧记录时取消在途读取并重读，不遗留加载状态', async () => {
        const pending = deferred<AutomaticTaskResponse<{ result: AutomaticTaskResult }>>();
        const newer = { ...delivery, messageId: 'newer', deliveredAt: '2026-11-02T03:15:00Z' };
        const page = { id: task.id, records: [delivery], retention: { days: 30, records: 100 }, earlierRecordsUnavailable: false, earlierRecordsPruned: false };
        history.mockResolvedValueOnce({ history: page, generation: 0 });
        result.mockReturnValueOnce(pending.promise);
        await mount(); await press(task.title);
        const signal = result.mock.calls[0][1]!.signal!;
        history.mockResolvedValueOnce({ history: { ...page, records: [newer, delivery] }, generation: 0 });
        result.mockImplementation(async (_id, options) => ({ result: { taskId: task.id, status: 'ended', endReason: 'completed', assistantText: [`重读-${options?.messageId}`], truncated: false, delivery: options?.messageId === 'newer' ? newer : delivery }, generation: 0 }));
        await act(async () => { renderer.root.findAllByType(FlatList)[1].props.onRefresh(); });
        expect(signal.aborted).toBe(true);
        expect(texts()).toEqual(expect.arrayContaining(['重读-newer', '重读-m1']));
        expect(renderer.root.findAllByType(ActivityIndicator).filter(node => node.props.accessibilityLabel === '正在读取执行结果')).toHaveLength(0);
        await act(async () => { pending.resolve({ result: { taskId: task.id, status: 'unknown', assistantText: ['过期未完成结果'], truncated: false, delivery }, generation: 0 }); });
        expect(texts()).not.toContain('过期未完成结果');
    });

    it('详情下拉刷新目录后更新标题说明计划和下次时间', async () => {
        await mount(); await press(task.title);
        catalog.mockResolvedValueOnce({ tasks: [{ ...task, title: '更新标题', prompt: '更新说明', time: '15:45', scheduledAt: '2026-11-03T07:45:00Z' }], generation: 0 });
        await act(async () => { renderer.root.findAllByType(FlatList)[1].props.onRefresh(); });
        expect(catalog).toHaveBeenCalledTimes(2);
        expect(texts()).toEqual(expect.arrayContaining(['更新标题', '更新说明', '每天 15:45', '下次执行：2026年11月3日 15:45']));
        expect(texts()).not.toContain(task.prompt);
        expect(history).toHaveBeenCalledTimes(2);
    });

    it('详情刷新发现任务转为inactive时关闭详情并移出活动列表', async () => {
        await mount(); await press(task.title);
        catalog.mockResolvedValueOnce({ tasks: [{ ...task, status: 'inactive' }], generation: 0 });
        await act(async () => { renderer.root.findAllByType(FlatList)[1].props.onRefresh(); });
        expect(catalog).toHaveBeenCalledTimes(2);
        expect(texts()).not.toContain('任务详情');
        expect(texts()).not.toContain(task.title);
        expect(texts()).toContain('暂无开启的任务');
    });

    it('详情目录刷新失败保留内容并在详情内提示重试，成功重试更新下次执行', async () => {
        await mount(); await press(task.title);
        catalog.mockRejectedValueOnce(new AutomaticTaskError('network'));
        await act(async () => { renderer.root.findAllByType(FlatList)[1].props.onRefresh(); });
        expect(history).toHaveBeenCalledTimes(1);
        const detailList = renderer.root.findAllByType(FlatList)[1];
        const detailTexts = detailList.findAllByType(Text).map(node => node.props.children);
        expect(detailTexts).toContain(task.prompt);
        expect(detailTexts).toContain('无法读取服务器任务，请检查连接后重试。已有内容可能不是最新状态。');
        const retry = detailList.findAllByType(TouchableOpacity).find(node => node.props.accessibilityLabel === '重试')!;
        expect(retry).toBeDefined();
        catalog.mockResolvedValueOnce({ tasks: [{ ...task, scheduledAt: '2026-11-04T01:00:00Z' }], generation: 0 });
        await act(async () => { retry.props.onPress({ nativeEvent: { timestamp: 1 } }); });
        expect(catalog).toHaveBeenCalledTimes(3);
        expect(texts()).toContain('下次执行：2026年11月4日 09:00');
        expect(renderer.root.findAllByType(FlatList)[1].findAllByType(Text).map(node => node.props.children)).not.toContain('无法读取服务器任务，请检查连接后重试。已有内容可能不是最新状态。');
    });

    it('空原生历史保留目录最近投递结果，非空原生历史不混入过期目录投递', async () => {
        catalog.mockResolvedValue({ tasks: [{ ...task, lastDelivery: delivery }], generation: 0 });
        result.mockResolvedValue({ result: { taskId: task.id, status: 'ended', endReason: 'completed', assistantText: ['最近投递结果'], truncated: false, delivery }, generation: 0 });
        await mount(); await press(task.title);
        expect(renderer.root.findAllByType(FlatList)[1].props.data).toEqual([delivery]);
        expect(texts()).toContain('最近投递结果');
        expect(texts()).not.toContain('尚无执行记录，等待首次触发。');
        const authoritative = { ...delivery, messageId: 'native-latest' };
        history.mockResolvedValueOnce({ history: { id: task.id, records: [authoritative], retention: { days: 30, records: 100 }, earlierRecordsUnavailable: false, earlierRecordsPruned: false }, generation: 0 });
        await act(async () => { renderer.root.findAllByType(FlatList)[1].props.onRefresh(); });
        expect(renderer.root.findAllByType(FlatList)[1].props.data).toEqual([authoritative]);
    });

    it('没有任何投递的首次任务详情显示真正空历史且不读取结果', async () => {
        await mount(); await press(task.title);
        expect(texts()).toContain('尚无执行记录，等待首次触发。');
        expect(result).not.toHaveBeenCalled();
    });

    it('动态显示实际投递时刻，不使用计划时刻', async () => {
        const receipt = { ...delivery, scheduledAt: '2026-10-01T01:00:00Z', deliveredAt: '2026-10-02T02:15:00Z' };
        history.mockResolvedValueOnce({ history: { id: task.id, records: [receipt], retention: { days: 30, records: 100 }, earlierRecordsUnavailable: false, earlierRecordsPruned: false }, generation: 0 });
        await mount(); await press(task.title);
        expect(texts()).toContain('2026年10月2日 10:15');
        expect(texts()).not.toContain('2026年10月1日 09:00');
    });

    it('分页游标失效后重试从最新页重读，不重发失效游标', async () => {
        const page = { id: task.id, records: [delivery], retention: { days: 30, records: 100 }, earlierRecordsUnavailable: false, earlierRecordsPruned: false, nextBefore: 'expired' };
        history.mockResolvedValueOnce({ history: page, generation: 0 })
            .mockResolvedValueOnce({ history: { id: task.id, code: 'delivery_cursor_not_found' }, generation: 0 })
            .mockResolvedValueOnce({ history: { ...page, nextBefore: undefined }, generation: 0 });
        await mount(); await press(task.title); await press('加载更早记录');
        expect(texts()).toContain(task.prompt);
        await press('重新加载执行记录');
        expect(history).toHaveBeenLastCalledWith(task.id, { limit: 20, before: undefined }, { signal: expect.any(AbortSignal) });
        expect(renderer.root.findAllByType(TouchableOpacity).some(node => node.props.accessibilityLabel === '重新加载执行记录')).toBe(false);
    });

    it('分页网络失败保留记录并以相同游标重试，重复记录不重复插入', async () => {
        const page = { id: task.id, records: [delivery], retention: { days: 30, records: 100 }, earlierRecordsUnavailable: false, earlierRecordsPruned: false, nextBefore: 'page-2' };
        history.mockResolvedValueOnce({ history: page, generation: 0 })
            .mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValueOnce({ history: { ...page, nextBefore: undefined, records: [delivery, { ...delivery, messageId: 'older' }] }, generation: 0 });
        await mount(); await press(task.title); await press('加载更早记录');
        expect(texts()).toContain('暂时无法读取执行记录。');
        expect(texts()).toContain('尚未确认执行结果');
        await press('重新加载执行记录');
        expect(history).toHaveBeenLastCalledWith(task.id, { limit: 20, before: 'page-2' }, { signal: expect.any(AbortSignal) });
        expect(renderer.root.findAllByType(FlatList)[1].props.data).toHaveLength(2);
    });

    it('历史和结果失败独立重试，历史失败仍可读最近投递结果', async () => {
        catalog.mockResolvedValueOnce({ tasks: [{ ...task, lastDelivery: delivery }], generation: 0 });
        history.mockRejectedValueOnce(new Error('offline'));
        result.mockRejectedValue(new Error('offline'));
        await mount(); await press(task.title);
        expect(texts()).toEqual(expect.arrayContaining(['暂时无法读取执行记录。', '暂时无法读取这次执行的结果。']));
        const resultCount = result.mock.calls.length;
        result.mockResolvedValue({ result: { taskId: task.id, status: 'ended', endReason: 'completed', assistantText: ['恢复结果'], truncated: false, delivery }, generation: 0 });
        await press('重试读取结果');
        expect(history).toHaveBeenCalledTimes(1);
        expect(texts()).toContain('恢复结果');
        expect(result).toHaveBeenCalledTimes(resultCount + 1);
        await press('重新加载执行记录');
        expect(history).toHaveBeenCalledTimes(2);
    });

    it('关闭详情同时取消历史和结果，重开不接受旧响应', async () => {
        catalog.mockResolvedValueOnce({ tasks: [{ ...task, lastDelivery: delivery }], generation: 0 });
        const pendingHistory = deferred<AutomaticTaskResponse<{ history: import('../src/types/automaticTasks').AutomaticTaskHistory }>>();
        const pendingResult = deferred<AutomaticTaskResponse<{ result: AutomaticTaskResult }>>();
        history.mockReturnValueOnce(pendingHistory.promise); result.mockReturnValueOnce(pendingResult.promise);
        await mount(); await press(task.title);
        const historySignal = history.mock.calls[0][2]!.signal!;
        const resultSignal = result.mock.calls[0][1]!.signal!;
        await press('返回');
        expect(historySignal.aborted).toBe(true); expect(resultSignal.aborted).toBe(true);
        await press(task.title);
        await act(async () => {
            pendingHistory.resolve({ history: { id: task.id, records: [{ ...delivery, messageId: 'stale', prompt: '过期记录' }], retention: { days: 1, records: 1 }, earlierRecordsUnavailable: false, earlierRecordsPruned: false }, generation: 0 });
            pendingResult.resolve({ result: { taskId: task.id, status: 'ended', endReason: 'completed', assistantText: ['过期结果'], truncated: false, delivery }, generation: 0 });
        });
        expect(texts()).not.toContain('过期记录'); expect(texts()).not.toContain('过期结果');
    });

    it('详情中切换身份取消子请求，过期generation不展示结果', async () => {
        catalog.mockResolvedValueOnce({ tasks: [{ ...task, lastDelivery: delivery }], generation: 0 });
        const pending = deferred<AutomaticTaskResponse<{ result: AutomaticTaskResult }>>();
        result.mockReturnValueOnce(pending.promise);
        await mount(); await press(task.title);
        const signal = result.mock.calls[0][1]!.signal!;
        Object.defineProperty(service, 'generation', { configurable: true, value: 1 });
        catalog.mockResolvedValueOnce({ tasks: [{ ...task, title: '新身份任务' }], generation: 1 });
        await act(async () => { useAssistantStore.setState({ serverToken: 'new' }); });
        expect(signal.aborted).toBe(true);
        await act(async () => { pending.resolve({ result: { taskId: task.id, status: 'ended', endReason: 'completed', assistantText: ['旧身份结果'], truncated: false, delivery }, generation: 0 }); });
        expect(texts()).not.toContain('旧身份结果');
        history.mockResolvedValueOnce({ history: { id: task.id, records: [delivery], retention: { days: 30, records: 100 }, earlierRecordsUnavailable: false, earlierRecordsPruned: false }, generation: 1 });
        result.mockResolvedValueOnce({ result: { taskId: task.id, status: 'ended', endReason: 'completed', assistantText: ['错误generation'], truncated: false, delivery }, generation: 0 });
        await press('新身份任务');
        expect(texts()).not.toContain('错误generation');
        expect(texts()).toContain('暂时无法读取这次执行的结果。');
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
