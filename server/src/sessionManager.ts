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

/**
 * 会话事件日志：一行一个 JSON 事件，只追加不重写。
 * 写入代价与历史长度无关，替代原先「每次全量重写整个会话 JSON」的写入方式。
 * - msg   ：整条消息的新增或更新（含最新 seq）
 * - delta ：流式增量（防抖合并后落盘，重放时按 id 追加到 content）
 * - state ：任务状态与待审批卡变更
 * - dsh   ：dsh 会话 ID 绑定
 * - seq   ：纯序号推进（无消息体变化）
 * - snapshot：全量快照，只会作为某个日志文件的首行出现（建会话或轮换时写入）
 */
type SessionLogEvent =
    | { t: 'snapshot'; at: number; seq: number; taskState: TaskExecutionState; approval?: ApprovalRequest | null; dshSessionId?: string; msgs: AssistantMessage[] }
    | { t: 'msg'; at: number; seq: number; m: AssistantMessage }
    | { t: 'delta'; at: number; seq: number; id: string; d: string }
    | { t: 'state'; at: number; seq: number; taskState: TaskExecutionState; approval?: ApprovalRequest | null }
    | { t: 'dsh'; at: number; dshSessionId: string }
    | { t: 'seq'; at: number; seq: number };

const ACTIVE_LOG = 'events.jsonl';
const SEGMENT_PREFIX = 'seg.';
const TMP_LOG = 'events.jsonl.tmp';
/** 活跃日志超过该体积时轮换：旧日志封存为不可变分段，新日志以全量快照开头；可用环境变量覆盖（测试用小阈值轻量触发） */
const DEFAULT_ROTATE_THRESHOLD_BYTES = 4 * 1024 * 1024;
/** 流式增量防抖合并窗口 */
const DELTA_FLUSH_MS = 300;

interface PendingDelta {
    text: string;
    seq: number;
}

export class SessionManager {
    private dataDir: string;
    private sessionsDir: string;
    private sessions: Map<string, SessionData> = new Map();
    /** 轮换阈值（字节），构造时从环境变量 LVTIAN_SESSION_ROTATE_BYTES 读取 */
    private readonly rotateThresholdBytes: number;
    /** 流式增量的防抖落盘定时器（每会话一个） */
    private writeTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
    /** 已在内存生效、尚未落盘的流式增量（会话 → 消息 → 累积文本） */
    private pendingDeltas: Map<string, Map<string, PendingDelta>> = new Map();
    /** 活跃日志文件的累计字节数（用于轮换判定，避免每次追加 statSync） */
    private activeLogBytes: Map<string, number> = new Map();

    constructor(dataDir: string) {
        this.dataDir = dataDir;
        this.sessionsDir = path.join(this.dataDir, 'sessions');
        const envThreshold = Number.parseInt(process.env.LVTIAN_SESSION_ROTATE_BYTES ?? '', 10);
        this.rotateThresholdBytes = Number.isFinite(envThreshold) && envThreshold > 0
            ? envThreshold
            : DEFAULT_ROTATE_THRESHOLD_BYTES;
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

    private getSafeSessionDir(sessionId: string): string {
        this.assertValidSessionId(sessionId);
        const resolved = path.resolve(this.sessionsDir, sessionId);
        if (!resolved.startsWith(path.resolve(this.sessionsDir))) {
            throw new Error(`非法路径穿越: ${sessionId}`);
        }
        return resolved;
    }

    private assertValidSessionId(sessionId: string): void {
        if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
            throw new Error(`非法会话 ID: ${sessionId}`);
        }
    }

    private ensureSessionDir(sessionId: string): string {
        const dir = this.getSafeSessionDir(sessionId);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        }
        return dir;
    }

    private emptySession(sessionId: string): SessionData {
        return {
            sessionId,
            currentSeq: 0,
            messages: [],
            taskState: 'idle',
            updatedAt: Date.now(),
        };
    }

    private buildSnapshotEvent(session: SessionData): SessionLogEvent {
        return {
            t: 'snapshot',
            at: Date.now(),
            seq: session.currentSeq,
            taskState: session.taskState,
            approval: session.pendingApproval ?? null,
            dshSessionId: session.dshSessionId,
            msgs: session.messages,
        };
    }

    private eventLine(ev: SessionLogEvent): string {
        return `${JSON.stringify(ev)}\n`;
    }

    // ------------------------------------------------------------------
    // 加载与重放
    // ------------------------------------------------------------------

    private loadAll(): void {
        let entries: fs.Dirent[] = [];
        try {
            entries = fs.readdirSync(this.sessionsDir, { withFileTypes: true });
        } catch (err) {
            console.warn(`[SessionManager] 读取会话目录失败: ${err}`);
            return;
        }

        // 仅维护标准的事件日志目录，不引入复杂的存量迁移与向下兼容包袱
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            try {
                this.loadFromEventLog(entry.name);
            } catch (err) {
                console.warn(`[SessionManager] 加载会话 ${entry.name} 失败 (已跳过以保护其余正常会话): ${err}`);
            }
        }
    }

    /** 读取并重放一个会话的事件日志，完成重启修复后注册进内存 */
    private loadFromEventLog(sessionId: string): void {
        const dir = this.getSafeSessionDir(sessionId);
        const activePath = path.join(dir, ACTIVE_LOG);
        const tmpPath = path.join(dir, TMP_LOG);

        // 轮换中断保护：如果 activePath 缺失但 tmpPath 存在且完整，说明中断发生在重命名为 active 前夕，转正之
        if (!fs.existsSync(activePath) && fs.existsSync(tmpPath)) {
            try {
                fs.renameSync(tmpPath, activePath);
            } catch {
                // ignore
            }
        } else if (fs.existsSync(tmpPath)) {
            // 常规情况下的陈旧临时文件，清理
            try {
                fs.unlinkSync(tmpPath);
            } catch {
                // ignore
            }
        }

        const session = this.emptySession(sessionId);

        if (fs.existsSync(activePath)) {
            // 常规路径：活跃日志以快照开头，其后事件直接重放即可，旧分段无需读取
            this.replayFile(activePath, session);
        } else {
            // 崩溃极端窗口：活跃日志与临时文件皆未落位，按序重放全部分段重建状态
            const segments = this.listSegments(dir);
            for (const seg of segments) {
                this.replayFile(path.join(dir, seg), session);
            }
            // 重建后立即写入新的合法快照作为活跃日志，防止后续追加缺少快照头
            try {
                const snapLine = this.eventLine(this.buildSnapshotEvent(session));
                fs.writeFileSync(activePath, snapLine, { encoding: 'utf8', mode: 0o600 });
            } catch (err) {
                console.warn(`[SessionManager] 分段重建后写入活跃快照失败: ${err}`);
            }
        }

        this.repairAfterLoad(session);
        this.sessions.set(sessionId, session);
        this.activeLogBytes.set(sessionId, this.calculateActiveGrowthBytes(activePath));
    }

    /** 计算快照之后的增量字节，避免超大快照本身导致无限频繁轮换 */
    private calculateActiveGrowthBytes(activePath: string): number {
        try {
            if (!fs.existsSync(activePath)) return 0;
            const content = fs.readFileSync(activePath, 'utf8');
            const firstNewline = content.indexOf('\n');
            if (firstNewline === -1) {
                return 0; // 仅有首行快照，增量为 0
            }
            return Buffer.byteLength(content.slice(firstNewline + 1), 'utf8');
        } catch {
            return 0;
        }
    }

    private listSegments(dir: string): string[] {
        try {
            return fs
                .readdirSync(dir)
                .filter((f) => f.startsWith(SEGMENT_PREFIX) && f.endsWith('.jsonl'))
                .sort();
        } catch {
            return [];
        }
    }

    /** 逐行重放事件；末行撕裂（崩溃中断写入）时截断清理残余字节，中段解析失败则停止重放保护一致性 */
    private replayFile(filePath: string, session: SessionData): void {
        const raw = fs.readFileSync(filePath, 'utf8');
        const lines = raw.split('\n');
        let validByteLength = 0;
        let hasTornTail = false;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmed = line.trim();
            // 如果是中间空行，计入长度
            if (!trimmed) {
                if (i < lines.length - 1) {
                    validByteLength += Buffer.byteLength(line, 'utf8') + 1; // +1 for '\n'
                }
                continue;
            }
            let ev: SessionLogEvent;
            try {
                ev = JSON.parse(trimmed) as SessionLogEvent;
            } catch (err) {
                if (i === lines.length - 1) {
                    console.warn(`[SessionManager] ${path.basename(filePath)} 末行不完整(疑似崩溃撕裂)，已丢弃并截断文件`);
                    hasTornTail = true;
                } else {
                    console.warn(`[SessionManager] ${path.basename(filePath)} 第 ${i + 1} 行解析失败，停止重放该文件: ${err}`);
                }
                break;
            }
            this.applyEvent(session, ev);
            validByteLength += Buffer.byteLength(line, 'utf8') + 1;
        }

        // 如果末行损坏，截断清理残余字节，确保后续追加始终另起一个合法新行
        if (hasTornTail) {
            try {
                fs.truncateSync(filePath, validByteLength);
            } catch (truncErr) {
                console.warn(`[SessionManager] 截断清理损坏文件尾失败: ${truncErr}`);
            }
        }
    }

    private applyEvent(session: SessionData, ev: SessionLogEvent): void {
        switch (ev.t) {
            case 'snapshot':
                session.currentSeq = ev.seq;
                session.messages = ev.msgs.map((m) => ({ ...m }));
                session.taskState = ev.taskState;
                session.pendingApproval = ev.approval ?? undefined;
                session.dshSessionId = ev.dshSessionId;
                session.updatedAt = ev.at;
                break;
            case 'msg': {
                const idx = session.messages.findIndex((m) => m.id === ev.m.id);
                const copy: AssistantMessage = { ...ev.m };
                if (idx >= 0) {
                    session.messages[idx] = copy;
                } else {
                    session.messages.push(copy);
                }
                session.currentSeq = Math.max(session.currentSeq, ev.seq);
                session.updatedAt = ev.at;
                break;
            }
            case 'delta': {
                const msg = session.messages.find((m) => m.id === ev.id);
                if (msg) {
                    msg.content += ev.d;
                    msg.seq = ev.seq;
                    session.currentSeq = Math.max(session.currentSeq, ev.seq);
                } else {
                    console.warn(`[SessionManager] 重放 delta 事件时找不到消息 ${ev.id}，已跳过`);
                }
                session.updatedAt = ev.at;
                break;
            }
            case 'state':
                session.taskState = ev.taskState;
                session.pendingApproval = ev.approval ?? undefined;
                session.currentSeq = Math.max(session.currentSeq, ev.seq);
                session.updatedAt = ev.at;
                break;
            case 'dsh':
                session.dshSessionId = ev.dshSessionId;
                session.updatedAt = ev.at;
                break;
            case 'seq':
                session.currentSeq = Math.max(session.currentSeq, ev.seq);
                session.updatedAt = ev.at;
                break;
        }
    }

    /**
     * 重启修复：processing/awaiting_approval 重置为 stopped，流式中断的消息标错并推进 seq。
     * 修复结果以事件形式追加落盘，与原全量重写行为等价。
     */
    private repairAfterLoad(session: SessionData): void {
        if (session.taskState === 'processing' || session.taskState === 'awaiting_approval') {
            session.taskState = 'stopped';
            session.pendingApproval = undefined;
            this.appendEvent(session.sessionId, {
                t: 'state',
                at: Date.now(),
                seq: session.currentSeq,
                taskState: session.taskState,
                approval: null,
            });
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
                this.appendEvent(session.sessionId, {
                    t: 'msg',
                    at: Date.now(),
                    seq: m.seq,
                    m,
                });
            }
        }
    }

    // ------------------------------------------------------------------
    // 追加与轮换
    // ------------------------------------------------------------------

    /** 追加一条事件（先冲刷该会话待落盘的流式增量，保证事件顺序） */
    private appendEvent(sessionId: string, ev: SessionLogEvent): boolean {
        this.flushDeltaBuffer(sessionId);
        return this.appendRaw(sessionId, this.eventLine(ev));
    }

    private appendRaw(sessionId: string, line: string): boolean {
        try {
            this.assertValidSessionId(sessionId);
            const dir = this.ensureSessionDir(sessionId);
            const activePath = path.join(dir, ACTIVE_LOG);
            fs.appendFileSync(activePath, line, { encoding: 'utf8', mode: 0o600 });
            const bytes = (this.activeLogBytes.get(sessionId) ?? 0) + Buffer.byteLength(line, 'utf8');
            this.activeLogBytes.set(sessionId, bytes);
            this.maybeRotate(sessionId);
            return true;
        } catch (err) {
            console.error(`[SessionManager] 追加会话事件 ${sessionId} 失败: ${err}`);
            return false;
        }
    }

    private maybeRotate(sessionId: string): void {
        const bytes = this.activeLogBytes.get(sessionId) ?? 0;
        if (bytes < this.rotateThresholdBytes) {
            return;
        }
        const session = this.sessions.get(sessionId);
        if (!session) {
            return;
        }
        try {
            const dir = this.ensureSessionDir(sessionId);
            const activePath = path.join(dir, ACTIVE_LOG);
            if (!fs.existsSync(activePath)) {
                this.activeLogBytes.set(sessionId, 0);
                return;
            }
            // 快照写入新日志的 tmp，随后旧日志封存为分段、tmp 转正
            const tmpPath = path.join(dir, TMP_LOG);
            const snapLine = this.eventLine(this.buildSnapshotEvent(session));
            fs.writeFileSync(tmpPath, snapLine, { encoding: 'utf8', mode: 0o600 });
            const segments = this.listSegments(dir);
            let nextIdx = 0;
            for (const seg of segments) {
                const n = parseInt(seg.slice(SEGMENT_PREFIX.length), 10);
                if (!Number.isNaN(n) && n >= nextIdx) {
                    nextIdx = n + 1;
                }
            }
            fs.renameSync(activePath, path.join(dir, `${SEGMENT_PREFIX}${String(nextIdx).padStart(6, '0')}.jsonl`));
            fs.renameSync(tmpPath, activePath);
            // 轮换后增量重置为 0，避免超大快照本身导致无限频繁轮换
            this.activeLogBytes.set(sessionId, 0);

            // 保留最近 10 个轮换分段（~40MB），自动清理被最新快照完全覆盖的历史超期分段，杜绝磁盘无限累积
            const updatedSegments = this.listSegments(dir);
            const maxSegments = 10;
            if (updatedSegments.length > maxSegments) {
                const toPrune = updatedSegments.slice(0, updatedSegments.length - maxSegments);
                for (const seg of toPrune) {
                    try {
                        fs.unlinkSync(path.join(dir, seg));
                    } catch {
                        // ignore
                    }
                }
            }
        } catch (err) {
            console.warn(`[SessionManager] 轮换会话日志 ${sessionId} 失败(不影响继续追加): ${err}`);
        }
    }

    private flushDeltaBuffer(sessionId: string): void {
        const timer = this.writeTimers.get(sessionId);
        if (timer) {
            clearTimeout(timer);
            this.writeTimers.delete(sessionId);
        }
        const buffered = this.pendingDeltas.get(sessionId);
        if (!buffered || buffered.size === 0) {
            return;
        }
        this.pendingDeltas.delete(sessionId);
        for (const [messageId, pending] of buffered) {
            this.appendRaw(sessionId, this.eventLine({
                t: 'delta',
                at: Date.now(),
                seq: pending.seq,
                id: messageId,
                d: pending.text,
            }));
        }
    }

    private scheduleDeltaFlush(sessionId: string): void {
        if (this.writeTimers.has(sessionId)) {
            return;
        }
        const timer = setTimeout(() => {
            this.writeTimers.delete(sessionId);
            this.flushDeltaBuffer(sessionId);
        }, DELTA_FLUSH_MS);
        this.writeTimers.set(sessionId, timer);
    }

    // ------------------------------------------------------------------
    // 公开接口（签名与语义同旧版一致）
    // ------------------------------------------------------------------

    public getOrCreateSession(sessionId = 'main'): SessionData {
        this.assertValidSessionId(sessionId);
        let session = this.sessions.get(sessionId);
        if (!session) {
            session = this.emptySession(sessionId);
            this.sessions.set(sessionId, session);
            // 新会话落一个快照头，保证日志文件始终以快照开头
            this.appendEvent(sessionId, this.buildSnapshotEvent(session));
        }
        return session;
    }

    /**
     * 兼容保留：旧版为「全量重写落盘」，事件日志模式下状态变更已在各修改入口即时追加，
     * 此方法只负责冲刷该会话待落盘的流式增量。
     */
    public persistSession(session: SessionData, _immediate = true): boolean {
        this.flushDeltaBuffer(session.sessionId);
        return true;
    }

    public nextSeq(sessionId: string): number {
        const session = this.getOrCreateSession(sessionId);
        session.currentSeq += 1;
        session.updatedAt = Date.now();
        this.appendEvent(sessionId, { t: 'seq', at: Date.now(), seq: session.currentSeq });
        return session.currentSeq;
    }

    public addMessage(
        sessionId: string,
        msg: Omit<AssistantMessage, 'seq'>
    ): AssistantMessage {
        const session = this.getOrCreateSession(sessionId);
        session.currentSeq += 1;
        const fullMsg: AssistantMessage = {
            ...msg,
            seq: session.currentSeq,
        };
        session.messages.push(fullMsg);
        const saved = this.appendEvent(sessionId, { t: 'msg', at: Date.now(), seq: fullMsg.seq, m: fullMsg });
        if (!saved) {
            throw new Error(`持久化会话消息失败 (存储满或权限受限): ${sessionId}`);
        }
        return fullMsg;
    }

    public updateMessage(
        sessionId: string,
        messageId: string,
        updater: (msg: AssistantMessage) => void,
        advanceSeq = true,
        _immediatePersist = true
    ): AssistantMessage | undefined {
        const session = this.getOrCreateSession(sessionId);
        const msg = session.messages.find((m) => m.id === messageId);
        if (msg) {
            updater(msg);
            if (advanceSeq) {
                session.currentSeq += 1;
                msg.seq = session.currentSeq;
            }
            this.appendEvent(sessionId, { t: 'msg', at: Date.now(), seq: msg.seq, m: msg });
        }
        return msg;
    }

    public appendDelta(
        sessionId: string,
        messageId: string,
        delta: string
    ): AssistantMessage | undefined {
        // 内存即时生效并推进 seq（断网重连对账依赖）；磁盘侧防抖合并落盘，崩溃窗口由重启修复兜底
        const session = this.getOrCreateSession(sessionId);
        const msg = session.messages.find((m) => m.id === messageId);
        if (!msg) {
            return undefined;
        }
        msg.content += delta;
        msg.status = 'processing';
        session.currentSeq += 1;
        msg.seq = session.currentSeq;
        session.updatedAt = Date.now();

        let buffered = this.pendingDeltas.get(sessionId);
        if (!buffered) {
            buffered = new Map();
            this.pendingDeltas.set(sessionId, buffered);
        }
        const existing = buffered.get(messageId);
        if (existing) {
            existing.text += delta;
            existing.seq = msg.seq;
        } else {
            buffered.set(messageId, { text: delta, seq: msg.seq });
        }
        this.scheduleDeltaFlush(sessionId);
        return msg;
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
        session.currentSeq += 1;
        session.updatedAt = Date.now();
        this.appendEvent(sessionId, {
            t: 'state',
            at: Date.now(),
            seq: session.currentSeq,
            taskState: state,
            approval: approval ?? null,
        });
        return session.currentSeq;
    }

    public getPendingApproval(sessionId: string): ApprovalRequest | undefined {
        const session = this.getOrCreateSession(sessionId);
        return session.pendingApproval;
    }

    public clearPendingApproval(sessionId: string): void {
        const session = this.getOrCreateSession(sessionId);
        session.pendingApproval = undefined;
        this.appendEvent(sessionId, {
            t: 'state',
            at: Date.now(),
            seq: session.currentSeq,
            taskState: session.taskState,
            approval: null,
        });
    }

    public setDshSessionId(sessionId: string, dshSessionId: string): void {
        const session = this.getOrCreateSession(sessionId);
        session.dshSessionId = dshSessionId;
        session.updatedAt = Date.now();
        this.appendEvent(sessionId, { t: 'dsh', at: Date.now(), dshSessionId });
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
        // 如果客户端是初次同步（lastSeq <= 0），返回最近 100 条消息窗口切片；如果增量同步，返回当前会话中大于 lastSeq 的消息
        const messages = lastSeq > 0
            ? session.messages.filter((m) => (m.seq ?? 0) > lastSeq)
            : session.messages.slice(-100);

        return {
            messages,
            taskState: session.taskState,
            pendingApproval: session.pendingApproval,
            currentSeq: session.currentSeq,
        };
    }
}
