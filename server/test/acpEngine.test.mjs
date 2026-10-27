import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { AcpEngineManager, formatToolDetails, extractToolOutput } from '../dist/acpEngineManager.js';
import { MemoryManager } from '../dist/memoryManager.js';
import { SessionManager } from '../dist/sessionManager.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function keepEventLoopAlive(t) {
    // 进程内 mock 没有真实服务端的 socket；让 unref 的回收/看门狗计时器有机会触发。
    // 长于测试的 3s 超时，并在成功、失败或取消时由测试清理，避免掩盖挂死。
    const keepAlive = setTimeout(() => {}, 5000);
    t.after(() => clearTimeout(keepAlive));
}

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
            if (options.promptNeverEnds) {
                // 引擎卡死：发出首个增量后永不结束当前轮（对取消通知也无响应）
                await notify({
                    sessionUpdate: 'agent_message_chunk',
                    content: { type: 'text', text: 'stuck' },
                });
                await new Promise(() => {});
            }
            if (options.doublePermission) {
                // 同一会话并发两个审批请求（模拟重叠工具各自请求审批）
                const askPermission = (toolCallId) => c.client.request(acp.methods.client.session.requestPermission, {
                    sessionId,
                    toolCall: { toolCallId, title: `Permission ${toolCallId}`, kind: 'shell' },
                    options: [
                        { kind: 'allow_once', name: 'Allow once', optionId: 'allow' },
                        { kind: 'reject_once', name: 'Reject once', optionId: 'reject' },
                    ],
                });
                const [p1, p2] = await Promise.all([askPermission('perm-a'), askPermission('perm-b')]);
                options.permissionOutcomeLog?.push(`${p1.outcome.outcome}|${p2.outcome.outcome}`);
                await notify({
                    sessionUpdate: 'agent_message_chunk',
                    content: { type: 'text', text: `double-${p1.outcome.outcome}-${p2.outcome.outcome}` },
                });
                return { stopReason: 'end_turn' };
            }
            if (options.toolInitialFailed) {
                // 初始通知直接携带失败终态（无后续 update）
                await notify({
                    sessionUpdate: 'tool_call',
                    toolCallId: 'tool-init-failed',
                    title: 'Initially failed tool',
                    kind: 'shell',
                    status: 'failed',
                });
            }
            if (options.overlappingTools) {
                // 协议允许的重叠工具：A 启动后 B 启动，随后 A 才回报失败
                await notify({
                    sessionUpdate: 'tool_call',
                    toolCallId: 'tool-a',
                    title: 'Tool A',
                    kind: 'shell',
                    status: 'in_progress',
                });
                await notify({
                    sessionUpdate: 'tool_call',
                    toolCallId: 'tool-b',
                    title: 'Tool B',
                    kind: 'shell',
                    status: 'in_progress',
                });
                await notify({
                    sessionUpdate: 'tool_call_update',
                    toolCallId: 'tool-a',
                    status: 'failed',
                });
                return { stopReason: 'end_turn' };
            }
            if (options.toolRunningMs) {
                // 工具长时间运行后以正常响应结束当前轮（模拟引擎对 cancel 无感知、正常收尾）
                await notify({
                    sessionUpdate: 'tool_call',
                    toolCallId: 'tool-running',
                    title: 'Long running tool',
                    kind: 'shell',
                    status: 'in_progress',
                });
                await delay(options.toolRunningMs);
                return { stopReason: 'end_turn' };
            }
            for (let i = 0; i < (options.chunkCount ?? 1); i++) {
                if (options.chunkDelayMs) await delay(options.chunkDelayMs);
                await notify({
                    sessionUpdate: 'agent_message_chunk',
                    content: { type: 'text', text: `chunk-${i + 1}` },
                });
            }
            if (options.enablePermission) {
                // allowAlwaysFirst 模拟引擎把持久授权排在最前的选项顺序
                const permissionOptions = options.allowAlwaysFirst
                    ? [
                        { kind: 'allow_always', name: 'Always allow', optionId: 'allow-always' },
                        { kind: 'allow_once', name: 'Allow once', optionId: 'allow' },
                        { kind: 'reject_once', name: 'Reject once', optionId: 'reject' },
                    ]
                    : [
                        { kind: 'allow_once', name: 'Allow once', optionId: 'allow' },
                        { kind: 'reject_once', name: 'Reject once', optionId: 'reject' },
                    ];
                const permission = await c.client.request(acp.methods.client.session.requestPermission, {
                    sessionId,
                    toolCall: { toolCallId: 'permission-tool', title: 'Permission tool', kind: 'shell' },
                    options: permissionOptions,
                });
                if (options.hangOnPermissionTimeout && permission.outcome.outcome === 'cancelled') {
                    // 审批被超时取消后引擎对收尾无响应（病态挂死），验证停止回收兜底
                    await new Promise(() => {});
                }
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
            return { stopReason: options.stopReason ?? 'end_turn' };
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

    let connectionCount = 0;
    const connectEngine = async (app) => {
        if (agentOptions.engineStartDelayMs) {
            await delay(agentOptions.engineStartDelayMs);
        }
        connectionCount++;
        const engineOptions = { ...agentOptions, sessionStore };
        // promptNeverEnds / hangOnPermissionTimeout 只让首个引擎卡死（复现无响应），
        // 懒重启后的新引擎须正常应答（含跳过审批路径）以验证会话可恢复
        if (connectionCount > 1) {
            delete engineOptions.promptNeverEnds;
            delete engineOptions.hangOnPermissionTimeout;
            delete engineOptions.enablePermission;
        }
        const engineApp = createMockEngineApp(engineOptions);
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
        onStatusChange: (status, payload) => sink.push({ kind: 'status', status, payload }),
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
    assert.strictEqual(msg.errorMessage, 'approval_timeout', '持久化的应为稳定错误码而非固定语言文案');
    const stoppedEvent = events.find((e) => e.kind === 'status' && e.status === 'stopped');
    assert.strictEqual(stoppedEvent?.payload?.code, 'approval_timeout', '超时应经回调广播结构化终态而非仅改持久化');
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
    assert.strictEqual(msg.errorMessage, 'task_stopped');
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
    assert.strictEqual(msg.errorMessage, 'task_stopped');
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
    assert.strictEqual(session.pendingApprovals.length, 0, '不应登记待审批项');
});

test('工具失败时终态为 failed，且不被后续事件覆盖为成功', async () => {
    const { manager } = buildManager({ chunkCount: 1, emitFailedTool: true });
    const events = [];
    await manager.execute('main', 'asst-1', '执行会失败的操作', collectCallbacks(events));

    const toolStatuses = events.filter((e) => e.kind === 'tool').map((e) => e.toolCall.status);
    assert.deepStrictEqual(toolStatuses, ['running', 'failed'], '失败终态应保留且无后续覆盖');
    assert.strictEqual(lastStatus(events), 'done');
});

test('初始状态落盘失败时不锁死会话，后续消息可继续执行', async () => {
    const { manager, sessionManager } = buildManager({ chunkCount: 1 });
    const originalSetTaskState = sessionManager.setTaskState.bind(sessionManager);
    let failOnce = true;
    sessionManager.setTaskState = (sessionId, state) => {
        if (failOnce) {
            failOnce = false;
            throw new Error('disk full');
        }
        return originalSetTaskState(sessionId, state);
    };

    const events1 = [];
    await manager.execute('main', 'asst-1', '你好', collectCallbacks(events1));

    assert.strictEqual(manager.isRunning('main'), false, '失败的请求不应永久占用会话预留');
    assert.strictEqual(lastStatus(events1), 'error', '落盘失败应走错误终态');

    const events2 = [];
    await manager.execute('main', 'asst-2', '再试一次', collectCallbacks(events2));
    assert.strictEqual(lastStatus(events2), 'done', '会话不应被前次落盘失败锁死');
});

test('工具运行中手动停止：被中断的工具终态为失败而非成功', async () => {
    const { manager, sessionManager } = buildManager({ toolRunningMs: 200 });
    const events = [];
    sessionManager.addMessage('main', { id: 'asst-1', role: 'assistant', content: '', timestamp: Date.now(), status: 'processing' });
    const executing = manager.execute('main', 'asst-1', '长任务', collectCallbacks(events));

    await delay(100); // 工具已进入运行中
    manager.stop('main');
    await executing; // 引擎对 cancel 无感知，工具窗口结束后以正常响应结束当前轮

    const toolStatuses = events.filter((e) => e.kind === 'tool').map((e) => e.toolCall.status);
    assert.deepStrictEqual(toolStatuses, ['running', 'failed'], '被中断的工具应终态化为失败而非误标成功');
    const session = sessionManager.getOrCreateSession('main');
    assert.strictEqual(session.taskState, 'stopped');
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

test('重叠工具各自按 ID 收尾：后启动的工具不掩盖前一个的失败', async () => {
    const { manager } = buildManager({ overlappingTools: true });
    const events = [];
    await manager.execute('main', 'asst-1', '并发工具任务', collectCallbacks(events));

    const statusesOf = (id) => events
        .filter((e) => e.kind === 'tool' && e.toolCall.id === id)
        .map((e) => e.toolCall.status);
    assert.deepStrictEqual(statusesOf('tool-a'), ['running', 'failed'], 'A 的失败不得被 B 的启动误标为成功');
    assert.deepStrictEqual(statusesOf('tool-b'), ['running', 'done'], '无终态回报的 B 由收尾兜底终态化');
    assert.strictEqual(lastStatus(events), 'done');
});

test('审批选项含持久授权时，单一同意意图仍选中「仅本次」', async () => {
    const { manager } = buildManager({ chunkCount: 0, enablePermission: true, allowAlwaysFirst: true });
    const events = [];
    const executing = manager.execute('main', 'asst-1', '执行操作', collectCallbacks(events));

    const approval = await new Promise((resolve) => {
        const timer = setInterval(() => {
            const found = events.find((e) => e.kind === 'approval');
            if (found) { clearInterval(timer); resolve(found.request); }
        }, 10);
    });
    manager.handleApproval('main', approval.approvalId, true);
    await executing;

    assert.ok(deltas(events).includes('permission-selected-allow'), '应选中 allow_once 而非排列在前的 allow_always');
    assert.ok(!deltas(events).includes('allow-always'), '不得静默升级为持久授权');
});

test('回复被截断时经 done 载荷透出 stopReason，由客户端本地化提示', async () => {
    const { manager } = buildManager({ chunkCount: 1, stopReason: 'max_tokens' });
    const events = [];
    await manager.execute('main', 'asst-1', '长回复', collectCallbacks(events));

    assert.strictEqual(lastStatus(events), 'done');
    const doneEvent = events.find((e) => e.kind === 'status' && e.status === 'done');
    assert.strictEqual(doneEvent?.payload?.stopReason, 'max_tokens', '截断原因应结构化透出而非服务端内嵌文案');
});

test('同一会话并发审批各自独立应答，互不覆盖', async () => {
    const { manager } = buildManager({ doublePermission: true });
    const events = [];
    const executing = manager.execute('main', 'asst-1', '并发审批任务', collectCallbacks(events));

    const approvals = await new Promise((resolve) => {
        const timer = setInterval(() => {
            const found = events.filter((e) => e.kind === 'approval');
            if (found.length >= 2) { clearInterval(timer); resolve(found.map((e) => e.request)); }
        }, 10);
    });
    assert.notStrictEqual(approvals[0].approvalId, approvals[1].approvalId, '并发审批的 ID 必须唯一');
    assert.strictEqual(manager.handleApproval('main', approvals[0].approvalId, true), true, '第一个审批应可独立应答');
    assert.strictEqual(manager.handleApproval('main', approvals[1].approvalId, false), true, '第二个审批不得覆盖第一个的登记');
    await executing;

    assert.ok(deltas(events).includes('double-selected-selected'), '两个审批均应收到各自的选择结果');
});

test('停止后引擎无响应：超时强制回收连接并释放会话占用', { timeout: 3000 }, async (t) => {
    keepEventLoopAlive(t);
    const { manager, sessionManager } = buildManager(
        { promptNeverEnds: true },
        { stopTimeoutMs: 100 }
    );
    const events = [];
    sessionManager.addMessage('main', { id: 'asst-1', role: 'assistant', content: '', timestamp: Date.now(), status: 'processing' });
    const executing = manager.execute('main', 'asst-1', '卡死任务', collectCallbacks(events));

    await delay(100); // prompt 已发出且引擎不响应
    assert.strictEqual(manager.isRunning('main'), true);
    manager.stop('main');
    await executing; // 超时回收应让挂起的 prompt 以 stopped 终态结束

    assert.strictEqual(manager.isRunning('main'), false, '强制回收后会话占用必须释放');
    assert.strictEqual(sessionManager.getOrCreateSession('main').taskState, 'stopped');

    // 引擎随下次请求懒重启，会话可继续使用
    const events2 = [];
    await manager.execute('main', 'asst-2', '回收后的新任务', collectCallbacks(events2));
    assert.strictEqual(lastStatus(events2), 'done', '强制回收后应能重建引擎并继续执行');
});

test('初始通知即带失败终态的工具：按失败广播，不被收尾改写为成功', async () => {
    const { manager } = buildManager({ chunkCount: 1, toolInitialFailed: true });
    const events = [];
    await manager.execute('main', 'asst-1', '执行操作', collectCallbacks(events));

    const statuses = events
        .filter((e) => e.kind === 'tool' && e.toolCall.id === 'tool-init-failed')
        .map((e) => e.toolCall.status);
    assert.deepStrictEqual(statuses, ['failed'], '出生即失败的工具应只广播一次失败终态');
    assert.strictEqual(lastStatus(events), 'done');
});

test('停止后引擎快速收尾时：回收计时器不误杀同会话的后续请求', async () => {
    const { manager, sessionManager } = buildManager(
        { toolRunningMs: 300 }, // 引擎 300ms 后自行结束当前轮（短于回收窗口）
        { stopTimeoutMs: 500 }
    );
    const events1 = [];
    sessionManager.addMessage('main', { id: 'asst-1', role: 'assistant', content: '', timestamp: Date.now(), status: 'processing' });
    const executing = manager.execute('main', 'asst-1', '长任务', collectCallbacks(events1));

    await delay(100);
    manager.stop('main');
    await executing; // 引擎在回收窗口内正常收尾，连接保持存活

    // 立即在同会话发起新请求：旧回收计时器（500ms）到点时不得关闭新请求的连接
    const events2 = [];
    sessionManager.addMessage('main', { id: 'asst-2', role: 'assistant', content: '', timestamp: Date.now(), status: 'processing' });
    const executing2 = manager.execute('main', 'asst-2', '回收窗口内的新任务', collectCallbacks(events2));
    await delay(600); // 跨过旧计时器的触发点
    await executing2;

    assert.strictEqual(lastStatus(events2), 'done', '旧回收计时器不得中断同会话的后续请求');
    assert.strictEqual(sessionManager.getOrCreateSession('main').taskState, 'completed');
});

test('并发审批其一超时：其余审批一并取消，任务停止后不再授权', async () => {
    const outcomeLog = [];
    const { manager, sessionManager } = buildManager(
        { doublePermission: true, permissionOutcomeLog: outcomeLog },
        { approvalTimeoutMs: 100 }
    );
    const events = [];
    sessionManager.addMessage('main', { id: 'asst-1', role: 'assistant', content: '', timestamp: Date.now(), status: 'processing' });
    await manager.execute('main', 'asst-1', '并发审批任务', collectCallbacks(events));

    assert.strictEqual(sessionManager.getOrCreateSession('main').taskState, 'stopped', '任一审批超时即终止任务');
    assert.deepStrictEqual(outcomeLog, ['cancelled|cancelled'], '超时后同会话其余审批不得向引擎传递授权选择');
    const stoppedEvent = [...events].reverse().find((e) => e.kind === 'status' && e.status === 'stopped');
    assert.ok(stoppedEvent, '超时审批应广播 stopped 终态');
});

test('任务占用看门狗：占用超时强制回收连接，任务以错误终态释放会话', { timeout: 3000 }, async (t) => {
    keepEventLoopAlive(t);
    const { manager, sessionManager } = buildManager(
        { promptNeverEnds: true },
        { taskTimeoutMs: 100 }
    );
    const events = [];
    sessionManager.addMessage('main', { id: 'asst-1', role: 'assistant', content: '', timestamp: Date.now(), status: 'processing' });
    await manager.execute('main', 'asst-1', '静默挂死任务', collectCallbacks(events));

    assert.strictEqual(manager.isRunning('main'), false, '看门狗回收后必须释放会话占用');
    assert.strictEqual(sessionManager.getOrCreateSession('main').taskState, 'error');
    assert.strictEqual(lastStatus(events), 'error', '占用超时应以错误终态收尾而非永久占用');

    // 引擎随下次请求懒重启，会话可继续使用
    const events2 = [];
    await manager.execute('main', 'asst-2', '回收后的新任务', collectCallbacks(events2));
    assert.strictEqual(lastStatus(events2), 'done', '看门狗回收后应能重建引擎并继续执行');
});

test('审批超时且引擎无响应：停止回收兜底释放会话占用', { timeout: 3000 }, async (t) => {
    keepEventLoopAlive(t);
    const { manager, sessionManager } = buildManager(
        { chunkCount: 1, enablePermission: true, hangOnPermissionTimeout: true },
        { approvalTimeoutMs: 100, stopTimeoutMs: 100 }
    );
    const events = [];
    sessionManager.addMessage('main', { id: 'asst-1', role: 'assistant', content: '', timestamp: Date.now(), status: 'processing' });
    await manager.execute('main', 'asst-1', '审批挂死任务', collectCallbacks(events));

    assert.strictEqual(sessionManager.getOrCreateSession('main').taskState, 'stopped');
    assert.strictEqual(manager.isRunning('main'), false, '审批超时回收后必须释放会话占用');
    const stoppedEvent = [...events].reverse().find((e) => e.kind === 'status' && e.status === 'stopped');
    assert.ok(stoppedEvent, '审批超时应广播 stopped 终态');

    const events2 = [];
    await manager.execute('main', 'asst-2', '回收后的新任务', collectCallbacks(events2));
    assert.strictEqual(lastStatus(events2), 'done', '回收后应能重建引擎并继续执行');
});

test('formatToolDetails: 精准提取命令、文件路径与结构化参数', () => {
    // 1. bash 工具提取命令行
    const bashRes = formatToolDetails('shell', 'bash', { command: 'git status -s' });
    assert.strictEqual(bashRes.name, 'bash');
    assert.strictEqual(bashRes.summary, '$ git status -s');
    assert.deepStrictEqual(bashRes.input, { command: 'git status -s' });

    // 2. 带 $ 前缀的命令不重复加 $
    const bashWithDollar = formatToolDetails('bash', 'bash', { command: '$ git pull' });
    assert.strictEqual(bashWithDollar.summary, '$ git pull');

    // 3. 读写文件提取路径
    const readRes = formatToolDetails('fs', 'read_file', { path: 'docs/技术架构.md' });
    assert.strictEqual(readRes.name, 'read_file');
    assert.strictEqual(readRes.summary, 'read: docs/技术架构.md');

    const writeRes = formatToolDetails('fs', 'write_file', { file_path: 'src/test.ts' });
    assert.strictEqual(writeRes.summary, 'write: src/test.ts');

    // 4. 搜索查询与 URL 访问
    const searchRes = formatToolDetails('search', 'web_search', { query: 'React Native 0.88' });
    assert.strictEqual(searchRes.summary, 'search: "React Native 0.88"');

    const urlRes = formatToolDetails('web', 'web_fetch', { url: 'https://example.com' });
    assert.strictEqual(urlRes.summary, 'fetch: https://example.com');

    // 5. 兜底提取
    const customRes = formatToolDetails('custom', 'custom_tool', { key: 'value' });
    assert.strictEqual(customRes.name, 'custom_tool');
    assert.strictEqual(customRes.summary, 'custom_tool: value');
});

test('extractToolOutput: 独立提取工具输出并在各阶段无条件保留', () => {
    // 1. 数组结构提取
    const single = extractToolOutput([{ text: 'output line 1' }]);
    assert.strictEqual(single, 'output line 1');

    // 2. 嵌套 content 结构
    const nested = extractToolOutput([{ content: { text: 'nested text' } }]);
    assert.strictEqual(nested, 'nested text');

    // 3. 多段组合与超长截断（1000字符）
    const multi = extractToolOutput([{ text: 'line 1' }, { text: 'line 2' }]);
    assert.strictEqual(multi, 'line 1\nline 2');

    const longText = 'a'.repeat(1500);
    const truncated = extractToolOutput([{ text: longText }]);
    assert.strictEqual(truncated.length, 1000);

    // 4. 空值与非数组返回 undefined
    assert.strictEqual(extractToolOutput(undefined), undefined);
    assert.strictEqual(extractToolOutput([]), undefined);
    assert.strictEqual(extractToolOutput('not-an-array'), undefined);
});

test('后台汇报不推进主人activity，不把后台唤醒当提前归来清掉预生成提要', async t => {
    const { manager, sessionManager, tmp } = buildManager();
    t.after(async () => { await manager.stopAll(); fs.rmSync(tmp, { recursive: true, force: true }); });
    const baseline = Date.now() - 2 * 60 * 60 * 1000;
    sessionManager.recordActivity('main', baseline);
    sessionManager.setPendingBackground('main', '已有接力提要');
    await manager.execute('main', 'background-result', '后台完整结果', collectCallbacks([]), undefined, 'task_report');
    assert.strictEqual(sessionManager.getLastActiveAt('main'), baseline);
    assert.strictEqual(sessionManager.getPendingBackground('main'), '已有接力提要');
    assert.strictEqual(manager.isRunning('main'), false);
});

test('后台汇报冻结无activity旧会话fallback，连续汇报和冷读不隐式续期', async t => {
    const { manager, sessionManager, tmp } = buildManager();
    t.after(async () => { await manager.stopAll(); fs.rmSync(tmp, { recursive: true, force: true }); });
    const baseline = Date.now() - 123456;
    sessionManager.addMessage('main', { id: 'old-user', role: 'user', content: '旧指令', status: 'sent', timestamp: baseline });
    await manager.execute('main', 'bg-1', '第一次结果', collectCallbacks([]), undefined, 'task_report');
    await manager.execute('main', 'bg-2', '第二次结果', collectCallbacks([]), undefined, 'task_report');
    assert.strictEqual(sessionManager.getLastActiveAt('main'), baseline);
    assert.strictEqual(new SessionManager(path.join(tmp, 'data')).getLastActiveAt('main'), baseline);
});

test('后台activity初始化异常仍释放会话预留，后续主人消息可执行', async t => {
    const { manager, sessionManager, tmp } = buildManager();
    t.after(async () => { await manager.stopAll(); fs.rmSync(tmp, { recursive: true, force: true }); });
    const original = sessionManager.recordActivity.bind(sessionManager);
    sessionManager.recordActivity = () => { throw new Error('injected baseline persistence failure'); };
    const failed = [];
    await manager.execute('main', 'failed-report', '后台结果', collectCallbacks(failed), undefined, 'task_report');
    assert.strictEqual(lastStatus(failed), 'error');
    assert.strictEqual(manager.isRunning('main'), false);
    sessionManager.recordActivity = original;
    const next = [];
    await manager.execute('main', 'user-next', '主人新指令', collectCallbacks(next));
    assert.strictEqual(lastStatus(next), 'done');
});
