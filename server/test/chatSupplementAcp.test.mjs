import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import yaml from 'yaml';
import { AcpEngineManager } from '../dist/acpEngineManager.js';
import { LvtianServer } from '../dist/server.js';
import { MemoryManager } from '../dist/memoryManager.js';
import { SessionManager } from '../dist/sessionManager.js';
import { prepareAutonomousJobReplyOverlay } from '../dist/autonomousJobReplyOverlay.js';

test('busy chat delivery is consumed once and a message after the final pull receives its own persisted reply', { timeout: 20_000 }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lvtian-chat-delivery-'));
    const dshHome = path.join(root, '.dsh');
    const dshProfileDir = path.join(dshHome, 'profiles', 'acp');
    const synthetic = path.join(root, 'synthetic.patch.yml');
    await fs.writeFile(synthetic, yaml.stringify([
        { id: 'acp', config: { provider: 'local-chat', model: 'synthetic' } },
        { id: 'agent-default-model', config: { provider: 'local-chat', model: 'synthetic' } },
        { id: 'session-log-deepseek', disabled: true },
        { id: 'session-telemetry-otel', disabled: true },
        { insert: [{ id: 'local-chat-model', name: fileURLToPath(new URL('./fixtures/chatDeliveryModel.mjs', import.meta.url)) }] },
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

    const socket = new WebSocket('ws://127.0.0.1:' + server.httpServer.address().port);
    const packets = [];
    socket.on('message', raw => packets.push(JSON.parse(raw)));
    const waitFor = async predicate => {
        for (let i = 0; i < 500; i++) {
            if (predicate()) return;
            await delay(20);
        }
        assert.fail('chat delivery did not reach its expected state');
    };
    try {
        await once(socket, 'open');
        socket.send(JSON.stringify({ type: 'auth', token: config.token }));
        await waitFor(() => packets.some(p => p.type === 'auth_result' && p.success));
        socket.send(JSON.stringify({ type: 'sync', sessionId: 'main', lastSeq: 0 }));
        await waitFor(() => packets.some(p => p.type === 'sync_result'));
        const withdraw = id => socket.send(JSON.stringify({ type: 'withdraw_unreceived', sessionId: 'main', messageId: id }));
        withdraw('cancelled');
        await waitFor(() => packets.some(p => p.type === 'message_deleted' && p.messageId === 'cancelled'));
        socket.send(JSON.stringify({ type: 'chat', sessionId: 'main', messageId: 'cancelled', content: 'late write' }));
        await waitFor(() => packets.filter(p => p.type === 'message_deleted' && p.messageId === 'cancelled').length === 2);
        const [peer] = server.wss.clients;
        const deliver = id => server.handleChat(peer, 'main', id, id);
        // Deliver at the exact admission boundary. The child still owns an ACP
        // prompt while the parent is answering its last empty pull.
        const take = sessions.takeQueuedMessage.bind(sessions);
        let emptyPulls = 0;
        sessions.takeQueuedMessage = (sid, owner) => {
            const claimed = take(sid, owner);
            if (owner === 'A' && !claimed) {
                emptyPulls++;
                if (emptyPulls === 1) { deliver('B'); deliver('B'); deliver('B2'); }
                if (emptyPulls === 3) deliver('C');
            }
            return claimed;
        };
        socket.send(JSON.stringify({ type: 'chat', sessionId: 'main', messageId: 'A', content: 'A' }));
        await waitFor(() => sessions.getOrCreateSession('main').messages.some(m => m.replyTo === 'C' && m.status === 'done'));
        await waitFor(() => packets.some(p => p.type === 'event_chunk' && p.delta === 'A/B/B2/C'));
        const beforeWithdrawal = packets.length;
        withdraw('B');
        await waitFor(() => packets.slice(beforeWithdrawal).some(p => p.type === 'message_ack' && p.messageId === 'B' && p.replyTo === 'A'));
        const history = new SessionManager(dataDir).getOrCreateSession('main').messages;
        assert.deepEqual(history.filter(m => m.role === 'user').map(m => [m.id, m.replyTo]),
            [['A', undefined], ['B', 'A'], ['B2', 'A'], ['C', undefined]]);
        assert.deepEqual(history.filter(m => m.role === 'assistant').map(m => m.replyTo), ['A', 'C']);
        assert.ok(packets.some(p => p.type === 'event_chunk' && p.delta === 'A/B/B2'));
        assert.ok(history.find(m => m.replyTo === 'C').content.endsWith('A/B/B2/C'));
    } finally {
        socket.terminate();
    }
});
