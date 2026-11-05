#!/usr/bin/env node
// Compile server first. --execute explicitly opts into calls to DeepSeek official API.
import { mkdtemp, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { NativeTaskHost } from '../dist/nativeTaskHost.js';
import { NativeTaskClient } from '../dist/nativeTaskClient.js';
import { assertCreatedTask, assertCompletedDelivery } from './nativeScheduleProbeAssertions.mjs';

const execute = process.argv.includes('--execute');
if (execute && !process.env.DEEPSEEK_API_KEY) throw new Error('Execute probe requires inherited DeepSeek official API credential');
const root = await mkdtemp(path.join(os.tmpdir(), 'lvtian-schedule-probe-'));
const workspace = path.join(root, 'workspace');
await mkdir(workspace);
const modelEnvironment = {
  HOME: root,
  XDG_CONFIG_HOME: path.join(root, 'config'),
  XDG_CACHE_HOME: path.join(root, 'cache'),
  XDG_DATA_HOME: path.join(root, 'data'),
  ...(execute ? { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY } : {}),
};
const host = new NativeTaskHost({ root, workspace, modelEnvironment });
let client;
const cleanup = async () => {
  try { await client?.dispose(); }
  finally { await host.stop(); }
};
const onSignal = () => { cleanup().finally(() => process.exit(130)); };
process.once('SIGINT', onSignal);
process.once('SIGTERM', onSignal);
try {
  let endpoint = await host.start();
  const anonymous = await fetch(`${endpoint.origin}/api`, { method: 'POST', body: '{}', signal: AbortSignal.timeout(10000) });
  if (anonymous.status !== 401) throw new Error(`Anonymous API status ${anonymous.status}`);
  client = await NativeTaskClient.connect({ origin: endpoint.origin, bootToken: endpoint.token });
  if ((await client.catalog()).length) throw new Error('Isolated catalog must start empty');
  console.log(JSON.stringify({ root, check: 'authenticated-native-catalog', passed: true }));
  if (execute) {
    const requestedAt = Date.now();
    const { sessionId } = await client.createSession({ cwd: workspace, agentPreset: 'standard' });
    await client.create({ title: 'Lvtian native probe', prompt: 'Reply exactly LVT_SCHEDULE_PROBE_OK and do not call tools.', timing: { kind: 'at', at: new Date(requestedAt + 90000).toISOString() }, target: { kind: 'session', sessionId } });
    let task;
    for (let i = 0; i < 90; i++) {
      const catalog = await client.catalog();
      if (catalog.some(entry => entry.target.kind === 'session' && entry.target.sessionId === sessionId)) {
        task = assertCreatedTask(catalog, sessionId, requestedAt);
        break;
      }
      await delay(1000);
    }
    if (!task) throw new Error('Model did not persist a native schedule before deadline');
    console.log(JSON.stringify({ check: 'schedule-created', sessionId, taskId: task.id, scheduledAt: task.scheduledAt }));
    await client.dispose(); client = undefined;
    await host.stop();
    endpoint = await host.start();
    console.log(JSON.stringify({ check: 'host-restarted-without-client', passed: true }));
    // No client exists while native Schedule delivers and the Agent executes.
    await delay(Math.max(0, Date.parse(task.scheduledAt) - Date.now()) + 25000);
    const observedAt = Date.now();
    client = await NativeTaskClient.connect({ origin: endpoint.origin, bootToken: endpoint.token });
    const restored = await client.catalog();
    const projection = await client.projections({ sessionId });
    if (projection?.kind !== 'sequenced') throw new Error('Cannot obtain exact cold history cursor');
    const history = await client.page({ address: { kind: 'session', sessionId }, throughSeq: projection.asOfSeq, maxMessages: 100 });
    const evidence = assertCompletedDelivery(restored, task, history.records, observedAt);
    console.log(JSON.stringify({ check: 'offline-restart-execution', passed: true, ...evidence }));
  }
} finally {
  process.removeListener('SIGINT', onSignal);
  process.removeListener('SIGTERM', onSignal);
  await cleanup();
}
