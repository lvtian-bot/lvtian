import http from 'node:http';
import { createRequire } from 'node:module';
import type WebSocket from 'ws';
import { ServerConfig } from './config.js';
import { SessionManager } from './sessionManager.js';
import { MemoryManager } from './memoryManager.js';
import { DshRunner } from './dshRunner.js';
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
    private httpServer: http.Server;
    private wss: any;
    private heartbeatInterval: ReturnType<typeof setInterval> | null = null;

    constructor(
        config: ServerConfig,
        sessionManager: SessionManager,
        memoryManager: MemoryManager,
        dshRunner: DshRunner
    ) {
        this.config = config;
        this.sessionManager = sessionManager;
        this.memoryManager = memoryManager;
        this.dshRunner = dshRunner;

        this.httpServer = http.createServer((req, res) => {
            this.handleHttpRequest(req, res);
        });

        this.wss = new WS.Server({ server: this.httpServer });
        this.setupWebSocket();
    }

    private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
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

        // 实例连接信息验证（需要 Bearer Token）
        if (pathname === '/api/info' && req.method === 'GET') {
            const authHeader = req.headers.authorization;
            const token = authHeader?.startsWith('Bearer ')
                ? authHeader.slice(7)
                : urlObj.searchParams.get('token');

            if (token !== this.config.token) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: '无效的访问令牌（Unauthorized）' }));
                return;
            }

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

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '未找到接口' }));
    }

    private setupWebSocket(): void {
        this.wss.on('connection', (ws: AuthenticatedSocket, req: http.IncomingMessage) => {
            ws.isAlive = true;
            ws.isAuthenticated = false;
            ws.sessionId = 'main';

            let queryToken: string | null = null;
            try {
                const urlObj = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
                queryToken = urlObj.searchParams.get('token');
            } catch {
                // 忽略异常主机头
            }

            // 如果 URL 参数中包含正确 token，直接视为认证通过
            if (queryToken && queryToken === this.config.token) {
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
            }

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

        // 1. 存入用户消息
        const userMsg = this.sessionManager.addMessage(sessionId, {
            id: userMessageId,
            role: 'user',
            content,
            timestamp: Date.now(),
            status: 'sent',
        });

        // 2. 确认已受理
        this.send(ws, {
            type: 'message_ack',
            messageId: userMessageId,
            seq: userMsg.seq,
        });

        // 3. 创建助理回复消息占位
        const assistantMessageId = `asst-${Date.now()}`;
        const asstMsg = this.sessionManager.addMessage(sessionId, {
            id: assistantMessageId,
            role: 'assistant',
            content: '',
            timestamp: Date.now(),
            status: 'processing',
        });

        // 广播助理消息占位
        this.broadcastSession(sessionId, {
            type: 'event_chunk',
            seq: asstMsg.seq,
            sessionId,
            messageId: assistantMessageId,
            delta: '',
            status: 'thinking',
        });

        // 4. 调用 DshRunner 驱动底层任务
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
        });
    }

    private send(ws: WebSocket, msg: ServerMessage): void {
        if (ws.readyState === WS.OPEN) {
            ws.send(JSON.stringify(msg));
        }
    }

    private broadcastSession(sessionId: string, msg: ServerMessage): void {
        const payload = JSON.stringify(msg);
        this.wss.clients.forEach((client: WebSocket) => {
            const ws = client as AuthenticatedSocket;
            if (ws.isAuthenticated && ws.sessionId === sessionId && ws.readyState === WS.OPEN) {
                ws.send(payload);
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

    public stop(): Promise<void> {
        return new Promise((resolve) => {
            // 终止所有正在运行的底层 dsh 子进程，防止僵尸进程常驻
            this.dshRunner.stopAll();

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
