#!/usr/bin/env node
// Real native management/restart proof; no App, production profile or extra scheduler.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { NativeTaskRuntime } from '../dist/nativeTaskRuntime.js';

if (!process.argv.includes('--execute') || !process.env.DEEPSEEK_API_KEY) throw new Error('Explicit --execute and inherited DeepSeek official API credential required');
const root = await mkdtemp(path.join(os.tmpdir(), 'lvtian-management-probe-'));
const workspace = path.join(root, 'workspace');
await mkdir(workspace);
const options = { root: path.join(root, 'tasks'), workspace, modelEnvironment: { HOME: root, DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY } };
let runtime = new NativeTaskRuntime(options);
async function confirmed(input) {
  let operation = await runtime.service.create(input);
  for (let i = 0; operation.status !== 'ready' && i < 90; i++) {
    await delay(1000);
    operation = await runtime.service.getOperationStatus(input.requestId);
  }
  assert.equal(operation.status, 'ready', 'Native operation must be confirmed');
  return operation;
}
try {
  await runtime.start();
  const at = new Date(Date.now() + 90000).toISOString();
  const input = { requestId: randomUUID(), title: 'Service restart probe', prompt: 'Reply exactly SERVICE_RESTART_PROBE_OK and do not call tools.', timing: { kind: 'at', at } };
  const oneShot = await confirmed(input);
  assert.deepEqual(await runtime.service.create(input), oneShot, 'Identical retry must reuse confirmed operation');
  await assert.rejects(runtime.service.create({ ...input, prompt: 'Different request' }), error => error.code === 'request_conflict');
  const dailyInput = { requestId: randomUUID(), title: 'Daily management probe', prompt: 'Reply DAILY_PROBE_OK only.', timing: { kind: 'daily', time: '23:59:59', timeZone: 'Asia/Shanghai' } };
  const weeklyInput = { requestId: randomUUID(), title: 'Weekly management probe', prompt: 'Reply WEEKLY_PROBE_OK only.', timing: { kind: 'weekly', time: '23:58:59', timeZone: 'Asia/Shanghai', weekdays: [1, 3, 5] } };
  const daily = await confirmed(dailyInput);
  const weekly = await confirmed(weeklyInput);
  let catalog = await runtime.service.catalog();
  assert.equal(catalog.length, 3);
  const dailyTask = catalog.find(task => task.id === daily.taskId);
  const weeklyTask = catalog.find(task => task.id === weekly.taskId);
  assert.equal(dailyTask.kind, 'daily');
  assert.equal(dailyTask.timeZone, 'Asia/Shanghai');
  assert.equal(weeklyTask.kind, 'weekly');
  assert.deepEqual(weeklyTask.weekdays, [1, 3, 5]);
  const update = await runtime.service.update(daily.taskId, { expected: dailyTask, title: 'Changed daily probe' });
  assert.equal(update.updated, true);
  assert.equal(update.record.id, daily.taskId);
  const conflict = await runtime.service.update(daily.taskId, { expected: dailyTask, title: 'Must not overwrite' });
  assert.equal(conflict.updated, false);
  assert.equal(conflict.code, 'schedule_conflict');
  const history = await runtime.service.history(weekly.taskId, { limit: 10 });
  assert.deepEqual(history.records, []);
  assert.equal((await runtime.service.delete(daily.taskId)).deleted, true);
  assert.equal((await runtime.service.delete(weekly.taskId)).deleted, true);
  assert.equal((await runtime.service.catalog()).length, 1);
  console.log(JSON.stringify({ root, check: 'daily-weekly-update-conflict-delete-idempotency', passed: true }));
  await runtime.stop();
  runtime = new NativeTaskRuntime(options);
  await runtime.start();
  assert.deepEqual(await runtime.service.getOperationStatus(input.requestId), oneShot, 'Metadata binding must survive restart');
  // No App or user status request occurs while the native due work executes.
  await delay(Math.max(0, Date.parse(at) - Date.now()) + 25000);
  const result = await runtime.service.getResult(oneShot.taskId);
  assert.equal(result.status, 'ended');
  assert.equal(result.endReason, 'completed');
  assert.equal(result.assistantText.at(-1), 'SERVICE_RESTART_PROBE_OK');
  assert.ok(result.delivery?.messageId);
  assert.deepEqual(await runtime.service.create(input), oneShot, 'Retry after past due must not create a second task');
  catalog = await runtime.service.catalog();
  assert.equal(catalog.length, 1);
  console.log(JSON.stringify({ check: 'service-restart-offline-result', passed: true, taskId: oneShot.taskId, deliveredAt: result.delivery.deliveredAt, turn: result.turn }));
} finally { await runtime.stop(); }
