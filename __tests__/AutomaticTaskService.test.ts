import { AutomaticTaskError, AutomaticTaskService, type AutomaticTaskFetch } from '../src/services/AutomaticTaskService';
import { useAssistantStore } from '../src/store/useAssistantStore';
import type { AutomaticTaskConnection, AutomaticTaskRecord } from '../src/types/automaticTasks';

jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
jest.mock('expo-secure-store', () => ({ getItemAsync: jest.fn(), setItemAsync: jest.fn(), deleteItemAsync: jest.fn() }));

const task: AutomaticTaskRecord = {
    id: 'task/1', kind: 'at', title: 'Task', prompt: 'Instruction', scheduledAt: '2030-01-01T00:00:00.000Z',
};
function response(data: unknown, status = 200): Response {
    return { ok: status >= 200 && status < 300, status, redirected: false, json: async () => data } as Response;
}
function deferred<T>() {
    let resolve: (value: T) => void = () => undefined;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}
function setup(data: unknown = { tasks: [] }, status = 200) {
    const connection: AutomaticTaskConnection = { serverUrl: 'wss://example.test/', token: 'secret', generation: 0 };
    const fetcher = jest.fn<ReturnType<AutomaticTaskFetch>, Parameters<AutomaticTaskFetch>>().mockResolvedValue(response(data, status));
    const service = new AutomaticTaskService({ connection: async () => ({ ...connection }), fetch: fetcher });
    return { service, fetcher, connection };
}

describe('AutomaticTaskService read-only contract and isolation', () => {
    it('exposes only catalog/history/result data APIs, all GET with no request body', async () => {
        const { service, fetcher } = setup({ tasks: [{ ...task, sessionId: 'session', status: 'inactive' }] });
        expect((await service.catalog()).tasks).toHaveLength(1);
        fetcher.mockResolvedValue(response({ history: { id: task.id, code: 'schedule_not_found' } }));
        await service.history(task.id);
        fetcher.mockResolvedValue(response({ result: { taskId: task.id, status: 'not_delivered', assistantText: [], truncated: false } }));
        await service.getResult(task.id);
        expect(fetcher.mock.calls.map(call => call[0])).toEqual([
            'https://example.test/api/tasks', 'https://example.test/api/tasks/task%2F1/history', 'https://example.test/api/tasks/task%2F1/result',
        ]);
        for (const [, init] of fetcher.mock.calls) {
            expect(init).toEqual(expect.objectContaining({ method: 'GET', redirect: 'error', headers: { Authorization: 'Bearer secret' }, signal: expect.any(AbortSignal) }));
            expect(init).not.toHaveProperty('body');
        }
        for (const method of ['create', 'update', 'delete', 'getOperationStatus']) expect(method in service).toBe(false);
        service.dispose();
    });
    it('retains delivery pagination, retention and lookup misses', async () => {
        const value = { id: task.id, records: [{ scheduledAt: task.scheduledAt, deliveredAt: task.scheduledAt, messageId: 'message', prompt: 'Delivered' }],
            earlierRecordsUnavailable: true, earlierRecordsPruned: true, retention: { days: 30, records: 100 }, nextBefore: 'message' };
        const { service, fetcher } = setup({ history: value });
        expect((await service.history(task.id, { limit: 5, before: 'cursor &/' })).history).toEqual(value);
        expect(fetcher.mock.calls[0][0]).toContain('limit=5&before=cursor+%26%2F');
        fetcher.mockResolvedValue(response({ history: { id: task.id, code: 'delivery_cursor_not_found' } }));
        expect((await service.history(task.id)).history).toEqual({ id: task.id, code: 'delivery_cursor_not_found' });
    });
    it('encodes optional result messageId and rejects a result for a different receipt', async () => {
        const delivery = { scheduledAt: task.scheduledAt, deliveredAt: task.scheduledAt, messageId: 'receipt /&' };
        const value = { taskId: task.id, status: 'ended', endReason: 'completed', assistantText: ['This receipt'], truncated: false, delivery };
        const { service, fetcher } = setup({ result: value });
        expect((await service.getResult(task.id, { messageId: delivery.messageId })).result).toEqual(value);
        expect(fetcher.mock.calls[0][0]).toBe('https://example.test/api/tasks/task%2F1/result?messageId=receipt%20%2F%26');
        await expect(service.getResult(task.id, { messageId: 'older' })).rejects.toMatchObject({ code: 'invalid_response' });
        fetcher.mockResolvedValue(response({ result: { ...value, delivery: undefined } }));
        await expect(service.getResult(task.id, { messageId: delivery.messageId })).rejects.toMatchObject({ code: 'invalid_response' });
        service.dispose();
    });
    it.each(['unknown', 'not_delivered', 'running', 'ended'])('does not reinterpret result status %s', async status => {
        const value = { taskId: task.id, status, assistantText: ['Visible'], truncated: true, endReason: 'cancelled' };
        expect((await setup({ result: value }).service.getResult(task.id)).result).toEqual(value);
    });
    it.each([{}, { tasks: null }, { tasks: [{}] }, { tasks: [{ ...task, status: 'active' }] }])('rejects malformed catalog, not empty success: %j', async data => {
        await expect(setup(data).service.catalog()).rejects.toMatchObject({ code: 'invalid_response' });
    });
    it('rejects malformed history/result, mismatched identity and unexpected HTTP 202', async () => {
        const { service, fetcher } = setup({ history: { id: task.id, records: [] } });
        await expect(service.history(task.id)).rejects.toMatchObject({ code: 'invalid_response' });
        fetcher.mockResolvedValue(response({ result: { taskId: task.id, status: 'ended' } }));
        await expect(service.getResult(task.id)).rejects.toMatchObject({ code: 'invalid_response' });
        fetcher.mockResolvedValue(response({ history: { id: 'other', code: 'schedule_not_found' } }));
        await expect(service.history(task.id)).rejects.toMatchObject({ code: 'invalid_response' });
        fetcher.mockResolvedValue(response({ tasks: [] }, 202));
        await expect(service.catalog()).rejects.toMatchObject({ code: 'invalid_response' });
    });
    it.each([401, 403, 503])('exposes safe errors for HTTP %s, never native bodies', async status => {
        const { service } = setup({ code: 'credential secret', error: 'secret body' }, status);
        try { await service.catalog(); throw new Error('must fail'); }
        catch (error: unknown) {
            expect(error).toBeInstanceOf(AutomaticTaskError);
            expect(String(error)).not.toContain('secret');
            expect(error).toMatchObject({ status });
        }
    });
    it('preserves the fixed service_closed code', async () => {
        await expect(setup({ code: 'service_closed' }, 503).service.catalog()).rejects.toMatchObject({ code: 'service_closed', status: 503 });
    });
    it.each(['catalog', 'history', 'getResult'] as const)('does not retry %s on network failure', async method => {
        const { service, fetcher } = setup();
        fetcher.mockRejectedValue(new Error('credential secret'));
        const promise = method === 'catalog' ? service.catalog() : service[method](task.id);
        await expect(promise).rejects.toMatchObject({ code: 'network', message: 'network' });
        expect(fetcher).toHaveBeenCalledTimes(1);
    });
    it('bounds hanging fetch even if transport ignores abort', async () => {
        jest.useFakeTimers();
        try {
            const { service, fetcher } = setup();
            fetcher.mockReturnValue(new Promise<Response>(() => undefined));
            const settled = service.catalog({ timeoutMs: 10 }).catch((error: unknown) => error);
            await jest.advanceTimersByTimeAsync(10);
            expect(await settled).toMatchObject({ code: 'timeout' });
            expect(fetcher).toHaveBeenCalledTimes(1);
            expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
        } finally { jest.useRealTimers(); }
    });
    it('supports preflight and in-flight abort', async () => {
        const { service, fetcher } = setup();
        const controller = new AbortController();
        controller.abort();
        await expect(service.catalog({ signal: controller.signal })).rejects.toMatchObject({ code: 'aborted' });
        expect(fetcher).not.toHaveBeenCalled();
        const active = new AbortController();
        const started = deferred<void>();
        fetcher.mockImplementation(async () => { started.resolve(); return new Promise<Response>(() => undefined); });
        const promise = service.getResult(task.id, { signal: active.signal });
        await started.promise;
        active.abort();
        await expect(promise).rejects.toMatchObject({ code: 'aborted' });
    });
    it('discards responses after injected identity generation changes', async () => {
        const { service, fetcher, connection } = setup();
        const pending = deferred<Response>();
        const started = deferred<void>();
        fetcher.mockImplementation(async () => { started.resolve(); return pending.promise; });
        const promise = service.catalog();
        await started.promise;
        connection.generation++;
        pending.resolve(response({ tasks: [] }));
        await expect(promise).rejects.toMatchObject({ code: 'connection_changed' });
    });
    it('blocks redirects and unsafe endpoints before credentials leave', async () => {
        const { service, fetcher, connection } = setup({}, 302);
        await expect(service.catalog()).rejects.toMatchObject({ code: 'redirect_blocked' });
        connection.serverUrl = 'https://user:password@example.test';
        await expect(service.catalog()).rejects.toMatchObject({ code: 'invalid_endpoint' });
        expect(fetcher).toHaveBeenCalledTimes(1);
    });
    it('rejects malformed JSON without exposing exceptions or retrying', async () => {
        const { service, fetcher } = setup();
        fetcher.mockResolvedValue({ ...response({}), json: async () => { throw new Error('credential secret'); } });
        await expect(service.catalog()).rejects.toMatchObject({ code: 'invalid_response', message: 'invalid_response' });
        expect(fetcher).toHaveBeenCalledTimes(1);
    });
    it('does not send when identity switches during secure loading', async () => {
        const saved = deferred<{ url: string; token: string }>();
        const started = deferred<void>();
        useAssistantStore.setState({ hasHydrated: true, serverUrl: 'https://old.test', serverToken: '',
            loadSavedCredentials: async () => { started.resolve(); return saved.promise; } });
        const fetcher = jest.fn<ReturnType<AutomaticTaskFetch>, Parameters<AutomaticTaskFetch>>();
        const service = new AutomaticTaskService({ fetch: fetcher });
        const promise = service.catalog();
        await started.promise;
        useAssistantStore.setState({ serverUrl: 'https://new.test', serverToken: 'new' });
        saved.resolve({ url: 'https://old.test', token: 'old' });
        await expect(promise).rejects.toMatchObject({ code: 'connection_changed' });
        expect(fetcher).not.toHaveBeenCalled();
        service.dispose();
    });
    it('discards default-store responses when identity switches away and back', async () => {
        useAssistantStore.setState({ hasHydrated: true, serverUrl: 'https://old.test', serverToken: 'old' });
        const pending = deferred<Response>();
        const started = deferred<void>();
        const fetcher = jest.fn<ReturnType<AutomaticTaskFetch>, Parameters<AutomaticTaskFetch>>()
            .mockImplementation(async () => { started.resolve(); return pending.promise; });
        const service = new AutomaticTaskService({ fetch: fetcher });
        const promise = service.catalog();
        await started.promise;
        useAssistantStore.setState({ serverToken: 'new' });
        useAssistantStore.setState({ serverToken: 'old' });
        pending.resolve(response({ tasks: [] }));
        await expect(promise).rejects.toMatchObject({ code: 'connection_changed' });
        service.dispose();
    });
    it('requires hydration then uses existing saved credentials; keeps generation stable until identity changes', async () => {
        const load = jest.fn(async () => {
            useAssistantStore.setState({ serverToken: 'saved' });
            return { url: 'ws://saved.test', token: 'saved' };
        });
        useAssistantStore.setState({ hasHydrated: false, serverUrl: 'ws://saved.test', serverToken: '', loadSavedCredentials: load });
        const fetcher = jest.fn<ReturnType<AutomaticTaskFetch>, Parameters<AutomaticTaskFetch>>().mockResolvedValue(response({ tasks: [] }));
        const service = new AutomaticTaskService({ fetch: fetcher });
        await expect(service.catalog()).rejects.toMatchObject({ code: 'connection_not_ready' });
        expect(fetcher).not.toHaveBeenCalled();
        useAssistantStore.setState({ hasHydrated: true });
        const first = await service.catalog();
        expect(first.generation).toBe(service.generation);
        expect(load).toHaveBeenCalledTimes(1);
        expect(fetcher.mock.calls[0][0]).toBe('http://saved.test/api/tasks');
        expect((await service.catalog()).generation).toBe(first.generation);
        useAssistantStore.setState({ serverToken: 'new' });
        expect(service.generation).not.toBe(first.generation);
        service.dispose();
    });
});
