import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TaskReportStore, NativeTaskReporting, reportMessageId } from '../dist/nativeTaskReporting.js';
import { LvtianServer } from '../dist/server.js';
import { SessionManager } from '../dist/sessionManager.js';
import { MemoryManager } from '../dist/memoryManager.js';
import { ChatSyncPush } from '../dist/chatSyncPush.js';

function result(id = 'delivery-1', status = 'ended', deliveredAt = new Date().toISOString()) {
    return { taskId: 'task-1', status, delivery: { messageId: id, deliveredAt, scheduledAt: deliveredAt }, endReason: status === 'ended' ? 'completed' : undefined, assistantText: ['完整10仓明细'], truncated: false };
}
function fixture(t, execute) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lvtian-report-integration-'));
    const store = new TaskReportStore(path.join(root, 'reports.sqlite'), 0);
    const sm = new SessionManager(root);
    const engine = { isRunning: () => false, stopAll: async () => {}, stop: () => true, handleApproval: () => {}, execute };
    const server = new LvtianServer({ port: 0, host: '127.0.0.1', token: 'test', workspace: root, dataDir: root, assistantName: 'Test' }, sm, new MemoryManager(root), engine);
    server.taskReportStore = store;
    t.after(async () => { await server.stop(); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
    return { store, sm, server, engine };
}
function enqueue(store, id = 'delivery-1') { store.observe('task-1', 'Git同步', result(id)); return store.next(); }

test('offline report calls actual main agent with full input then publishes only assistant reply', async t => {
    let calls = 0;
    const { store, sm, server } = fixture(t, async (session, id, prompt, cb, attachments, source) => {
        calls++;
        assert.equal(session, 'main'); assert.equal(source, 'task_report'); assert.match(prompt, /完整10仓明细/);
        assert.equal(sm.getOrCreateSession('main').messages.length, 0);
        cb.onDelta('10仓完整同步报告'); cb.onStatusChange('done', { stopReason: 'end_turn' });
    });
    const report = enqueue(store);
    assert.equal(await server.reportNativeTask(report), true);
    const messages = sm.getOrCreateSession('main').messages;
    assert.equal(messages.length, 1); assert.equal(messages[0].role, 'assistant');
    assert.equal(messages[0].source, 'native_task_report'); assert.equal(messages[0].content, '10仓完整同步报告');
    assert.equal(store.next(), undefined); assert.equal(calls, 1);
    const cold = new SessionManager(server.config.dataDir);
    assert.equal(cold.getOrCreateSession('main').messages[0].id, reportMessageId(report.id));
});

test('task reports send a generic Android system notification to opted-in devices and wake sync independently', async t => {
    const { store, server } = fixture(t, async (_session, _id, _prompt, cb) => {
        cb.onDelta('私密任务汇报正文');
        cb.onStatusChange('done', { stopReason: 'end_turn' });
    });
    const requests = [];
    let finishNotification;
    const notificationSend = new Promise(resolve => { finishNotification = resolve; });
    const sender = { sendEachForMulticast: async message => {
        requests.push(message);
        if (message.notification) await notificationSend;
        return { responses: message.tokens.map(() => ({ success: true })), failureCount: 0 };
    } };
    const { dataDir } = server.config;
    server.chatSyncPush = new ChatSyncPush(dataDir, sender);
    await server.start();
    const url = `http://127.0.0.1:${server.httpServer.address().port}/api/chat/sync-device`;
    const register = body => fetch(url, {
        method: 'POST',
        headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const optedIn = 'test-fcm:opted-in-lvtian-token';
    const syncOnly = 'test-fcm:sync-only-lvtian-token';
    const routeId = 'ab'.repeat(16);
    const title = '绿天';
    const body = '你有一条新消息';
    const registration = await register({ token: optedIn, taskNotification: { routeId, language: 'zh' } });
    assert.equal(registration.status, 204);
    assert.equal(registration.headers.get('X-Lvtian-Task-Notification'), '1');
    assert.equal((await register({ token: syncOnly })).headers.get('X-Lvtian-Task-Notification'), null);
    server.chatSyncPush = new ChatSyncPush(dataDir, sender);
    try {
        const report = enqueue(store);
        assert.equal(await server.reportNativeTask(report), true);
        const messageId = reportMessageId(report.id);
        assert.equal(requests.length, 2);
        assert.deepEqual(requests[0].tokens, [optedIn]);
        assert.deepEqual(requests[0].notification, { title, body });
        assert.deepEqual(requests[0].data, { type: 'lvtian_task_report', messageId, routeId });
        assert.equal(requests[0].android.priority, 'high');
        assert.equal(requests[0].android.notification.tag, messageId);
        assert(!JSON.stringify(requests).includes('私密任务汇报正文'));
        assert.deepEqual(requests[1].tokens, [optedIn, syncOnly]);
        assert.deepEqual(JSON.parse(requests[1].data.messageIds), [messageId]);

        assert.equal((await register({ token: optedIn })).headers.get('X-Lvtian-Task-Notification'), null);
        assert.equal(await server.reportNativeTask(enqueue(store, 'next-delivery')), true);
        assert.equal(requests.length, 3);
        assert.equal(requests[2].notification, undefined);
    } finally {
        finishNotification();
    }
});

test('busy main and queued real user prevent any background acceptance', async t => {
    const { store, sm, server, engine } = fixture(t, async () => assert.fail('must not run'));
    const report = enqueue(store);
    engine.isRunning = () => true;
    assert.equal(await server.reportNativeTask(report), false); assert.equal(store.next().attempts, 0);
    engine.isRunning = () => false;
    sm.addMessage('main', { id: 'user', role: 'user', content: '当前工作', timestamp: Date.now(), status: 'queued' });
    assert.equal(await server.reportNativeTask(report), false); assert.equal(store.next().attempts, 0);
});

test('a client-created colliding message id cannot bypass actual agent reporting', async t => {
    const { store, sm, server } = fixture(t, async () => assert.fail('identity conflict must not execute'));
    const report = enqueue(store);
    sm.addMessage('main', { id: reportMessageId(report.id), role: 'user', content: 'spoof', timestamp: Date.now(), status: 'sent' });
    assert.equal(await server.reportNativeTask(report), false);
    assert.equal(store.next(Date.now() + 100000), undefined);
    assert.equal(store.known(report.id), true);
    assert.equal(sm.getOrCreateSession('main').messages.length, 1);
    assert.equal(sm.getOrCreateSession('main').messages[0].role, 'user');
});

test('generated reply survives publication failure and retries without another model call', async t => {
    let calls = 0;
    const { store, sm, server } = fixture(t, async (_s, _id, _p, cb) => { calls++; cb.onDelta('完整结果'); cb.onStatusChange('done', { stopReason: 'end_turn' }); });
    const report = enqueue(store);
    const persist = sm.persistDurableMessage.bind(sm);
    sm.persistDurableMessage = () => { throw new Error('disk failure'); };
    assert.equal(await server.reportNativeTask(report), false);
    assert.equal(store.next(Date.now() + 100000).reply, '完整结果');
    sm.persistDurableMessage = persist;
    assert.equal(await server.reportNativeTask(store.next(Date.now() + 100000)), true);
    assert.equal(calls, 1); assert.equal(sm.getOrCreateSession('main').messages.length, 1);
});

test('failed, empty and truncated main-agent outputs do not publish or claim delivered', async t => {
    let mode = 'error';
    const { store, sm, server } = fixture(t, async (_s, _id, _p, cb) => {
        cb.onDelta(mode === 'empty' ? '' : '半截');
        cb.onStatusChange(mode === 'error' ? 'error' : 'done', mode === 'truncated' ? { stopReason: 'max_tokens' } : undefined);
    });
    for (const nextMode of ['error', 'empty', 'truncated']) {
        mode = nextMode;
        const report = enqueue(store, nextMode);
        assert.equal(await server.reportNativeTask(report), false);
        assert.equal(sm.getOrCreateSession('main').messages.length, 0);
        // Acknowledge this test row before selecting the next variant.
        store.delivered(report.id);
    }
});

test('done without an explicit end_turn cannot acknowledge a report', async t => {
    const { store, sm, server } = fixture(t, async (_s, _id, _p, cb) => { cb.onDelta('半截'); cb.onStatusChange('done'); });
    assert.equal(await server.reportNativeTask(enqueue(store)), false);
    assert.equal(sm.getOrCreateSession('main').messages.length, 0);
    assert.equal(store.next(Date.now() + 600000).reply, undefined);
});

test('failure status reconciliation preserves a newer owner of main and never leaks buffered text', async t => {
    let currentOwner = false;
    const { store, sm, server, engine } = fixture(t, async (_s, _id, _p, cb) => {
        cb.onDelta('私有缓冲');
        currentOwner = true;
        sm.setTaskState('main', 'processing');
        throw new Error('previous reporting round failed');
    });
    engine.isRunning = () => currentOwner;
    const broadcasts = [];
    server.broadcastSession = (sessionId, message) => broadcasts.push({ sessionId, message });
    assert.equal(await server.reportNativeTask(enqueue(store)), false);
    assert.equal(sm.getOrCreateSession('main').taskState, 'processing');
    assert.equal(broadcasts.at(-1).message.type, 'task_status');
    assert.equal(broadcasts.at(-1).message.state, 'processing');
    assert.equal(JSON.stringify(broadcasts).includes('私有缓冲'), false);
});

test('report appends once to pre-generated handoff and repeats do not duplicate history', async t => {
    const { store, sm, server } = fixture(t, async (_s, _id, _p, cb) => { cb.onDelta('完整报告'); cb.onStatusChange('done', { stopReason: 'end_turn' }); });
    sm.setPendingBackground('main', '旧提要');
    const report = enqueue(store);
    assert.equal(await server.reportNativeTask(report), true);
    assert.match(sm.getPendingBackground('main'), /旧提要[\s\S]*完整报告/);
    assert.equal(await server.reportNativeTask(report), true);
    assert.equal(sm.getPendingBackground('main').match(/后台任务报告/g).length, 1);
    assert.equal(sm.getOrCreateSession('main').messages.length, 1);
});

test('stored outbox drains even when native catalog is offline', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lvtian-report-discovery-'));
    const store = new TaskReportStore(path.join(root, 'reports.sqlite'), 0);
    enqueue(store);
    let calls = 0;
    const reporting = new NativeTaskReporting({ store, service: { catalog: async () => { throw new Error('offline'); } }, report: async r => { calls++; store.delivered(r.id); return true; } });
    t.after(async () => { await reporting.stop(); fs.rmSync(root, { recursive: true, force: true }); });
    reporting.wake(); await reporting.running;
    assert.equal(calls, 1); assert.equal(store.next(), undefined);
});

test('broken task history does not block another owned task result', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lvtian-report-isolation-'));
    const store = new TaskReportStore(path.join(root, 'reports.sqlite'), 0);
    const reporting = new NativeTaskReporting({ store, service: {
        catalog: async () => [{ id: 'broken', title: 'broken' }, { id: 'task-1', title: 'good' }],
        history: async id => { if (id === 'broken') throw new Error('offline task'); return { records: [{ messageId: 'good' }] }; },
        getResult: async () => result('good'),
    }, report: async () => false });
    t.after(async () => { await reporting.stop(); fs.rmSync(root, { recursive: true, force: true }); });
    await reporting.reconcile();
    assert.equal(store.next().id, 'good');
});

test('shutdown aborts official watcher and waits admitted discovery before closing store', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lvtian-report-stop-'));
    const store = new TaskReportStore(path.join(root, 'reports.sqlite'), 0);
    let catalogEntered;
    const entered = new Promise(resolve => { catalogEntered = resolve; });
    let finishCatalog;
    const gate = new Promise(resolve => { finishCatalog = resolve; });
    let watcherAborted = false;
    const reporting = new NativeTaskReporting({ store, service: { catalog: async () => { catalogEntered(); await gate; return []; } },
        watchChanges: async (_cb, signal) => { await new Promise(resolve => signal.addEventListener('abort', () => { watcherAborted = true; resolve(); }, { once: true })); },
        report: async () => assert.fail('no reports'),
    });
    reporting.start(); await entered;
    let stopped = false;
    const stop = reporting.stop().then(() => { stopped = true; });
    await Promise.resolve();
    assert.equal(stopped, false); assert.equal(watcherAborted, true);
    finishCatalog(); await stop;
    assert.equal(stopped, true);
    fs.rmSync(root, { recursive: true, force: true });
});

test('delivery-specific reconciliation tracks earlier unfinished recurring run independently', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lvtian-report-recurring-'));
    const store = new TaskReportStore(path.join(root, 'reports.sqlite'), 0);
    const reads = [];
    const reporting = new NativeTaskReporting({ store, service: {
        catalog: async () => [{ id: 'task-1', title: 'daily' }],
        history: async () => ({ records: [{ messageId: 'later' }, { messageId: 'earlier' }] }),
        getResult: async (_taskId, messageId) => { reads.push(messageId); return result(messageId, messageId === 'earlier' && reads.length < 3 ? 'unknown' : 'ended'); },
    }, report: async () => false });
    t.after(async () => { await reporting.stop(); fs.rmSync(root, { recursive: true, force: true }); });
    await reporting.reconcile();
    assert.deepEqual(store.observing().map(r => r.id), ['earlier']);
    await reporting.reconcile();
    assert.equal(reads.filter(id => id === 'earlier').length, 2);
    assert.equal(store.observing().length, 0);
});

test('persistent frontier scans only new saved-order receipts including equal timestamps', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lvtian-report-frontier-'));
    const filename = path.join(root, 'reports.sqlite');
    let store = new TaskReportStore(filename, 0);
    const sameTime = '2026-11-25T00:00:00.000Z';
    let records = [{ messageId: 'old', deliveredAt: sameTime }];
    const reads = [];
    const service = {
        catalog: async () => [{ id: 'task-1', title: 'daily' }],
        history: async () => ({ records }),
        getResult: async (_taskId, messageId) => { reads.push(messageId); return result(messageId, 'ended', sameTime); },
    };
    let reporting = new NativeTaskReporting({ store, service, report: async () => false });
    await reporting.reconcile();
    assert.equal(store.scanFrontier('task-1'), 'old');
    await reporting.stop();

    store = new TaskReportStore(filename, 0);
    records = [{ messageId: 'new-2', deliveredAt: sameTime }, { messageId: 'new-1', deliveredAt: sameTime }, { messageId: 'old', deliveredAt: sameTime }];
    reporting = new NativeTaskReporting({ store, service, report: async () => false });
    t.after(async () => { await reporting.stop(); fs.rmSync(root, { recursive: true, force: true }); });
    await reporting.reconcile();
    assert.deepEqual(reads, ['old', 'new-1', 'new-2']);
    assert.equal(store.scanFrontier('task-1'), 'new-2');
    await reporting.reconcile();
    assert.deepEqual(reads, ['old', 'new-1', 'new-2']);
});

test('frontier crosses pages and is not committed before every new receipt is durable', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lvtian-report-frontier-retry-'));
    const filename = path.join(root, 'reports.sqlite');
    let store = new TaskReportStore(filename, 0);
    let phase = 'seed';
    let fail = true;
    const calls = [];
    const service = {
        catalog: async () => [{ id: 'task-1', title: 'daily' }],
        history: async (_id, options) => {
            calls.push(['history', options.before]);
            if (phase === 'seed') return { records: [{ messageId: 'old' }] };
            return options.before
                ? { records: [{ messageId: 'new-1' }, { messageId: 'old' }] }
                : { records: [{ messageId: 'new-2' }], nextBefore: 'new-2' };
        },
        getResult: async (_taskId, messageId) => {
            calls.push(['result', messageId]);
            if (messageId === 'new-1' && fail) throw new Error('temporary disconnect');
            return result(messageId);
        },
    };
    let reporting = new NativeTaskReporting({ store, service, report: async () => false });
    await reporting.reconcile();
    assert.equal(store.scanFrontier('task-1'), 'old');
    phase = 'new';
    await reporting.reconcile();
    assert.equal(store.scanFrontier('task-1'), 'old');
    await reporting.stop();

    fail = false;
    store = new TaskReportStore(filename, 0);
    reporting = new NativeTaskReporting({ store, service, report: async () => false });
    t.after(async () => { await reporting.stop(); fs.rmSync(root, { recursive: true, force: true }); });
    await reporting.reconcile();
    assert.equal(store.scanFrontier('task-1'), 'new-2');
    assert.ok(store.known('new-1'));
    assert.ok(store.known('new-2'));
    const before = calls.length;
    await reporting.reconcile();
    assert.deepEqual(calls.slice(before), [['history', undefined]]);
});

test('a pruned frontier rebuilds from the complete retained history window', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lvtian-report-pruned-frontier-'));
    const store = new TaskReportStore(path.join(root, 'reports.sqlite'), 0);
    store.commitScanFrontier('task-1', 'pruned');
    const reads = [];
    const reporting = new NativeTaskReporting({ store, service: {
        catalog: async () => [{ id: 'task-1', title: 'daily' }],
        history: async (_id, options) => options.before
            ? { records: [{ messageId: 'retained-1' }] }
            : { records: [{ messageId: 'retained-2' }], nextBefore: 'retained-2' },
        getResult: async (_taskId, messageId) => { reads.push(messageId); return result(messageId); },
    }, report: async () => false });
    t.after(async () => { await reporting.stop(); fs.rmSync(root, { recursive: true, force: true }); });

    await reporting.reconcile();
    assert.deepEqual(reads, ['retained-1', 'retained-2']);
    assert.equal(store.scanFrontier('task-1'), 'retained-2');
    await reporting.reconcile();
    assert.deepEqual(reads, ['retained-1', 'retained-2']);
});

test('persisted inbox receipt is observed without replay and reports only after real turn end', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lvtian-report-queued-receipt-'));
    const filename = path.join(root, 'reports.sqlite');
    let store = new TaskReportStore(filename, 0);
    let ended = false;
    let resultReads = 0;
    const service = {
        catalog: async () => [{ id: 'task-1', title: 'side effect task' }],
        history: async () => ({ records: [{ messageId: 'receipt' }] }),
        getResult: async () => { resultReads++; return result('receipt', ended ? 'ended' : 'unknown'); },
    };
    let reporting = new NativeTaskReporting({ store, service, report: async () => assert.fail('queued receipt is not completion') });
    await reporting.reconcile();
    assert.equal(store.scanFrontier('task-1'), 'receipt');
    assert.deepEqual(store.observing().map(row => row.id), ['receipt']);
    assert.equal(store.next(), undefined);
    await reporting.stop();

    ended = true;
    store = new TaskReportStore(filename, 0);
    reporting = new NativeTaskReporting({ store, service, report: async () => false });
    t.after(async () => { await reporting.stop(); fs.rmSync(root, { recursive: true, force: true }); });
    await reporting.reconcile();
    assert.equal(store.next().id, 'receipt');
    assert.equal(resultReads, 2);
});
