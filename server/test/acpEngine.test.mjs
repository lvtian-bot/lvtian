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
    /** 引擎侧会话登记：跨连接持久（模拟 dsh-acp 会话存储），已知 ID 可 resume */
    const knownSessions = options.sessionStore ?? new Set();
    /** 本连接内活跃的会话：同一连接 new/resume 过才允许 prompt，模拟真实引擎的会话校验 */
    const activeOnConnection = new Set();
    return acp.agent({ name: 'mock-engine' })
        .onRequest(acp.methods.agent.initialize, () => ({
            protocolVersion: acp.PROTOCOL_VERSION,
            agentCapabilities: {},
        }))
        .onRequest(acp.methods.agent.authenticate, () => ({}))
        .onRequest(acp.methods.agent.session.new, () => {
            const sessionId = globalThis.crypto.randomUUID();
            knownSessions.add(sessionId);
            activeOnConnection.add(sessionId);
            return { sessionId };
        })
        .onRequest(acp.methods.agent.session.resume, (c) => {
            if (!knownSessions.has(c.params.sessionId)) {
                throw new acp.RequestError(-32002, 'session not found');
            }
            activeOnConnection.add(c.params.sessionId);
            return { sessionId: c.params.sessionId };
        })
        .onRequest(acp.methods.agent.session.prompt, async (c) => {
            const sessionId = c.params.sessionId;
            if (!activeOnConnection.has(sessionId)) {
                throw new acp.RequestError(-32002, 'session not active on this connection');
            }
            options.promptLog?.push(sessionId);
            const notify = (update) =>
                c.client.notify(acp.methods.client.session.update, { sessionId, update });
            if (options.emitFailedTool) {
                await notify({
                    sessionUpdate: 'tool_call',
                    toolCallId: 'tool-fail',
                    title: 'Failing tool',
                    kind: 'shell',
                    status: 'in_progress',
                });
                await notify({
                    sessionUpdate: 'tool_call_update',
                    toolCallId: 'tool-fail',
                    status: 'failed',
                });
            }
            if (options.toolThenReject) {
                await notify({
                    sessionUpdate: 'tool_call',
                    toolCallId: 'tool-crash',
                    title: 'Crashing tool',
                    kind: 'shell',
                    status: 'in_progress',
                });
                throw new Error('engine boom');
            }
            for (let i = 0; i < (options.chunkCount ?? 1); i++) {
                if (options.chunkDelayMs) await delay(options.chunkDelayMs);
                await notify({
                    sessionUpdate: 'agent_message_chunk',
                    content: { type: 'text', text: `chunk-${i + 1}` },
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
        if (agentOptions.engineStartDelayMs) {
            await delay(agentOptions.engineStartDelayMs);
        }
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
    assert.strictEqual(lastStatus(events), 'stopped', '超时应经回调广播终态而非仅改持久化');
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

test('引擎启动期间手动停止：不发送 prompt，消息与任务同步终态化', async () => {
    const promptLog = [];
    const { manager, sessionManager } = buildManager({ chunkCount: 1, engineStartDelayMs: 200, promptLog });
    const events = [];
    sessionManager.addMessage('main', { id: 'asst-1', role: 'assistant', content: '', timestamp: Date.now(), status: 'processing' });
    const executing = manager.execute('main', 'asst-1', '长任务', collectCallbacks(events));

    await delay(50); // execute 已受理但引擎仍在启动（并发预留窗口）
    assert.strictEqual(manager.isRunning('main'), true);
    assert.strictEqual(manager.stop('main'), true, '启动窗口内 stop 应被受理');
    await executing;

    const session = sessionManager.getOrCreateSession('main');
    assert.strictEqual(session.taskState, 'stopped');
    const msg = session.messages.find((m) => m.id === 'asst-1');
    assert.strictEqual(msg.status, 'error', '占位消息应随停止立即终态化而非停留处理中');
    assert.match(msg.errorMessage, /手动终止/);
    assert.strictEqual(promptLog.length, 0, '停止后不应向引擎发送 prompt');
});

test('引擎启动期间 stopAll：等待启动完成并关闭连接，不留进行中任务', async () => {
    const promptLog = [];
    const { manager, sessionManager } = buildManager({ chunkCount: 1, engineStartDelayMs: 200, promptLog });
    const events = [];
    sessionManager.addMessage('main', { id: 'asst-1', role: 'assistant', content: '', timestamp: Date.now(), status: 'processing' });
    const executing = manager.execute('main', 'asst-1', '长任务', collectCallbacks(events));

    await delay(50); // 引擎仍在启动中执行关停
    await manager.stopAll();
    await executing;

    assert.strictEqual(sessionManager.getOrCreateSession('main').taskState, 'stopped');
    assert.strictEqual(promptLog.length, 0, '关停后不应向引擎发送 prompt');
    assert.strictEqual(manager.isRunning('main'), false);

    // 关停已等待启动完成并关闭连接：下次请求走全新连接，行为正常
    const events2 = [];
    await manager.execute('main', 'asst-2', '关停后的新任务', collectCallbacks(events2));
    assert.strictEqual(lastStatus(events2), 'done');
});

test('引擎异常退出时进行中的工具终态化为失败', async () => {
    const { manager, sessionManager } = buildManager({ toolThenReject: true });
    const events = [];
    sessionManager.addMessage('main', { id: 'asst-1', role: 'assistant', content: '', timestamp: Date.now(), status: 'processing' });
    await manager.execute('main', 'asst-1', '触发引擎异常', collectCallbacks(events));

    const toolStatuses = events.filter((e) => e.kind === 'tool').map((e) => e.toolCall.status);
    assert.deepStrictEqual(toolStatuses, ['running', 'failed'], '异常路径工具应终态化为失败而非停留运行中');
    assert.strictEqual(lastStatus(events), 'error');
});

test('停止后到达的引擎迟到事件不回写消息状态', async () => {
    const { manager, sessionManager } = buildManager({ chunkCount: 2, chunkDelayMs: 150 });
    const events = [];
    sessionManager.addMessage('main', { id: 'asst-1', role: 'assistant', content: '', timestamp: Date.now(), status: 'processing' });
    const executing = manager.execute('main', 'asst-1', '长任务', collectCallbacks(events));

    await new Promise((resolve) => setTimeout(resolve, 200)); // 第一个 chunk 已到，第二个在途
    manager.stop('main');
    await executing; // mock 引擎无取消感知，停止后仍会发出第二个 chunk 事件

    const session = sessionManager.getOrCreateSession('main');
    const msg = session.messages.find((m) => m.id === 'asst-1');
    assert.strictEqual(msg.status, 'error', '消息应保持停止终态');
    assert.strictEqual(deltas(events), 'chunk-1', '停止后的迟到文本事件应被忽略');
    assert.strictEqual(session.taskState, 'stopped');
});

test('停止后到达的迟到审批请求被直接拒绝，不弹审批卡', async () => {
    const { manager, sessionManager } = buildManager({ chunkCount: 1, chunkDelayMs: 200, enablePermission: true });
    const events = [];
    sessionManager.addMessage('main', { id: 'asst-1', role: 'assistant', content: '', timestamp: Date.now(), status: 'processing' });
    const executing = manager.execute('main', 'asst-1', '长任务', collectCallbacks(events));

    await new Promise((resolve) => setTimeout(resolve, 100)); // chunk 尚未发出，任务执行中
    manager.stop('main');
    await executing; // mock 引擎无取消感知，继续发 chunk 与审批请求

    assert.strictEqual(events.filter((e) => e.kind === 'approval').length, 0, '迟到审批不应转发为审批卡');
    const session = sessionManager.getOrCreateSession('main');
    assert.strictEqual(session.taskState, 'stopped', '任务应保持停止而非回到等待审批');
    assert.strictEqual(session.pendingApproval, undefined, '不应登记待审批项');
});

test('工具失败时终态为 failed，且不被后续事件覆盖为成功', async () => {
    const { manager } = buildManager({ chunkCount: 1, emitFailedTool: true });
    const events = [];
    await manager.execute('main', 'asst-1', '执行会失败的操作', collectCallbacks(events));

    const toolStatuses = events.filter((e) => e.kind === 'tool').map((e) => e.toolCall.status);
    assert.deepStrictEqual(toolStatuses, ['running', 'failed'], '失败终态应保留且无后续覆盖');
    assert.strictEqual(lastStatus(events), 'done');
});

test('引擎子进程启动失败时走错误终态，服务端不崩溃', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lvtian-acp-spawn-'));
    const memoryManager = new MemoryManager(tmp);
    const sessionManager = new SessionManager(path.join(tmp, 'data'));
    // 不注入连接工厂：走真实 spawn 路径，工作区目录不存在触发子进程 error 事件
    const manager = new AcpEngineManager(path.join(tmp, 'no-such-workspace'), memoryManager, sessionManager);

    const events = [];
    sessionManager.addMessage('main', { id: 'asst-1', role: 'assistant', content: '', timestamp: Date.now(), status: 'processing' });
    await manager.execute('main', 'asst-1', '你好', collectCallbacks(events));

    assert.strictEqual(sessionManager.getOrCreateSession('main').taskState, 'error');
    assert.strictEqual(lastStatus(events), 'error');
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
