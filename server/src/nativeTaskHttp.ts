import type http from 'node:http';
import { NativeTaskService, NativeTaskServiceError, type NativeTaskCreateInput, type NativeTaskUpdateInput } from './nativeTaskService.js';
import { NativeTaskClientError } from './nativeTaskClient.js';

type TaskApi = Pick<NativeTaskService, 'catalog' | 'create' | 'getOperationStatus' | 'update' | 'delete' | 'history' | 'getResult'>;
export function isNativeTaskPath(pathname: string): boolean {
    return pathname === '/api/tasks' || pathname.startsWith('/api/tasks/') || pathname.startsWith('/api/task-operations/');
}
function record(input: unknown): input is Record<string, unknown> {
    return input !== null && typeof input === 'object' && !Array.isArray(input);
}
function json(res: http.ServerResponse, status: number, value: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
}
/** Called only AFTER the existing server's bearer authorization. No native credentials cross it. */
export async function handleNativeTaskHttp(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
    service: TaskApi | undefined,
    readBody: () => Promise<unknown>,
    draining = false,
): Promise<void> {
    if (!service) { json(res, 503, { code: 'native_tasks_unavailable' }); return; }
    if (draining && req.method !== 'GET') { json(res, 503, { code: 'service_upgrading' }); return; }
    const parseBody = async (): Promise<unknown> => {
        try { return await readBody(); }
        catch { throw new NativeTaskServiceError('invalid_input'); }
    };
    try {
        if (url.pathname === '/api/tasks') {
            if (req.method === 'GET') { json(res, 200, { tasks: await service.catalog() }); return; }
            if (req.method === 'POST') {
                const body = await parseBody();
                if (!record(body) || typeof body.requestId !== 'string' || typeof body.title !== 'string' || typeof body.prompt !== 'string' || !record(body.timing)) throw new NativeTaskServiceError('invalid_input');
                const operation = await service.create(body as unknown as NativeTaskCreateInput);
                json(res, operation.status === 'ready' ? 200 : 202, { operation }); return;
            }
        }
        const operationMatch = /^\/api\/task-operations\/([^/]+)$/.exec(url.pathname);
        if (operationMatch && req.method === 'GET') {
            const operation = await service.getOperationStatus(decodeURIComponent(operationMatch[1]));
            json(res, operation.status === 'ready' ? 200 : 202, { operation }); return;
        }
        const taskMatch = /^\/api\/tasks\/([^/]+)\/(result|history|update|delete)$/.exec(url.pathname);
        if (taskMatch) {
            const id = decodeURIComponent(taskMatch[1]);
            const action = taskMatch[2];
            if (action === 'result' && req.method === 'GET') {
                const messageIds = url.searchParams.getAll('messageId');
                if (messageIds.length > 1) throw new NativeTaskServiceError('invalid_input');
                json(res, 200, { result: await service.getResult(id, messageIds[0]) }); return;
            }
            if (action === 'history' && req.method === 'GET') {
                const before = url.searchParams.get('before');
                const limit = url.searchParams.get('limit');
                json(res, 200, { history: await service.history(id, { ...(before !== null ? { before } : {}), ...(limit !== null ? { limit: Number(limit) } : {}) }) }); return;
            }
            if (action === 'delete' && req.method === 'POST') { json(res, 200, { result: await service.delete(id) }); return; }
            if (action === 'update' && req.method === 'POST') {
                const body = await parseBody();
                if (!record(body) || !record(body.expected)) throw new NativeTaskServiceError('invalid_input');
                json(res, 200, { result: await service.update(id, body as unknown as NativeTaskUpdateInput) }); return;
            }
        }
        json(res, 405, { code: 'method_not_allowed' });
    } catch (error) {
        if (error instanceof NativeTaskServiceError) { json(res, error.httpStatus, { code: error.code }); return; }
        if (error instanceof NativeTaskClientError) { json(res, 503, { code: error.code, outcomeUnknown: error.outcomeUnknown }); return; }
        // Never forward parser messages, filesystem errors, native cookie/URL or model output.
        json(res, error instanceof SyntaxError || error instanceof URIError ? 400 : 503, { code: error instanceof SyntaxError || error instanceof URIError ? 'invalid_input' : 'native_tasks_unavailable' });
    }
}
