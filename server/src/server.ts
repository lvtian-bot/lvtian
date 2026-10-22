import http from 'node:http';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import type WebSocket from 'ws';
import type { WebSocketServer } from 'ws';
import { ServerConfig } from './config.js';
import { SessionManager } from './sessionManager.js';
import { MemoryManager } from './memoryManager.js';
import { DshRunner } from './dshRunner.js';
import { FileManager, FileManagerError } from './fileManager.js';
import {
    ClientMessage,
    ServerMessage,
    ToolCallState,
    TaskExecutionState,
} from './protocol.js';

const require = createRequire(import.meta.url);
const WS = require('ws');

interface AuthenticatedSocket extends WebSocket {
    isAuthenticated?: boolean;
    isAlive?: boolean;
    sessionId?: string;
}

export class LvtianServer {
    private config: ServerConfig;
    private sessionManager: SessionManager;
    private memoryManager: MemoryManager;
    private dshRunner: DshRunner;
    private fileManager: FileManager;
    private httpServer: http.Server;
    private wss: WebSocketServer;
    private heartbeatInterval: ReturnType<typeof setInterval> | null = null;

    constructor(
        config: ServerConfig,
        sessionManager: SessionManager,
        memoryManager: MemoryManager,
        dshRunner: DshRunner,
        fileManager?: FileManager
    ) {
        this.config = config;
        this.sessionManager = sessionManager;
        this.memoryManager = memoryManager;
        this.dshRunner = dshRunner;
        this.fileManager = fileManager || new FileManager(config.workspace);

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
            maxPayload: 1024 * 1024, // 限制单条报文 1MB 上限，防止超大报文消耗内存或阻塞事件循环
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
                })
            );
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
                const body = await this.readJsonBody<{ path?: string; content?: string; expectedMtime?: number }>(req);
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
                res.writeHead(200, {
                    'Content-Type': 'application/octet-stream',
                    'Content-Length': downloadInfo.size,
                    'Content-Disposition': `attachment; filename="${encodeURIComponent(downloadInfo.fileName)}"`,
                });
                const stream = fs.createReadStream(downloadInfo.resolvedPath);
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
                const sessionId = msg.sessionId || 'main';
                ws.sessionId = sessionId;
                const reconcile = this.sessionManager.getReconcileData(sessionId, msg.lastSeq);
                this.send(ws, {
                    type: 'sync_result',
                    sessionId,
                    messages: reconcile.messages,
                    taskState: reconcile.taskState,
                    pendingApproval: reconcile.pendingApproval,
                    currentSeq: reconcile.currentSeq,
                });
                break;
            }

            case 'chat': {
                this.handleChat(ws, msg.sessionId || 'main', msg.messageId, msg.content);
                break;
            }

            case 'stop': {
                const sessionId = msg.sessionId || 'main';
                const stopped = this.dshRunner.stop(sessionId);
                const seq = this.sessionManager.nextSeq(sessionId);
                this.broadcastSession(sessionId, {
                    type: 'task_status',
                    seq,
                    sessionId,
                    state: 'stopped',
                    error: stopped ? '任务已被手动终止' : undefined,
                });
                break;
            }

            case 'approval_response': {
                // 人工审批响应
                const sessionId = ws.sessionId || 'main';
                const pending = this.sessionManager.getPendingApproval(sessionId);
                if (pending && pending.approvalId === msg.approvalId) {
                    this.sessionManager.clearPendingApproval(sessionId);
                    const nextState = msg.approved ? 'processing' : 'stopped';
                    const seq = this.sessionManager.setTaskState(sessionId, nextState);
                    this.dshRunner.handleApproval(sessionId, msg.approvalId, msg.approved);
                    this.broadcastSession(sessionId, {
                        type: 'task_status',
                        seq,
                        sessionId,
                        state: nextState,
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
        content: string
    ): void {
        // 如果当前已有任务在执行，拒绝并发任务且通知客户端该消息发送失败
        if (this.dshRunner.isRunning(sessionId)) {
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

        // 4. 调用 DshRunner 驱动底层任务 (捕获异步异常，避免 unhandled rejection 导致主进程崩溃)
        this.dshRunner.execute(sessionId, assistantMessageId, content, {
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
            onStatusChange: (status: 'thinking' | 'running_tool' | 'done' | 'error', error?: string) => {
                let taskState: TaskExecutionState = 'processing';
                if (status === 'done') taskState = 'completed';
                if (status === 'error') taskState = 'error';

                this.sessionManager.updateMessage(sessionId, assistantMessageId, (m) => {
                    m.status = status === 'done' ? 'done' : status === 'error' ? 'error' : 'processing';
                    if (error) m.errorMessage = error;
                });

                const seq = this.sessionManager.setTaskState(sessionId, taskState);
                this.broadcastSession(sessionId, {
                    type: 'task_status',
                    seq,
                    sessionId,
                    state: taskState,
                    error,
                });
            },
            onFinalText: (fullText: string) => {
                const session = this.sessionManager.getOrCreateSession(sessionId);
                const currentMsg = session.messages.find((m) => m.id === assistantMessageId);
                const currentContent = currentMsg ? currentMsg.content : '';
                if (fullText && fullText !== currentContent) {
                    const updated = this.sessionManager.updateMessage(
                        sessionId,
                        assistantMessageId,
                        (m) => {
                            m.content = fullText;
                        },
                        true,
                        true
                    );
                    if (updated) {
                        this.broadcastSession(sessionId, {
                            type: 'event_chunk',
                            seq: updated.seq,
                            sessionId,
                            messageId: assistantMessageId,
                            content: fullText,
                        });
                    }
                }
            },
        }).catch((err: unknown) => {
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

    public start(): Promise<void> {
        return new Promise((resolve) => {
            this.httpServer.listen(this.config.port, this.config.host, () => {
                resolve();
            });
        });
    }

    public async stop(): Promise<void> {
        // 优雅终止所有正在运行的底层 dsh 子进程，等待其退出（带 2.5s 超时），防止僵尸进程常驻
        await this.dshRunner.stopAll();

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
}
