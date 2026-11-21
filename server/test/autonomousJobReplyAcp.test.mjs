import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import yaml from 'yaml';
import { AcpEngineManager } from '../dist/acpEngineManager.js';
import { LvtianServer } from '../dist/server.js';
import { MemoryManager } from '../dist/memoryManager.js';
import { SessionManager } from '../dist/sessionManager.js';
import { prepareAutonomousJobReplyOverlay } from '../dist/autonomousJobReplyOverlay.js';

test('real ACP child publishes a job-notice reply after the user request closes, without a second user request', { timeout: 20_000 }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lvtian-autonomous-reply-acp-'));
    const dshHome = path.join(root, '.dsh');
    const dshProfileDir = path.join(dshHome, 'profiles', 'acp');
    const synthetic = path.join(root, 'synthetic.patch.yml');
    await fs.writeFile(synthetic, yaml.stringify([
        { id: 'acp', config: { provider: 'local-job-smoke', model: 'synthetic' } },
        { id: 'agent-default-model', config: { provider: 'local-job-smoke', model: 'synthetic' } },
        { id: 'session-log-deepseek', disabled: true },
        { id: 'session-telemetry-otel', disabled: true },
        { insert: [{ id: 'local-autonomous-smoke', name: fileURLToPath(new URL('./fixtures/autonomousReplySmokePlugin.mjs', import.meta.url)) }] },
    ]));
    const dataDir = path.join(root, 'data');
    const config = { workspace: root, dataDir, host: '127.0.0.1', port: 0, token: 'local-test', assistantName: 'test' };
    const sessions = new SessionManager(dataDir);
    const memory = new MemoryManager(root);
    const engine = new AcpEngineManager(root, memory, sessions, {
        dshProfileDir, privateEnvironment: { DSH_HOME: dshHome, DSH_AGENTS_HOME: path.join(root, '.agents') },
        additionalPatches: [synthetic, await prepareAutonomousJobReplyOverlay(dataDir)], autonomousJobReplies: true,
    });
    const server = new LvtianServer(config, sessions, memory, engine);
    t.after(async () => { await server.stop(); await fs.rm(root, { recursive: true, force: true }); });
    await server.start();
    let text = '';
    let terminal;
    await engine.execute('main', 'first-response', '启动一个测试任务', {
        onDelta: part => { text += part; }, onToolCall: () => {}, onApprovalRequest: () => {},
        onStatusChange: (status, detail) => { if (status === 'done' || status === 'error') terminal = [status, detail]; },
    });
    assert.equal(terminal?.[0], 'done', JSON.stringify(terminal));
    assert.equal(text, '普通回复');
    sessions.setPendingBackground('main', '已有摘要：作业仍在运行', true);
    const waitLimit = Date.now() + 6000;
    while (!sessions.getOrCreateSession('main').messages.some(message => message.id.startsWith('job-reply-')) && Date.now() < waitLimit) {
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    const reloaded = new SessionManager(dataDir);
    const persisted = reloaded.getOrCreateSession('main').messages.filter(message => message.id.startsWith('job-reply-'));
    assert.deepEqual(persisted.map(message => [message.role, message.source, message.status, message.content]),
        [['assistant', 'autonomous_job_reply', 'done', '后台结果：已完成']]);
    assert.equal(reloaded.getPendingBackground('main'), `已有摘要：作业仍在运行\n\n[后台作业回复 ${persisted[0].id}]\n后台结果：已完成`);
});
