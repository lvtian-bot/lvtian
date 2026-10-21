import fs from 'node:fs';
import path from 'node:path';
import { AssistantMessage, TaskExecutionState, ApprovalRequest, ToolCallState } from './protocol.js';

export interface SessionData {
    sessionId: string;
    currentSeq: number;
    messages: AssistantMessage[];
    taskState: TaskExecutionState;
    pendingApproval?: ApprovalRequest;
    dshSessionId?: string;
    updatedAt: number;
}

export class SessionManager {
    private dataDir: string;
    private sessionsDir: string;
    private sessions: Map<string, SessionData> = new Map();
    private writeTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

    constructor(dataDir: string) {
        this.dataDir = dataDir;
        this.sessionsDir = path.join(this.dataDir, 'sessions');
        if (!fs.existsSync(this.sessionsDir)) {
            fs.mkdirSync(this.sessionsDir, { recursive: true, mode: 0o700 });
        }
        try {
            fs.chmodSync(this.sessionsDir, 0o700);
        } catch {
            // ignore
        }
        this.loadAll();
    }

    private getSafeSessionPath(sessionId: string): string {
        if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
            throw new Error(`非法会话 ID: ${sessionId}`);
        }
        const resolved = path.resolve(this.sessionsDir, `${sessionId}.json`);
        if (!resolved.startsWith(path.resolve(this.sessionsDir))) {
            throw new Error(`非法路径穿越: ${sessionId}`);
        }
        return resolved;
    }

    private loadAll(): void {
        let files: string[] = [];
        try {
            files = fs.readdirSync(this.sessionsDir);
        } catch (err) {
            console.warn(`[SessionManager] 读取会话目录失败: ${err}`);
            return;
        }

        for (const file of files) {
            if (!file.endsWith('.json')) continue;
            try {
                const filePath = path.join(this.sessionsDir, file);
                const raw = fs.readFileSync(filePath, 'utf8');
                const session = JSON.parse(raw) as SessionData;
                // 如果服务重启时处于 processing 或 awaiting_approval 状态，重置为 stopped 状态，并修补中断中的消息
                let modified = false;
                if (session.taskState === 'processing' || session.taskState === 'awaiting_approval') {
                    session.taskState = 'stopped';
                    session.pendingApproval = undefined;
                    modified = true;
                }

                for (const m of session.messages) {
                    if (m.status === 'processing') {
                        m.status = 'error';
                        m.content = m.content
                            ? `${m.content}\n\n⚠️ [任务中断：服务已重启]`
                            : '⚠️ 服务已重启，前序执行已中断';
                        // 同步推进 seq 与 currentSeq，确保客户端重连增量同步能感知此修补
                        session.currentSeq += 1;
                        m.seq = session.currentSeq;
                        modified = true;
                    }
                }
                if (modified) {
                    this.persistSession(session, true);
                }
                this.sessions.set(session.sessionId, session);
            } catch (fileErr) {
                console.warn(`[SessionManager] 加载单个会话文件 ${file} 失败 (已跳过以保护其余正常会话): ${fileErr}`);
            }
        }
    }

    public getOrCreateSession(sessionId = 'main'): SessionData {
        const safeSessionId = /^[a-zA-Z0-9_-]+$/.test(sessionId) ? sessionId : 'main';
        let session = this.sessions.get(safeSessionId);
        if (!session) {
            session = {
                sessionId: safeSessionId,
                currentSeq: 0,
                messages: [],
                taskState: 'idle',
                updatedAt: Date.now(),
            };
            this.sessions.set(safeSessionId, session);
            this.persistSession(session, true);
        }
        return session;
    }

    public persistSession(session: SessionData, immediate = true): void {
        session.updatedAt = Date.now();

        const writeNow = () => {
            try {
                const filePath = this.getSafeSessionPath(session.sessionId);
                const tmpPath = `${filePath}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`;
                fs.writeFileSync(tmpPath, JSON.stringify(session, null, 2), { encoding: 'utf8', mode: 0o600 });
                try {
                    fs.chmodSync(tmpPath, 0o600);
                } catch {
                    // ignore
                }
                fs.renameSync(tmpPath, filePath);
            } catch (err) {
                console.error(`[SessionManager] 保存会话 ${session.sessionId} 失败: ${err}`);
            }
        };

        if (immediate) {
            const timer = this.writeTimers.get(session.sessionId);
            if (timer) {
                clearTimeout(timer);
                this.writeTimers.delete(session.sessionId);
            }
            writeNow();
        } else {
            // 防抖落盘，避免高频流式 chunk 频繁同步阻塞事件循环
            if (!this.writeTimers.has(session.sessionId)) {
                const timer = setTimeout(() => {
                    this.writeTimers.delete(session.sessionId);
                    writeNow();
                }, 300);
                this.writeTimers.set(session.sessionId, timer);
            }
        }
    }

    public nextSeq(sessionId: string): number {
        const session = this.getOrCreateSession(sessionId);
        session.currentSeq += 1;
        this.persistSession(session, true);
        return session.currentSeq;
    }

    public addMessage(
        sessionId: string,
        msg: Omit<AssistantMessage, 'seq'>
    ): AssistantMessage {
        const session = this.getOrCreateSession(sessionId);
        const seq = this.nextSeq(sessionId);
        const fullMsg: AssistantMessage = {
            ...msg,
            seq,
        };
        session.messages.push(fullMsg);
        this.persistSession(session, true);
        return fullMsg;
    }

    public updateMessage(
        sessionId: string,
        messageId: string,
        updater: (msg: AssistantMessage) => void,
        advanceSeq = true,
        immediatePersist = true
    ): AssistantMessage | undefined {
        const session = this.getOrCreateSession(sessionId);
        const msg = session.messages.find((m) => m.id === messageId);
        if (msg) {
            updater(msg);
            if (advanceSeq) {
                session.currentSeq += 1;
                msg.seq = session.currentSeq;
            }
            this.persistSession(session, immediatePersist);
        }
        return msg;
    }

    public appendDelta(
        sessionId: string,
        messageId: string,
        delta: string
    ): AssistantMessage | undefined {
        // 流式追加时递增 seq 保证断网重连能拉到最新消息，同时使用防抖落盘
        return this.updateMessage(
            sessionId,
            messageId,
            (msg) => {
                msg.content += delta;
                msg.status = 'processing';
            },
            true,
            false
        );
    }

    public setToolCall(
        sessionId: string,
        messageId: string,
        toolCall: ToolCallState
    ): AssistantMessage | undefined {
        return this.updateMessage(
            sessionId,
            messageId,
            (msg) => {
                if (!msg.toolCalls) {
                    msg.toolCalls = [];
                }
                const existingIdx = msg.toolCalls.findIndex((t) => t.id === toolCall.id);
                if (existingIdx >= 0) {
                    msg.toolCalls[existingIdx] = toolCall;
                } else {
                    msg.toolCalls.push(toolCall);
                }
            },
            true,
            true
        );
    }

    public setTaskState(
        sessionId: string,
        state: TaskExecutionState,
        approval?: ApprovalRequest
    ): number {
        const session = this.getOrCreateSession(sessionId);
        session.taskState = state;
        session.pendingApproval = approval;
        const seq = this.nextSeq(sessionId);
        this.persistSession(session);
        return seq;
    }

    public getPendingApproval(sessionId: string): ApprovalRequest | undefined {
        const session = this.getOrCreateSession(sessionId);
        return session.pendingApproval;
    }

    public clearPendingApproval(sessionId: string): void {
        const session = this.getOrCreateSession(sessionId);
        session.pendingApproval = undefined;
        this.persistSession(session);
    }

    public setDshSessionId(sessionId: string, dshSessionId: string): void {
        const session = this.getOrCreateSession(sessionId);
        session.dshSessionId = dshSessionId;
        this.persistSession(session, true);
    }

    public getDshSessionId(sessionId: string): string | undefined {
        const session = this.getOrCreateSession(sessionId);
        return session.dshSessionId;
    }

    public getReconcileData(
        sessionId: string,
        lastSeq: number
    ): {
        messages: AssistantMessage[];
        taskState: TaskExecutionState;
        pendingApproval?: ApprovalRequest;
        currentSeq: number;
    } {
        const session = this.getOrCreateSession(sessionId);
        // 如果客户端是初次同步（lastSeq <= 0），返回全部消息；如果增量同步，返回当前会话中大于 lastSeq 的消息
        const messages = lastSeq > 0
            ? session.messages.filter((m) => (m.seq ?? 0) > lastSeq)
            : session.messages;

        return {
            messages,
            taskState: session.taskState,
            pendingApproval: session.pendingApproval,
            currentSeq: session.currentSeq,
        };
    }
}
