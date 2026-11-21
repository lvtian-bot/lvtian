import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import yaml from 'yaml';
import { AcpEngineManager } from '../dist/acpEngineManager.js';
import { MemoryManager } from '../dist/memoryManager.js';
import { SessionManager } from '../dist/sessionManager.js';
import { prepareAutonomousJobReplyOverlay } from '../dist/autonomousJobReplyOverlay.js';

const cwd = fileURLToPath(new URL('../', import.meta.url));

test('real ACP forwards 1,200 ordinary updates in order before prompt completion', { timeout: 20_000 }, async t => {
    await fs.access(path.join(cwd, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lvtian-acp-burst-'));
    const dshHome = path.join(root, '.dsh');
    const dataDir = path.join(root, 'data');
    const modelPatch = path.join(root, 'model.patch.yml');
    await fs.writeFile(modelPatch, yaml.stringify([
        { id: 'acp', config: { provider: 'local-job-smoke', model: 'synthetic' } },
        { id: 'agent-default-model', config: { provider: 'local-job-smoke', model: 'synthetic' } },
        { id: 'session-log-deepseek', disabled: true },
        { id: 'session-telemetry-otel', disabled: true },
        { insert: [{ id: 'local-autonomous-smoke', name: fileURLToPath(new URL('./fixtures/autonomousReplySmokePlugin.mjs', import.meta.url)) }] },
    ]));
    const engine = new AcpEngineManager(root, new MemoryManager(root), new SessionManager(dataDir), {
        dshProfileDir: path.join(dshHome, 'profiles', 'acp'),
        privateEnvironment: { DSH_HOME: dshHome, DSH_AGENTS_HOME: path.join(root, '.agents') },
        additionalPatches: [modelPatch, await prepareAutonomousJobReplyOverlay(dataDir)],
        autonomousJobReplies: true,
    });
    t.after(async () => { await engine.stopAll(); await fs.rm(root, { recursive: true, force: true }); });
    const updates = [];
    let terminal;
    let countAtTerminal;
    await engine.execute('main', 'burst-response', 'ACP_BURST', {
        onDelta: text => { updates.push(text); }, onToolCall: () => {}, onApprovalRequest: () => {},
        onStatusChange: (status, detail) => {
            if (status === 'done' || status === 'error') {
                terminal = [status, detail];
                countAtTerminal = updates.length;
            }
        },
    });
    assert.equal(terminal?.[0], 'done', JSON.stringify(terminal));
    assert.equal(countAtTerminal, 1200);
    assert.deepEqual(updates, Array.from({ length: 1200 }, (_, index) => `${index},`));
});
