import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { LvtianServer } from '../dist/server.js';
import { SessionManager } from '../dist/sessionManager.js';
import { MemoryManager } from '../dist/memoryManager.js';
import { AcpEngineManager } from '../dist/acpEngineManager.js';
import { NativeTaskServiceError } from '../dist/nativeTaskService.js';
import { NativeTaskClientError } from '../dist/nativeTaskClient.js';

async function fixture(runtime) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lvtian-task-http-'));
  const sm = new SessionManager(root);
  const mm = new MemoryManager(root);
  const engine = new AcpEngineManager(root, mm, sm, { connectEngine: async () => { throw new Error('Must not start main chat'); } });
  const server = new LvtianServer({ port: 0, host: '127.0.0.1', token: 'fixture-bearer', workspace: root, dataDir: root, assistantName: 'Test' }, sm, mm, engine, undefined, undefined, runtime);
  await server.start();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  const request = (route, options = {}) => fetch(`${origin}${route}`, { ...options, headers: { Authorization: 'Bearer fixture-bearer', 'Content-Type': 'application/json', ...options.headers } });
  return { server, request };
}

const fakeRuntime = service => ({ service, start: async () => {}, stop: async () => {} });

test('existing bearer authorization runs before task API and disabled feature is explicit', async () => {
  const { server, request } = await fixture(undefined);
  try {
    assert.equal((await request('/api/tasks', { headers: { Authorization: '' } })).status, 401);
    const response = await request('/api/tasks');
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { code: 'native_tasks_unavailable' });
  } finally { await server.stop(); }
});

test('native lifecycle starts without clients and stops with server', async () => {
  let started = 0; let stopped = 0;
  const { server } = await fixture({ service: {}, start: async () => { started++; }, stop: async () => { stopped++; } });
  assert.equal(started, 1);
  await server.stop();
  assert.equal(stopped, 1);
});

test('routes preserve pending vs confirmed operations and expose no native host credential', async () => {
  let input;
  const service = {
    catalog: async () => [{ id: 'task-1' }],
    create: async body => { input = body; return { requestId: body.requestId, status: 'pending' }; },
    getOperationStatus: async id => ({ requestId: id, status: 'ready', taskId: 'task-1' }),
    getResult: async id => ({ taskId: id, status: 'ended', endReason: 'completed', assistantText: ['result'] }),
    history: async (id, options) => ({ id, ...options }),
    delete: async id => ({ id, deleted: true }),
    update: async (id, body) => ({ id, expected: body.expected }),
  };
  const { server, request } = await fixture(fakeRuntime(service));
  try {
    assert.deepEqual(await (await request('/api/tasks')).json(), { tasks: [{ id: 'task-1' }] });
    const body = { requestId: 'operation-1', title: 'Task', prompt: 'Work', timing: { kind: 'at', at: '2099-01-01T00:00:00Z' } };
    const pending = await request('/api/tasks', { method: 'POST', body: JSON.stringify(body) });
    assert.equal(pending.status, 202); assert.deepEqual(input, body);
    const confirmed = await request('/api/task-operations/operation-1');
    assert.equal(confirmed.status, 200); assert.equal((await confirmed.json()).operation.status, 'ready');
    assert.equal((await (await request('/api/tasks/task-1/result')).json()).result.endReason, 'completed');
    assert.equal((await (await request('/api/tasks/task-1/history?limit=10&before=message-1')).json()).history.limit, 10);
    assert.equal((await (await request('/api/tasks/task-1/delete', { method: 'POST' })).json()).result.deleted, true);
    const expected = { id: 'task-1', kind: 'at', scheduledAt: body.timing.at, title: 'Task', prompt: 'Work' };
    assert.deepEqual((await (await request('/api/tasks/task-1/update', { method: 'POST', body: JSON.stringify({ expected, title: 'New' }) })).json()).result.expected, expected);
    assert.equal((await request('/api/tasks/task-1/delete')).status, 405);
  } finally { await server.stop(); }
});

test('invalid JSON/shape is 400, unknown tasks are 404, and native errors remain sanitized', async () => {
  let error = new NativeTaskServiceError('not_found');
  const { server, request } = await fixture(fakeRuntime({ getResult: async () => { throw error; } }));
  try {
    for (const body of ['{', 'null', '[]', '{}']) assert.equal((await request('/api/tasks', { method: 'POST', body })).status, 400);
    assert.equal((await request('/api/tasks/missing/result')).status, 404);
    error = new Error('Bearer private-value http://127.0.0.1/?token=private');
    const unknown = await request('/api/tasks/missing/result');
    assert.equal(unknown.status, 503); assert.deepEqual(await unknown.json(), { code: 'native_tasks_unavailable' });
    error = new NativeTaskClientError('timeout', 'prompt', true);
    const timeout = await request('/api/tasks/missing/result');
    assert.deepEqual(await timeout.json(), { code: 'timeout', outcomeUnknown: true });
  } finally { await server.stop(); }
});

test('draining rejects task writes without stopping read-only status queries', async () => {
  const { server, request } = await fixture(fakeRuntime({ catalog: async () => [] }));
  server.isDraining = true;
  try {
    assert.equal((await request('/api/tasks', { method: 'POST', body: '{}' })).status, 503);
    assert.equal((await request('/api/tasks')).status, 200);
  } finally { await server.stop(); }
});
