import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionManager } from '../dist/sessionManager.js';
import { TaskReportStore, reportMessageId } from '../dist/nativeTaskReporting.js';

function fixture(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvtian-report-barrier-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return { dir, sessions: new SessionManager(dir) };
}
function addReport(sessions, id = reportMessageId('delivery')) {
    return sessions.addMessage('main', { id, role: 'assistant', content: '10个仓库完整结果', timestamp: 123, completedAt: 124, status: 'done' });
}

test('report durability barrier survives cold load without duplicate messages or seq changes', (t) => {
    const { dir, sessions } = fixture(t);
    const message = addReport(sessions);
    const seq = sessions.getOrCreateSession('main').currentSeq;
    sessions.persistDurableMessage('main', message.id);
    sessions.persistDurableMessage('main', message.id);
    const restored = new SessionManager(dir).getOrCreateSession('main');
    assert.equal(restored.currentSeq, seq);
    assert.equal(restored.messages.length, 1);
    assert.equal(restored.messages[0].id, message.id);
    assert.equal(restored.messages[0].content, '10个仓库完整结果');
    assert.equal(restored.lastActiveAt, undefined);
});

test('durability barrier fsyncs actual message log before permitting outbox acknowledgement', (t) => {
    const { dir, sessions } = fixture(t);
    const store = new TaskReportStore(path.join(dir, 'native-tasks', 'reports.sqlite'), 0);
    t.after(() => store.close());
    const result = { taskId: 'task', status: 'ended', truncated: false, endReason: 'completed', assistantText: ['完整结果'], delivery: { messageId: 'delivery', scheduledAt: new Date(1000).toISOString(), deliveredAt: new Date(1001).toISOString() } };
    store.observe('task', '同步', result);
    store.generated('delivery', '10个仓库完整结果');
    const message = addReport(sessions);
    const original = fs.fsyncSync;
    let calls = 0;
    fs.fsyncSync = () => { calls++; throw new Error('injected_fsync_failure'); };
    try {
        assert.throws(() => {
            sessions.persistDurableMessage('main', message.id);
            store.delivered('delivery');
        }, /injected_fsync_failure/);
    } finally { fs.fsyncSync = original; }
    assert.ok(calls > 0);
    assert.equal(store.next().reply, '10个仓库完整结果');
    sessions.persistDurableMessage('main', message.id);
    store.delivered('delivery');
    assert.equal(store.next(), undefined);
    assert.equal(new SessionManager(dir).getOrCreateSession('main').messages.length, 1);
});

test('durability barrier explicitly rejects missing messages rather than acknowledging an absent report', (t) => {
    const { sessions } = fixture(t);
    assert.throws(() => sessions.persistDurableMessage('main', 'missing'), /report_message_not_persisted/);
});
