import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NativeTaskRuntime } from '../dist/nativeTaskRuntime.js';
import { NativeTaskClient } from '../dist/nativeTaskClient.js';

async function runtimeFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lvtian-runtime-'));
  return new NativeTaskRuntime({ root, workspace: root });
}

test('starts proactively, reuses checked connection, and disposes client before host', async t => {
  const runtime = await runtimeFixture();
  const order = [];
  runtime.host.start = async () => { order.push('start-host'); return { origin: 'http://127.0.0.1:3100', token: 'fixture-token' }; };
  runtime.host.stop = async () => { order.push('stop-host'); };
  t.mock.method(NativeTaskClient, 'connect', async () => ({ catalog: async () => [], dispose: async () => { order.push('dispose-client'); } }));
  await runtime.start();
  await runtime.service.catalog();
  await runtime.stop();
  assert.deepEqual(order, ['start-host', 'dispose-client', 'stop-host']);
  await assert.rejects(runtime.start(), /native_tasks_stopped/);
});

test('recovers an exited native host without a phone query or replaying task creation', { timeout: 3000 }, async t => {
  // The mocked host has no server socket to keep its unref'ed recovery timer alive.
  // Outlive the test deadline; the hook also clears this handle on failure/cancellation.
  const keepAlive = setTimeout(() => {}, 5000);
  t.after(() => clearTimeout(keepAlive));
  const runtime = await runtimeFixture();
  let starts = 0; let connects = 0;
  let recovered;
  const finished = new Promise(resolve => { recovered = resolve; });
  runtime.host.start = async () => { starts++; return { origin: 'http://127.0.0.1:3100', token: 'fixture-token' }; };
  runtime.host.stop = async () => {};
  let disconnected = false;
  t.mock.method(NativeTaskClient, 'connect', async () => {
    connects++;
    if (connects === 2) recovered();
    return { catalog: async () => { if (disconnected && connects === 1) throw new Error('closed'); return []; }, dispose: async () => {} };
  });
  try {
    await runtime.start();
    disconnected = true;
    runtime.host.options.onUnexpectedExit();
    await finished;
    assert.equal(starts, 2);
    assert.equal(connects, 2);
  } finally { await runtime.stop(); }
});

test('parent metadata ownership persists while native child is absent and until service drains', async () => {
  const runtime = await runtimeFixture();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  runtime.service.close = async () => { await gate; };
  const stopping = runtime.stop();
  assert.throws(() => new NativeTaskRuntime(runtime.options), /native_task_metadata_locked/);
  release();
  await stopping;
  const replacement = new NativeTaskRuntime(runtime.options);
  try { await runtime.stop(); }
  finally { await replacement.stop(); }
});

test('ACP overlay contains only the local plugin path and protects modified files', async () => {
  const runtime = await runtimeFixture();
  const overlay = await runtime.prepareAcpOverlay();
  const content = await readFile(overlay, 'utf8');
  assert.match(content, /nativeTaskToolBridge\.js/);
  assert.doesNotMatch(content, /Bearer|TOKEN|Cookie|fixture-token/);
  assert.equal(await runtime.prepareAcpOverlay(), overlay);
  await writeFile(overlay, 'user modified');
  await assert.rejects(runtime.prepareAcpOverlay(), /overlay_conflict/);
  assert.equal(await readFile(overlay, 'utf8'), 'user modified');
  await runtime.stop();
});
