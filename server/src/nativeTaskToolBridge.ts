import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { JsonValue } from '@deepseek-ai/dsh-util-values';

export const inject = ['tools'];

type BridgeErrorCode = 'task_api_unconfigured' | 'task_api_invalid_config' | 'task_api_aborted' | 'task_api_timeout' | 'task_api_unavailable' | 'task_api_unauthorized' | 'task_api_not_found' | 'task_api_conflict' | 'task_api_invalid_input' | 'task_api_invalid_response';
export interface NativeTaskHttpRequest {
  method: 'GET' | 'POST';
  path: string;
  body?: JsonValue;
  signal: AbortSignal;
}
export type NativeTaskHttpHelper = (request: NativeTaskHttpRequest) => Promise<JsonValue>;
export interface NativeTaskToolBridgeOptions {
  fetch?: typeof globalThis.fetch;
  env?: Readonly<Record<string, string | undefined>>;
  timeoutMs?: number;
  request?: NativeTaskHttpHelper;
}
function failure(code: BridgeErrorCode): JsonValue { return { error: code }; }
function canonicalOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' || url.origin !== value || url.username || url.password) return undefined;
    if (url.hostname === '[::1]') return value;
    const parts = url.hostname.split('.');
    if (parts.length !== 4 || parts[0] !== '127' || parts.some(part => !/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)) return undefined;
    return value;
  } catch { return undefined; }
}

/** Bearer credentials remain in this process; never put them in a tool schema or error. */
export function createNativeTaskHttpHelper(options: NativeTaskToolBridgeOptions = {}): NativeTaskHttpHelper {
  const fetcher = options.fetch ?? globalThis.fetch;
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? 30_000;
  return async request => {
    const rawOrigin = env.LVTIAN_TASK_API_ORIGIN;
    const token = env.LVTIAN_TASK_API_TOKEN;
    if (!rawOrigin || !token) return failure('task_api_unconfigured');
    const origin = canonicalOrigin(rawOrigin);
    if (!origin || /[\r\n]/.test(token) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) return failure('task_api_invalid_config');
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    request.signal.addEventListener('abort', abort, { once: true });
    if (request.signal.aborted) abort();
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
      const url = new URL(request.path, origin);
      if (url.origin !== origin || !request.path.startsWith('/api/') || !url.pathname.startsWith('/api/') || url.hash) return failure('task_api_invalid_config');
      if (controller.signal.aborted) return failure('task_api_aborted');
      const response = await fetcher(url, {
        method: request.method,
        headers: { authorization: `Bearer ${token}`, ...(request.body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
        redirect: 'manual', signal: controller.signal,
      });
      // Never parse an error response: upstream messages may contain secrets or internals.
      if (!response.ok) {
        const codes: Partial<Record<number, BridgeErrorCode>> = { 400: 'task_api_invalid_input', 401: 'task_api_unauthorized', 403: 'task_api_unauthorized', 404: 'task_api_not_found', 409: 'task_api_conflict' };
        return failure(codes[response.status] ?? 'task_api_unavailable');
      }
      const value: unknown = await response.json();
      if (controller.signal.aborted) return failure(timedOut ? 'task_api_timeout' : 'task_api_aborted');
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return failure('task_api_invalid_response');
      // JSON.parse gives lossless JSON data. Preserve the entire object, including payload/error status wrappers.
      return value as { [key: string]: JsonValue };
    } catch {
      return failure(timedOut ? 'task_api_timeout' : request.signal.aborted ? 'task_api_aborted' : 'task_api_unavailable');
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener('abort', abort);
    }
  };
}

const timing = {
  oneOf: [
    { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', const: 'at', required: true }, at: { type: 'string', required: true, description: 'Absolute ISO timestamp including offset or Z.' } } },
    { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', const: 'daily', required: true }, time: { type: 'string', required: true }, timeZone: { type: 'string', required: true, description: 'Explicit IANA time zone.' } } },
    { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', const: 'weekly', required: true }, time: { type: 'string', required: true }, timeZone: { type: 'string', required: true }, weekdays: { type: 'array', items: { type: 'integer' }, required: true, description: 'ISO weekdays, Monday=1, Sunday=7.' } } },
  ],
} as const;
const taskId = { type: 'string', required: true, description: 'Native task id returned by lvtian_task_list.' } as const;
const output = {
  schema: { type: 'json' },
  render: (_args: unknown, value: JsonValue) => [{ type: 'text' as const, text: JSON.stringify(value) }],
} as const;

/** Thin transport only: ownership, timing validation, idempotency and reconciliation belong to the service. */
export function createNativeTaskToolDefinitions(options: NativeTaskToolBridgeOptions = {}) {
  const helper = options.request ?? createNativeTaskHttpHelper(options);
  const request: NativeTaskHttpHelper = async input => {
    try { return await helper(input); } catch { return failure('task_api_unavailable'); }
  };
  const taskPath = (id: string, suffix: string) => `/api/tasks/${encodeURIComponent(id)}/${suffix}`;
  return [
    defineTool({ name: 'lvtian_task_create', description: 'Create an authorized native scheduled task in an independent session, not execute it now. requestId is required: reuse it for the same intent, never blindly retry with a new id. pending/unknown are NOT arranged; only ready confirms authoritative catalog readback. Poll lvtian_task_operation for confirmation.', parameters: {
      requestId: { type: 'string', required: true, description: 'Stable idempotency key for this exact creation intent.' }, title: { type: 'string', required: true }, prompt: { type: 'string', required: true }, timing: { ...timing, required: true },
    }, output, execute: (args, exec) => request({ method: 'POST', path: '/api/tasks', body: args, signal: exec.signal }) }),
    defineTool({ name: 'lvtian_task_list', description: 'Read the authorized native task catalog, including complete native records. Rule/delivery status is not execution success.', parameters: {}, output, execute: (_args, exec) => request({ method: 'GET', path: '/api/tasks', signal: exec.signal }) }),
    defineTool({ name: 'lvtian_task_operation', description: 'Reconcile a creation by its original requestId. pending/unknown do not mean arranged; only ready confirms native catalog readback. Do not recreate on uncertainty.', parameters: { requestId: { type: 'string', required: true } }, output, execute: (args, exec) => request({ method: 'GET', path: `/api/task-operations/${encodeURIComponent(args.requestId)}`, signal: exec.signal }) }),
    defineTool({ name: 'lvtian_task_update', description: 'Update an authorized task. First read lvtian_task_list and pass its complete record including updatedAt as expected, unchanged. Conflicts/unknown outcomes require readback, not blind retries.', parameters: { taskId, expected: { type: 'object', additionalProperties: true, required: true, description: 'Complete task record from the catalog, including updatedAt, unchanged.' }, title: { type: 'string' }, prompt: { type: 'string' }, timing }, output, execute: ({ taskId: id, ...body }, exec) => request({ method: 'POST', path: taskPath(id, 'update'), body, signal: exec.signal }) }),
    defineTool({ name: 'lvtian_task_delete', description: 'Delete an authorized task only after user confirmation. Removes the scheduling rule and native delivery history; does NOT retract already delivered messages or stop queued/running work.', parameters: { taskId }, output, execute: (args, exec) => request({ method: 'POST', path: taskPath(args.taskId, 'delete'), signal: exec.signal }) }),
    defineTool({ name: 'lvtian_task_history', description: 'Read native delivery history. Delivery is not proof that model execution finished or succeeded.', parameters: { taskId, limit: { type: 'integer' }, before: { type: 'string' } }, output, execute: (args, exec) => {
      const query = new URLSearchParams();
      if (args.limit !== undefined) query.set('limit', String(args.limit));
      if (args.before !== undefined) query.set('before', args.before);
      return request({ method: 'GET', path: `${taskPath(args.taskId, 'history')}${query.size ? `?${query}` : ''}`, signal: exec.signal });
    } }),
    defineTool({ name: 'lvtian_task_result', description: 'Read actual task-session execution facts and assistant output. Delivery/inactive/ended alone do not prove success; inspect endReason and uncertainty/truncation.', parameters: { taskId }, output, execute: (args, exec) => request({ method: 'GET', path: taskPath(args.taskId, 'result'), signal: exec.signal }) }),
  ];
}

export function apply(ctx: Context): void {
  for (const definition of createNativeTaskToolDefinitions()) ctx.tools.register(definition);
}
