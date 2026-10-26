import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeTaskHttpHelper, createNativeTaskToolDefinitions, apply, inject } from '../dist/nativeTaskToolBridge.js';

const env = { LVTIAN_TASK_API_ORIGIN: 'http://127.0.0.1:12345', LVTIAN_TASK_API_TOKEN: 'PRIVATE_TEST_TOKEN' };
const signal = () => new AbortController().signal;
const input = (path = '/api/tasks') => ({ method: 'GET', path, signal: signal() });
const invoke = (definitions, name, args = {}, abortSignal = signal()) => definitions.find(tool => tool.name === name).execute(args, { signal: abortSignal });

test('registers seven real defineTool definitions without public credentials', () => {
  const registered = [];
  apply({ tools: { register: tool => registered.push(tool) } });
  assert.deepEqual(inject, ['tools']);
  assert.equal(registered.length, 7);
  assert.deepEqual(registered.map(tool => tool.name), ['lvtian_task_create', 'lvtian_task_list', 'lvtian_task_operation', 'lvtian_task_update', 'lvtian_task_delete', 'lvtian_task_history', 'lvtian_task_result']);
  for (const tool of registered) {
    assert.doesNotMatch(JSON.stringify(tool.parameters), /token|origin|url/i);
    assert.deepEqual(tool.output.render({}, { status: 'unknown' }), [{ type: 'text', text: '{"status":"unknown"}' }]);
  }
  assert.match(registered[0].description, /pending\/unknown are NOT arranged/);
  assert.match(registered[4].description, /does NOT retract/);
});

test('all tools forward exact routes, arguments and execution cancellation signal', async () => {
  const calls = [];
  const definitions = createNativeTaskToolDefinitions({ request: async request => { calls.push(request); return { status: 'pending' }; } });
  const abortSignal = signal();
  const body = { requestId: 'intent-1', title: 'Title', prompt: 'Prompt', timing: { kind: 'at', at: '2027-01-01T00:00:00Z' } };
  assert.deepEqual(await invoke(definitions, 'lvtian_task_create', body, abortSignal), { status: 'pending' });
  await invoke(definitions, 'lvtian_task_list');
  await invoke(definitions, 'lvtian_task_operation', { requestId: 'intent/ ?#' });
  const expected = { id: 'schedule-1', sessionId: 'session-1', kind: 'at', active: true, scheduledAt: body.timing.at };
  await invoke(definitions, 'lvtian_task_update', { taskId: 'schedule-1', expected, title: 'Changed' });
  await invoke(definitions, 'lvtian_task_delete', { taskId: 'schedule-1' });
  await invoke(definitions, 'lvtian_task_history', { taskId: 'schedule/1', limit: 7, before: 'a&b' });
  await invoke(definitions, 'lvtian_task_result', { taskId: 'schedule-1' });
  assert.deepEqual(calls.map(call => [call.method, call.path]), [
    ['POST', '/api/tasks'], ['GET', '/api/tasks'], ['GET', '/api/task-operations/intent%2F%20%3F%23'],
    ['POST', '/api/tasks/schedule-1/update'], ['POST', '/api/tasks/schedule-1/delete'],
    ['GET', '/api/tasks/schedule%2F1/history?limit=7&before=a%26b'], ['GET', '/api/tasks/schedule-1/result'],
  ]);
  assert.deepEqual(calls[0].body, body);
  assert.equal(calls[0].signal, abortSignal);
  assert.deepEqual(calls[3].body, { expected, title: 'Changed' });
});

test('create enforces required requestId and explicit supported timing schemas', async () => {
  let called = 0;
  const definitions = createNativeTaskToolDefinitions({ request: async () => { called++; return {}; } });
  const base = { title: 'a', prompt: 'b', timing: { kind: 'daily', time: '10:00', timeZone: 'Asia/Shanghai' } };
  await assert.rejects(invoke(definitions, 'lvtian_task_create', base));
  await assert.rejects(invoke(definitions, 'lvtian_task_create', { ...base, requestId: 'r', timing: { kind: 'cron', cron: '*' } }));
  await invoke(definitions, 'lvtian_task_create', { ...base, requestId: 'daily' });
  await invoke(definitions, 'lvtian_task_create', { ...base, requestId: 'weekly', timing: { kind: 'weekly', time: '10:00', timeZone: 'UTC', weekdays: [1, 7] } });
  assert.equal(called, 2);
});

test('HTTP sends Bearer privately, manual redirects, and preserves full successful objects', async () => {
  const value = { status: 'conflict', payload: { status: 'unknown' }, error: { code: 'request_conflict' } };
  const helper = createNativeTaskHttpHelper({ env, fetch: async (url, init) => {
    assert.equal(url.origin, env.LVTIAN_TASK_API_ORIGIN);
    assert.equal(init.headers.authorization, `Bearer ${env.LVTIAN_TASK_API_TOKEN}`);
    assert.equal(init.redirect, 'manual');
    assert.equal(init.body, '{"title":"Title"}');
    return Response.json(value);
  } });
  assert.deepEqual(await helper({ ...input(), method: 'POST', body: { title: 'Title' } }), value);
});

test('rejects noncanonical/nonloopback origins and foreign paths without fetching', async () => {
  let fetched = 0;
  const fetcher = async () => { fetched++; return Response.json({}); };
  for (const origin of ['https://127.0.0.1:12345', 'http://localhost:12345', 'http://127.1:12345', 'http://2130706433:12345', 'http://127.0.0.1:12345/', 'http://user:secret@127.0.0.1:12345', 'http://127.0.0.1.evil.test:12345', 'http://0.0.0.0:12345', 'http://[::ffff:127.0.0.1]:12345']) {
    const helper = createNativeTaskHttpHelper({ env: { ...env, LVTIAN_TASK_API_ORIGIN: origin }, fetch: fetcher });
    assert.deepEqual(await helper(input()), { error: 'task_api_invalid_config' });
  }
  const helper = createNativeTaskHttpHelper({ env, fetch: fetcher });
  for (const path of ['//evil.test/api/tasks', 'http://evil.test/api/tasks', '/api/../../other', '/api/tasks#secret']) assert.deepEqual(await helper(input(path)), { error: 'task_api_invalid_config' });
  assert.equal(fetched, 0);
  for (const origin of ['http://[::1]:12345', 'http://127.2.3.4:12345']) assert.deepEqual(await createNativeTaskHttpHelper({ env: { ...env, LVTIAN_TASK_API_ORIGIN: origin }, fetch: fetcher })(input()), {});
});

test('HTTP errors and exceptions disclose only fixed safe codes, never response bodies or causes', async () => {
  for (const [status, code] of [[400, 'invalid_input'], [401, 'unauthorized'], [403, 'unauthorized'], [404, 'not_found'], [409, 'conflict'], [302, 'unavailable'], [500, 'unavailable']]) {
    const helper = createNativeTaskHttpHelper({ env, fetch: async () => new Response('PRIVATE_TEST_TOKEN http://secret/ internal stack', { status, headers: { location: 'http://secret/' } }) });
    assert.deepEqual(await helper(input()), { error: `task_api_${code}` });
  }
  const helper = createNativeTaskHttpHelper({ env, fetch: async () => { throw new Error('PRIVATE_TEST_TOKEN', { cause: 'secret' }); } });
  assert.deepEqual(await helper(input()), { error: 'task_api_unavailable' });
  const definitions = createNativeTaskToolDefinitions({ request: async () => { throw new Error('secret'); } });
  assert.deepEqual(await invoke(definitions, 'lvtian_task_list'), { error: 'task_api_unavailable' });
});

test('rejects unconfigured/invalid responses and sanitizes malformed JSON', async () => {
  assert.deepEqual(await createNativeTaskHttpHelper({ env: {} })(input()), { error: 'task_api_unconfigured' });
  for (const value of [null, [], 'secret', 7]) assert.deepEqual(await createNativeTaskHttpHelper({ env, fetch: async () => Response.json(value) })(input()), { error: 'task_api_invalid_response' });
  assert.deepEqual(await createNativeTaskHttpHelper({ env, fetch: async () => new Response('secret not json') })(input()), { error: 'task_api_unavailable' });
});

test('forwards caller abort and enforces timeout without exposing abort reasons', async () => {
  const fetcher = async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('SECRET_ABORT_CAUSE')), { once: true });
  });
  const helper = createNativeTaskHttpHelper({ env, fetch: fetcher, timeoutMs: 10 });
  assert.deepEqual(await helper(input()), { error: 'task_api_timeout' });
  const controller = new AbortController();
  const waiting = createNativeTaskHttpHelper({ env, fetch: fetcher })({ ...input(), signal: controller.signal });
  controller.abort('SECRET_REASON');
  assert.deepEqual(await waiting, { error: 'task_api_aborted' });
  const already = new AbortController(); already.abort('SECRET_REASON');
  assert.deepEqual(await helper({ ...input(), signal: already.signal }), { error: 'task_api_aborted' });
});
