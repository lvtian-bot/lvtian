import { spawn, ChildProcess } from 'node:child_process';
import { MemoryManager } from './memoryManager.js';
import { SessionManager } from './sessionManager.js';
import { ToolCallState, ApprovalRequest } from './protocol.js';

export interface RunnerCallbacks {
    onDelta: (delta: string) => void;
    onToolCall: (toolCall: ToolCallState) => void;
    onApprovalRequest?: (request: ApprovalRequest) => void;
    onStatusChange: (status: 'thinking' | 'running_tool' | 'done' | 'error', error?: string) => void;
}

export class DshRunner {
    private workspace: string;
    private memoryManager: MemoryManager;
    private sessionManager: SessionManager;
    private activeProcesses: Map<string, ChildProcess> = new Map();
    private pendingApprovals: Map<string, (approved: boolean) => void> = new Map();

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
        const resolver = this.pendingApprovals.get(sessionId);
        const proc = this.activeProcesses.get(sessionId);
        if (resolver) {
            resolver(approved);
            this.pendingApprovals.delete(sessionId);
            return true;
        }
        if (proc && proc.stdin && !proc.stdin.destroyed) {
            proc.stdin.write(approved ? 'y\n' : 'n\n');
            return true;
        }
        return false;
    }

    public stop(sessionId: string): boolean {
        const proc = this.activeProcesses.get(sessionId);
        if (proc) {
            this.sessionManager.setTaskState(sessionId, 'stopped');
            try {
                proc.kill('SIGINT');
                const killTimer = setTimeout(() => {
                    if (proc.exitCode === null && !proc.killed) {
                        try {
                            proc.kill('SIGKILL');
                        } catch {
                            // ignore
                        }
                    }
                }, 2000);

                proc.once('close', () => {
                    clearTimeout(killTimer);
                    this.activeProcesses.delete(sessionId);
                });
            } catch (err) {
                console.warn(`[DshRunner] 终止进程失败: ${err}`);
                this.activeProcesses.delete(sessionId);
            }
            return true;
        }
        return false;
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
        const systemInstructions = `[系统背景]
${memoryContext.soul}

[主人记忆]
${memoryContext.memory}

[主人档案]
${memoryContext.user}
`;

        // 尝试调用 npx @deepseek-ai/dsh --profile headless 执行，
        // 如当前环境缺失 API Key 或外部模型连接，提供优雅的降级与清晰提示
        const dshArgs = [
            '-y',
            '@deepseek-ai/dsh',
            '--profile',
            'headless',
            userPrompt,
        ];

        console.log(`[DshRunner] 在工作区 ${this.workspace} 启动任务...`);

        try {
            const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
            const child = spawn(npxCmd, dshArgs, {
                cwd: this.workspace,
                env: {
                    ...process.env,
                    DSH_WORKSPACE: this.workspace,
                    LVIAN_SYSTEM_PROMPT: systemInstructions,
                },
                shell: false,
            });

            this.activeProcesses.set(sessionId, child);

            let stdoutAcc = '';
            let stderrAcc = '';
            let currentToolCall: ToolCallState | null = null;
            let toolSeq = 0;

            const finalizeCurrentTool = (finalStatus: 'done' | 'failed' = 'done') => {
                if (currentToolCall && currentToolCall.status === 'running') {
                    currentToolCall.status = finalStatus;
                    callbacks.onToolCall({ ...currentToolCall });
                    currentToolCall = null;
                }
            };

            child.stdout?.on('data', async (chunk: Buffer) => {
                const text = chunk.toString('utf8');
                stdoutAcc += text;

                // 识别审批请求提示（例如 [y/N] 或需要人工确认的特定标记）
                const approvalMatch = text.match(/\[APPROVAL_REQUIRED:([^:]+):([^\]]+)\]/i);
                const isInteractiveConfirm = !approvalMatch && (text.includes('确认执行') && text.includes('[y/n]'));

                if ((approvalMatch || isInteractiveConfirm) && callbacks.onApprovalRequest) {
                    const approvalId = `appr-${Date.now()}`;
                    const toolName = approvalMatch ? approvalMatch[1] : '系统指令';
                    const prompt = approvalMatch ? approvalMatch[2] : '助手请求确认执行高风险操作，是否同意？';

                    callbacks.onApprovalRequest({
                        approvalId,
                        toolName,
                        prompt,
                        status: 'pending',
                    });
                    callbacks.onStatusChange('running_tool');

                    const approved = await new Promise<boolean>((resolve) => {
                        this.pendingApprovals.set(sessionId, resolve);
                    });
                    this.pendingApprovals.delete(sessionId);

                    if (child.stdin && !child.stdin.destroyed) {
                        child.stdin.write(approved ? 'y\n' : 'n\n');
                    }
                    return;
                }

                // 识别工具调用流式标记
                if (text.includes('[Tool]') || text.includes('Running tool')) {
                    if (currentToolCall && currentToolCall.status === 'running') {
                        finalizeCurrentTool('done');
                    }
                    toolSeq++;
                    currentToolCall = {
                        id: `tool-${sessionId}-${toolSeq}`,
                        name: '系统工具',
                        status: 'running',
                        summary: text.trim().slice(0, 100),
                    };
                    callbacks.onToolCall({ ...currentToolCall });
                    callbacks.onStatusChange('running_tool');
                } else {
                    if (currentToolCall && currentToolCall.status === 'running') {
                        finalizeCurrentTool('done');
                    }
                    callbacks.onDelta(text);
                }
            });

            child.stderr?.on('data', (chunk: Buffer) => {
                const text = chunk.toString('utf8');
                stderrAcc += text;
                console.log(`[DshRunner:stderr] ${text.trim()}`);
            });

            await new Promise<void>((resolve) => {
                child.on('close', (code: number | null) => {
                    finalizeCurrentTool(code === 0 ? 'done' : 'failed');
                    this.activeProcesses.delete(sessionId);
                    console.log(`[DshRunner] 进程退出，退出码: ${code}`);

                    if (code === 0) {
                        callbacks.onStatusChange('done');
                        this.sessionManager.setTaskState(sessionId, 'completed');
                        // 记录流水日志
                        this.memoryManager.appendDailyLog(
                            '对话与任务完成',
                            `问：${userPrompt}\n答：${stdoutAcc.trim().slice(0, 300)}...`
                        );
                    } else if (code === null || child.killed) {
                        callbacks.onStatusChange('error', '任务已被用户停止');
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
