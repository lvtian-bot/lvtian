#!/usr/bin/env node
// Explicit real-model probe: main ACP -> project tool -> authenticated HTTP -> native root task.
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { NativeTaskRuntime } from '../dist/nativeTaskRuntime.js';
import { AcpEngineManager } from '../dist/acpEngineManager.js';
import { MemoryManager } from '../dist/memoryManager.js';
import { SessionManager } from '../dist/sessionManager.js';
import { LvtianServer } from '../dist/server.js';

if (!process.argv.includes('--execute') || !process.env.DEEPSEEK_API_KEY) throw new Error('Explicit --execute and inherited DeepSeek official API credential required');
const root = await mkdtemp(path.join(os.tmpdir(), 'lvtian-task-bridge-probe-'));
const workspace = path.join(root, 'workspace');
await mkdir(workspace);
const dataDir = path.join(root, 'server-data');
const runtime = new NativeTaskRuntime({ root: path.join(root, 'tasks'), workspace, modelEnvironment: { HOME: root, DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY } });
const bridgeOverlay = await runtime.prepareAcpOverlay();
const probeOverlay = path.join(root, 'probe.patch.yml');
// Model selection and privacy overrides apply only to this synthetic test profile.
await writeFile(probeOverlay, '- id: session-log-deepseek\n  disabled: true\n- id: session-telemetry-otel\n  disabled: true\n- id: acp\n  config:\n    provider: deepseek-official\n    model: deepseek-flash\n');
const privateEnvironment = { DSH_HOME: path.join(root, 'main-home'), DSH_AGENTS_HOME: path.join(root, 'main-agents'), HOME: root, LVTIAN_TASK_API_ORIGIN: '', LVTIAN_TASK_API_TOKEN: randomUUID() };
const sm = new SessionManager(dataDir);
const mm = new MemoryManager(workspace);
const engine = new AcpEngineManager(workspace, mm, sm, { dshProfileDir: path.join(root, 'main-home', 'profiles', 'acp'), additionalPatches: [bridgeOverlay, probeOverlay], privateEnvironment, taskTimeoutMs: 120000 });
const server = new LvtianServer({ host: '127.0.0.1', port: 0, token: privateEnvironment.LVTIAN_TASK_API_TOKEN, workspace, dataDir, assistantName: 'Probe' }, sm, mm, engine, undefined, undefined, runtime);
let serverStarted = false;
try {
  await server.start(); serverStarted = true;
  privateEnvironment.LVTIAN_TASK_API_ORIGIN = `http://127.0.0.1:${server.httpServer.address().port}`;
  await runtime.start();
  const requestId = randomUUID();
  const at = new Date(Date.now() + 5 * 60000).toISOString();
  const payload = { requestId, title: 'Bridge probe', prompt: 'Reply exactly BRIDGE_PROBE_OK and do not call tools.', timing: { kind: 'at', at } };
  sm.addMessage('probe-main', { id: 'probe-user', role: 'user', content: 'Create a test task', timestamp: Date.now(), status: 'sent' });
  sm.addMessage('probe-main', { id: 'probe-answer', role: 'assistant', content: '', timestamp: Date.now(), status: 'processing' });
  const toolCalls = [];
  let status;
  await engine.execute('probe-main', 'probe-answer', `Integration test. Actually invoke lvtian_task_create exactly once with these arguments: ${JSON.stringify(payload)}. Do not use bash, files, or other tools. Report the returned operation status truthfully; pending/unknown is not confirmed. Do not execute the future task now.`, {
    onDelta() {}, onToolCall(tool) { toolCalls.push(tool.name); }, onStatusChange(value) { status = value; },
  });
  if (!toolCalls.includes('lvtian_task_create')) throw new Error('Main model did not actually call task creation bridge');
  if (status !== 'done') throw new Error('Main ACP turn did not complete');
  let operation;
  for (let i = 0; i < 90; i++) {
    operation = await runtime.service.getOperationStatus(requestId);
    if (operation.status === 'ready') break;
    await delay(1000);
  }
  if (operation?.status !== 'ready') throw new Error('Native schedule not confirmed for main tool call');
  const catalog = await runtime.service.catalog();
  const task = catalog.find(row => row.id === operation.taskId);
  if (!task || task.sessionId === sm.getDshSessionId('probe-main') || task.prompt !== payload.prompt || task.scheduledAt !== at) throw new Error('Task context or rule differs from accepted bridge request');
  console.log(JSON.stringify({ root, check: 'main-acp-tool-to-native-task', passed: true, operation, mainSessionId: sm.getDshSessionId('probe-main'), taskSessionId: task.sessionId }));
} finally {
  if (serverStarted) await server.stop();
  else { try { await engine.stopAll(); } finally { await runtime.stop(); } }
}
