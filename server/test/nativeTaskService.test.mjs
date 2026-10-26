import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NativeTaskService, NativeTaskServiceError } from '../dist/nativeTaskService.js';

const input = { requestId: 'r1', title: 'Title', prompt: 'Task instructions', timing: { kind: 'at', at: '2099-01-01T08:00:00Z' } };
async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lvt-native-service-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const metadataPath = path.join(root, 'metadata.json');
  const calls = { create: 0, prompt: 0, page: [], update: [] };
  let tasks = [];
  const task = { id: 'task-1', sessionId: 'session-owned', kind: 'at', title: input.title, prompt: input.prompt, scheduledAt: '2099-01-01T08:00:00.000Z', status: 'active' };
  const client = {
    catalog: async () => tasks,
    createSession: async request => { calls.create++; assert.equal(request.agentPreset, 'standard'); assert.equal(request.sessionId, undefined); return { sessionId: 'session-owned' }; },
    prompt: async request => {
      calls.prompt++;
      const persisted = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
      assert.equal(persisted.operations[0].sessionId, request.sessionId);
      assert.match(request.requestId, /^lvtian-task-[a-f0-9]{64}$/);
      tasks = [task]; return { accepted: true };
    },
    update: async request => { calls.update.push(request); return { id: task.id, updated: false, code: 'schedule_conflict' }; },
    delete: async () => ({ id: task.id, deleted: true }),
    history: async () => ({ id: task.id, records: [], retention: { days: 30, records: 200 }, earlierRecordsUnavailable: false, earlierRecordsPruned: false }),
    projections: async () => ({ kind: 'sequenced', asOfSeq: 100, values: { secret: 'NEVER_RETURN' } }),
    page: async request => { calls.page.push(request); return { records: [event('tool/call', 5, { name: 'schedule_create', arguments: JSON.stringify({ title: input.title, prompt: input.prompt, at: input.timing.at }) })], hasMore: false, header: { secret: 'NEVER_RETURN' } }; },
    ...overrides,
  };
  const options = { metadataPath, workspace: root, clientFactory: async () => client };
  return { service: new NativeTaskService(options), options, client, calls, task, metadataPath, setTasks: value => { tasks = value; } };
}
function event(type, seq, data) { return { type: 'event', event: { type, seq, time: seq * 100, data } }; }

test('create persists root before stable prompt and confirms native facts; concurrent request merges', async t => {
  const f = await fixture(t);
  const [a, b] = await Promise.all([f.service.create(input), f.service.create(input)]);
  assert.equal(a.status, 'ready'); assert.deepEqual(a, b); assert.equal(f.calls.create, 1); assert.equal(f.calls.prompt, 1);
  const stored = await fs.readFile(f.metadataPath, 'utf8'); assert.ok(!stored.includes(input.prompt)); assert.ok(!stored.includes('2099'));
  assert.equal((await f.service.listOwnedTasks()).length, 1);
  assert.equal((await new NativeTaskService(f.options).create(input)).status, 'ready'); assert.equal(f.calls.prompt, 1);
});
test('a connection failure before any native write does not permanently reserve the request id', async t => {
  const f = await fixture(t);
  let unavailable = true;
  const service = new NativeTaskService({ ...f.options, clientFactory: async () => { if (unavailable) throw new Error('host unavailable'); return f.client; } });
  await assert.rejects(service.create(input), /host unavailable/);
  await assert.rejects(fs.readFile(f.metadataPath), error => error.code === 'ENOENT');
  unavailable = false;
  assert.equal((await service.create(input)).status, 'ready');
  assert.equal(f.calls.create, 1);
});

test('close waits for admitted metadata writes and refuses subsequent operations', async t => {
  let enter; let release;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { prompt: async () => { enter(); await gate; return { accepted: true }; } });
  const pending = f.service.create(input).catch(error => error);
  await entered;
  let closed = false;
  const closing = f.service.close().then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false);
  assert.throws(() => f.service.create(input), error => error.code === 'service_closed');
  assert.throws(() => f.service.getOperationStatus(input.requestId), error => error.code === 'service_closed');
  release();
  await closing;
  assert.equal((await pending).code, 'service_closed');
  assert.equal(JSON.parse(await fs.readFile(f.metadataPath, 'utf8')).operations[0].status, 'pending');
});

test('same request with changed payload is rejected', async t => {
  const f = await fixture(t); await f.service.create(input);
  await assert.rejects(async () => f.service.create({ ...input, prompt: 'changed' }), error => error instanceof NativeTaskServiceError && error.httpStatus === 409);
});
test('verbal acceptance without native task remains pending and never replays after restart', async t => {
  const f = await fixture(t, { prompt: async () => ({ accepted: true }) });
  assert.equal((await f.service.create(input)).status, 'pending');
  assert.equal((await new NativeTaskService(f.options).create(input)).status, 'pending'); assert.equal(f.calls.create, 1);
});
test('lost prompt response reconciles without replay', async t => {
  const f = await fixture(t, { prompt: async () => { throw new Error('lost response'); } });
  assert.equal((await f.service.create(input)).status, 'unknown');
  const restarted = new NativeTaskService(f.options);
  assert.equal((await restarted.create(input)).status, 'unknown');
  f.setTasks([f.task]); assert.equal((await restarted.getOperationStatus(input.requestId)).status, 'ready'); assert.equal(f.calls.create, 1);
});
test('unknown session creation never creates a second session', async t => {
  let attempts = 0;
  const f = await fixture(t, { createSession: async () => { attempts++; throw new Error('timeout'); } });
  assert.equal((await f.service.create(input)).status, 'unknown');
  assert.equal((await new NativeTaskService(f.options).create(input)).status, 'unknown'); assert.equal(attempts, 1);
});
test('incorrect or duplicate native records cannot confirm create', async t => {
  const f = await fixture(t, { prompt: async () => ({ accepted: true }) }); await f.service.create(input);
  f.setTasks([{ ...f.task, prompt: 'wrong' }]); assert.equal((await f.service.getOperationStatus('r1')).status, 'pending');
  f.setTasks([f.task, { ...f.task, id: 'duplicate' }]); assert.equal((await f.service.getOperationStatus('r1')).status, 'pending');
});
test('catalog alone cannot confirm a task without native schedule_create evidence', async t => {
  const f = await fixture(t, { page: async () => ({ records: [event('assistant/message', 10, { turn: 1, message: { content: [{ type: 'text', text: 'Scheduled successfully' }] } })], hasMore: false }) });
  assert.equal((await f.service.create(input)).status, 'pending');
});
test('distinct concurrent requests serialize metadata without losing intents', async t => {
  const f = await fixture(t, { prompt: async () => ({ accepted: true }) });
  await Promise.all(Array.from({ length: 10 }, (_, index) => f.service.create({ ...input, requestId: `request-${index}` })));
  const data = JSON.parse(await fs.readFile(f.metadataPath, 'utf8'));
  assert.equal(data.operations.length, 10); assert.equal(new Set(data.operations.map(row => row.requestId)).size, 10);
});
test('corrupt metadata is a failure, never an empty task list', async t => {
  const f = await fixture(t); await fs.writeFile(f.metadataPath, '{');
  await assert.rejects(f.service.catalog(), error => error.code === 'metadata_invalid');
  await assert.rejects(async () => f.service.create(input), error => error.code === 'metadata_invalid'); assert.equal(f.calls.create, 0);
});
test('unowned task/session cannot be read, updated, deleted or queried for results', async t => {
  const f = await fixture(t); f.setTasks([{ ...f.task, sessionId: 'main-chat' }]);
  assert.deepEqual(await f.service.catalog(), []);
  for (const run of [() => f.service.history('task-1'), () => f.service.getResult('task-1'), () => f.service.delete('task-1'), () => f.service.update('task-1', { expected: f.task })]) await assert.rejects(run(), error => error.code === 'not_found');
});
test('update forwards complete original expected record without re-reading it into expected', async t => {
  const f = await fixture(t); await f.service.create(input);
  const expected = { id: f.task.id, kind: 'weekly', title: 'old', prompt: 'old', time: '09:00:00.000', timeZone: 'UTC', weekdays: [2, 4], scheduledAt: '2098-12-01T09:00:00.000Z' };
  const result = await f.service.update(f.task.id, { expected, title: 'new' }); assert.equal(result.code, 'schedule_conflict'); assert.deepEqual(f.calls.update[0].expected, expected);
});
test('rejects invalid strings, time zones, wall times, weekdays and invalid absolute dates', async t => {
  const f = await fixture(t);
  const rules = [{ kind: 'daily', time: '12:00', timeZone: '+01:00' }, { kind: 'daily', time: '25:00', timeZone: 'UTC' }, { kind: 'daily', time: '12:00', timeZone: 'No/Such' }, { kind: 'weekly', time: '12:00', timeZone: 'UTC', weekdays: [0] }, { kind: 'weekly', time: '12:00', timeZone: 'UTC', weekdays: [2, 2] }, { kind: 'at', at: '2099-02-30T12:00:00Z' }];
  for (const timing of rules) await assert.rejects(async () => f.service.create({ ...input, timing }), error => error.code === 'invalid_input');
  await assert.rejects(async () => f.service.create({ ...input, title: 'x'.repeat(121) }), error => error.code === 'invalid_input'); assert.equal(f.calls.create, 0);
});
test('receipt alone never implies execution completion and does not expose projections/header', async t => {
  const f = await fixture(t); await f.service.create(input); f.setTasks([{ ...f.task, status: 'inactive', lastDelivery: { messageId: 'delivery', scheduledAt: f.task.scheduledAt, deliveredAt: f.task.scheduledAt } }]);
  const result = await f.service.getResult(f.task.id); assert.equal(result.status, 'unknown'); assert.deepEqual(result.assistantText, []); assert.ok(!JSON.stringify(result).includes('NEVER_RETURN'));
});
test('cold result uses projection cut and backwards pages, maps only associated assistant text/end', async t => {
  const f = await fixture(t); await f.service.create(input);
  f.setTasks([{ ...f.task, lastDelivery: { messageId: 'delivery', scheduledAt: f.task.scheduledAt, deliveredAt: f.task.scheduledAt } }]);
  f.calls.page.length = 0;
  f.client.page = async request => {
    f.calls.page.push(request);
    return request.beforeSeq === undefined ? { records: [event('assistant/message', 80, { turn: 2, message: { content: [{ type: 'thinking', text: 'SECRET' }, { type: 'text', text: 'answer' }] } }), event('turn/end', 90, { turn: 2, reason: { kind: 'completed' } })], hasMore: true } : { records: [event('turn/start', 60, { turn: 2 }), event('user/message', 70, { id: 'delivery' })], hasMore: false };
  };
  const result = await f.service.getResult(f.task.id); assert.equal(result.status, 'ended'); assert.equal(result.endReason, 'completed'); assert.deepEqual(result.assistantText, ['answer']); assert.equal(result.turn, 2); assert.equal(f.calls.page[1].beforeSeq, 80); assert.ok(f.calls.page.every(request => request.throughSeq === 100)); assert.ok(!JSON.stringify(result).includes('SECRET'));
});
