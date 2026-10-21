import { useAssistantStore } from '../store/useAssistantStore';
import {
    ClientMessage,
    ServerMessage,
    AssistantMessage,
} from '../types/assistantProtocol';

export class AssistantClient {
    private static instance: AssistantClient | null = null;
    private ws: WebSocket | null = null;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private pingTimer: ReturnType<typeof setInterval> | null = null;
    private reconnectAttempts = 0;
    private isExplicitlyClosed = false;
    private activeUrl: string | null = null;
    private activeToken: string | null = null;

    public static getInstance(): AssistantClient {
        if (!AssistantClient.instance) {
            AssistantClient.instance = new AssistantClient();
        }
        return AssistantClient.instance;
    }

    /**
     * 解析一键配置链接，提取服务地址与 Token
     */
    public static parseConnectionUrl(input: string): { url: string; token: string } {
        const trimmed = input.trim();
        try {
            const parsed = new URL(trimmed);
            const token = parsed.searchParams.get('token') || '';
            parsed.search = '';
            parsed.hash = '';
            let cleanUrl = parsed.toString().replace(/\/+$/, '');
            return { url: cleanUrl, token };
        } catch {
            return { url: trimmed, token: '' };
        }
    }

    /**
     * 联通性测试 (HTTP)
     */
    public static async testConnection(
        serverUrl: string,
        token: string
    ): Promise<{ success: boolean; message: string; version?: string }> {
        const cleanUrl = serverUrl.trim().replace(/\/+$/, '');
        if (!cleanUrl) {
            return { success: false, message: '服务地址不能为空' };
        }
        if (!token || !token.trim()) {
            return { success: false, message: '访问令牌（Token）不能为空' };
        }

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 6000);

            // 1. 测试健康检查
            const healthRes = await fetch(`${cleanUrl}/health`, {
                signal: controller.signal,
            });
            clearTimeout(timeoutId);

            if (!healthRes.ok) {
                return { success: false, message: `服务响应异常 (${healthRes.status})` };
            }

            const healthData = (await healthRes.json()) as { version?: string };

            // 2. 测试 Token 鉴权（服务端必备安全校验）
            const authController = new AbortController();
            const authTimeout = setTimeout(() => authController.abort(), 6000);
            const infoRes = await fetch(`${cleanUrl}/api/info`, {
                headers: {
                    Authorization: `Bearer ${token.trim()}`,
                },
                signal: authController.signal,
            });
            clearTimeout(authTimeout);

            if (infoRes.status === 401) {
                return { success: false, message: '连接成功，但访问令牌（Token）不正确' };
            }
            if (!infoRes.ok) {
                return { success: false, message: `鉴权验证失败 (${infoRes.status})` };
            }

            return {
                success: true,
                message: '连接成功',
                version: healthData.version,
            };
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('aborted') || msg.includes('timeout')) {
                return { success: false, message: '连接超时，请检查服务是否启动或网络可达性' };
            }
            return { success: false, message: `网络连接失败: ${msg}` };
        }
    }

    /**
     * 启动长连接
     */
    public async connect(forceReconnect = false): Promise<void> {
        this.isExplicitlyClosed = false;
        const store = useAssistantStore.getState();
        const { url, token } = await store.loadSavedCredentials();

        if (!url) {
            store.setConnectionState('disconnected', null);
            return;
        }

        // 如果未要求强制重连，且 WebSocket 已处于连接或打开状态，并且目标地址与 Token 均未变化，则不重复连接
        if (
            !forceReconnect &&
            this.ws &&
            (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN) &&
            this.activeUrl === url &&
            this.activeToken === token
        ) {
            return;
        }

        this.cleanUpWs();
        this.activeUrl = url;
        this.activeToken = token;
        store.setConnectionState(this.reconnectAttempts > 0 ? 'reconnecting' : 'connecting');

        try {
            // 将 http/https 转换为 ws/wss，不再在 URL 查询参数中携带 token，避免在反向代理等访问日志中泄露长效凭据
            const wsUrl = url.replace(/^http:\/\//, 'ws://').replace(/^https:\/\//, 'wss://');
            this.ws = new WebSocket(wsUrl);

            this.ws.onopen = () => {
                this.reconnectAttempts = 0;
                store.setConnectionState('connected');
                this.startPing();

                // 认证 & 增量对账
                if (token) {
                    this.sendRaw({ type: 'auth', token });
                }
                const lastSeq = store.currentSeq;
                this.sendRaw({ type: 'sync', sessionId: 'main', lastSeq });
            };

            this.ws.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data as string) as ServerMessage;
                    this.handleServerMessage(data);
                } catch (err) {
                    console.warn('[AssistantClient] 解析下发数据失败:', err);
                }
            };

            this.ws.onerror = (_event) => {
                console.warn('[AssistantClient] WebSocket 发生异常');
            };

            this.ws.onclose = (_event) => {
                this.stopPing();
                if (!this.isExplicitlyClosed) {
                    store.setConnectionState('disconnected', '连接已断开，正在准备重连...');
                    this.scheduleReconnect();
                } else {
                    store.setConnectionState('disconnected', null);
                }
            };
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            store.setConnectionState('error', msg);
            this.scheduleReconnect();
        }
    }

    /**
     * 断开连接
     */
    public disconnect(): void {
        this.isExplicitlyClosed = true;
        this.activeUrl = null;
        this.activeToken = null;
        this.stopPing();
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.cleanUpWs();
        useAssistantStore.getState().setConnectionState('disconnected');
    }

    private cleanUpWs(): void {
        if (this.ws) {
            try {
                this.ws.onopen = null;
                this.ws.onmessage = null;
                this.ws.onerror = null;
                this.ws.onclose = null;
                this.ws.close();
            } catch {}
            this.ws = null;
        }
    }

    private scheduleReconnect(): void {
        if (this.isExplicitlyClosed || this.reconnectTimer) return;

        this.reconnectAttempts += 1;
        // 指数退避: 1s, 2s, 4s, 最大 10s
        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 10000);

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, delay);
    }

    private startPing(): void {
        this.stopPing();
        this.pingTimer = setInterval(() => {
            this.sendRaw({ type: 'ping' });
        }, 15000);
    }

    private stopPing(): void {
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }
    }

    private sendRaw(msg: ClientMessage): boolean {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(msg));
            return true;
        }
        return false;
    }

    /**
     * 发送聊天消息
     */
    public sendMessage(content: string): string {
        const store = useAssistantStore.getState();
        const messageId = `msg-${Date.now()}`;

        const localMessage: AssistantMessage = {
            id: messageId,
            seq: store.currentSeq,
            role: 'user',
            content,
            timestamp: Date.now(),
            status: 'sending',
        };

        store.addOrUpdateMessage(localMessage);

        const sent = this.sendRaw({
            type: 'chat',
            sessionId: 'main',
            messageId,
            content,
        });

        if (!sent) {
            store.addOrUpdateMessage({
                ...localMessage,
                status: 'error',
                errorMessage: '网络连接未就绪，消息已暂存，连上后可重试',
            });
        }

        return messageId;
    }

    /**
     * 响应人工审批
     */
    public respondApproval(approvalId: string, approved: boolean, reason?: string): void {
        const store = useAssistantStore.getState();
        this.sendRaw({
            type: 'approval_response',
            approvalId,
            approved,
            reason,
        });
        store.setPendingApproval(null);
    }

    /**
     * 停止当前执行
     */
    public stopExecution(): boolean {
        const sent = this.sendRaw({
            type: 'stop',
            sessionId: 'main',
        });
        if (sent) {
            useAssistantStore.getState().setTaskState('stopped');
            return true;
        }
        return false;
    }

    /**
     * 处理服务端下发的事件报文
     */
    private handleServerMessage(msg: ServerMessage): void {
        const store = useAssistantStore.getState();

        switch (msg.type) {
            case 'auth_result': {
                if (!msg.success) {
                    store.setConnectionState('error', msg.error || '认证失败，请检查访问令牌');
                    this.isExplicitlyClosed = true;
                    this.stopPing();
                    if (this.reconnectTimer) {
                        clearTimeout(this.reconnectTimer);
                        this.reconnectTimer = null;
                    }
                    this.cleanUpWs();
                }
                break;
            }

            case 'sync_result': {
                store.setCurrentSeq(msg.currentSeq);
                store.setTaskState(msg.taskState);
                if (msg.pendingApproval) {
                    store.setPendingApproval({
                        approvalId: msg.pendingApproval.approvalId,
                        prompt: msg.pendingApproval.prompt,
                        toolName: msg.pendingApproval.toolName,
                        params: msg.pendingApproval.params,
                        status: 'pending',
                    });
                } else {
                    store.setPendingApproval(null);
                }

                // 保留本地发送失败或仍在排队发送的未决消息，防止重连后用户重试入口丢失
                const localMessages = store.messages;
                const localUnsent = localMessages.filter(
                    (m) => m.status === 'error' || m.status === 'sending'
                );

                const msgMap = new Map<string, AssistantMessage>();
                // 先写入本地已有的所有消息（支持增量同步）
                for (const m of localMessages) {
                    msgMap.set(m.id, m);
                }
                // 服务端下发的消息优先覆盖更新
                for (const m of msg.messages) {
                    msgMap.set(m.id, m);
                }
                // 确保本地未成功的消息依然保留；若原本处于 sending 的消息未获服务端确认，转为 error 状态以激活重试按钮
                for (const m of localUnsent) {
                    if (!msgMap.has(m.id)) {
                        msgMap.set(m.id, {
                            ...m,
                            status: 'error',
                            errorMessage: m.errorMessage || '发送中断，请重试',
                        });
                    } else if (msgMap.get(m.id)?.status === 'error') {
                        msgMap.set(m.id, m);
                    }
                }

                const merged = Array.from(msgMap.values()).sort(
                    (a, b) => a.timestamp - b.timestamp
                );
                store.setMessages(merged);
                break;
            }

            case 'message_ack': {
                const existing = store.messages.find((m) => m.id === msg.messageId);
                const isError = msg.status === 'error';
                store.addOrUpdateMessage({
                    id: msg.messageId,
                    seq: msg.seq,
                    role: 'user',
                    content: existing ? existing.content : '',
                    timestamp: existing ? existing.timestamp : Date.now(),
                    status: isError ? 'error' : 'sent',
                    errorMessage: isError ? (msg.error || '发送失败') : undefined,
                });
                store.setCurrentSeq(msg.seq);
                break;
            }

            case 'event_chunk': {
                store.setCurrentSeq(msg.seq);

                // 仅当该助理回复占位卡片尚不存在时才初始化创建，避免流式覆写已有文本
                const existing = store.messages.find((m) => m.id === msg.messageId);
                if (!existing) {
                    store.addOrUpdateMessage({
                        id: msg.messageId,
                        seq: msg.seq,
                        role: 'assistant',
                        content: msg.delta || '',
                        timestamp: Date.now(),
                        status: 'processing',
                    });
                } else if (msg.delta) {
                    store.appendDeltaToMessage(msg.messageId, msg.delta);
                }

                if (msg.toolCall) {
                    store.setToolCallForMessage(msg.messageId, msg.toolCall);
                }
                break;
            }

            case 'approval_request': {
                store.setCurrentSeq(msg.seq);
                store.setPendingApproval({
                    approvalId: msg.approvalId,
                    prompt: msg.prompt,
                    toolName: msg.toolName,
                    params: msg.params,
                    status: 'pending',
                });
                store.setTaskState('awaiting_approval');
                break;
            }

            case 'task_status': {
                store.setCurrentSeq(msg.seq);
                store.setTaskState(msg.state);
                if (msg.state === 'completed' || msg.state === 'stopped' || msg.state === 'error') {
                    // 更新最后一条处理中消息的状态
                    const lastMsg = store.messages[store.messages.length - 1];
                    if (lastMsg && lastMsg.role === 'assistant') {
                        store.addOrUpdateMessage({
                            ...lastMsg,
                            status: msg.state === 'completed' ? 'done' : msg.state === 'error' ? 'error' : 'done',
                            errorMessage: msg.error,
                        });
                    }
                }
                break;
            }

            case 'pong': {
                // 心跳回执
                break;
            }
        }
    }
}
