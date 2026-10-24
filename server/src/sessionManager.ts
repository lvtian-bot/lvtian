import fs from 'node:fs';
import path from 'node:path';
import { AssistantMessage, TaskExecutionState, ApprovalRequest, ToolCallState } from './protocol.js';

export interface SessionData {
    sessionId: string;
    currentSeq: number;
    messages: AssistantMessage[];
    taskState: TaskExecutionState;
    /** 待审批队列：协议允许同一会话并发多个工具各自请求审批，按登记顺序展示与应答 */
    pendingApprovals: ApprovalRequest[];
    dshSessionId?: string;
    updatedAt: number;
    /** 上次真实交互完成的时间戳，用于心流超时判定 */
    lastActiveAt?: number;
    /** 当前会话消耗的上下文 Token 数 */
    contextTokens?: number;
    /** 上下文窗口总大小 (tokens)，默认 128_000 */
    contextWindowSize?: number;
    /** 当前 DSH 实例建立时的 seq 起点，用于无 usage_update 时准确估算新会话增量 */
    activeSessionStartSeq?: number;
}

/**
 * 会话事件日志：一行一个 JSON 事件，只追加不重写。
 * 写入代价与历史长度无关，替代原先「每次全量重写整个会话 JSON」的写入方式。
 * - msg   ：整条消息的新增或更新（含最新 seq）
 * - delta ：流式增量（防抖合并后落盘，重放时按 id 追加到 content）
 * - state ：任务状态与待审批卡变更
 * - dsh   ：dsh 会话 ID 绑定
 * - seq   ：纯序号推进（无消息体变化）
 * - activity：真实交互完成时间戳记录
 * - usage ：上下文用量更新
 * - snapshot：全量快照，只会作为某个日志文件的首行出现（建会话或轮换时写入）
 */
type SessionLogEvent =
    | {
          t: 'snapshot';
          at: number;
          seq: number;
          taskState: TaskExecutionState;
          approvals?: ApprovalRequest[];
          dshSessionId?: string;
          msgs: AssistantMessage[];
          lastActiveAt?: number;
          contextTokens?: number;
          contextWindowSize?: number;
          activeSessionStartSeq?: number;
      }
    | { t: 'msg'; at: number; seq: number; m: AssistantMessage }
    | { t: 'delta'; at: number; seq: number; id: string; d: string }
    | { t: 'state'; at: number; seq: number; taskState: TaskExecutionState; approvals?: ApprovalRequest[] }
    | { t: 'dsh'; at: number; dshSessionId: string }
    | { t: 'seq'; at: number; seq: number }
    | { t: 'activity'; at: number; lastActiveAt: number; contextTokens?: number; contextWindowSize?: number }
    | { t: 'usage'; at: number; contextTokens?: number; contextWindowSize?: number; activeSessionStartSeq?: number };

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
            pendingApprovals: [],
            updatedAt: Date.now(),
            lastActiveAt: undefined,
            contextTokens: undefined,
            contextWindowSize: undefined,
            activeSessionStartSeq: 0,
        };
    }

    private buildSnapshotEvent(session: SessionData): SessionLogEvent {
        return {
            t: 'snapshot',
            at: Date.now(),
            seq: session.currentSeq,
            taskState: session.taskState,
            approvals: session.pendingApprovals,
            dshSessionId: session.dshSessionId,
            msgs: session.messages,
            lastActiveAt: session.lastActiveAt,
            contextTokens: session.contextTokens,
            contextWindowSize: session.contextWindowSize,
            activeSessionStartSeq: session.activeSessionStartSeq,
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

    /**
     * 逐行重放事件；遇到不合法记录（末行撕裂或中段损坏）即停止重放并截断至最后合法字节。
     * 不截断的话，后续新事件会追加在坏记录之后，每次重启都在同一位置停止重放，
     * 坏记录之后写入的所有事件会被静默丢弃；坏记录之后的原残余字节本就永远无法重放，截断不损失可恢复数据。
     */
    private replayFile(filePath: string, session: SessionData): void {
        const raw = fs.readFileSync(filePath, 'utf8');
        const lines = raw.split('\n');
        let validByteLength = 0;
        let needsTruncate = false;

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
                } else {
                    console.warn(`[SessionManager] ${path.basename(filePath)} 第 ${i + 1} 行解析失败(疑似局部损坏)，停止重放并截断至最后合法字节: ${err}`);
                }
                needsTruncate = true;
                break;
            }
            this.applyEvent(session, ev);
            validByteLength += Buffer.byteLength(line, 'utf8') + 1;
        }

        // 截断清理坏记录及其后的残余字节，确保后续追加始终另起合法新行、重启重放不再卡在同一位置
        if (needsTruncate) {
            try {
                fs.truncateSync(filePath, validByteLength);
            } catch (truncErr) {
                console.warn(`[SessionManager] 截断清理损坏文件失败: ${truncErr}`);
            }
            return;
        }

        // 末条记录合法但缺换行符（崩溃恰在换行符写入前中断）时补齐分隔符：
        // 否则下一条事件会直接拼接在该行尾部，再次重启时整行解析失败、连同其后新事件一并被截断丢弃
        if (raw.length > 0 && !raw.endsWith('\n')) {
            try {
                fs.appendFileSync(filePath, '\n', { encoding: 'utf8' });
            } catch (nlErr) {
                console.warn(`[SessionManager] 补齐末行换行符失败: ${nlErr}`);
            }
        }
    }

    /** 兼容旧版事件日志的单审批字段：approvals 为现行队列格式，approval 为旧版单对象 */
    private normalizeApprovals(ev: { approvals?: ApprovalRequest[]; approval?: ApprovalRequest | null }): ApprovalRequest[] {
        if (ev.approvals) {
            return [...ev.approvals];
        }
        return ev.approval ? [ev.approval] : [];
    }

    private applyEvent(session: SessionData, ev: SessionLogEvent): void {
        switch (ev.t) {
            case 'snapshot':
                session.currentSeq = ev.seq;
                session.messages = ev.msgs.map((m) => ({ ...m }));
                session.taskState = ev.taskState;
                session.pendingApprovals = this.normalizeApprovals(ev);
                session.dshSessionId = ev.dshSessionId;
                session.updatedAt = ev.at;
                session.lastActiveAt = ev.lastActiveAt;
                session.contextTokens = ev.contextTokens;
                session.contextWindowSize = ev.contextWindowSize;
                session.activeSessionStartSeq = ev.activeSessionStartSeq;
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
                session.pendingApprovals = this.normalizeApprovals(ev);
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
            case 'activity':
                session.lastActiveAt = ev.lastActiveAt;
                if (ev.contextTokens !== undefined) session.contextTokens = ev.contextTokens;
                if (ev.contextWindowSize !== undefined) session.contextWindowSize = ev.contextWindowSize;
                session.updatedAt = ev.at;
                break;
            case 'usage':
                session.contextTokens = ev.contextTokens;
                if (ev.contextWindowSize !== undefined) session.contextWindowSize = ev.contextWindowSize;
                if (ev.activeSessionStartSeq !== undefined) session.activeSessionStartSeq = ev.activeSessionStartSeq;
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
            session.pendingApprovals = [];
            this.appendEvent(session.sessionId, {
                t: 'state',
                at: Date.now(),
                seq: session.currentSeq,
                taskState: session.taskState,
                approvals: [],
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
        // 一批增量合并为一次追加（单次写入、单次轮换判定）：
        // 若逐条追加且轮换恰在中途触发，轮换快照取自内存（已含其余未落盘增量），
        // 这些增量随后又作为事件写入新日志，重放时同一文本会被重复计入
        const lines = [...buffered.entries()]
            .map(([messageId, pending]) =>
                this.eventLine({
                    t: 'delta',
                    at: Date.now(),
                    seq: pending.seq,
                    id: messageId,
                    d: pending.text,
                })
            )
            .join('');
        this.appendRaw(sessionId, lines);
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

    /**
     * 更新任务执行状态：传入 approval 时向待审批队列追加登记；
     * 状态落入终态（stopped/completed/error）时清空待审批队列——任务已终止，未决审批不再有意义。
     */
    public setTaskState(
        sessionId: string,
        state: TaskExecutionState,
        approval?: ApprovalRequest
    ): number {
        const session = this.getOrCreateSession(sessionId);
        session.taskState = state;
        if (state === 'stopped' || state === 'completed' || state === 'error') {
            session.pendingApprovals = [];
        } else if (approval) {
            session.pendingApprovals.push(approval);
        }
        session.currentSeq += 1;
        session.updatedAt = Date.now();
        this.appendEvent(sessionId, {
            t: 'state',
            at: Date.now(),
            seq: session.currentSeq,
            taskState: state,
            approvals: session.pendingApprovals,
        });
        return session.currentSeq;
    }

    public getPendingApproval(sessionId: string): ApprovalRequest | undefined {
        const session = this.getOrCreateSession(sessionId);
        return session.pendingApprovals[0];
    }

    /** 清除待审批登记：带 approvalId 时仅移除该项（并发审批互不影响），不带时清空队列 */
    public clearPendingApproval(sessionId: string, approvalId?: string): void {
        const session = this.getOrCreateSession(sessionId);
        session.pendingApprovals = approvalId
            ? session.pendingApprovals.filter((a) => a.approvalId !== approvalId)
            : [];
        this.appendEvent(sessionId, {
            t: 'state',
            at: Date.now(),
            seq: session.currentSeq,
            taskState: session.taskState,
            approvals: session.pendingApprovals,
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
        pendingApprovals: ApprovalRequest[];
        /** 兼容保留：待审批队列的第一项 */
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
            pendingApprovals: session.pendingApprovals,
            pendingApproval: session.pendingApprovals[0],
            currentSeq: session.currentSeq,
        };
    }

    // ------------------------------------------------------------------
    // 人脑认知记忆模型与会话轮换
    // ------------------------------------------------------------------

    public listSessionIds(): string[] {
        return Array.from(this.sessions.keys());
    }

    /** 记录真实用户交互完成时间，推进主聊天活跃状态（不被心跳/断线重连假刷新） */
    public recordActivity(sessionId: string, timestamp = Date.now()): void {
        const session = this.getOrCreateSession(sessionId);
        session.lastActiveAt = timestamp;
        session.updatedAt = timestamp;
        this.appendEvent(sessionId, {
            t: 'activity',
            at: timestamp,
            lastActiveAt: timestamp,
            contextTokens: session.contextTokens,
            contextWindowSize: session.contextWindowSize,
        });
    }

    public getLastActiveAt(sessionId: string): number {
        const session = this.getOrCreateSession(sessionId);
        return session.lastActiveAt
            ?? (session.messages.length > 0 ? session.messages[session.messages.length - 1].timestamp : session.updatedAt);
    }

    /** 记录底层引擎报告的上下文 Token 消耗与窗口大小 */
    public setUsage(sessionId: string, tokens: number, windowSize?: number): void {
        const session = this.getOrCreateSession(sessionId);
        session.contextTokens = tokens;
        if (windowSize !== undefined && windowSize > 0) {
            session.contextWindowSize = windowSize;
        }
        session.updatedAt = Date.now();
        this.appendEvent(sessionId, {
            t: 'usage',
            at: Date.now(),
            contextTokens: tokens,
            contextWindowSize: session.contextWindowSize,
        });
    }

    /** 会话轮换到新 DSH 实例时，重置底层 Token 统计与估算起点 */
    public resetSessionUsage(sessionId: string, startSeq?: number): void {
        const session = this.getOrCreateSession(sessionId);
        session.contextTokens = undefined;
        const resolvedStartSeq = startSeq ?? (session.currentSeq + 1);
        session.activeSessionStartSeq = resolvedStartSeq;
        this.appendEvent(sessionId, {
            t: 'usage',
            at: Date.now(),
            contextTokens: undefined,
            contextWindowSize: session.contextWindowSize,
            activeSessionStartSeq: resolvedStartSeq,
        });
    }

    /** 估算当前会话累积字符折合 Token（中英混合按约 2 字符/Token 估算，仅统计当前 DSH 实例的消息） */
    public estimateTokens(sessionId: string): number {
        const session = this.getOrCreateSession(sessionId);
        const startSeq = session.activeSessionStartSeq ?? 0;
        let totalChars = 0;
        for (const msg of session.messages) {
            if ((msg.seq ?? 0) >= startSeq) {
                totalChars += msg.content?.length ?? 0;
                if (msg.toolCalls) {
                    for (const t of msg.toolCalls) {
                        totalChars += (t.name?.length ?? 0) + (t.summary?.length ?? 0);
                    }
                }
            }
        }
        return Math.ceil(totalChars / 2);
    }

    public getUsage(sessionId: string): { tokens: number; windowSize: number; ratio: number } {
        const session = this.getOrCreateSession(sessionId);
        const windowSize = session.contextWindowSize && session.contextWindowSize > 0
            ? session.contextWindowSize
            : 128_000;
        const tokens = session.contextTokens !== undefined
            ? session.contextTokens
            : this.estimateTokens(sessionId);
        const ratio = windowSize > 0 ? tokens / windowSize : 0;
        return { tokens, windowSize, ratio };
    }

    /** 时间门禁：静默空闲时长是否达到阈值（默认 3 小时） */
    public isIdle(sessionId: string, idleTimeoutMs = 3 * 60 * 60 * 1000): boolean {
        return Date.now() - this.getLastActiveAt(sessionId) >= idleTimeoutMs;
    }

    /** 容量门禁：上下文占用是否达到或超过阈值（默认 20%） */
    public isCapacityOver(sessionId: string, minRatio = 0.2): boolean {
        return this.getUsage(sessionId).ratio >= minRatio;
    }

    /** 双重门禁复合判定：空闲满 3h AND 上下文满 20% */
    public isRotationEligible(
        sessionId: string,
        idleTimeoutMs = 3 * 60 * 60 * 1000,
        minRatio = 0.2
    ): boolean {
        return this.isIdle(sessionId, idleTimeoutMs) && this.isCapacityOver(sessionId, minRatio);
    }

    public getPendingBackgroundPath(sessionId: string): string {
        const dir = this.ensureSessionDir(sessionId);
        return path.join(dir, 'pending_background.txt');
    }

    public hasPendingBackground(sessionId: string): boolean {
        try {
            return fs.existsSync(this.getPendingBackgroundPath(sessionId));
        } catch {
            return false;
        }
    }

    public getPendingBackground(sessionId: string): string | null {
        try {
            const p = this.getPendingBackgroundPath(sessionId);
            if (fs.existsSync(p)) {
                const content = fs.readFileSync(p, 'utf8').trim();
                return content.length > 0 ? content : null;
            }
        } catch (err) {
            console.warn(`[SessionManager] 读取 pending_background.txt 失败: ${err}`);
        }
        return null;
    }

    public setPendingBackground(sessionId: string, content: string): void {
        const dir = this.ensureSessionDir(sessionId);
        const targetPath = path.join(dir, 'pending_background.txt');
        const tmpPath = path.join(dir, `pending_background.txt.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`);
        fs.writeFileSync(tmpPath, content, { encoding: 'utf8', mode: 0o600 });
        fs.renameSync(tmpPath, targetPath);
    }

    public clearPendingBackground(sessionId: string): void {
        try {
            const p = this.getPendingBackgroundPath(sessionId);
            if (fs.existsSync(p)) {
                fs.unlinkSync(p);
            }
        } catch (err) {
            console.warn(`[SessionManager] 清理 pending_background.txt 失败: ${err}`);
        }
    }

    /** 提取近期对话文本供后台模型提炼心智接力备忘录 */
    public getRecentDialogue(sessionId: string, maxMessages = 30): string {
        const session = this.getOrCreateSession(sessionId);
        const validMsgs = session.messages
            .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content && m.content.trim().length > 0)
            .slice(-maxMessages);
        return validMsgs
            .map((m) => `${m.role === 'user' ? '主人' : '助理'}: ${m.content.trim()}`)
            .join('\n\n');
    }

    /**
     * 关键原文物理锚定规则（Verbatim Anchoring）：
     * 回溯最近 5~8 轮交互，字数封顶 1500~2000 字（默认 1800），倒序自适应追加截断并保持时间线正序。
     * - 对首条超长消息执行有界截取（maxChars - 3 + '...'）
     * - 将分隔符（\n\n，2字符）计入字符预算
     * - 支持排除当前轮次输入（避免在提示词中重复出现）
     */
    public getVerbatimExcerpts(
        sessionId: string,
        maxTurns = 8,
        maxChars = 1800,
        options?: { excludePrompt?: string }
    ): string {
        const session = this.getOrCreateSession(sessionId);
        let dialogue = session.messages.filter(
            (m) => (m.role === 'user' || m.role === 'assistant') && m.content && m.content.trim().length > 0 && m.status !== 'error'
        );
        if (dialogue.length === 0) {
            return '';
        }

        if (options?.excludePrompt) {
            const trimmedPrompt = options.excludePrompt.trim();
            for (let i = dialogue.length - 1; i >= 0; i--) {
                if (dialogue[i].role === 'user' && dialogue[i].content.trim() === trimmedPrompt) {
                    dialogue = dialogue.slice(0, i).concat(dialogue.slice(i + 1));
                    break;
                }
            }
            if (dialogue.length === 0) {
                return '';
            }
        }

        const selected: string[] = [];
        let accumulatedLength = 0;
        let turnsCount = 0;

        for (let i = dialogue.length - 1; i >= 0; i--) {
            const m = dialogue[i];
            const speaker = m.role === 'user' ? '主人' : '助理';
            let line = `${speaker}: ${m.content.trim()}`;

            if (selected.length === 0) {
                if (line.length > maxChars) {
                    line = line.slice(0, Math.max(0, maxChars - 3)) + '...';
                    selected.unshift(line);
                    accumulatedLength = line.length;
                    break;
                }
                selected.unshift(line);
                accumulatedLength = line.length;
            } else {
                const delimiterLength = 2; // '\n\n'
                if (accumulatedLength + delimiterLength + line.length > maxChars) {
                    break;
                }
                selected.unshift(line);
                accumulatedLength += delimiterLength + line.length;
            }

            if (m.role === 'user') {
                turnsCount++;
                if (turnsCount >= maxTurns) {
                    break;
                }
            }
        }

        return selected.join('\n\n');
    }
}
