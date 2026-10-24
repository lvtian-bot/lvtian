import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { AcpEngineManager } from '../dist/acpEngineManager.js';
import { MemoryManager } from '../dist/memoryManager.js';
import { SessionManager } from '../dist/sessionManager.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 进程内模拟引擎（仅用 SDK 公开 API，不依赖真实 dsh、模型与 API Key）。
 * 行为契约：prompt → chunkCount 个文本增量 →（可选）一次审批请求 → 终态 end_turn；
 * 不注册 session/resume，用于覆盖「旧会话 ID 恢复失败自动新建」路径。
 */
function createMockEngineApp(options = {}) {
    /** 引擎侧会话登记：模拟 dsh-acp 的会话持久化，跨连接存活，已知 ID 可 resume */
    const knownSessions = options.sessionStore ?? new Set();
    return acp.agent({ name: 'mock-engine' })
        .onRequest(acp.methods.agent.initialize, () => ({
            protocolVersion: acp.PROTOCOL_VERSION,
            agentCapabilities: {},
        }))
        .onRequest(acp.methods.agent.authenticate, () => ({}))
        .onRequest(acp.methods.agent.session.new, () => {
            const sessionId = globalThis.crypto.randomUUID();
            knownSessions.add(sessionId);
            return { sessionId };
        })
        .onRequest(acp.methods.agent.session.resume, (c) => {
            if (!knownSessions.has(c.params.sessionId)) {
                throw new acp.RequestError('session not found', -32002);
            }
            return { sessionId: c.params.sessionId };
        })
        .onRequest(acp.methods.agent.session.prompt, async (c) => {
            const sessionId = c.params.sessionId;
            for (let i = 0; i < (options.chunkCount ?? 1); i++) {
                if (options.chunkDelayMs) await delay(options.chunkDelayMs);
                await c.client.notify(acp.methods.client.session.update, {
                    sessionId,
                    update: {
                        sessionUpdate: 'agent_message_chunk',
                        content: { type: 'text', text: `chunk-${i + 1}` },
                    },
                });
            }
            if (options.enablePermission) {
                const permission = await c.client.request(acp.methods.client.session.requestPermission, {
                    sessionId,
                    toolCall: { toolCallId: 'permission-tool', title: 'Permission tool', kind: 'shell' },
                    options: [
                        { kind: 'allow_once', name: 'Allow once', optionId: 'allow' },
                        { kind: 'reject_once', name: 'Reject once', optionId: 'reject' },
                    ],
                });
                const text = permission.outcome.outcome === 'selected'
                    ? `permission-selected-${permission.outcome.optionId}`
                    : 'permission-cancelled';
                await c.client.notify(acp.methods.client.session.update, {
                    sessionId,
                    update: {
                        sessionUpdate: 'agent_message_chunk',
                        content: { type: 'text', text },
                    },
                });
            }
            return { stopReason: 'end_turn' };
        })
        .onNotification(acp.methods.agent.session.cancel, () => {});
}

/**
 * 构造接入模拟引擎的 AcpEngineManager
 */
function buildManager(agentOptions = {}, managerOptions = {}) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lvtian-acp-test-'));
    const memoryManager = new MemoryManager(tmp);
    const sessionManager = new SessionManager(path.join(tmp, 'data'));
    /** 引擎侧会话存储：跨连接共享，模拟 dsh-acp 的会话持久化 */
    const sessionStore = new Set();

    const connectEngine = async (app) => {
        const engineApp = createMockEngineApp({ ...agentOptions, sessionStore });
        let resolveContext;
        let resolveStop;
        const contextReady = new Promise((resolve) => { resolveContext = resolve; });
        const stopSignal = new Promise((resolve) => { resolveStop = resolve; });
        const run = app.connectWith(engineApp, async (ctx) => {
            resolveContext(ctx);
            await stopSignal;
        });
        const closed = run.catch(() => undefined);
        return {
            context: await contextReady,
            closed,
            close: async () => {
                resolveStop();
                await closed;
            },
        };
    };

    const manager = new AcpEngineManager(tmp, memoryManager, sessionManager, {
        connectEngine,
        ...managerOptions,
    });
    return { manager, sessionManager, memoryManager, tmp };
}

function collectCallbacks(sink) {
    return {
        onDelta: (delta) => sink.push({ kind: 'delta', delta }),
        onToolCall: (toolCall) => sink.push({ kind: 'tool', toolCall }),
        onApprovalRequest: (request) => sink.push({ kind: 'approval', request }),
        onStatusChange: (status, error) => sink.push({ kind: 'status', status, error }),
    };
}

const deltas = (events) => events.filter((e) => e.kind === 'delta').map((e) => e.delta).join('');
const lastStatus = (events) => [...events].reverse().find((e) => e.kind === 'status')?.status;

test('任务执行：文本增量聚合、终态 completed、引擎会话绑定持久化', async () => {
    const { manager, sessionManager } = buildManager({ chunkCount: 3 });
    const events = [];
    await manager.execute('main', 'asst-1', '你好', collectCallbacks(events));

    assert.strictEqual(deltas(events), 'chunk-1chunk-2chunk-3');
    assert.strictEqual(lastStatus(events), 'done');
    assert.strictEqual(sessionManager.getOrCreateSession('main').taskState, 'completed');
    assert.ok(sessionManager.getDshSessionId('main'), '应持久化引擎侧会话 ID');
});

test('审批允许：请求转发客户端，应答后任务继续并完成', async () => {
    const { manager } = buildManager({ chunkCount: 1, enablePermission: true });
    const events = [];
    const executing = manager.execute('main', 'asst-1', '执行操作', collectCallbacks(events));

    // 审批请求到达后应答允许（轮询等待 approval 事件，模拟客户端异步确认）
    const approval = await new Promise((resolve) => {
        const timer = setInterval(() => {
            const found = events.find((e) => e.kind === 'approval');
            if (found) { clearInterval(timer); resolve(found.request); }
        }, 10);
    });
    assert.ok(approval.approvalId, '审批请求应带 ID');
    assert.strictEqual(manager.handleApproval('main', approval.approvalId, true), true);
    await executing;

    assert.ok(deltas(events).includes('permission-selected-allow'), '应选中允许选项');
    assert.strictEqual(lastStatus(events), 'done');
});

test('审批拒绝：应答拒绝后引擎收到拒绝选项', async () => {
    const { manager } = buildManager({ chunkCount: 1, enablePermission: true });
    const events = [];
    const executing = manager.execute('main', 'asst-1', '执行操作', collectCallbacks(events));

    const approval = await new Promise((resolve) => {
        const timer = setInterval(() => {
            const found = events.find((e) => e.kind === 'approval');
            if (found) { clearInterval(timer); resolve(found.request); }
        }, 10);
    });
    manager.handleApproval('main', approval.approvalId, false);
    await executing;

    assert.ok(deltas(events).includes('permission-selected-reject'), '应选中拒绝选项');
});

test('审批超时：自动拒绝并终态为 stopped，消息标注终止原因', async () => {
    const { manager, sessionManager } = buildManager(
        { chunkCount: 1, enablePermission: true },
        { approvalTimeoutMs: 100 }
    );
    const events = [];
    sessionManager.addMessage('main', { id: 'asst-1', role: 'assistant', content: '', timestamp: Date.now(), status: 'processing' });
    await manager.execute('main', 'asst-1', '执行操作', collectCallbacks(events));

    const session = sessionManager.getOrCreateSession('main');
    assert.strictEqual(session.taskState, 'stopped', '超时后终态应为 stopped 而非被 end_turn 覆盖');
    const msg = session.messages.find((m) => m.id === 'asst-1');
    assert.strictEqual(msg.status, 'error');
    assert.match(msg.errorMessage, /审批超时/);
});

test('手动停止：消息标错、任务终态 stopped', async () => {
    const { manager, sessionManager } = buildManager({ chunkCount: 2, chunkDelayMs: 150 });
    const events = [];
    sessionManager.addMessage('main', { id: 'asst-1', role: 'assistant', content: '', timestamp: Date.now(), status: 'processing' });
    const executing = manager.execute('main', 'asst-1', '长任务', collectCallbacks(events));

    await new Promise((resolve) => setTimeout(resolve, 100)); // 等任务进入执行中
    assert.strictEqual(manager.isRunning('main'), true);
    manager.stop('main');
    await executing;

    const session = sessionManager.getOrCreateSession('main');
    assert.strictEqual(session.taskState, 'stopped');
    const msg = session.messages.find((m) => m.id === 'asst-1');
    assert.strictEqual(msg.status, 'error');
    assert.match(msg.errorMessage, /手动终止/);
});

test('会话恢复失败时自动新建并更新绑定（旧 ID 不通用场景）', async () => {
    const { manager, sessionManager } = buildManager({ chunkCount: 1 });
    sessionManager.setDshSessionId('main', 'legacy-headless-id');
    const events = [];
    await manager.execute('main', 'asst-1', '继续', collectCallbacks(events));

    assert.strictEqual(lastStatus(events), 'done');
    const newId = sessionManager.getDshSessionId('main');
    assert.notStrictEqual(newId, 'legacy-headless-id', '绑定应替换为新引擎会话 ID');
});

test('同一连接内多轮直接复用会话，不新建', async () => {
    const { manager, sessionManager } = buildManager({ chunkCount: 1 });
    const events1 = [];
    await manager.execute('main', 'asst-1', '第一轮', collectCallbacks(events1));
    const firstId = sessionManager.getDshSessionId('main');

    const events2 = [];
    await manager.execute('main', 'asst-2', '第二轮', collectCallbacks(events2));

    assert.strictEqual(sessionManager.getDshSessionId('main'), firstId, '同连接应保持绑定不变');
    assert.strictEqual(lastStatus(events2), 'done');
});

test('引擎重连后通过 resume 恢复既有会话，不新建', async () => {
    const { manager, sessionManager } = buildManager({ chunkCount: 1 });
    const events1 = [];
    await manager.execute('main', 'asst-1', '第一轮', collectCallbacks(events1));
    const firstId = sessionManager.getDshSessionId('main');
    await manager.stopAll();

    const events2 = [];
    await manager.execute('main', 'asst-2', '重连后的第一轮', collectCallbacks(events2));

    assert.strictEqual(
        sessionManager.getDshSessionId('main'),
        firstId,
        '重连后应 resume 恢复原会话而非新建'
    );
    assert.strictEqual(lastStatus(events2), 'done');
});

test('stopAll 后可再次执行（引擎随下次请求懒重启）', async () => {
    const { manager } = buildManager({ chunkCount: 1 });
    const events1 = [];
    await manager.execute('main', 'asst-1', '第一轮', collectCallbacks(events1));
    await manager.stopAll();
    assert.strictEqual(manager.isRunning('main'), false);

    const events2 = [];
    await manager.execute('main', 'asst-2', '重启后的第一轮', collectCallbacks(events2));
    assert.strictEqual(lastStatus(events2), 'done', '懒重启后应能正常执行新任务');
});
