import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NativeTaskHost } from '../dist/nativeTaskHost.js';

async function fixture(source = "console.log('http://127.0.0.1:34567/?token=test-private-token'); setInterval(() => {}, 1000);") {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lvtian-host-test-'));
  const launcher = path.join(root, 'fixture.mjs');
  await writeFile(launcher, source);
  return { root, launcher, workspace: root, startupTimeoutMs: 2000, stopTimeoutMs: 1000 };
}

test('starts once for concurrent requests, preserves root and releases lease on stop', async () => {
  const options = await fixture();
  const host = new NativeTaskHost(options);
  try {
    const [one, two] = await Promise.all([host.start(), host.start()]);
    assert.deepEqual(one, two);
    assert.equal(one.origin, 'http://127.0.0.1:34567');
    assert.equal(one.token, 'test-private-token');
    const overlay = await readFile(path.join(options.root, 'managed-host.patch.yml'), 'utf8');
    assert.match(overlay, /session-log-deepseek/);
    assert.match(overlay, /storage-json/);
    assert.match(overlay, /session-persistence-jsonl/);
    assert.ok(overlay.includes(JSON.stringify(path.join(options.workspace, '.lvtian', 'native-tasks', 'storages'))));
    await host.stop();
    assert.deepEqual(await host.start(), one);
  } finally { await host.stop(); }
});

test('prevents two Harness processes writing the same storage root', async () => {
  const options = await fixture();
  const one = new NativeTaskHost(options);
  const two = new NativeTaskHost(options);
  try {
    await one.start();
    await assert.rejects(two.start(), /native_host_exited/);
    await one.stop();
    await two.start();
  } finally { await Promise.all([one.stop(), two.stop()]); }
});

test('prevents different private roots writing the same workspace task data', async () => {
  const firstOptions = await fixture();
  const secondRoot = await mkdtemp(path.join(os.tmpdir(), 'lvtian-host-private-root-'));
  const secondOptions = { ...firstOptions, root: secondRoot };
  const one = new NativeTaskHost(firstOptions);
  const two = new NativeTaskHost(secondOptions);
  try {
    await one.start();
    await assert.rejects(two.start(), /native_host_exited/);
    await one.stop();
    await two.start();
  } finally { await Promise.all([one.stop(), two.stop()]); }
});

test('fails without exposing output credentials when launcher exits or times out', async () => {
  for (const source of ["console.error('private-api-key=secret'); process.exit(1);", 'setInterval(() => {}, 1000);']) {
    const host = new NativeTaskHost({ ...await fixture(source), startupTimeoutMs: 200 });
    try { await assert.rejects(host.start(), error => /^native_host_(exited|startup_timeout)$/.test(error.message)); }
    finally { await host.stop(); }
  }
});

test('recovers the storage lease after a forced host crash', async () => {
  const options = await fixture();
  const host = new NativeTaskHost(options);
  try {
    await host.start();
    const exited = new Promise(resolve => host.child.once('exit', resolve));
    host.child.kill('SIGKILL');
    await exited;
    await host.start();
  } finally { await host.stop(); }
});

test('runner exits when the supervisor pipe closes', async () => {
  const host = new NativeTaskHost(await fixture());
  try {
    await host.start();
    const exited = new Promise(resolve => host.child.once('exit', resolve));
    host.child.stdin.end();
    await exited;
    await host.start();
  } finally { await host.stop(); }
});

test('waits for a full startup token across pipe chunks without mixing stdout and stderr', async () => {
  for (const output of ['stdout', 'stderr']) {
    const diagnostics = output === 'stdout' ? 'stderr' : 'stdout';
    // Let the runner's queued SQLite warning drain before deliberately splitting
    // the fixture's URL. A diagnostic inserted into that SAME line is not a
    // valid chunked URL; this regression exercises interference across streams.
    const host = new NativeTaskHost(await fixture(`
      process.nextTick(() => process.stderr.write('queued startup diagnostic\\n'));
      setImmediate(() => {
        process.${output}.write('http://127.0.0.1:34567/?token=partial');
        setTimeout(() => process.${diagnostics}.write('unrelated diagnostic\\n'), 20);
        setTimeout(() => process.${output}.write('-complete\\n'), 80);
      });
      setInterval(() => {}, 1000);
    `));
    try { assert.equal((await host.start()).token, 'partial-complete'); }
    finally { await host.stop(); }
  }
});

test('does not overwrite a user-modified managed overlay', async () => {
  const options = await fixture();
  await mkdir(options.root, { recursive: true });
  const overlay = path.join(options.root, 'managed-host.patch.yml');
  await writeFile(overlay, 'custom configuration');
  const host = new NativeTaskHost(options);
  await assert.rejects(host.start(), /native_host_overlay_conflict/);
  assert.equal(await readFile(overlay, 'utf8'), 'custom configuration');
});

test('upgrades the exact legacy managed overlay and moves native data into the workspace', async () => {
  const options = await fixture();
  const oldStorage = path.join(options.root, 'home', 'storages');
  const oldSessions = path.join(options.root, 'home', 'sessions');
  await mkdir(oldStorage, { recursive: true });
  await mkdir(oldSessions, { recursive: true });
  await writeFile(path.join(oldStorage, 'schedule.json'), '{"tasks":[]}');
  await writeFile(path.join(oldSessions, 'session.jsonl'), 'session');
  await writeFile(path.join(options.root, 'managed-host.patch.yml'), '- id: session-log-deepseek\n  disabled: true\n- id: session-telemetry-otel\n  disabled: true\n');
  const host = new NativeTaskHost(options);
  try {
    await host.start();
    const target = path.join(options.workspace, '.lvtian', 'native-tasks');
    assert.equal(await readFile(path.join(target, 'storages', 'schedule.json'), 'utf8'), '{"tasks":[]}');
    assert.equal(await readFile(path.join(target, 'sessions', 'session.jsonl'), 'utf8'), 'session');
    await assert.rejects(access(path.join(oldStorage, 'schedule.json')));
    await assert.rejects(access(oldSessions));
    assert.match(await readFile(path.join(options.root, 'managed-host.patch.yml'), 'utf8'), /storage-json/);
  } finally { await host.stop(); }
});

test('does not charge migration time against the endpoint startup deadline', async () => {
  const options = await fixture();
  const runner = path.join(options.root, 'delayed-runner.mjs');
  await writeFile(runner, `
    process.stdout.write('http://127.0.0.1:34567/?token=test-private-token\\n');
    setTimeout(() => {
      process.stderr.write('LVTIAN_NATIVE_TASK_MIGRATION_COMPLETE\\n');
    }, 100);
    setInterval(() => {}, 1000);
  `);
  const host = new NativeTaskHost({ ...options, runner, migrationTimeoutMs: 1000, startupTimeoutMs: 50 });
  try { assert.equal((await host.start()).token, 'test-private-token'); }
  finally { await host.stop(); }
});

test('restarts through the host after cleaning an interrupted committed migration', async () => {
  const options = await fixture();
  const taskRoot = path.join(options.workspace, '.lvtian', 'native-tasks');
  const target = path.join(taskRoot, 'sessions');
  const staging = `${target}.migration`;
  const state = path.join(options.root, 'sessions-workspace-migration.json');
  const migrationId = '77777777-7777-4777-8777-777777777777';
  await mkdir(target, { recursive: true });
  await mkdir(staging, { recursive: true });
  await writeFile(path.join(target, 'session.jsonl'), 'complete');
  await writeFile(path.join(staging, 'session.jsonl'), 'partial');
  await writeFile(path.join(target, `.lvtian-native-task-migration-${migrationId}`), migrationId);
  await writeFile(state, `${JSON.stringify({
    version: 1,
    source: path.join(options.root, 'home', 'sessions'),
    target,
    migrationId,
    phase: 'copying',
  })}\n`);
  const host = new NativeTaskHost(options);
  try {
    await host.start();
    await host.stop();
    await host.start();
    assert.equal(await readFile(path.join(target, 'session.jsonl'), 'utf8'), 'complete');
    await assert.rejects(access(staging));
    await assert.rejects(access(state));
  } finally { await host.stop(); }
});
