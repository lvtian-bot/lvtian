import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionManager } from '../dist/sessionManager.js';

const sessionId = 'timeline';
const tool = (id, status = 'running') => ({ id, name: 'bash', status });
const position = (toolCallId, textOffset) => ({ toolCallId, textOffset });

function fixture(t, rotateBytes) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvtian-timeline-'));
    const managers = [];
    const create = () => {
        const previous = process.env.LVTIAN_SESSION_ROTATE_BYTES;
        if (rotateBytes === undefined) delete process.env.LVTIAN_SESSION_ROTATE_BYTES;
        else process.env.LVTIAN_SESSION_ROTATE_BYTES = String(rotateBytes);
        try {
            const manager = new SessionManager(dir);
            managers.push(manager);
            return manager;
        } finally {
            if (previous === undefined) delete process.env.LVTIAN_SESSION_ROTATE_BYTES;
            else process.env.LVTIAN_SESSION_ROTATE_BYTES = previous;
        }
    };
    t.after(() => {
        for (const manager of managers) {
            for (const id of manager.listSessionIds()) {
                manager.persistSession(manager.getOrCreateSession(id));
            }
        }
        fs.rmSync(dir, { recursive: true, force: true });
    });
    return { dir, create, sm: create() };
}

function add(sm, id = 'assistant', extra = {}) {
    return sm.addMessage(sessionId, {
        id, role: 'assistant', content: '', timestamp: Date.now(), status: 'processing', ...extra,
    });
}

function finish(sm, id = 'assistant') {
    sm.updateMessage(sessionId, id, (message) => { message.status = 'done'; });
}

test('timeline alternates text and tools using UTF-16 offsets without changing content', (t) => {
    const { sm } = fixture(t);
    const message = add(sm);
    sm.appendDelta(sessionId, message.id, '开始😀');
    sm.setToolCall(sessionId, message.id, tool('first'));
    sm.appendDelta(sessionId, message.id, '中间');
    sm.setToolCall(sessionId, message.id, tool('second'));
    sm.appendDelta(sessionId, message.id, '结束');

    assert.equal(message.content, '开始😀中间结束');
    assert.deepEqual(message.toolCallPositions, [position('first', 4), position('second', 6)]);
    assert.deepEqual(message.toolCalls, [tool('first'), tool('second')]);
});

test('late status updates keep the first anchor and adjacent tools share an offset', (t) => {
    const { sm } = fixture(t);
    const message = add(sm);
    sm.setToolCall(sessionId, message.id, tool('before-text'));
    sm.appendDelta(sessionId, message.id, '正文');
    sm.setToolCall(sessionId, message.id, tool('first'));
    sm.setToolCall(sessionId, message.id, tool('second'));
    sm.appendDelta(sessionId, message.id, '后续');
    const anchors = structuredClone(message.toolCallPositions);
    sm.setToolCall(sessionId, message.id, { ...tool('first', 'done'), output: 'ok' });
    sm.setToolCall(sessionId, message.id, tool('second', 'failed'));
    sm.setToolCall(sessionId, message.id, tool('before-text', 'done'));

    assert.deepEqual(message.toolCallPositions, anchors);
    assert.deepEqual(anchors, [position('before-text', 0), position('first', 2), position('second', 2)]);
    assert.equal(message.toolCalls.length, 3);
    assert.equal(message.toolCalls[1].output, 'ok');
    assert.equal(message.toolCalls[2].status, 'failed');
});

for (const rotateBytes of [undefined, 1]) {
    test(`timeline survives pending delta boundaries and restart${rotateBytes ? ' with forced snapshot rotation' : ''}`, (t) => {
        const { sm, create, dir } = fixture(t, rotateBytes);
        const message = add(sm);
        const other = add(sm, 'other');
        sm.appendDelta(sessionId, message.id, '甲😀');
        sm.appendDelta(sessionId, other.id, '旁路');
        // Both deltas are pending when the full tool message forces a flush.
        sm.setToolCall(sessionId, message.id, tool('first'));
        sm.appendDelta(sessionId, message.id, '乙');
        sm.setToolCall(sessionId, message.id, tool('second'));
        sm.appendDelta(sessionId, message.id, '丙');
        sm.setToolCall(sessionId, message.id, tool('first', 'done'));
        finish(sm);
        finish(sm, other.id);
        const expected = structuredClone(sm.getReconcileData(sessionId, 0).messages);
        const logDir = path.join(dir, 'sessions', sessionId);
        if (rotateBytes) {
            assert.ok(fs.readdirSync(logDir).some((name) => name.startsWith('seg.')));
            const snapshot = JSON.parse(fs.readFileSync(path.join(logDir, 'events.jsonl'), 'utf8').split('\n')[0]);
            assert.equal(snapshot.t, 'snapshot');
            assert.deepEqual(snapshot.state.messages[0].toolCallPositions, [position('first', 3), position('second', 4)]);
        } else {
            const events = fs.readFileSync(path.join(logDir, 'events.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
            const firstToolIndex = events.findIndex((event) => event.t === 'msg' && event.m.toolCallPositions?.length);
            assert.ok(events.slice(0, firstToolIndex).some((event) => event.t === 'delta' && event.d === '甲😀'));
        }
        const replayed = create();
        assert.deepEqual(replayed.getReconcileData(sessionId, 0).messages, expected);
        assert.equal(expected[0].content, '甲😀乙丙');
        assert.equal(expected[1].content, '旁路');
        assert.deepEqual(expected[0].toolCallPositions, [position('first', 3), position('second', 4)]);
    });
}

test('incremental reconciliation includes full persisted timeline anchors after later text and tool updates', (t) => {
    const { sm, create } = fixture(t);
    const message = add(sm);
    sm.appendDelta(sessionId, message.id, '前');
    sm.setToolCall(sessionId, message.id, tool('first'));
    const lastSeq = message.seq;
    sm.appendDelta(sessionId, message.id, '后');
    sm.setToolCall(sessionId, message.id, tool('first', 'done'));
    finish(sm);
    const data = sm.getReconcileData(sessionId, lastSeq);
    assert.equal(data.messages.length, 1);
    assert.equal(data.messages[0].content, '前后');
    assert.deepEqual(data.messages[0].toolCallPositions, [position('first', 1)]);
    assert.ok(data.currentSeq > lastSeq);
    assert.deepEqual(create().getReconcileData(sessionId, lastSeq), data);
    assert.deepEqual(sm.getReconcileData(sessionId, data.currentSeq).messages, []);
});

test('legacy tool calls are anchored at zero before new tools and remain stable on updates', (t) => {
    const { sm, create } = fixture(t);
    const legacy = add(sm, 'legacy', { content: '旧正文', status: 'done', toolCalls: [tool('old-first'), tool('old-second')] });
    const loaded = create();
    const message = loaded.getOrCreateSession(sessionId).messages[0];
    assert.equal(message.toolCallPositions, undefined);
    loaded.setToolCall(sessionId, legacy.id, tool('new'));
    assert.deepEqual(message.toolCallPositions, [position('old-first', 0), position('old-second', 0), position('new', 3)]);
    loaded.appendDelta(sessionId, legacy.id, '新增正文');
    loaded.setToolCall(sessionId, legacy.id, tool('old-second', 'done'));
    finish(loaded, legacy.id);
    assert.deepEqual(message.toolCallPositions, [position('old-first', 0), position('old-second', 0), position('new', 3)]);
    assert.equal(message.toolCalls.length, 3);
    assert.deepEqual(create().getReconcileData(sessionId, 0).messages, [message]);
});

test('restart repair of an interrupted message preserves first-appearance anchors', (t) => {
    const { sm, create } = fixture(t);
    const message = add(sm);
    sm.setTaskState(sessionId, 'processing');
    sm.appendDelta(sessionId, message.id, '前😀');
    sm.setToolCall(sessionId, message.id, tool('first'));
    sm.appendDelta(sessionId, message.id, '后');
    sm.persistSession(sm.getOrCreateSession(sessionId));
    const lastSeq = message.seq;
    const replayed = create();
    const data = replayed.getReconcileData(sessionId, lastSeq);
    assert.equal(data.taskState, 'stopped');
    assert.equal(data.messages.length, 1);
    assert.equal(data.messages[0].status, 'error');
    assert.ok(data.messages[0].content.startsWith('前😀后'));
    assert.deepEqual(data.messages[0].toolCallPositions, [position('first', 3)]);
    assert.deepEqual(create().getReconcileData(sessionId, lastSeq), data);
});

test('a status-only update initializes all legacy tools at zero without adding a marker', (t) => {
    const { sm } = fixture(t);
    const message = add(sm, 'legacy', { content: '旧正文', toolCalls: [tool('old')] });
    sm.setToolCall(sessionId, message.id, tool('old', 'done'));
    sm.setToolCall(sessionId, message.id, tool('old', 'failed'));
    assert.deepEqual(message.toolCallPositions, [position('old', 0)]);
    assert.deepEqual(message.toolCalls, [tool('old', 'failed')]);
});
