import { spawn, ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Writable, Readable } from 'node:stream';
import path from 'node:path';
import fs from 'node:fs';
import * as acp from '@agentclientprotocol/sdk';
import { MemoryManager } from './memoryManager.js';
import { SessionManager } from './sessionManager.js';
import { ToolCallState, ApprovalRequest } from './protocol.js';

/**
 * 引擎模块用户可见消息的错误码：客户端按码本地化渲染（i18n），码值是持久化与流式的稳定契约。
 * 服务端不内嵌展示文案，未知码按原文兜底显示（兼容历史中文消息数据）。
 */
export type EngineMessageCode =
    | 'task_stopped' // 任务被用户手动终止
    | 'approval_timeout' // 审批超时未应答，任务已终止
    | 'engine_refusal' // 模型拒绝了本次请求
    | 'engine_error'; // 引擎执行异常，detail 透传技术原因

/** onStatusChange 的结构化载荷：code 供客户端本地化，stopReason 为引擎结束原因（如 max_tokens 截断） */
export interface EngineStatusPayload {
    code?: EngineMessageCode;
    detail?: string;
    stopReason?: string;
}

export interface EngineCallbacks {
    onDelta: (delta: string) => void;
    onFinalText?: (fullText: string) => void;
    onToolCall: (toolCall: ToolCallState) => void;
    onApprovalRequest?: (request: ApprovalRequest) => void;
    /** stopped 为模块内部终态（如审批超时自动拒绝），无对应客户端报文触发，须主动广播 */
    onStatusChange: (status: 'thinking' | 'running_tool' | 'done' | 'error' | 'stopped', payload?: EngineStatusPayload) => void;
}

/** 已建立的引擎连接：生产环境为 dsh 子进程的 stdio 流，测试可注入进程内模拟 */
export interface EngineConnection {
    context: acp.ClientContext;
    /** 连接关闭（引擎退出或被停）时 resolve，用于崩溃清理 */
    closed: Promise<void>;
    /** 主动关停连接并回收子进程 */
    close: () => Promise<void>;
}

export interface AcpEngineManagerOptions {
    /** 审批挂起超时（毫秒），超时自动拒绝；默认 5 分钟，测试可用环境变量 LVTIAN_APPROVAL_TIMEOUT_MS 覆盖 */
    approvalTimeoutMs?: number;
    /** 停止后引擎无响应的强制回收超时（毫秒），默认 2000，对齐旧 DshRunner 停止保障水位 */
    stopTimeoutMs?: number;
    /** 引擎连接工厂，默认 spawn dsh --profile acp；测试注入进程内模拟连接 */
    connectEngine?: (app: acp.ClientApp, systemPrompt: string) => Promise<EngineConnection>;
}

/** 会话任务运行时状态：一次 prompt 执行期间的聚合上下文 */
interface SessionRuntime {
    assistantMessageId: string;
    engineSessionId: string;
    callbacks: EngineCallbacks;
    /** 进行中的工具（按 toolCallId 追踪）：协议允许工具重叠执行，各自从自己的终态更新收尾 */
    outstandingTools: Map<string, ToolCallState>;
    toolSeq: number;
    committedText: string;
}

/** 挂起中的审批：等待客户端应答或超时；协议允许同一会话并发多个审批，按 approvalId 独立记账 */
interface PendingPermission {
    approvalId: string;
    sessionId: string;
    settle: (approved: boolean | 'timeout') => void;
    timer: ReturnType<typeof setTimeout>;
}

/** ACP 引擎审批请求参数（session/request_permission） */
interface AcpPermissionRequest {
    sessionId: string;
    toolCall: { toolCallId: string; title: string; kind: string };
    options: Array<{ optionId: string; name: string; kind: string }>;
}

/** dsh-acp 对 NewSessionRequest 的 mcpServers 字段强制必填（比标准更严格），空对象表示不挂载 */
const EMPTY_MCP: Record<string, never> = {};

/**
 * 定位服务端本地安装的 @deepseek-ai/dsh 二进制或 JS 入口，
 * 避免因 childProcess cwd 设置在 workspace 目录而导致 npx 回退联网下载或查找全局缓存
 */
function resolveDshInvocation(): { command: string; argsPrefix: string[] } {
    try {
        const require = createRequire(import.meta.url);
        const pkgJsonPath = require.resolve('@deepseek-ai/dsh/package.json');
        const dshDir = path.dirname(pkgJsonPath);
        const binJs = path.join(dshDir, 'lib', 'bin.js');
        if (fs.existsSync(binJs)) {
            return { command: process.execPath, argsPrefix: [binJs] };
        }
    } catch {
        // ignore
    }

    const localBin = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '../node_modules/.bin',
        process.platform === 'win32' ? 'dsh.cmd' : 'dsh'
    );
    if (fs.existsSync(localBin)) {
        return { command: localBin, argsPrefix: [] };
    }

    return {
        command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
        argsPrefix: ['-y', '@deepseek-ai/dsh'],
    };
}

/**
 * ACP 常驻引擎管理器：通过 dsh --profile acp 子进程以 JSON-RPC 长连接驱动 AI 助理，
 * 取代 headless 每轮拉起子进程的模式。单连接承载全部会话，引擎崩溃后随下次请求懒重启。
 */
export class AcpEngineManager {
    private workspace: string;
    private memoryManager: MemoryManager;
    private sessionManager: SessionManager;
    private approvalTimeoutMs: number;
    private stopTimeoutMs: number;
    private connectEngineImpl: (app: acp.ClientApp, systemPrompt: string) => Promise<EngineConnection>;

    private connection: EngineConnection | null = null;
    private engineStarting: Promise<void> | null = null;
    private engineDead = false;
    private engineSystemPrompt = '';

    /** 已受理（含引擎启动、建会话窗口）的会话 → 对应助理消息 ID：execute 入口同步登记，用于并发去重与停止时消息终态化 */
    private activeSessions: Map<string, string> = new Map();
    private runtimes: Map<string, SessionRuntime> = new Map();
    /** 引擎侧会话 ID → 绿天会话 ID 反查（审批请求与事件路由使用） */
    private engineSessionIndex: Map<string, string> = new Map();
    /** 挂起中的审批（键为 approvalId）：同一会话可并发多个审批，各自独立应答与超时 */
    private pendingPermissions: Map<string, PendingPermission> = new Map();
    private stoppedSessions: Set<string> = new Set();
    /** 审批 ID 序号：Date.now() 毫秒精度不足，并发审批需序列号保证唯一 */
    private approvalSeq = 0;

    constructor(
        workspace: string,
        memoryManager: MemoryManager,
        sessionManager: SessionManager,
        options?: AcpEngineManagerOptions
    ) {
        this.workspace = workspace;
        this.memoryManager = memoryManager;
        this.sessionManager = sessionManager;
        const envTimeout = Number.parseInt(process.env.LVTIAN_APPROVAL_TIMEOUT_MS ?? '', 10);
        this.approvalTimeoutMs = options?.approvalTimeoutMs
            ?? (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 5 * 60 * 1000);
        this.stopTimeoutMs = options?.stopTimeoutMs ?? 2000;
        this.connectEngineImpl = options?.connectEngine ?? this.spawnDshEngine.bind(this);
    }

    public isRunning(sessionId: string): boolean {
        return this.activeSessions.has(sessionId);
    }

    public handleApproval(sessionId: string, approvalId: string, approved: boolean): boolean {
        const pending = this.pendingPermissions.get(approvalId);
        if (!pending || pending.sessionId !== sessionId) {
            return false;
        }
        clearTimeout(pending.timer);
        this.pendingPermissions.delete(approvalId);
        pending.settle(approved);
        return true;
    }

    /** 手动停止：通知引擎取消当前轮次，并就地终态化消息状态（引擎侧 cancelled 响应到达后跳过重复终态） */
    public stop(sessionId: string): boolean {
        const runtime = this.runtimes.get(sessionId);
        if (runtime) {
            this.stoppedSessions.add(sessionId);
            this.rejectPendingPermission(sessionId, 'task_stopped');
            this.sessionManager.setTaskState(sessionId, 'stopped');
            this.sessionManager.updateMessage(sessionId, runtime.assistantMessageId, (m) => {
                m.status = 'error';
                m.errorMessage = 'task_stopped';
            });
            this.connection?.context.notify('session/cancel', { sessionId: runtime.engineSessionId }).catch((err) => {
                console.warn(`[AcpEngine] 发送取消通知失败: ${err instanceof Error ? err.message : String(err)}`);
            });
            // 引擎可能对取消通知无响应（卡死），超时兜底强制回收连接，防止会话被挂死的 prompt 永久占用
            this.scheduleStopRecovery(sessionId);
            return true;
        }

        // 引擎启动/建会话窗口：任务已受理但 prompt 尚未发出，标记停止由 execute 的检查点终态化；
        // 消息同步终态化，避免占位回复停留在「处理中」直到 execute 检查点才收尾
        if (this.activeSessions.has(sessionId)) {
            this.stoppedSessions.add(sessionId);
            const messageId = this.activeSessions.get(sessionId);
            if (messageId) {
                this.sessionManager.updateMessage(sessionId, messageId, (m) => {
                    m.status = 'error';
                    m.errorMessage = 'task_stopped';
                });
            }
            this.sessionManager.setTaskState(sessionId, 'stopped');
            return true;
        }
        return false;
    }

    /**
     * 停止后的超时兜底：引擎收到取消通知仍未结束当前轮（进程或工具卡死）时，
     * 强制关闭引擎连接——挂起的 prompt 请求随连接断开 reject，各占用会话经 execute
     * 的 stopped 分支收尾并释放预留；引擎在下次请求时懒重启。对齐旧 DshRunner 停止后 2 秒强制终止的保障水位。
     */
    private scheduleStopRecovery(sessionId: string): void {
        const timer = setTimeout(() => {
            if (!this.activeSessions.has(sessionId)) {
                return; // 引擎已在超时窗口内正常结束，无需回收
            }
            console.warn(`[AcpEngine] 停止后 ${this.stopTimeoutMs}ms 引擎仍未结束，强制回收引擎连接`);
            // 与 stopAll 相同模式：同步置空连接并清理映射再关闭。
            // closed 清理是异步回调，若不先置空，下一个请求会抢在清理前复用已关闭的死连接
            const conn = this.connection;
            this.connection = null;
            this.engineSessionIndex.clear();
            conn?.close().catch((err: unknown) => {
                console.warn(`[AcpEngine] 强制回收连接失败: ${err instanceof Error ? err.message : String(err)}`);
            });
        }, this.stopTimeoutMs);
        // 计时器不得阻止进程退出（Node Timeout 专属能力，其他环境安全跳过）
        timer.unref?.();
    }

    /** 优雅关停：停止全部受理中的任务（含引擎启动窗口）、等待启动中的引擎就位后关闭连接 */
    public async stopAll(): Promise<void> {
        for (const sessionId of [...this.activeSessions.keys()]) {
            this.stop(sessionId);
        }
        // 引擎仍在启动时等待其完成再关闭：否则启动完成后连接与进行中任务会残留到关停之后
        if (this.engineStarting) {
            await this.engineStarting.catch(() => undefined);
        }
        const conn = this.connection;
        this.connection = null;
        // 主动关停将 connection 置空，closed 处理器的连接比对不再命中，
        // 连接级会话映射须在此显式清理，否则下次懒重启后会话被误判为本连接活跃会话
        this.engineSessionIndex.clear();
        if (conn) {
            await conn.close().catch((err: unknown) => {
                console.warn(`[AcpEngine] 关闭引擎连接失败 (非致命): ${err instanceof Error ? err.message : String(err)}`);
            });
        }
    }

    public async execute(
        sessionId: string,
        assistantMessageId: string,
        userPrompt: string,
        callbacks: EngineCallbacks
    ): Promise<void> {
        // 入口同步预留（任何 await 之前）：同一会话的并发消息在此被拒绝，
        // 否则引擎启动/建会话窗口内两次调用都会通过检查、互踩运行时状态
        if (this.activeSessions.has(sessionId)) {
            return;
        }
        this.activeSessions.set(sessionId, assistantMessageId);

        try {
            // 初始状态更新须在预留的释放范围内：落盘或回调抛错时 finally 仍会释放预留，
            // 否则失败的请求会把会话永久锁在「进行中」，后续消息全部被静默拒绝
            this.sessionManager.setTaskState(sessionId, 'processing');
            callbacks.onStatusChange('thinking');

            await this.ensureEngine();
            if (!this.connection) {
                throw new Error('引擎连接不可用（启动失败或已退出）');
            }

            // 引擎启动等待期间收到手动停止：不再解析会话（避免 stopAll 清理映射后又被本任务重新登记），
            // 消息已由 stop 同步终态化，这里只收尾任务状态
            if (this.stoppedSessions.has(sessionId)) {
                this.stoppedSessions.delete(sessionId);
                this.sessionManager.setTaskState(sessionId, 'stopped');
                return;
            }

            const context = this.connection.context;
            const engineSessionId = await this.resolveEngineSession(sessionId);

            // 建会话窗口内收到手动停止：不再发送 prompt，直接终态化退出
            if (this.stoppedSessions.has(sessionId)) {
                this.stoppedSessions.delete(sessionId);
                this.sessionManager.setTaskState(sessionId, 'stopped');
                return;
            }

            const runtime: SessionRuntime = {
                assistantMessageId,
                engineSessionId,
                callbacks,
                outstandingTools: new Map(),
                toolSeq: 0,
                committedText: '',
            };
            this.runtimes.set(sessionId, runtime);

            const fullPrompt = `[系统人设与主人记忆背景]
${this.engineSystemPrompt}

[主人当前提问与指令]
${userPrompt}`;

            const response = await context.request<{ stopReason?: string }>(
                'session/prompt',
                {
                    sessionId: engineSessionId,
                    prompt: [{ type: 'text', text: fullPrompt }],
                }
            );

            this.finalizeRun(sessionId, runtime, response?.stopReason ?? 'end_turn');
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            // 异常退出时先把进行中的工具终态化为失败，避免消息已标错而工具状态永远停留运行中
            const runtime = this.runtimes.get(sessionId);
            if (runtime) {
                this.finalizeTools(runtime, 'failed');
            }
            this.runtimes.delete(sessionId);
            this.rejectPendingPermission(sessionId, 'engine_error');

            if (this.stoppedSessions.has(sessionId)) {
                this.stoppedSessions.delete(sessionId);
                this.sessionManager.setTaskState(sessionId, 'stopped');
                return;
            }
            console.error(`[AcpEngine] 执行任务异常: ${message}`);
            callbacks.onStatusChange('error', { code: 'engine_error', detail: message });
            this.sessionManager.setTaskState(sessionId, 'error');
        } finally {
            this.activeSessions.delete(sessionId);
        }
    }

    // ------------------------------------------------------------------
    // 引擎生命周期
    // ------------------------------------------------------------------

    private async ensureEngine(): Promise<void> {
        if (this.connection) {
            return;
        }
        if (!this.engineStarting) {
            this.engineStarting = this.startEngine().finally(() => {
                this.engineStarting = null;
            });
        }
        await this.engineStarting;
    }

    private async startEngine(): Promise<void> {
        // 记忆与人设在引擎启动时加载一次，经环境变量注入（进程级生效），并保留给每轮 prompt 前缀兜底
        const memoryContext = this.memoryManager.loadContext();
        const systemSections = [
            memoryContext.soul ? `[系统背景]\n${memoryContext.soul}` : '',
            memoryContext.memory ? `[主人记忆]\n${memoryContext.memory}` : '',
            memoryContext.user ? `[主人档案]\n${memoryContext.user}` : '',
        ].filter(Boolean).join('\n\n');
        this.engineSystemPrompt = systemSections;
        this.engineDead = false;

        const app = acp.client({ name: 'lvtian-server' });

        app.onRequest<Record<string, unknown>, Record<string, unknown>>(
            'session/request_permission',
            passthroughParser,
            (ctx) => this.handleRequestPermission(ctx.params as unknown as AcpPermissionRequest)
        );
        app.onNotification<Record<string, unknown>>(
            'session/update',
            passthroughParser,
            (ctx) => {
                const params = ctx.params as { sessionId?: string; update?: { sessionUpdate?: string } };
                if (params.sessionId && params.update) {
                    this.handleSessionUpdate(params.sessionId, params.update);
                }
            }
        );

        console.log(`[AcpEngine] 启动引擎 (工作区: ${this.workspace})...`);
        const connection = await this.connectEngineImpl(app, this.engineSystemPrompt);
        this.connection = connection;
        console.log('[AcpEngine] 引擎连接已建立');

        // 引擎退出（崩溃或被杀）时的清理：不在此重复广播错误，prompt 请求会因连接关闭 reject 并走各自终态
        connection.closed.then(() => {
            if (this.connection === connection) {
                this.connection = null;
                this.engineDead = true;
                this.engineSessionIndex.clear();
                for (const sessionId of [...this.runtimes.keys()]) {
                    this.rejectPendingPermission(sessionId, '引擎进程已退出');
                }
                console.warn('[AcpEngine] 引擎连接已断开，将在下次请求时自动重启');
            }
        });
    }

    private async spawnDshEngine(app: acp.ClientApp, systemPrompt: string): Promise<EngineConnection> {
        const { command, argsPrefix } = resolveDshInvocation();
        const child: ChildProcess = spawn(command, [...argsPrefix, '--profile', 'acp'], {
            cwd: this.workspace,
            env: {
                ...process.env,
                DSH_WORKSPACE: this.workspace,
                DSH_SYSTEM_PROMPT: systemPrompt,
                DEEPSEEK_SYSTEM_PROMPT: systemPrompt,
            },
            shell: false,
        });
        child.stdin?.on('error', (err: Error) => {
            console.warn(`[AcpEngine] stdin 管道异常 (子进程可能已退出): ${err.message}`);
        });
        child.stderr?.on('data', (chunk: Buffer) => {
            const text = chunk.toString('utf8').trim();
            if (text) {
                console.log(`[AcpEngine:stderr] ${text.slice(0, 500)}`);
            }
        });

        if (!child.stdin || !child.stdout) {
            child.kill();
            throw new Error('引擎子进程标准流不可用');
        }

        // 保活信号：close() 主动关停时结束 connectWith 回调（回调结束即连接关闭）
        let resolveStop!: () => void;
        const stopSignal = new Promise<void>((resolve) => {
            resolveStop = resolve;
        });
        let resolveContext!: (ctx: acp.ClientContext) => void;
        let rejectContext!: (err: Error) => void;
        let resolveHandshake!: () => void;
        let rejectHandshake!: (err: Error) => void;
        const contextReady = new Promise<acp.ClientContext>((resolve, reject) => {
            resolveContext = resolve;
            rejectContext = reject;
        });
        // 握手屏障：context 就绪不代表引擎可用（spawn 失败时 onConnect 仍会触发），
        // 必须等 initialize 握手完成；进程启动失败或秒退在此阶段被拒绝
        const handshakeReady = new Promise<void>((resolve, reject) => {
            resolveHandshake = resolve;
            rejectHandshake = reject;
        });

        // spawn 失败（可执行文件缺失、工作区目录不存在等）以异步 error 事件抛出，
        // 未监听会击穿为未捕获异常导致服务端崩溃；在此转为启动失败走 execute 的错误终态
        child.on('error', (err: Error) => {
            console.error(`[AcpEngine] 引擎子进程启动失败: ${err.message}`);
            rejectContext(err);
            rejectHandshake(err);
            resolveStop();
        });

        // Node 与 SDK 的 Web 流泛型声明存在库间差异（运行时行为一致），此处收窄类型
        const stdinWeb = Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>;
        const stdoutWeb = Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>;
        const stream = acp.ndJsonStream(stdinWeb, stdoutWeb);
        const run = app.connectWith(stream, async (context) => {
            resolveContext(context);
            try {
                await context.request('initialize', {
                    protocolVersion: acp.PROTOCOL_VERSION,
                    clientInfo: { name: 'lvtian-server', version: '0.1.0' },
                });
                resolveHandshake();
            } catch (err: unknown) {
                rejectHandshake(err instanceof Error ? err : new Error(String(err)));
                throw err;
            }
            await stopSignal;
        });
        // 连接结束信号：回调正常结束或流断开（进程崩溃）均会让 run settle
        const closed = run.catch(() => undefined);

        let context: acp.ClientContext;
        try {
            context = await contextReady;
            await handshakeReady;
        } catch (err) {
            // 启动失败（握手被拒或进程秒退）：此时连接尚未登记到实例，stopAll 无法回收，
            // 必须先结束传输并终止子进程再上抛，否则引擎进程泄漏且后续请求继续叠加新进程
            resolveStop();
            await closed;
            await terminateChild(child);
            throw err;
        }

        return {
            context,
            closed,
            close: async () => {
                resolveStop();
                await closed;
                await terminateChild(child);
            },
        };
    }

    // ------------------------------------------------------------------
    // 会话解析与事件路由
    // ------------------------------------------------------------------

    /**
     * 取得引擎侧会话：
     * 1. 同一连接内的活跃会话直接复用（resume 仅适用于恢复跨连接的非活跃会话，活跃会话 resume 会报 already active）；
     * 2. 连接重建后（引擎重启）尝试 resume 恢复持久化会话；
     * 3. resume 失败（如旧 headless 会话 ID 不通用）则新建并更新绑定。
     */
    private async resolveEngineSession(sessionId: string): Promise<string> {
        if (!this.connection) {
            throw new Error('引擎连接不可用');
        }
        const context = this.connection.context;
        const saved = this.sessionManager.getDshSessionId(sessionId);

        if (saved && this.engineSessionIndex.has(saved)) {
            return saved;
        }

        if (saved) {
            try {
                const resumed = await context.request<{ sessionId?: string }>('session/resume', {
                    sessionId: saved,
                    cwd: this.workspace,
                });
                if (resumed?.sessionId) {
                    this.engineSessionIndex.set(resumed.sessionId, sessionId);
                    return resumed.sessionId;
                }
            } catch (err: unknown) {
                console.warn(
                    `[AcpEngine] 恢复会话 ${saved} 失败，改为新建 (历史消息仍在服务端日志可查): ${err instanceof Error ? err.message : String(err)}`
                );
            }
        }

        const created = await context.request<{ sessionId?: string }>('session/new', {
            cwd: this.workspace,
            mcpServers: EMPTY_MCP,
        });
        if (!created?.sessionId) {
            throw new Error('引擎未返回会话 ID');
        }
        this.sessionManager.setDshSessionId(sessionId, created.sessionId);
        this.engineSessionIndex.set(created.sessionId, sessionId);
        return created.sessionId;
    }

    private handleSessionUpdate(engineSessionId: string, update: { sessionUpdate?: string }): void {
        const sessionId = this.engineSessionIndex.get(engineSessionId);
        const runtime = sessionId ? this.runtimes.get(sessionId) : undefined;
        if (!sessionId || !runtime) {
            return;
        }

        // 用户已停止：引擎取消收尾期间的迟到事件不得把消息与任务改回处理中
        if (this.stoppedSessions.has(sessionId)) {
            return;
        }

        switch (update.sessionUpdate) {
            case 'agent_message_chunk': {
                const content = (update as { content?: { type?: string; text?: string } }).content;
                const text = content?.type === 'text' && typeof content.text === 'string' ? content.text : '';
                if (text) {
                    // 文本不隐式终结进行中的工具：工具只从自己的终态更新收尾（协议允许重叠），未终结的由任务收尾兜底
                    runtime.committedText += text;
                    runtime.callbacks.onDelta(text);
                }
                break;
            }
            case 'agent_thought_chunk':
                runtime.callbacks.onStatusChange('thinking');
                break;
            case 'tool_call': {
                const t = update as { toolCallId?: string; title?: string; kind?: string; status?: string };
                runtime.toolSeq++;
                const toolCall: ToolCallState = {
                    id: t.toolCallId ?? `tool-${engineSessionId}-${runtime.toolSeq}`,
                    name: t.kind ?? t.title ?? '系统工具',
                    status: 'running',
                    summary: (t.title ?? t.kind ?? '').slice(0, 100),
                };
                runtime.outstandingTools.set(toolCall.id, toolCall);
                runtime.callbacks.onToolCall({ ...toolCall });
                runtime.callbacks.onStatusChange('running_tool');
                break;
            }
            case 'tool_call_update': {
                const t = update as { toolCallId?: string; status?: string };
                const tool = t.toolCallId ? runtime.outstandingTools.get(t.toolCallId) : undefined;
                // 未知工具或已终结工具的迟到更新：忽略，防止覆盖已收尾的终态
                if (!tool) {
                    break;
                }
                if (t.status === 'completed' || t.status === 'failed') {
                    // 终态（完成/失败）即从进行中集合移除，防止后续文本或收尾事件把失败结果覆盖为成功
                    tool.status = t.status === 'completed' ? 'done' : 'failed';
                    runtime.outstandingTools.delete(tool.id);
                    runtime.callbacks.onToolCall({ ...tool });
                } else {
                    tool.status = 'running';
                    runtime.callbacks.onToolCall({ ...tool });
                }
                break;
            }
            default:
                // usage_update / plan / user_message_chunk 等暂不消费
                break;
        }
    }

    /** 收尾兜底：引擎未回报终态的进行中工具统一终态化（正常收尾标 done，停止/异常标 failed） */
    private finalizeTools(runtime: SessionRuntime, status: 'done' | 'failed'): void {
        for (const tool of runtime.outstandingTools.values()) {
            tool.status = status;
            runtime.callbacks.onToolCall({ ...tool });
        }
        runtime.outstandingTools.clear();
    }

    private finalizeRun(sessionId: string, runtime: SessionRuntime, stopReason: string): void {
        this.runtimes.delete(sessionId);
        // 已停止任务的进行中工具是被动中断，终态化为失败；无条件 done 会把中断的工具误标为成功，
        // 且停止守卫拦截后续事件，虚假的成功结果无法再被修正
        const stopped = this.stoppedSessions.has(sessionId);
        this.finalizeTools(runtime, stopped ? 'failed' : 'done');

        if (stopped) {
            this.stoppedSessions.delete(sessionId);
            this.sessionManager.setTaskState(sessionId, 'stopped');
            return;
        }

        if (stopReason === 'refusal') {
            runtime.callbacks.onStatusChange('error', { code: 'engine_refusal' });
            this.sessionManager.setTaskState(sessionId, 'error');
            return;
        }

        // 截断提示由客户端按 stopReason 本地化插入，服务端不内嵌展示文案
        runtime.callbacks.onStatusChange('done', stopReason === 'max_tokens' ? { stopReason } : undefined);
        this.sessionManager.setTaskState(sessionId, 'completed');
        try {
            const recordedAnswer = runtime.committedText.trim().slice(0, 300);
            this.memoryManager.appendDailyLog('对话与任务完成', `答：${recordedAnswer}...`);
        } catch (logErr: unknown) {
            console.warn(`[AcpEngine] 写入每日流水失败 (非致命): ${logErr instanceof Error ? logErr.message : String(logErr)}`);
        }
    }

    // ------------------------------------------------------------------
    // 审批流
    // ------------------------------------------------------------------

    private async handleRequestPermission(params: AcpPermissionRequest): Promise<{ outcome: { outcome: string; optionId?: string } }> {
        const sessionId = this.engineSessionIndex.get(params.sessionId);
        const runtime = sessionId ? this.runtimes.get(sessionId) : undefined;
        if (!sessionId || !runtime || !runtime.callbacks.onApprovalRequest) {
            return { outcome: { outcome: 'cancelled' } };
        }

        // 用户已停止：迟到的审批请求不注册不广播，直接拒绝，防止任务被改回等待审批
        if (this.stoppedSessions.has(sessionId)) {
            return { outcome: { outcome: 'cancelled' } };
        }

        // 毫秒时间戳对并发审批不唯一，附加序列号保证各审批可独立应答
        const approvalId = `apr-${Date.now()}-${++this.approvalSeq}`;
        const request: ApprovalRequest = {
            approvalId,
            prompt: params.toolCall?.title ?? '助理请求执行操作',
            toolName: params.toolCall?.kind,
            params: { options: params.options?.map((o) => ({ id: o.optionId, name: o.name, kind: o.kind })) ?? [] },
            status: 'pending',
        };

        const approved = await new Promise<boolean | 'timeout'>((resolve) => {
            const timer = setTimeout(() => resolve('timeout'), this.approvalTimeoutMs);
            this.pendingPermissions.set(approvalId, { approvalId, sessionId, settle: resolve, timer });
            runtime.callbacks.onApprovalRequest!(request);
        });
        // 只清理本审批的登记，同会话其他并发审批不受影响
        this.pendingPermissions.delete(approvalId);

        if (approved === 'timeout') {
            console.warn(`[AcpEngine] 审批 ${approvalId} 超时未应答，自动拒绝`);
            // 引擎收到拒绝后会走完当前轮（end_turn），标记停止以防终态被覆盖为 completed
            this.stoppedSessions.add(sessionId);
            this.sessionManager.updateMessage(sessionId, runtime.assistantMessageId, (m) => {
                m.status = 'error';
                m.errorMessage = 'approval_timeout';
            });
            this.sessionManager.setTaskState(sessionId, 'stopped');
            // 持久化之外必须经回调广播终态，否则客户端实时视图停留在等待审批，直到重连对账才能修正
            runtime.callbacks.onStatusChange('stopped', { code: 'approval_timeout' });
            return { outcome: { outcome: 'cancelled' } };
        }

        // 客户端审批只有「同意/拒绝」单一意图，须优先匹配「仅本次」选项，
        // 防止选项顺序把单一授权扩大为持久授权（allow_always）
        const wanted = approved ? 'allow' : 'reject';
        const option = params.options?.find((o) => o.kind === `${wanted}_once`)
            ?? params.options?.find((o) => o.kind.startsWith(wanted));
        if (!option) {
            return { outcome: { outcome: 'cancelled' } };
        }
        return { outcome: { outcome: 'selected', optionId: option.optionId } };
    }

    /** 引擎取消或异常退出时，拒绝该会话挂起中的全部审批（引擎侧随后以 cancelled 终止当前轮） */
    private rejectPendingPermission(sessionId: string, reason: string): void {
        for (const pending of [...this.pendingPermissions.values()]) {
            if (pending.sessionId !== sessionId) {
                continue;
            }
            clearTimeout(pending.timer);
            this.pendingPermissions.delete(pending.approvalId);
            console.warn(`[AcpEngine] 审批 ${pending.approvalId} 被终止: ${reason}`);
            pending.settle(false);
        }
    }
}

/**
 * 终止引擎子进程并等待其退出：常规 kill 后 2 秒未退则升级 SIGKILL，保证调用方不会因进程悬挂而卡住
 */
function terminateChild(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null) {
        return Promise.resolve();
    }
    child.kill();
    return new Promise<void>((resolve) => {
        const killTimer = setTimeout(() => {
            try {
                child.kill('SIGKILL');
            } catch {
                // ignore
            }
            resolve();
        }, 2000);
        child.once('close', () => {
            clearTimeout(killTimer);
            resolve();
        });
    });
}

const passthroughParser = {
    parse: (value: unknown): Record<string, unknown> => value as Record<string, unknown>,
};
