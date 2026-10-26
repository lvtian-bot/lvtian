import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises';
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
    assert.match(await readFile(path.join(options.root, 'managed-host.patch.yml'), 'utf8'), /session-log-deepseek/);
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
    const host = new NativeTaskHost(await fixture(`
      process.${output}.write('http://127.0.0.1:34567/?token=partial');
      setTimeout(() => process.${diagnostics}.write('unrelated diagnostic\\n'), 20);
      setTimeout(() => process.${output}.write('-complete\\n'), 80);
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
