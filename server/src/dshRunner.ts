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

    public stop(sessionId: string): boolean {
        const proc = this.activeProcesses.get(sessionId);
        if (proc) {
            try {
                proc.kill('SIGINT');
                setTimeout(() => {
                    if (this.activeProcesses.has(sessionId)) {
                        proc.kill('SIGKILL');
                    }
                }, 2000);
            } catch (err) {
                console.warn(`[DshRunner] 终止进程失败: ${err}`);
            }
            this.activeProcesses.delete(sessionId);
            this.sessionManager.setTaskState(sessionId, 'stopped');
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
            callbacks.onStatusChange('error', '上一个任务正在执行中，请稍候或点击停止');
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
            const child = spawn('npx', dshArgs, {
                cwd: this.workspace,
                env: {
                    ...process.env,
                    DSH_WORKSPACE: this.workspace,
                    LVIAN_SYSTEM_PROMPT: systemInstructions,
                },
                shell: true,
            });

            this.activeProcesses.set(sessionId, child);

            let stdoutAcc = '';
            let stderrAcc = '';

            child.stdout?.on('data', (chunk: Buffer) => {
                const text = chunk.toString('utf8');
                stdoutAcc += text;

                // 简单的流式匹配：识别是否正在调用工具
                if (text.includes('[Tool]') || text.includes('Running tool')) {
                    const toolCall: ToolCallState = {
                        id: `tool-${Date.now()}`,
                        name: '系统工具',
                        status: 'running',
                        summary: text.trim().slice(0, 100),
                    };
                    callbacks.onToolCall(toolCall);
                    callbacks.onStatusChange('running_tool');
                } else {
                    callbacks.onDelta(text);
                }
            });

            child.stderr?.on('data', (chunk: Buffer) => {
                const text = chunk.toString('utf8');
                stderrAcc += text;
                // 部分诊断信息可能通过 stderr 输出
                console.log(`[DshRunner:stderr] ${text.trim()}`);
            });

            await new Promise<void>((resolve) => {
                child.on('close', (code: number | null) => {
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
