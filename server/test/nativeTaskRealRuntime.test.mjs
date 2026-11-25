import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { NativeTaskRuntime } from '../dist/nativeTaskRuntime.js';

test('real NativeTaskRuntime upgrades existing DSH data into the AI workspace', async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'lvtian-real-runtime-'));
  const root = path.join(fixture, 'private-native-tasks');
  const workspace = path.join(fixture, 'workspace');
  await mkdir(workspace);
  const options = {
    root,
    workspace,
    modelEnvironment: {
      HOME: fixture,
      XDG_CONFIG_HOME: path.join(fixture, 'config'),
      XDG_CACHE_HOME: path.join(fixture, 'cache'),
      XDG_DATA_HOME: path.join(fixture, 'data'),
    },
  };
  let runtime = new NativeTaskRuntime(options);
  try {
    await runtime.start();
    const created = await runtime.service.create({
      requestId: 'runtime-workspace-upgrade',
      title: 'workspace migration probe',
      prompt: 'reply with an isolated test result',
      timing: { kind: 'at', at: '2099-01-01T00:00:00Z' },
    });
    assert.equal(created.status, 'ready');
    const [before] = await runtime.service.catalog();
    assert.equal(before.id, created.taskId);
    await runtime.stop();

    const workspaceData = path.join(workspace, '.lvtian', 'native-tasks');
    await mkdir(path.join(root, 'home'), { recursive: true });
    await rename(path.join(workspaceData, 'storages'), path.join(root, 'home', 'storages'));
    await rename(path.join(workspaceData, 'sessions'), path.join(root, 'home', 'sessions'));
    await writeFile(path.join(root, 'managed-host.patch.yml'), '- id: session-log-deepseek\n  disabled: true\n- id: session-telemetry-otel\n  disabled: true\n');

    runtime = new NativeTaskRuntime(options);
    await runtime.start();
    const [after] = await runtime.service.catalog();
    assert.equal(after.id, before.id);
    assert.equal(after.title, before.title);
    await access(path.join(workspaceData, 'storages', 'schedule.json'));
    await assert.rejects(access(path.join(root, 'home', 'storages', 'schedule.json')));
    assert.equal(JSON.parse(await readFile(path.join(root, 'operations.json'), 'utf8')).operations.length, 1);
    assert.equal((await runtime.service.delete(after.id)).deleted, true);
    assert.deepEqual(await runtime.service.catalog(), []);
  } finally {
    await runtime.stop().catch(() => undefined);
    await rm(fixture, { recursive: true, force: true });
  }
});
