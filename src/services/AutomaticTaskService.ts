import { fetch as expoFetch } from 'expo/fetch';
import { useAssistantStore } from '../store/useAssistantStore';
import type {
    AutomaticTask, AutomaticTaskConnection, AutomaticTaskDelivery, AutomaticTaskErrorCode,
    AutomaticTaskHistory, AutomaticTaskHistoryOptions, AutomaticTaskRecord,
    AutomaticTaskRequestOptions, AutomaticTaskResponse, AutomaticTaskResult,
} from '../types/automaticTasks';

export class AutomaticTaskError extends Error {
    constructor(
        readonly code: AutomaticTaskErrorCode,
        readonly status?: number,
    ) {
        super(code);
        this.name = 'AutomaticTaskError';
    }
}
export type AutomaticTaskFetch = (url: string, init: {
    method: 'GET'; redirect: 'error'; signal: AbortSignal;
    headers: Record<string, string>;
}) => Promise<{ ok: boolean; status: number; redirected: boolean; json: () => Promise<unknown> }>;
export interface AutomaticTaskServiceOptions {
    connection?: () => Promise<AutomaticTaskConnection>;
    /** Must honor redirect:error before following any redirect. */
    fetch?: AutomaticTaskFetch;
    timeoutMs?: number;
}
function object(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function integer(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function date(value: unknown): value is string { return text(value) && Number.isFinite(Date.parse(value)); }
function optionalText(value: unknown): boolean { return value === undefined || text(value); }
function delivery(value: unknown): value is AutomaticTaskDelivery {
    return object(value) && date(value.scheduledAt) && date(value.deliveredAt) && text(value.messageId);
}
function record(value: unknown): value is AutomaticTaskRecord {
    if (!object(value) || !text(value.id) || !text(value.title) || !text(value.prompt) || !date(value.scheduledAt)) return false;
    switch (value.kind) {
        case 'at': return true;
        case 'after': return integer(value.afterSeconds) && value.afterSeconds > 0;
        case 'every': return integer(value.everySeconds) && value.everySeconds >= 60;
        case 'daily': return text(value.time) && text(value.timeZone);
        case 'weekly': return text(value.time) && text(value.timeZone) && Array.isArray(value.weekdays)
            && value.weekdays.length > 0 && value.weekdays.length <= 7
            && value.weekdays.every((day: unknown) => integer(day) && day >= 1 && day <= 7)
            && new Set(value.weekdays).size === value.weekdays.length;
        case 'cron': return text(value.expression) && text(value.timeZone);
        default: return false;
    }
}
function task(value: unknown): value is AutomaticTask {
    return record(value) && 'sessionId' in value && text(value.sessionId) && 'status' in value
        && (value.status === 'active' || value.status === 'inactive')
        && (!('lastDelivery' in value) || value.lastDelivery === undefined || delivery(value.lastDelivery));
}
function history(value: unknown): value is AutomaticTaskHistory {
    if (!object(value) || !text(value.id)) return false;
    if (value.code === 'schedule_not_found' || value.code === 'delivery_cursor_not_found') return true;
    return Array.isArray(value.records) && value.records.every((row: unknown) => delivery(row)
        && (!('prompt' in row) || row.prompt === undefined || typeof row.prompt === 'string'))
        && typeof value.earlierRecordsUnavailable === 'boolean' && typeof value.earlierRecordsPruned === 'boolean'
        && object(value.retention) && integer(value.retention.days) && integer(value.retention.records)
        && optionalText(value.nextBefore);
}
function result(value: unknown): value is AutomaticTaskResult {
    return object(value) && text(value.taskId) && ['unknown', 'not_delivered', 'running', 'ended'].includes(String(value.status))
        && (value.delivery === undefined || delivery(value.delivery)) && (value.turn === undefined || integer(value.turn))
        && optionalText(value.endReason) && Array.isArray(value.assistantText)
        && value.assistantText.every((part: unknown) => typeof part === 'string') && typeof value.truncated === 'boolean';
}
const remoteCodes: readonly AutomaticTaskErrorCode[] = ['invalid_input', 'not_found', 'metadata_invalid', 'service_closed',
    'native_tasks_unavailable', 'service_upgrading', 'invalid_endpoint', 'invalid_token', 'authentication_failed',
    'connection_failed', 'timeout', 'disposed', 'remote_failed', 'dispose_failed', 'method_not_allowed'];

/** Only HTTP data access. No scheduling, caches, offline queues, retries or native-host connection. */
export class AutomaticTaskService {
    private readonly fetcher: AutomaticTaskFetch;
    private readonly connection: () => Promise<AutomaticTaskConnection>;
    private readonly timeoutMs: number;
    private identity?: AutomaticTaskConnection;
    private currentGeneration = 0;
    private storeGeneration = 0;
    private unsubscribe?: () => void;
    private disposed = false;
    private readonly controllers = new Set<AbortController>();

    constructor(options: AutomaticTaskServiceOptions = {}) {
        // RN's legacy global fetch may ignore redirect:error. Expo's native fetch
        // disables redirects in its native HTTP client before sending another request.
        this.fetcher = options.fetch ?? expoFetch;
        this.timeoutMs = options.timeoutMs ?? 15000;
        if (options.connection) {
            this.connection = options.connection;
        } else {
            this.unsubscribe = useAssistantStore.subscribe((state, previous) => {
                if (state.serverUrl !== previous.serverUrl || state.serverToken !== previous.serverToken
                    || state.hasHydrated !== previous.hasHydrated) {
                    this.storeGeneration++;
                    this.currentGeneration++;
                }
            });
            this.connection = async () => {
                const state = useAssistantStore.getState();
                if (!state.hasHydrated) throw new AutomaticTaskError('connection_not_ready');
                if (!state.serverToken) {
                    // Existing secure loading mutates the store. Detect a concurrent config switch,
                    // rather than pairing a newly hydrated URL with an old secure-store read.
                    let switched = false;
                    let changes = 0;
                    const stop = useAssistantStore.subscribe((next, previous) => {
                        if (next.serverUrl !== previous.serverUrl || next.hasHydrated !== previous.hasHydrated) switched = true;
                        if (next.serverToken !== previous.serverToken) changes++;
                    });
                    try { await state.loadSavedCredentials(); }
                    finally { stop(); }
                    if (switched || changes > 1) throw new AutomaticTaskError('connection_changed');
                }
                const next = useAssistantStore.getState();
                if (!next.hasHydrated) throw new AutomaticTaskError('connection_not_ready');
                return { serverUrl: next.serverUrl, token: next.serverToken, generation: this.storeGeneration };
            };
        }
    }
    /** Consumers should compare the returned generation again when applying asynchronous results. */
    get generation(): number { return this.currentGeneration; }
    dispose(): void {
        this.disposed = true;
        this.currentGeneration++;
        this.unsubscribe?.();
        this.controllers.forEach(controller => controller.abort());
    }
    private observe(connection: AutomaticTaskConnection): number {
        if (!integer(connection.generation)) throw new AutomaticTaskError('connection_not_ready');
        if (this.identity && (this.identity.serverUrl !== connection.serverUrl || this.identity.token !== connection.token
            || this.identity.generation !== connection.generation)) this.currentGeneration++;
        this.identity = { ...connection };
        return this.currentGeneration;
    }
    private endpoint(connection: AutomaticTaskConnection): string {
        let url: URL;
        try {
            url = new URL(connection.serverUrl.trim().replace(/^ws:/i, 'http:').replace(/^wss:/i, 'https:'));
        } catch { throw new AutomaticTaskError('invalid_endpoint'); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
            throw new AutomaticTaskError('invalid_endpoint');
        }
        if (!text(connection.token) || /[\r\n\0]/.test(connection.token)) throw new AutomaticTaskError('invalid_token');
        return url.toString().replace(/\/+$/, '');
    }
    private async request<T>(path: string, parse: (body: unknown) => T,
        options: AutomaticTaskRequestOptions): Promise<AutomaticTaskResponse<T>> {
        const timeoutMs = options.timeoutMs ?? this.timeoutMs;
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw new AutomaticTaskError('invalid_input');
        if (this.disposed) throw new AutomaticTaskError('disposed');
        if (options.signal?.aborted) throw new AutomaticTaskError('aborted');
        const controller = new AbortController();
        this.controllers.add(controller);
        let timedOut = false;
        const onAbort = () => controller.abort();
        options.signal?.addEventListener('abort', onAbort);
        let rejectAbort: (error: AutomaticTaskError) => void = () => undefined;
        const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
        const abortError = () => rejectAbort(new AutomaticTaskError(this.disposed ? 'disposed' : timedOut ? 'timeout' : 'aborted'));
        controller.signal.addEventListener('abort', abortError);
        const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
        try {
            return await Promise.race([aborted, (async () => {
                const connection = await this.connection();
                if (controller.signal.aborted) throw new AutomaticTaskError('aborted');
                const generation = this.observe(connection);
                const baseUrl = this.endpoint(connection);
                const response = await this.fetcher(`${baseUrl}${path}`, {
                    method: 'GET', redirect: 'error', signal: controller.signal,
                    headers: { Authorization: `Bearer ${connection.token.trim()}` },
                });
                // Defense in depth for injected/nonconforming transports. redirect:error prevents
                // following redirects BEFORE credentials could leave the configured endpoint.
                if (response.redirected || (response.status >= 300 && response.status < 400)) throw new AutomaticTaskError('redirect_blocked');
                let data: unknown;
                try { data = await response.json(); }
                catch { throw new AutomaticTaskError('invalid_response', response.status); }
                const current = await this.connection();
                this.observe(current);
                if (generation !== this.currentGeneration || this.disposed) throw new AutomaticTaskError('connection_changed');
                if (!response.ok) {
                    const code = response.status === 401 ? 'unauthorized' : response.status === 403 ? 'forbidden'
                        : object(data) ? remoteCodes.find(candidate => candidate === data.code) ?? 'http_error' : 'http_error';
                    throw new AutomaticTaskError(code, response.status);
                }
                if (response.status !== 200) throw new AutomaticTaskError('invalid_response', response.status);
                return { ...parse(data), generation };
            })()]);
        } catch (error: unknown) {
            if (error instanceof AutomaticTaskError) throw error;
            throw new AutomaticTaskError('network');
        } finally {
            clearTimeout(timer);
            options.signal?.removeEventListener('abort', onAbort);
            controller.signal.removeEventListener('abort', abortError);
            this.controllers.delete(controller);
        }
    }
    private invalid(): never { throw new AutomaticTaskError('invalid_response'); }
    private id(value: string): string {
        if (!text(value) || value.length > 200) throw new AutomaticTaskError('invalid_input');
        return encodeURIComponent(value);
    }
    catalog(options: AutomaticTaskRequestOptions = {}): Promise<AutomaticTaskResponse<{ tasks: AutomaticTask[] }>> {
        return this.request('/api/tasks', body => {
            if (!object(body) || !Array.isArray(body.tasks) || !body.tasks.every(task)) return this.invalid();
            return { tasks: body.tasks };
        }, options);
    }
    history(id: string, query: AutomaticTaskHistoryOptions = {}, options: AutomaticTaskRequestOptions = {}): Promise<AutomaticTaskResponse<{ history: AutomaticTaskHistory }>> {
        if (query.limit !== undefined && (!integer(query.limit) || query.limit < 1 || query.limit > 100)) throw new AutomaticTaskError('invalid_input');
        const params = new URLSearchParams();
        if (query.limit !== undefined) params.set('limit', String(query.limit));
        if (query.before !== undefined) { this.id(query.before); params.set('before', query.before); }
        const suffix = params.toString();
        return this.request(`/api/tasks/${this.id(id)}/history${suffix ? `?${suffix}` : ''}`, body => {
            if (!object(body) || !history(body.history) || body.history.id !== id) return this.invalid();
            return { history: body.history };
        }, options);
    }
    getResult(id: string, options: AutomaticTaskRequestOptions = {}): Promise<AutomaticTaskResponse<{ result: AutomaticTaskResult }>> {
        return this.request(`/api/tasks/${this.id(id)}/result`, body => {
            if (!object(body) || !result(body.result) || body.result.taskId !== id) return this.invalid();
            return { result: body.result };
        }, options);
    }
}
export const automaticTaskService = new AutomaticTaskService();
