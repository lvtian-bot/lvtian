import { spawn, ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { MemoryManager } from './memoryManager.js';
import { SessionManager } from './sessionManager.js';
import { ToolCallState, ApprovalRequest } from './protocol.js';

export interface RunnerCallbacks {
    onDelta: (delta: string) => void;
    onFinalText?: (fullText: string) => void;
    onToolCall: (toolCall: ToolCallState) => void;
    onApprovalRequest?: (request: ApprovalRequest) => void;
    onStatusChange: (status: 'thinking' | 'running_tool' | 'done' | 'error', error?: string) => void;
}

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

export class DshRunner {
    private workspace: string;
    private memoryManager: MemoryManager;
    private sessionManager: SessionManager;
    private activeProcesses: Map<string, ChildProcess> = new Map();
    private pendingApprovals: Map<string, (approved: boolean) => void> = new Map();
    private stoppedSessions: Set<string> = new Set();

    constructor(
        workspace: string,
        memoryManager: MemoryManager,
        sessionManager: SessionManager
    ) {
        this.workspace = workspace;
        this.memoryManager = memoryManager;
        this.sessionManager = sessionManager;
    }

    public isRunning(sessionId: string): boolean {
        return this.activeProcesses.has(sessionId);
    }

    public handleApproval(sessionId: string, _approvalId: string, approved: boolean): boolean {
        // 当前底层采用 dsh --profile headless 执行，官方契约为单轮非交互执行器，不支持运行时向 stdin 注入确认；
        // 此处保留审批状态解析器接口以符合完整协议契约，供未来接入 ACP 交互式长连接通道时无缝挂接。
        const resolver = this.pendingApprovals.get(sessionId);
        if (resolver) {
            resolver(approved);
            this.pendingApprovals.delete(sessionId);
            return true;
        }
        return false;
    }

    public stop(sessionId: string): boolean {
        // 将会话中进行中的助理消息状态终态化为 error，避免离线重连客户端一直悬挂思考动画
        const session = this.sessionManager.getOrCreateSession(sessionId);
        const lastMsg = session.messages[session.messages.length - 1];
        if (lastMsg && lastMsg.status === 'processing') {
            this.sessionManager.updateMessage(sessionId, lastMsg.id, (m) => {
                m.status = 'error';
                m.errorMessage = '任务已被手动终止';
            });
        }

        const proc = this.activeProcesses.get(sessionId);
        if (proc) {
            this.stoppedSessions.add(sessionId);
            this.sessionManager.setTaskState(sessionId, 'stopped');
            try {
                let exited = false;
                const killTimer = setTimeout(() => {
                    if (!exited && proc.exitCode === null) {
                        try {
                            proc.kill('SIGKILL');
                        } catch {
                            // ignore
                        }
                    }
                }, 2000);

                proc.once('close', () => {
                    exited = true;
                    clearTimeout(killTimer);
                    this.activeProcesses.delete(sessionId);
                });

                if (proc.exitCode === null) {
                    proc.kill('SIGINT');
                } else {
                    exited = true;
                    clearTimeout(killTimer);
                    this.activeProcesses.delete(sessionId);
                }
            } catch (err) {
                console.warn(`[DshRunner] 终止进程失败: ${err}`);
                this.activeProcesses.delete(sessionId);
            }
            return true;
        }
        return false;
    }

    public async stopAll(): Promise<void> {
        const sessionIds = Array.from(this.activeProcesses.keys());
        if (sessionIds.length === 0) return;

        const promises = sessionIds.map((sessionId) => {
            return new Promise<void>((resolve) => {
                const proc = this.activeProcesses.get(sessionId);
                if (!proc || proc.exitCode !== null) {
                    this.stop(sessionId);
                    resolve();
                    return;
                }

                let resolved = false;
                const done = () => {
                    if (!resolved) {
                        resolved = true;
                        resolve();
                    }
                };

                proc.once('close', done);
                this.stop(sessionId);

                // 2.5 秒超时兜底，保证主服务停机绝不挂起
                setTimeout(done, 2500);
            });
        });

        await Promise.all(promises);
    }

    public async execute(
        sessionId: string,
        assistantMessageId: string,
        userPrompt: string,
        callbacks: RunnerCallbacks
    ): Promise<void> {
        if (this.isRunning(sessionId)) {
            // 已有进程在运行，不修改当前会话状态，直接返回
            return;
        }

        this.sessionManager.setTaskState(sessionId, 'processing');
        callbacks.onStatusChange('thinking');

        // 加载记忆与全局人设
        const memoryContext = this.memoryManager.loadContext();
        const systemSections = [
            memoryContext.soul ? `[系统背景]\n${memoryContext.soul}` : '',
            memoryContext.memory ? `[主人记忆]\n${memoryContext.memory}` : '',
            memoryContext.user ? `[主人档案]\n${memoryContext.user}` : '',
        ].filter(Boolean).join('\n\n');

        const systemInstructions = systemSections;

        const fullPrompt = `[系统人设与主人记忆背景]
${systemInstructions}

[主人当前提问与指令]
${userPrompt}`;

        // 检查当前会话是否已有持久化的 dshSessionId
        const dshSessionId = this.sessionManager.getDshSessionId(sessionId);

        // 解析服务端本地安装的 @deepseek-ai/dsh，优先调用本地已编译/安装的二进制或 JS 入口
        const { command: dshCommand, argsPrefix } = resolveDshInvocation();

        // 调用 dsh --profile headless 执行，
        // 若已有 dshSessionId 则传入 --session-id 接续多轮对话，若为首轮则不传由 dsh 自动新建；
        // 通过 stdin 管道以 '-' 传参，避免在命令行参数中暴露人设与提问，同时消除命令行长度限制
        const dshArgs = [
            ...argsPrefix,
            '--profile',
            'headless',
        ];

        if (dshSessionId) {
            dshArgs.push('--session-id', dshSessionId);
        }

        dshArgs.push('--json', '-');

        console.log(`[DshRunner] 在工作区 ${this.workspace} 启动任务 (执行命令: ${dshCommand}, 会话: ${sessionId}, dshSession: ${dshSessionId || '新会话'})...`);

        try {
            const child = spawn(dshCommand, dshArgs, {
                cwd: this.workspace,
                env: {
                    ...process.env,
                    DSH_WORKSPACE: this.workspace,
                    DSH_SYSTEM_PROMPT: systemInstructions,
                    DEEPSEEK_SYSTEM_PROMPT: systemInstructions,
                },
                shell: false,
            });

            this.activeProcesses.set(sessionId, child);

            // 监听 child.stdin 错误事件，防止子进程秒退导致主进程抛出未捕获的 EPIPE 异常闪退
            if (child.stdin) {
                child.stdin.on('error', (stdinErr) => {
                    console.warn(`[DshRunner] stdin 管道发生异常 (子进程可能已提前退出): ${stdinErr}`);
                });

                // 将提示词与记忆通过 stdin 写入，不在 argv 中暴露私密指令，解除命令行参数长度限制
                if (!child.stdin.destroyed) {
                    try {
                        child.stdin.write(fullPrompt);
                        child.stdin.end();
                    } catch (writeErr) {
                        console.warn(`[DshRunner] 写入 stdin 失败: ${writeErr}`);
                    }
                }
            }

            let stdoutAcc = '';
            let stderrAcc = '';
            let stdoutBuffer = '';
            let finalFullText = '';
            const committedTextSegments: string[] = [];
            const stdoutDecoder = new StringDecoder('utf8');
            const stderrDecoder = new StringDecoder('utf8');
            let currentToolCall: ToolCallState | null = null;
            let toolSeq = 0;

            const finalizeCurrentTool = (finalStatus: 'done' | 'failed' = 'done') => {
                if (currentToolCall && currentToolCall.status === 'running') {
                    currentToolCall.status = finalStatus;
                    callbacks.onToolCall({ ...currentToolCall });
                    currentToolCall = null;
                }
            };

            const processLine = async (line: string) => {
                const trimmedLine = line.trim();
                if (!trimmedLine) return;

                let isJsonEvent = false;
                if (trimmedLine.startsWith('{') && trimmedLine.endsWith('}')) {
                    try {
                        const evt = JSON.parse(trimmedLine) as Record<string, unknown>;
                        isJsonEvent = true;

                        if (evt.type === 'session' && typeof evt.sessionId === 'string' && evt.sessionId) {
                            // 捕获 dsh 分配的真实会话 ID，并持久化到会话数据中
                            this.sessionManager.setDshSessionId(sessionId, evt.sessionId);
                        } else if (evt.type === 'text' && typeof evt.text === 'string') {
                            if (currentToolCall && currentToolCall.status === 'running') {
                                finalizeCurrentTool('done');
                            }
                            committedTextSegments.push(evt.text);
                            callbacks.onDelta(evt.text);
                        } else if (evt.type === 'thinking' && typeof evt.text === 'string') {
                            callbacks.onStatusChange('thinking');
                        } else if (evt.type === 'tool_call') {
                            if (currentToolCall && currentToolCall.status === 'running') {
                                finalizeCurrentTool('done');
                            }
                            toolSeq++;
                            const toolName = typeof evt.tool === 'string' ? evt.tool : '系统工具';
                            const toolInput = evt.input ? JSON.stringify(evt.input).slice(0, 100) : '';
                            currentToolCall = {
                                id: typeof evt.callId === 'string' ? evt.callId : `tool-${sessionId}-${toolSeq}`,
                                name: toolName,
                                status: 'running',
                                summary: toolInput || toolName,
                            };
                            callbacks.onToolCall({ ...currentToolCall });
                            callbacks.onStatusChange('running_tool');
                        } else if (evt.type === 'tool_result') {
                            if (currentToolCall) {
                                const isErr = evt.status === 'error';
                                finalizeCurrentTool(isErr ? 'failed' : 'done');
                            }
                        } else if (evt.type === 'status') {
                            if (evt.phase === 'turn_start' || evt.phase === 'step_start') {
                                callbacks.onStatusChange('thinking');
                            }
                        } else if (evt.type === 'final' && typeof evt.text === 'string' && evt.text) {
                            // 官方 headless 协议中，每个 text 事件代表已提交的 assistant 消息；
                            // 终态 final 事件的 text 是最后一个非空 assistant 文本的无损副本（长文本 >8KiB 在 text 事件会被截断）；
                            // 需完整保留工具调用前已提交的前置文本段，仅使用 final 替换终端可能被截断的最后一段
                            const priorText =
                                committedTextSegments.length > 1
                                    ? committedTextSegments.slice(0, -1).join('')
                                    : '';
                            finalFullText = priorText + evt.text;
                            if (callbacks.onFinalText) {
                                callbacks.onFinalText(finalFullText);
                            }
                        } else if (evt.type === 'error' && typeof evt.message === 'string') {
                            callbacks.onDelta(`\n\n> ⚠️ [执行反馈]：${evt.message}`);
                            callbacks.onStatusChange('error', evt.message);
                        }
                    } catch {
                        isJsonEvent = false;
                    }
                }

                if (!isJsonEvent) {
                    // 识别常规工具调用流式标记
                    if (trimmedLine.includes('[Tool]') || trimmedLine.includes('Running tool')) {
                        if (currentToolCall && currentToolCall.status === 'running') {
                            finalizeCurrentTool('done');
                        }
                        toolSeq++;
                        currentToolCall = {
                            id: `tool-${sessionId}-${toolSeq}`,
                            name: '系统工具',
                            status: 'running',
                            summary: trimmedLine.slice(0, 100),
                        };
                        callbacks.onToolCall({ ...currentToolCall });
                        callbacks.onStatusChange('running_tool');
                    } else {
                        if (currentToolCall && currentToolCall.status === 'running') {
                            finalizeCurrentTool('done');
                        }
                        callbacks.onDelta(trimmedLine + '\n');
                    }
                }
            };

            child.stdout?.on('data', async (chunk: Buffer) => {
                // 使用 StringDecoder 解码，避免汉字等 UTF-8 多字节字符被 chunk 边界截断导致乱码
                const text = stdoutDecoder.write(chunk);
                // 限制内存累加器上限为 1000 字符，用于每日日志记录，同时防止长任务无上限膨胀内存
                if (stdoutAcc.length < 1000) {
                    stdoutAcc = (stdoutAcc + text).slice(0, 1000);
                }
                stdoutBuffer += text;

                // 跨 chunk 完整换行解析，防止跨包拆分导致 JSON 解析截断
                const lines = stdoutBuffer.split('\n');
                stdoutBuffer = lines.pop() ?? '';

                for (const line of lines) {
                    await processLine(line);
                }
            });

            child.stderr?.on('data', (chunk: Buffer) => {
                const text = stderrDecoder.write(chunk);
                if (stderrAcc.length < 1000) {
                    stderrAcc = (stderrAcc + text).slice(0, 1000);
                }
                console.log(`[DshRunner:stderr] ${text.trim()}`);
            });

            await new Promise<void>((resolve) => {
                child.on('close', async (code: number | null) => {
                    const remainingStdout = stdoutDecoder.end();
                    if (remainingStdout) {
                        stdoutAcc += remainingStdout;
                        stdoutBuffer += remainingStdout;
                    }
                    stderrDecoder.end();

                    if (stdoutBuffer.trim()) {
                        await processLine(stdoutBuffer);
                        stdoutBuffer = '';
                    }

                    finalizeCurrentTool(code === 0 ? 'done' : 'failed');
                    this.activeProcesses.delete(sessionId);
                    console.log(`[DshRunner] 进程退出，退出码: ${code}`);

                    // 如果是用户主动停止，保持 stopped 状态，不覆盖为 error
                    if (this.stoppedSessions.has(sessionId)) {
                        this.stoppedSessions.delete(sessionId);
                        this.sessionManager.setTaskState(sessionId, 'stopped');
                        resolve();
                        return;
                    }

                    if (code === 0) {
                        callbacks.onStatusChange('done');
                        this.sessionManager.setTaskState(sessionId, 'completed');
                        // 记录流水日志（包裹异常保护，优先采用 final 完整终态文本）
                        try {
                            const recordedAnswer = (finalFullText || stdoutAcc).trim().slice(0, 300);
                            this.memoryManager.appendDailyLog(
                                '对话与任务完成',
                                `问：${userPrompt}\n答：${recordedAnswer}...`
                            );
                        } catch (logErr) {
                            console.warn(`[DshRunner] 写入每日流水失败 (非致命): ${logErr}`);
                        }
                    } else if (code === null || child.killed) {
                        this.sessionManager.setTaskState(sessionId, 'stopped');
                    } else {
                        // 进程非零退出（例如缺失 API Key 等）
                        const errMsg = stderrAcc.trim() || `执行失败，退出码: ${code}`;
                        callbacks.onDelta(
                            `\n\n> ⚠️ [执行反馈]：${errMsg}\n> 提示：如需调用云端大模型，请确保服务端已配置 DEEPSEEK_API_KEY。`
                        );
                        callbacks.onStatusChange('error', errMsg);
                        this.sessionManager.setTaskState(sessionId, 'error');
                    }
                    resolve();
                });

                child.on('error', (err: Error) => {
                    finalizeCurrentTool('failed');
                    this.activeProcesses.delete(sessionId);
                    if (this.stoppedSessions.has(sessionId)) {
                        this.stoppedSessions.delete(sessionId);
                        this.sessionManager.setTaskState(sessionId, 'stopped');
                        resolve();
                        return;
                    }
                    console.error(`[DshRunner] 子进程发生错误:`, err);
                    callbacks.onStatusChange('error', err.message);
                    this.sessionManager.setTaskState(sessionId, 'error');
                    resolve();
                });
            });
        } catch (err: unknown) {
            this.activeProcesses.delete(sessionId);
            const msg = err instanceof Error ? err.message : String(err);
            callbacks.onStatusChange('error', msg);
            this.sessionManager.setTaskState(sessionId, 'error');
        }
    }
}
