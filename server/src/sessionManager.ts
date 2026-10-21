import fs from 'node:fs';
import path from 'node:path';
import { AssistantMessage, TaskExecutionState, ApprovalRequest, ToolCallState } from './protocol.js';

export interface SessionData {
    sessionId: string;
    currentSeq: number;
    messages: AssistantMessage[];
    taskState: TaskExecutionState;
    pendingApproval?: ApprovalRequest;
    updatedAt: number;
}

export class SessionManager {
    private dataDir: string;
    private sessionsDir: string;
    private sessions: Map<string, SessionData> = new Map();

    constructor(dataDir: string) {
        this.dataDir = dataDir;
        this.sessionsDir = path.join(this.dataDir, 'sessions');
        if (!fs.existsSync(this.sessionsDir)) {
            fs.mkdirSync(this.sessionsDir, { recursive: true });
        }
        this.loadAll();
    }

    private loadAll(): void {
        try {
            const files = fs.readdirSync(this.sessionsDir);
            for (const file of files) {
                if (file.endsWith('.json')) {
                    const filePath = path.join(this.sessionsDir, file);
                    const raw = fs.readFileSync(filePath, 'utf8');
                    const session = JSON.parse(raw) as SessionData;
                    // 如果服务重启时处于 processing 状态，重置为 stopped 或 error 状态，防止手机端永远悬挂加载
                    if (session.taskState === 'processing') {
                        session.taskState = 'stopped';
                    }
                    this.sessions.set(session.sessionId, session);
                }
            }
        } catch (err) {
            console.warn(`[SessionManager] 加载持久化会话失败: ${err}`);
        }
    }

    public getOrCreateSession(sessionId = 'main'): SessionData {
        let session = this.sessions.get(sessionId);
        if (!session) {
            session = {
                sessionId,
                currentSeq: 0,
                messages: [],
                taskState: 'idle',
                updatedAt: Date.now(),
            };
            this.sessions.set(sessionId, session);
            this.persistSession(session);
        }
        return session;
    }

    public persistSession(session: SessionData): void {
        session.updatedAt = Date.now();
        const filePath = path.join(this.sessionsDir, `${session.sessionId}.json`);
        try {
            fs.writeFileSync(filePath, JSON.stringify(session, null, 2), 'utf8');
        } catch (err) {
            console.error(`[SessionManager] 保存会话 ${session.sessionId} 失败: ${err}`);
        }
    }

    public nextSeq(sessionId: string): number {
        const session = this.getOrCreateSession(sessionId);
        session.currentSeq += 1;
        this.persistSession(session);
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
        this.persistSession(session);
        return fullMsg;
    }

    public updateMessage(
        sessionId: string,
        messageId: string,
        updater: (msg: AssistantMessage) => void
    ): AssistantMessage | undefined {
        const session = this.getOrCreateSession(sessionId);
        const msg = session.messages.find((m) => m.id === messageId);
        if (msg) {
            updater(msg);
            this.persistSession(session);
        }
        return msg;
    }

    public appendDelta(
        sessionId: string,
        messageId: string,
        delta: string
    ): AssistantMessage | undefined {
        return this.updateMessage(sessionId, messageId, (msg) => {
            msg.content += delta;
            msg.status = 'processing';
        });
    }

    public setToolCall(
        sessionId: string,
        messageId: string,
        toolCall: ToolCallState
    ): AssistantMessage | undefined {
        return this.updateMessage(sessionId, messageId, (msg) => {
            if (!msg.toolCalls) {
                msg.toolCalls = [];
            }
            const existingIdx = msg.toolCalls.findIndex((t) => t.id === toolCall.id);
            if (existingIdx >= 0) {
                msg.toolCalls[existingIdx] = toolCall;
            } else {
                msg.toolCalls.push(toolCall);
            }
        });
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

    public getReconcileData(
        sessionId: string,
        _lastSeq: number
    ): {
        messages: AssistantMessage[];
        taskState: TaskExecutionState;
        pendingApproval?: ApprovalRequest;
        currentSeq: number;
    } {
        const session = this.getOrCreateSession(sessionId);
        // 如果客户端是全新的（lastSeq <= 0），返回全部消息；如果客户端已有一部分，返回 seq > lastSeq 的消息或全量消息
        return {
            messages: session.messages,
            taskState: session.taskState,
            pendingApproval: session.pendingApproval,
            currentSeq: session.currentSeq,
        };
    }
}
