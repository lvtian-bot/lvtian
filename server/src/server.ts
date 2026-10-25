import http from 'node:http';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import type WebSocket from 'ws';
import type { WebSocketServer } from 'ws';
import { ServerConfig } from './config.js';
import { SessionManager } from './sessionManager.js';
import { MemoryManager } from './memoryManager.js';
import { AcpEngineManager, EngineStatusPayload } from './acpEngineManager.js';
import { FileManager, FileManagerError } from './fileManager.js';
import { ContextConsolidator } from './contextConsolidator.js';
import { getDshPermissionMode, setDshPermissionMode, DshPermissionMode } from './dshConfigManager.js';
import {
    ClientMessage,
    ServerMessage,
    ToolCallState,
    TaskExecutionState,
    ChatAttachment,
} from './protocol.js';

const require = createRequire(import.meta.url);
const WS = require('ws');

// 保存端点传输上限：内容解码后上限为 5MB（saveFileContent 中的权威限制），
// JSON 序列化最坏情况下单个字符会膨胀至 6 字节（\uXXXX 转义），
// 传输上限需覆盖最坏膨胀并留出 JSON 结构（path 等字段）余量，避免合法内容在传输层被误拒
const SAVE_BODY_MAX_BYTES = 5 * 1024 * 1024 * 6 + 2 * 1024 * 1024;

interface AuthenticatedSocket extends WebSocket {
    isAuthenticated?: boolean;
    isAlive?: boolean;
    sessionId?: string;
}

export class LvtianServer {
    private config: ServerConfig;
    private sessionManager: SessionManager;
    private memoryManager: MemoryManager;
    private acpEngine: AcpEngineManager;
    private fileManager: FileManager;
    private contextConsolidator: ContextConsolidator;
    private httpServer: http.Server;
    private wss: WebSocketServer;
    private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
    private consolidationInterval: ReturnType<typeof setInterval> | null = null;
    private isDraining = false;

    constructor(
        config: ServerConfig,
        sessionManager: SessionManager,
        memoryManager: MemoryManager,
        acpEngine: AcpEngineManager,
        fileManager?: FileManager,
        contextConsolidator?: ContextConsolidator
    ) {
        this.config = config;
        this.sessionManager = sessionManager;
        this.memoryManager = memoryManager;
        this.acpEngine = acpEngine;
        this.fileManager = fileManager || new FileManager(config.workspace);
        this.contextConsolidator = contextConsolidator || new ContextConsolidator(sessionManager);

        const scanMs = Number.parseInt(process.env.LVTIAN_IDLE_SCAN_INTERVAL_MS ?? '', 10);
        const intervalMs = Number.isFinite(scanMs) && scanMs > 0 ? scanMs : 60_000;
        this.consolidationInterval = setInterval(() => {
            this.contextConsolidator.scanAllSessions().catch((err: unknown) => {
                console.warn(`[Server] 会话记忆巩固扫描异常: ${err instanceof Error ? err.message : String(err)}`);
            });
        }, intervalMs);
        this.consolidationInterval.unref?.();

        this.httpServer = http.createServer((req, res) => {
            this.handleHttpRequest(req, res).catch((err) => {
                console.error('[Server] 处理 HTTP 请求未捕获异常:', err);
                if (!res.headersSent) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: '服务端内部错误' }));
                }
            });
        });

        this.wss = new WS.Server({
            server: this.httpServer,
            maxPayload: 5 * 1024 * 1024, // 限制单条报文 5MB 上限，防止超大报文消耗内存，同时为图片/文件 Base64 预留充裕空间
        }) as WebSocketServer;
        this.setupWebSocket();
    }

    private isAuthorized(req: http.IncomingMessage): boolean {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return false;
        }
        const token = authHeader.slice(7).trim();
        return token === this.config.token;
    }

    private async readJsonBody<T>(req: http.IncomingMessage, maxBytes = 10 * 1024 * 1024): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            let totalBytes = 0;
            const chunks: Buffer[] = [];

            req.on('data', (chunk: Buffer) => {
                totalBytes += chunk.length;
                if (totalBytes > maxBytes) {
                    req.destroy();
                    reject(new Error(`请求体超出限制（最大允许 ${(maxBytes / 1024 / 1024).toFixed(1)}MB）`));
                    return;
                }
                chunks.push(chunk);
            });

            req.on('end', () => {
                try {
                    const raw = Buffer.concat(chunks).toString('utf8');
                    const parsed = JSON.parse(raw) as T;
                    resolve(parsed);
                } catch (err: unknown) {
                    reject(new Error(`无效的 JSON 格式: ${(err as Error).message}`));
                }
            });

            req.on('error', (err) => {
                reject(err);
            });
        });
    }

    private sendFileManagerError(res: http.ServerResponse, err: unknown): void {
        if (err instanceof FileManagerError) {
            res.writeHead(err.statusCode, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message, code: err.code }));
            return;
        }
        const message = (err as Error)?.message || '服务器内部错误';
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: message, code: 'UNKNOWN_ERROR' }));
    }

    private async handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
        let urlObj: URL;
        try {
            urlObj = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
        } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: '无效请求或主机头格式错误 (Bad Request)' }));
            return;
        }

        const pathname = urlObj.pathname;

        // 设置 CORS
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        // 健康检查（仅提供存活状态，不泄露工作区内部路径）
        if (pathname === '/health' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
                JSON.stringify({
                    status: 'ok',
                    version: '0.1.0',
                    assistantName: this.config.assistantName,
                })
            );
            return;
        }

        // 统一鉴权拦截：所有 /api/* 均需要 Bearer Token
        if (pathname.startsWith('/api/')) {
            if (!this.isAuthorized(req)) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: '无效的访问令牌（Unauthorized）' }));
                return;
            }
        }

        // 实例连接信息验证
        if (pathname === '/api/info' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
                JSON.stringify({
                    status: 'authenticated',
                    assistantName: this.config.assistantName,
                    version: '0.1.0',
                    workspace: this.config.workspace,
                    permissionMode: getDshPermissionMode(this.config.dshProfileDir),
                })
            );
            return;
        }

        // 查询当前 DSH 权限模式
        if (pathname === '/api/permission' && req.method === 'GET') {
            const mode = getDshPermissionMode(this.config.dshProfileDir);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ permissionMode: mode }));
            return;
        }

        // 修改当前 DSH 权限模式并触发统一会话交接
        if (pathname === '/api/permission' && req.method === 'POST') {
            try {
                const body = await this.readJsonBody<{ permissionMode?: string }>(req, 1024);
                const targetMode = body.permissionMode;
                if (targetMode !== 'workspace-write' && targetMode !== 'danger-full-access') {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(
                        JSON.stringify({
                            error: '无效的 permissionMode，必须为 workspace-write 或 danger-full-access',
                            code: 'PARAM_INVALID',
                        })
                    );
                    return;
                }

                // 门禁检查：仅当权限模式真正发生变动时，才检查并禁止在任务执行中途切换
                const currentMode = getDshPermissionMode(this.config.dshProfileDir);
                if (targetMode !== currentMode && this.acpEngine.isRunning('main')) {
                    res.writeHead(409, { 'Content-Type': 'application/json' });
                    res.end(
                        JSON.stringify({
                            error: '当前有正在执行的任务，请先停止任务后再切换权限模式',
                            code: 'TASK_RUNNING',
                        })
                    );
                    return;
                }

                // 1. 原子更新 DSH 官方配置文件 cordis.patch.yml（由配置管理器验证语法并返回是否发生真正变更）
                const changed = setDshPermissionMode(targetMode as DshPermissionMode, this.config.dshProfileDir);

                // 2. 仅当配置真正发生变更时触发会话交接，避免无谓中断与提炼开销
                if (changed) {
                    await this.acpEngine.triggerHandover('main', `permission_switch_to_${targetMode}`);
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, permissionMode: targetMode, changed }));
            } catch (err: unknown) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(
                    JSON.stringify({
                        error: `修改权限模式失败: ${err instanceof Error ? err.message : String(err)}`,
                    })
                );
            }
            return;
        }

        // 获取文件系统与环境信息
        if (pathname === '/api/files/info' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(this.fileManager.getSystemInfo()));
            return;
        }

        // 列出目录内容
        if (pathname === '/api/files/list' && req.method === 'GET') {
            const targetPath = urlObj.searchParams.get('path') || undefined;
            try {
                const listing = await this.fileManager.listDirectory(targetPath);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(listing));
            } catch (err: unknown) {
                this.sendFileManagerError(res, err);
            }
            return;
        }

        // 获取文件文本内容
        if (pathname === '/api/files/content' && req.method === 'GET') {
            const targetPath = urlObj.searchParams.get('path');
            if (!targetPath) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: '缺少 path 参数', code: 'PARAM_MISSING' }));
                return;
            }
            try {
                const result = await this.fileManager.readFileContent(targetPath);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
            } catch (err: unknown) {
                this.sendFileManagerError(res, err);
            }
            return;
        }

        // 保存文件文本内容（轻度编辑，支持 expectedMtime 乐观锁）
        if (pathname === '/api/files/content' && req.method === 'POST') {
            try {
                const body = await this.readJsonBody<{ path?: string; content?: string; expectedMtime?: number }>(req, SAVE_BODY_MAX_BYTES);
                if (!body.path || typeof body.content !== 'string') {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: '缺少 path 或 content 参数', code: 'PARAM_MISSING' }));
                    return;
                }
                const result = await this.fileManager.saveFileContent(body.path, body.content, body.expectedMtime);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
            } catch (err: unknown) {
                this.sendFileManagerError(res, err);
            }
            return;
        }

        // 下载文件流
        if (pathname === '/api/files/download' && req.method === 'GET') {
            const targetPath = urlObj.searchParams.get('path');
            if (!targetPath) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: '缺少 path 参数', code: 'PARAM_MISSING' }));
                return;
            }
            try {
                const downloadInfo = await this.fileManager.getFileDownloadInfo(targetPath);
                // 直接使用 Node 官方 FileHandle 打开文件并创建只读流，
                // 由 Node 内部在流传输完成/出错时安全自动关闭该句柄，杜绝描述符泄漏与并发竞争
                let fileHandle: fs.promises.FileHandle;
                try {
                    fileHandle = await fs.promises.open(downloadInfo.resolvedPath, 'r');
                } catch (openErr: unknown) {
                    const nodeErr = openErr as NodeJS.ErrnoException;
                    if (nodeErr.code === 'EACCES' || nodeErr.code === 'EPERM') {
                        res.writeHead(403, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: `无权限读取该文件: ${targetPath}`, code: 'EACCES' }));
                        return;
                    }
                    throw openErr;
                }

                res.writeHead(200, {
                    'Content-Type': 'application/octet-stream',
                    'Content-Length': downloadInfo.size,
                    'Content-Disposition': `attachment; filename="${encodeURIComponent(downloadInfo.fileName)}"`,
                });
                const stream = fileHandle.createReadStream();
                stream.on('error', (streamErr: unknown) => {
                    console.error('[Server] 下载流传输异常:', streamErr);
                    if (!res.headersSent) {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: '文件传输读取失败', code: 'STREAM_ERROR' }));
                    } else {
                        res.destroy();
                    }
                });
                stream.pipe(res);
            } catch (err: unknown) {
                this.sendFileManagerError(res, err);
            }
            return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '未找到接口' }));
    }

    private setupWebSocket(): void {
        this.wss.on('error', (err: Error) => {
            console.warn(`[Server] WebSocketServer 错误: ${err.message}`);
        });

        this.wss.on('connection', (ws: AuthenticatedSocket) => {
            ws.isAlive = true;
            ws.isAuthenticated = false;
            ws.sessionId = 'main';

            // 监听每个连接的 error 事件，防止非法帧或超限 payload 触发未捕获异常导致服务崩溃
            ws.on('error', (err: Error) => {
                console.warn(`[Server] WebSocket 客户端连接错误: ${err.message}`);
            });

            ws.on('pong', () => {
                ws.isAlive = true;
            });

            ws.on('message', (raw: Buffer) => {
                try {
                    const msg = JSON.parse(raw.toString('utf8')) as ClientMessage;
                    this.handleClientMessage(ws, msg);
                } catch (err) {
                    console.warn(`[Server] 解析客户端消息失败: ${err}`);
                }
            });

            ws.on('close', () => {
                console.log('[Server] 客户端连接断开');
            });
        });

        // 心跳检测定时器 (30s)
        this.heartbeatInterval = setInterval(() => {
            this.wss.clients.forEach((client: WebSocket) => {
                const ws = client as AuthenticatedSocket;
                if (!ws.isAlive) {
                    return ws.terminate();
                }
                ws.isAlive = false;
                ws.ping();
            });
        }, 30000);
    }

    private handleClientMessage(ws: AuthenticatedSocket, msg: ClientMessage): void {
        // 未认证拦截
        if (!ws.isAuthenticated && msg.type !== 'auth') {
            this.send(ws, {
                type: 'auth_result',
                success: false,
                error: '请先完成访问令牌认证',
            });
            return;
        }

        switch (msg.type) {
            case 'auth': {
                if (msg.token === this.config.token) {
                    ws.isAuthenticated = true;
                    this.send(ws, {
                        type: 'auth_result',
                        success: true,
                        serverInfo: {
                            version: '0.1.0',
                            workspace: this.config.workspace,
                            assistantName: this.config.assistantName,
                        },
                    });
                } else {
                    this.send(ws, {
                        type: 'auth_result',
                        success: false,
                        error: '访问令牌错误',
                    });
                }
                break;
            }

            case 'ping': {
                this.send(ws, { type: 'pong' });
                break;
            }

            case 'sync': {
                const rawSessionId = msg.sessionId || 'main';
                if (!/^[a-zA-Z0-9_-]+$/.test(rawSessionId)) {
                    console.warn(`[Server] 拒绝非法 sessionId 报文: ${rawSessionId}`);
                    break;
                }
                const sessionId = rawSessionId;
                ws.sessionId = sessionId;
                const reconcile = this.sessionManager.getReconcileData(sessionId, msg.lastSeq);
                this.send(ws, {
                    type: 'sync_result',
                    sessionId,
                    messages: reconcile.messages,
                    taskState: reconcile.taskState,
                    pendingApprovals: reconcile.pendingApprovals,
                    pendingApproval: reconcile.pendingApproval,
                    currentSeq: reconcile.currentSeq,
                });
                break;
            }

            case 'chat': {
                const rawSessionId = msg.sessionId || 'main';
                if (!/^[a-zA-Z0-9_-]+$/.test(rawSessionId)) {
                    console.warn(`[Server] 拒绝非法 sessionId 聊天报文: ${rawSessionId}`);
                    this.send(ws, {
                        type: 'message_ack',
                        messageId: msg.messageId,
                        seq: 0,
                        status: 'error',
                        error: '非法 sessionId',
                    });
                    break;
                }
                this.handleChat(ws, rawSessionId, msg.messageId, msg.content, msg.attachments);
                break;
            }

            case 'stop': {
                const rawSessionId = msg.sessionId || 'main';
                if (!/^[a-zA-Z0-9_-]+$/.test(rawSessionId)) {
                    console.warn(`[Server] 拒绝非法 sessionId 终止报文: ${rawSessionId}`);
                    break;
                }
                const sessionId = rawSessionId;
                const stopped = this.acpEngine.stop(sessionId);
                const seq = this.sessionManager.nextSeq(sessionId);
                this.broadcastSession(sessionId, {
                    type: 'task_status',
                    seq,
                    sessionId,
                    state: 'stopped',
                    error: stopped ? 'task_stopped' : undefined,
                });
                break;
            }

            case 'approval_response': {
                // 人工审批响应：应答按 approvalId 直接路由给引擎管理器（并发审批各自独立记账），
                // 待审批登记按 ID 移除——并发场景登记队列中其余审批不受影响
                const sessionId = ws.sessionId || 'main';
                this.sessionManager.clearPendingApproval(sessionId, msg.approvalId);
                // ACP 引擎下拒绝审批不终止任务（引擎收到拒绝后自行收尾），
                // 允许与拒绝均恢复执行中状态，最终由引擎终态回调修正；审批已被
                // 引擎管理器移除（超时/停止竞态）时不得覆盖其终态
                if (this.acpEngine.handleApproval(sessionId, msg.approvalId, msg.approved)) {
                    const seq = this.sessionManager.setTaskState(sessionId, 'processing');
                    this.broadcastSession(sessionId, {
                        type: 'task_status',
                        seq,
                        sessionId,
                        state: 'processing',
                    });
                }
                break;
            }
        }
    }

    private handleChat(
        ws: AuthenticatedSocket,
        sessionId: string,
        userMessageId: string,
        content: string,
        attachments?: ChatAttachment[]
    ): void {
        // 服务端正在优雅停机升级中，拒绝受理新任务并返回可国际化的稳定错误码
        if (this.isDraining) {
            this.send(ws, {
                type: 'message_ack',
                messageId: userMessageId,
                seq: 0,
                status: 'error',
                error: 'service_upgrading',
            });
            return;
        }

        // 如果当前已有任务在执行，拒绝并发任务且通知客户端该消息发送失败
        if (this.acpEngine.isRunning(sessionId)) {
            const currentSession = this.sessionManager.getOrCreateSession(sessionId);
            const errMsg = '上一个任务正在执行中，请等待其完成或点击停止';
            this.send(ws, {
                type: 'task_status',
                seq: currentSession.currentSeq,
                sessionId,
                state: currentSession.taskState,
                error: errMsg,
            });
            this.send(ws, {
                type: 'message_ack',
                messageId: userMessageId,
                seq: currentSession.currentSeq,
                status: 'error',
                error: errMsg,
            });
            return;
        }

        // 1. 存入用户消息与助理回复占位 (包裹磁盘写入异常保护)
        let userMsg;
        let asstMsg;
        const assistantMessageId = `asst-${Date.now()}`;
        try {
            userMsg = this.sessionManager.addMessage(sessionId, {
                id: userMessageId,
                role: 'user',
                content,
                timestamp: Date.now(),
                status: 'sent',
                attachments,
            });
            asstMsg = this.sessionManager.addMessage(sessionId, {
                id: assistantMessageId,
                role: 'assistant',
                content: '',
                timestamp: Date.now(),
                status: 'processing',
            });
        } catch (addErr) {
            const errStr = addErr instanceof Error ? addErr.message : String(addErr);
            console.error(`[Server] 保存消息失败:`, addErr);
            this.send(ws, {
                type: 'message_ack',
                messageId: userMessageId,
                seq: 0,
                status: 'error',
                error: errStr,
            });
            return;
        }

        // 2. 向该会话所有活跃连接广播用户消息受理确认，并携带提问内容，确保多端时间线完全同步
        this.broadcastSession(sessionId, {
            type: 'message_ack',
            messageId: userMessageId,
            seq: userMsg.seq,
            role: 'user',
            content,
            attachments,
        });

        // 3. 广播助理消息占位
        this.broadcastSession(sessionId, {
            type: 'event_chunk',
            seq: asstMsg.seq,
            sessionId,
            messageId: assistantMessageId,
            delta: '',
            status: 'thinking',
        });

        // 4. 调用 ACP 引擎管理器驱动底层任务 (捕获异步异常，避免 unhandled rejection 导致主进程崩溃)
        this.acpEngine.execute(
            sessionId,
            assistantMessageId,
            content,
            {
            onDelta: (delta: string) => {
                const updated = this.sessionManager.appendDelta(sessionId, assistantMessageId, delta);
                if (updated) {
                    this.broadcastSession(sessionId, {
                        type: 'event_chunk',
                        seq: updated.seq,
                        sessionId,
                        messageId: assistantMessageId,
                        delta,
                    });
                }
            },
            onToolCall: (toolCall: ToolCallState) => {
                const updated = this.sessionManager.setToolCall(sessionId, assistantMessageId, toolCall);
                if (updated) {
                    this.broadcastSession(sessionId, {
                        type: 'event_chunk',
                        seq: updated.seq,
                        sessionId,
                        messageId: assistantMessageId,
                        toolCall,
                        status: 'running_tool',
                    });
                }
            },
            onApprovalRequest: (request) => {
                const seq = this.sessionManager.setTaskState(sessionId, 'awaiting_approval', request);
                this.broadcastSession(sessionId, {
                    type: 'approval_request',
                    seq,
                    sessionId,
                    approvalId: request.approvalId,
                    prompt: request.prompt,
                    toolName: request.toolName,
                    params: request.params,
                });
            },
            onStatusChange: (status, payload?: EngineStatusPayload) => {
                // 过渡态（思考中/执行工具）已由占位 event_chunk 与工具活动广播承载，
                // 任务状态也已由引擎管理器在执行入口落盘，这里不重复推进 seq
                if (status === 'thinking' || status === 'running_tool') {
                    return;
                }
                // stopped 为引擎管理器内部终态（如审批超时自动拒绝），持久化已由管理器完成，
                // 这里广播结构化错误码以修正客户端实时视图
                if (status === 'stopped') {
                    const seq = this.sessionManager.nextSeq(sessionId);
                    this.broadcastSession(sessionId, {
                        type: 'task_status',
                        seq,
                        sessionId,
                        state: 'stopped',
                        error: payload?.code,
                    });
                    return;
                }

                // done/error 终态：消息状态与稳定错误码由此处落盘（引擎管理器只终态化任务状态），
                // error 字段与持久化一致存稳定码，客户端按码本地化渲染、未知码按原文兜底；
                // stopReason 一并持久化，重连对账后截断提示不丢失
                this.sessionManager.updateMessage(sessionId, assistantMessageId, (m) => {
                    m.status = status === 'done' ? 'done' : 'error';
                    if (payload?.code) m.errorMessage = payload.code;
                    if (payload?.stopReason) m.stopReason = payload.stopReason;
                });

                const taskState: TaskExecutionState = status === 'done' ? 'completed' : 'error';
                const seq = this.sessionManager.setTaskState(sessionId, taskState);
                this.broadcastSession(sessionId, {
                    type: 'task_status',
                    seq,
                    sessionId,
                    state: taskState,
                    error: payload?.code,
                    stopReason: payload?.stopReason,
                });
            },
        },
        attachments,
    ).catch((err: unknown) => {
            const errorMsg = err instanceof Error ? err.message : String(err);
            console.error(`[Server] 执行任务发生未捕获异常:`, err);
            this.sessionManager.updateMessage(sessionId, assistantMessageId, (m) => {
                m.status = 'error';
                m.errorMessage = errorMsg;
            });
            const seq = this.sessionManager.setTaskState(sessionId, 'error');
            this.broadcastSession(sessionId, {
                type: 'task_status',
                seq,
                sessionId,
                state: 'error',
                error: errorMsg,
            });
        });
    }

    private send(ws: WebSocket, msg: ServerMessage): void {
        if (ws.readyState === WS.OPEN) {
            try {
                ws.send(JSON.stringify(msg), (err) => {
                    if (err) {
                        console.warn(`[Server] 发送客户端消息失败: ${err.message}`);
                    }
                });
            } catch (err) {
                console.warn(`[Server] 调用 send 抛出异常: ${err}`);
            }
        }
    }

    private broadcastSession(sessionId: string, msg: ServerMessage): void {
        const payload = JSON.stringify(msg);
        this.wss.clients.forEach((client: WebSocket) => {
            const ws = client as AuthenticatedSocket;
            if (ws.isAuthenticated && ws.sessionId === sessionId && ws.readyState === WS.OPEN) {
                try {
                    ws.send(payload, (err) => {
                        if (err) {
                            console.warn(`[Server] 广播消息失败: ${err.message}`);
                        }
                    });
                } catch (err) {
                    console.warn(`[Server] 调用 broadcastSession send 抛出异常: ${err}`);
                }
            }
        });
    }

    /** 向所有已通过认证且处于连接状态的客户端广播报文（跨会话全局广播） */
    public broadcastAll(msg: ServerMessage): void {
        const payload = JSON.stringify(msg);
        this.wss.clients.forEach((client: WebSocket) => {
            const ws = client as AuthenticatedSocket;
            if (ws.isAuthenticated && ws.readyState === WS.OPEN) {
                try {
                    ws.send(payload, (err) => {
                        if (err) {
                            console.warn(`[Server] 全局广播消息失败: ${err.message}`);
                        }
                    });
                } catch (err) {
                    console.warn(`[Server] 调用 broadcastAll send 抛出异常: ${err}`);
                }
            }
        });
    }

    public isShuttingDownOrDraining(): boolean {
        return this.isDraining;
    }

    /**
     * 优雅避让与升级停机：
     * 1. 标记 isDraining = true，拒绝新的高开销后台长期任务；
     * 2. 第一时间向所有在线客户端广播即将升级通知，让客户端提前获悉状态并进入排队态；
     * 3. 若当前有任务正在生成，等待本轮对话完成（带超时熔断兜底）；
     * 4. 再次向在线客户端广播确认（覆盖避让期间新建立连接的客户端）；
     * 5. 等待 500ms 确保网络缓冲区刷出；
     * 6. 安全关闭服务。
     */
    public async gracefulDrainAndStop(options?: {
        estimatedSeconds?: number;
        targetVersion?: string;
        reason?: string;
        timeoutMs?: number;
    }): Promise<void> {
        if (this.isDraining) {
            return;
        }
        this.isDraining = true;
        console.log('[Server] 开始执行优雅停机避让流程 (Graceful Drain)...');

        const estimatedSeconds = options?.estimatedSeconds ?? 5;
        console.log(`[Server] 第一时间向所有在线客户端广播即将升级通知 (预计 ${estimatedSeconds} 秒)...`);
        this.broadcastAll({
            type: 'service_upgrading',
            estimatedSeconds,
            targetVersion: options?.targetVersion,
            reason: options?.reason,
        });

        if (this.acpEngine.hasActiveTasks()) {
            const timeout = options?.timeoutMs ?? 30000;
            console.log(`[Server] 检测到当前有活跃生成任务，等待本轮对话完成（最多 ${timeout / 1000}s 熔断保护）...`);
            await this.acpEngine.waitForIdle(timeout);
            console.log('[Server] 活跃生成任务已结束或已达超时熔断点');

            // 避让等待结束后，再次广播确保期间新连上的客户端也收到升级通知
            this.broadcastAll({
                type: 'service_upgrading',
                estimatedSeconds,
                targetVersion: options?.targetVersion,
                reason: options?.reason,
            });
        }

        // 等待 500ms 确保网络缓冲区完全刷出给所有连接的客户端
        await new Promise((resolve) => setTimeout(resolve, 500));

        console.log('[Server] 正在停止服务与回收资源...');
        await this.stop();
        console.log('[Server] 服务已优雅停机');
    }

    public start(): Promise<void> {
        return new Promise((resolve) => {
            this.httpServer.listen(this.config.port, this.config.host, () => {
                resolve();
            });
        });
    }

    public async stop(): Promise<void> {
        if (this.consolidationInterval) {
            clearInterval(this.consolidationInterval);
            this.consolidationInterval = null;
        }

        // 优雅关停 ACP 引擎：停止全部受理中任务、关闭引擎连接并回收子进程，防止僵尸进程常驻
        await this.acpEngine.stopAll();

        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
        }
        // 终止所有存活的客户端 WebSocket，避免 wss.close() 等待未断开客户端导致关停挂起
        this.wss.clients.forEach((client: WebSocket) => {
            try {
                client.terminate();
            } catch {
                // ignore
            }
        });

        return new Promise((resolve) => {
            const forceTimeout = setTimeout(() => {
                this.httpServer.close(() => {
                    resolve();
                });
            }, 3000);

            this.wss.close(() => {
                clearTimeout(forceTimeout);
                this.httpServer.close(() => {
                    resolve();
                });
            });
        });
    }

    public getContextConsolidator(): ContextConsolidator {
        return this.contextConsolidator;
    }
}
