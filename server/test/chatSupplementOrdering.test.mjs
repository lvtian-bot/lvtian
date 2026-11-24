import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LvtianServer } from '../dist/server.js';
import { SessionManager } from '../dist/sessionManager.js';

for (const rotateBytes of [undefined, '1']) {
    test(`actual consumption captures prose offsets and persists across reconnect/restart (rotation=${rotateBytes})`, t => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvtian-supplement-'));
        const previous = process.env.LVTIAN_SESSION_ROTATE_BYTES;
        if (rotateBytes) process.env.LVTIAN_SESSION_ROTATE_BYTES = rotateBytes;
        const sessions = new SessionManager(dir);
        if (previous === undefined) delete process.env.LVTIAN_SESSION_ROTATE_BYTES;
        else process.env.LVTIAN_SESSION_ROTATE_BYTES = previous;
        t.after(() => {
            sessions.persistSession(sessions.getOrCreateSession('main'));
            fs.rmSync(dir, { recursive: true, force: true });
        });
        const add = (id, timestamp, status = 'queued') => sessions.addMessage('main', {
            id, timestamp, status, role: 'user', content: id,
        });
        add('u', 1, 'sent');
        let callbacks;
        const events = [];
        // Execute the real server callback wiring without opening a port or starting a model.
        const server = Object.create(LvtianServer.prototype);
        Object.assign(server, { sessionManager: sessions, isDraining: false,
            acpEngine: { execute: async (_session, _id, _content, hooks) => { callbacks = hooks; } },
            broadcastSession: (_session, event) => events.push(structuredClone(event)),
            scheduleProcessQueue: () => {},
        });
        server.executeAssistantPrompt('main', 'u', undefined, 'u');
        callbacks.onDelta('already😀');
        add('s1', 3);
        add('s2', 4);
        const cursor = sessions.getOrCreateSession('main').currentSeq;
        assert.equal(callbacks.takeSupplement().id, 's1');
        assert.equal(callbacks.takeSupplement().id, 's2');
        callbacks.onDelta('middle');
        add('s3', 5);
        assert.equal(callbacks.takeSupplement().id, 's3');
        callbacks.onToolCall({ id: 'tool', name: 'bash', status: 'running' });
        callbacks.onDelta('answer');
        // Arrived after the engine's last consumption: remains queued for a distinct turn.
        add('late', 6);
        callbacks.onStatusChange('done');
        const session = sessions.getOrCreateSession('main');
        const reply = session.messages.find(m => m.role === 'assistant');
        const expected = [
            { messageId: 's1', timestamp: 3, textOffset: 9 },
            { messageId: 's2', timestamp: 4, textOffset: 9 },
            { messageId: 's3', timestamp: 5, textOffset: 15 },
        ];
        assert.deepEqual(reply.supplementBoundaries, expected);
        assert.equal(reply.content, 'already😀middleanswer');
        assert.equal(session.messages.find(m => m.id === 'late').replyTo, undefined);
        assert.equal(session.messages.find(m => m.id === 'late').status, 'queued');
        assert.equal(events.findLast(e => e.type === 'task_status').completedAt, reply.completedAt);
        assert.ok(reply.completedAt >= reply.timestamp);
        assert.deepEqual(events.filter(e => e.supplementBoundaries).at(-1).supplementBoundaries, expected);
        assert.deepEqual(sessions.getReconcileData('main', cursor).messages.find(m => m.id === reply.id).supplementBoundaries, expected);
        sessions.persistSession(session);
        const reopened = new SessionManager(dir);
        const restored = reopened.getOrCreateSession('main').messages.find(m => m.id === reply.id);
        assert.deepEqual(restored.supplementBoundaries, expected);
        assert.equal(restored.completedAt, reply.completedAt);
    });
}
