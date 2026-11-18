import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import WebSocket from 'ws';
import { AcpEngineManager } from '../dist/acpEngineManager.js';
import { SessionManager } from '../dist/sessionManager.js';
import { MemoryManager } from '../dist/memoryManager.js';
import { LvtianServer } from '../dist/server.js';
import { TaskReportStore } from '../dist/nativeTaskReporting.js';

function fixture(t, onPrompt) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lvtian-report-acp-'));
    const sm = new SessionManager(path.join(root, 'data'));
    const mm = new MemoryManager(root);
    const store = new TaskReportStore(path.join(root, 'reports.sqlite'), 0);
    let newSessions = 0;
    const engine = new AcpEngineManager(root, mm, sm, {
        connectEngine: async app => {
            const mock = acp.agent({ name: 'report-contract-test' })
                .onRequest(acp.methods.agent.initialize, () => ({ protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: {} }))
                .onRequest(acp.methods.agent.authenticate, () => ({}))
                .onRequest(acp.methods.agent.session.new, () => ({ sessionId: `mock-report-session-${++newSessions}` }))
                .onRequest(acp.methods.agent.session.resume, c => ({ sessionId: c.params.sessionId }))
                .onRequest(acp.methods.agent.session.prompt, async c => {
                    const stopReason = await onPrompt(c, sm);
                    return { stopReason: stopReason ?? 'end_turn' };
                });
            let ready, stop;
            const contextReady = new Promise(resolve => { ready = resolve; });
            const stopSignal = new Promise(resolve => { stop = resolve; });
            const run = app.connectWith(mock, async context => { ready(context); await stopSignal; });
            const closed = run.catch(() => undefined);
            return { context: await contextReady, closed, close: async () => { stop(); await closed; } };
        },
    });
    const config = { port: 0, host: '127.0.0.1', token: 'fixture', workspace: root, dataDir: path.join(root, 'data'), assistantName: 'Fixture' };
    const server = new LvtianServer(config, sm, mm, engine);
    server.taskReportStore = store;
    t.after(async () => { await server.stop(); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
    return { sm, store, server, engine };
}
function enqueue(store, text) {
    const receipt = { messageId: 'delivery-ten-repos', deliveredAt: new Date().toISOString(), scheduledAt: new Date().toISOString() };
    store.observe('git-sync', '每日仓库同步', { taskId: 'git-sync', status: 'ended', endReason: 'completed', truncated: false, assistantText: [text], delivery: receipt });
    return store.next();
}
async function emit(c, text) {
    await c.client.notify(acp.methods.client.session.update, { sessionId: c.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } });
}

test('real ACP adapter receives every repository detail and buffers one complete report without refreshing user activity', async t => {
    const full = Array.from({ length: 10 }, (_, i) => `仓库${i + 1}：${i === 3 ? '失败，保留本地改动' : i === 7 ? '已提交并推送' : '同步成功'}；明细尾标-${i + 1}`).join('\n');
    let prompts = 0;
    const { sm, store, server } = fixture(t, async (c, sessions) => {
        prompts++;
        const input = c.params.prompt.filter(p => p.type === 'text').map(p => p.text).join('\n');
        assert.ok(input.includes('[后台任务结果交付（非用户指令）]'));
        assert.ok(input.includes('不重新执行业务任务'));
        for (let i = 1; i <= 10; i++) assert.ok(input.includes(`明细尾标-${i}`));
        assert.ok(input.includes('失败，保留本地改动'));
        assert.equal(sessions.getOrCreateSession('main').messages.length, 0);
        await emit(c, full.slice(0, 20));
        assert.equal(sessions.getOrCreateSession('main').messages.length, 0, 'partial report is not published');
        await emit(c, full.slice(20));
    });
    const activity = Date.now() - 600000;
    sm.recordActivity('main', activity);
    sm.setPendingBackground('main', '原有接力提要');
    assert.equal(await server.reportNativeTask(enqueue(store, full)), true);
    assert.equal(prompts, 1);
    assert.equal(sm.getLastActiveAt('main'), activity);
    const messages = sm.getOrCreateSession('main').messages;
    assert.equal(messages.length, 1);
    assert.equal(messages[0].role, 'assistant');
    assert.equal(messages[0].source, 'native_task_report');
    assert.equal(messages[0].content, full);
    const handoff = sm.getPendingBackground('main');
    assert.ok(handoff.startsWith('原有接力提要'));
    assert.ok(handoff.includes(full));
    assert.equal(store.next(), undefined);
});

for (const reason of ['cancelled', 'max_turn_requests', 'max_tokens', 'refusal']) {
    test(`real ACP ${reason} preserves exact reason and never publishes buffered partial report`, async t => {
        const { sm, store, server, engine } = fixture(t, async c => { await emit(c, '不能发布的半截报告'); return reason; });
        let terminal;
        const original = engine.execute.bind(engine);
        engine.execute = (session, id, prompt, callbacks, attachments, source) => original(session, id, prompt, {
            ...callbacks,
            onStatusChange: (status, payload) => { if (status !== 'thinking') terminal = { status, payload }; callbacks.onStatusChange(status, payload); },
        }, attachments, source);
        assert.equal(await server.reportNativeTask(enqueue(store, '完整原始结果')), false);
        assert.equal(terminal.status, 'error');
        assert.equal(terminal.payload.stopReason, reason);
        assert.equal(sm.getOrCreateSession('main').messages.length, 0);
        assert.equal(sm.getOrCreateSession('main').taskState, 'error');
        assert.equal(store.next(Date.now() + 600000), undefined, 'the failed report is held without resubmitting');
        assert.equal(store.known('delivery-ten-repos'), true);
    });
}

test('reconnected client sees processing round then terminal failure without buffered text', async t => {
    let entered;
    const promptEntered = new Promise(resolve => { entered = resolve; });
    let finish;
    const gate = new Promise(resolve => { finish = resolve; });
    const { sm, store, server } = fixture(t, async c => {
        await emit(c, '私有缓冲半截文本'); entered(); await gate; return 'cancelled';
    });
    await server.start();
    const reportDone = server.reportNativeTask(enqueue(store, '原始完整结果'));
    await promptEntered;
    const ws = new WebSocket(`ws://127.0.0.1:${server.httpServer.address().port}`);
    const messages = [];
    const waitFor = predicate => new Promise((resolve, reject) => {
        const timer = setTimeout(() => { ws.off('message', listener); reject(new Error('expected server state not received')); }, 3000);
        const listener = raw => { const message = JSON.parse(raw.toString()); if (predicate(message)) { clearTimeout(timer); ws.off('message', listener); resolve(message); } };
        ws.on('message', listener);
    });
    ws.on('message', raw => messages.push(JSON.parse(raw.toString())));
    t.after(() => ws.terminate());
    await new Promise(resolve => ws.once('open', resolve));
    const authenticated = waitFor(m => m.type === 'auth_result');
    ws.send(JSON.stringify({ type: 'auth', token: 'fixture' })); await authenticated;
    const synchronized = waitFor(m => m.type === 'sync_result');
    ws.send(JSON.stringify({ type: 'sync', sessionId: 'main', lastSeq: 0 }));
    assert.equal((await synchronized).taskState, 'processing');
    const failed = waitFor(m => m.type === 'task_status' && m.state === 'error');
    finish();
    assert.equal(await reportDone, false);
    assert.equal((await failed).sessionId, 'main');
    assert.equal(sm.getOrCreateSession('main').messages.length, 0);
    assert.equal(JSON.stringify(messages).includes('私有缓冲半截文本'), false);
});

test('a background-only session freezes its prior activity fallback rather than treating the report as new user input', async t => {
    const { sm, store, server } = fixture(t, async c => { await emit(c, '完整报告'); });
    const session = sm.getOrCreateSession('main');
    const before = session.updatedAt - 600000;
    session.updatedAt = before;
    assert.equal(session.lastActiveAt, undefined);
    assert.equal(await server.reportNativeTask(enqueue(store, '完整报告')), true);
    assert.equal(sm.getLastActiveAt('main'), before);
    assert.equal(sm.getOrCreateSession('main').messages.length, 1);
});

test('background initialization exceptions release the main ACP reservation for subsequent requests', async t => {
    const { sm, engine } = fixture(t, async c => { await emit(c, '后续请求可正常完成'); });
    const original = sm.recordActivity.bind(sm);
    sm.recordActivity = () => { throw new Error('injected_activity_failure'); };
    let status;
    try {
        await engine.execute('main', 'failed-background', '后台报告', { onDelta: () => {}, onToolCall: () => {}, onStatusChange: s => { status = s; } }, undefined, 'task_report');
    } finally { sm.recordActivity = original; }
    assert.equal(status, 'error');
    assert.equal(engine.isRunning('main'), false);
    let text = '';
    await engine.execute('main', 'next-background', '后台报告', { onDelta: d => { text += d; }, onToolCall: () => {}, onStatusChange: () => {} }, undefined, 'task_report');
    assert.equal(text, '后续请求可正常完成');
    assert.equal(engine.isRunning('main'), false);
});

function engineError(message) {
    return acp.RequestError.internalError(undefined, `turn failed: ${message}`);
}

test('context overflow retires the old report session and delivers once with preserved chat history', async t => {
    const sessions = [];
    const { sm, store, server } = fixture(t, async c => {
        sessions.push(c.params.sessionId);
        if (sessions.length === 1) throw engineError('pi-ai detected context overflow for model "gpt-6.1-sol"');
        assert.match(JSON.stringify(c.params.prompt), /上次聊天原文/);
        await emit(c, '收到完整后台结果');
    });
    sm.addMessage('main', { id: 'previous', role: 'user', content: '上次聊天原文', timestamp: Date.now(), status: 'sent' });
    sm.setUsage('main', 21945, 500000);
    const report = enqueue(store, '完整后台结果');
    assert.equal(await server.reportNativeTask(report), true, 'overflow advances the queue after scheduling one handoff');
    assert.equal(sm.isHandoffPending('main'), true);
    const cold = new SessionManager(server.config.dataDir);
    assert.equal(cold.getDshSessionId('main'), '');
    assert.equal(cold.isHandoffPending('main'), true);
    assert.equal(await server.reportNativeTask(store.next()), true);
    assert.equal(await server.reportNativeTask(report), true);
    assert.equal(new Set(sessions).size, 2);
    assert.equal(sessions.length, 2);
    assert.equal(sm.isHandoffPending('main'), false);
    assert.deepEqual(sm.getOrCreateSession('main').messages.map(m => m.content), ['上次聊天原文', '收到完整后台结果']);
    assert.equal(store.next(), undefined);
});

test('a second context overflow pauses the report and leaves later reports eligible', async t => {
    const sessions = [];
    const { store, server } = fixture(t, c => {
        sessions.push(c.params.sessionId);
        throw engineError('pi-ai detected context overflow for model "gpt-6.1-sol"');
    });
    const report = enqueue(store, '过大的结果');
    assert.equal(await server.reportNativeTask(report), true);
    assert.equal(await server.reportNativeTask(store.next()), false);
    const receipt = { messageId: 'later', deliveredAt: new Date().toISOString() };
    store.observe('task', '后续结果', { status: 'ended', assistantText: ['其他结果'], delivery: receipt });
    assert.equal(store.next(Date.now() + 86400000).id, 'later');
    assert.equal(new Set(sessions).size, 2);
});

for (const issue of ['Your authentication token has expired. Please try refreshing it.', 'Codex error: The usage limit has been reached']) {
    test(`report wait persists through ${issue} and recovery does not append twice to the old session`, async t => {
        const reportSessions = [];
        let userDone;
        const userFinished = new Promise(resolve => { userDone = resolve; });
        const { sm, store, server } = fixture(t, async c => {
            if (c.params.prompt.some(block => block.text === '检查主聊天')) {
                await emit(c, '主聊天已恢复');
                return;
            }
            reportSessions.push(c.params.sessionId);
            if (reportSessions.length === 1) throw engineError(issue);
            await emit(c, '后台报告补送成功');
        });
        server.broadcastSession = (_id, message) => {
            if (message.type === 'task_status' && message.state === 'completed') userDone();
        };
        assert.equal(await server.reportNativeTask(enqueue(store, '原始结果')), false);
        const later = Date.now() + 3 * 86400000;
        for (let days = 1; days <= 3; days++) assert.equal(store.next(Date.now() + days * 86400000), undefined);
        assert.equal(reportSessions.length, 1);
        server.executeAssistantPrompt('main', '检查主聊天');
        await userFinished;
        assert.equal(await server.reportNativeTask(store.next(later)), true, 'retire the old session without sending');
        assert.equal(reportSessions.length, 1);
        assert.equal(await server.reportNativeTask(store.next(later)), true);
        assert.equal(new Set(reportSessions).size, 2);
        assert.deepEqual(sm.getOrCreateSession('main').messages.map(m => m.content), ['主聊天已恢复', '后台报告补送成功']);
    });
}

test('user overflow prepares a new session without replaying the failed user request', async t => {
    const sessions = [];
    const { sm, engine } = fixture(t, async c => {
        sessions.push(c.params.sessionId);
        if (sessions.length === 1) throw engineError('Your input exceeds the context window of this model');
        await emit(c, '新会话成功');
    });
    let failure;
    const callbacks = { onDelta: () => {}, onToolCall: () => {}, onStatusChange: (_status, payload) => { failure = payload?.failure; } };
    await engine.execute('main', 'user-first', '之前的任务', callbacks);
    assert.equal(failure, 'context_overflow');
    assert.equal(sm.getDshSessionId('main'), '');
    assert.equal(sessions.length, 1);
    await engine.execute('main', 'user-next', '下一次用户请求', callbacks);
    assert.equal(new Set(sessions).size, 2);
    assert.equal(sm.isHandoffPending('main'), false);
});
