import i18n from '../i18n';
import { useAssistantStore } from '../store/useAssistantStore';
import { fsService } from './FileSystemService';
import {
    ClientMessage,
    ServerMessage,
    AssistantMessage,
    ChatAttachment,
} from '../types/assistantProtocol';

export class AssistantClient {
    private static instance: AssistantClient | null = null;
    private static messageSeq = 0;
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
        let toParse = trimmed;
        if (!/^https?:\/\//i.test(toParse) && !toParse.startsWith('ws://') && !toParse.startsWith('wss://')) {
            toParse = `http://${toParse}`;
        }
        try {
            const parsed = new URL(toParse);
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
        // 自动将 ws/wss 协议头转换为 fetch 支持的 http/https 协议头
        const httpUrl = cleanUrl.replace(/^ws:\/\//i, 'http://').replace(/^wss:\/\//i, 'https://');
        if (!httpUrl) {
            return { success: false, message: i18n.t('assistant.urlRequired', '服务地址不能为空') };
        }
        if (!token || !token.trim()) {
            return { success: false, message: i18n.t('assistant.tokenRequired', '访问令牌（Token）不能为空') };
        }

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 6000);

            // 1. 测试健康检查
            const healthRes = await fetch(`${httpUrl}/health`, {
                signal: controller.signal,
            });
            clearTimeout(timeoutId);

            if (!healthRes.ok) {
                return { success: false, message: `${i18n.t('assistant.serverError', '服务响应异常')} (${healthRes.status})` };
            }

            const healthData = (await healthRes.json()) as { version?: string };

            // 2. 测试 Token 鉴权（服务端必备安全校验）
            const authController = new AbortController();
            const authTimeout = setTimeout(() => authController.abort(), 6000);
            const infoRes = await fetch(`${httpUrl}/api/info`, {
                headers: {
                    Authorization: `Bearer ${token.trim()}`,
                },
                signal: authController.signal,
            });
            clearTimeout(authTimeout);

            if (infoRes.status === 401) {
                return { success: false, message: i18n.t('assistant.tokenIncorrect', '连接成功，但访问令牌（Token）不正确') };
            }
            if (!infoRes.ok) {
                return { success: false, message: `${i18n.t('assistant.authFailed', '鉴权验证失败')} (${infoRes.status})` };
            }

            return {
                success: true,
                message: i18n.t('assistant.testSuccess', '连接成功'),
                version: healthData.version,
            };
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            if (msg.includes('aborted') || msg.includes('timeout')) {
                return { success: false, message: i18n.t('assistant.connectionTimeout', '连接超时，请检查服务是否启动或网络可达性') };
            }
            return { success: false, message: `${i18n.t('assistant.connectionFailed', '网络连接失败')}: ${msg}` };
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
                store.setConnectionState('connected');
                this.startPing();

                // 认证 & 增量对账
                if (token) {
                    this.sendRaw({ type: 'auth', token });
                }
                const lastSeq = Math.max(store.currentSeq, store.clearedSeq ?? 0);
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
        const isUpgrading = useAssistantStore.getState().isServerUpgrading;
        // 升级期间前 5 次尝试采用 1 秒快速重连，使服务秒级重启就绪后即刻重连；常规断开采用指数退避
        let delay: number;
        if (isUpgrading && this.reconnectAttempts <= 5) {
            delay = 1000;
        } else {
            delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 10000);
        }

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
     * 遵循产品铁律：无论离线、断线还是服务端升级期间，绝不弹窗报错或中断心流，
     * 消息乐观上屏并在本地队列排队，连上对账后自动静默补发。
     */
    public sendMessage(content: string, attachments?: ChatAttachment[], customMessageId?: string): string {
        const store = useAssistantStore.getState();
        const messageId = customMessageId || `msg-${Date.now()}-${++AssistantClient.messageSeq}`;

        const localMessage: AssistantMessage = {
            id: messageId,
            seq: store.currentSeq,
            role: 'user',
            content,
            timestamp: Date.now(),
            status: 'sending',
            attachments,
        };

        store.addOrUpdateMessage(localMessage);

        const isConnected = this.ws && this.ws.readyState === WebSocket.OPEN && store.connectionState === 'connected';
        const isUpgrading = store.isServerUpgrading;

        // 若处于升级中或连接未就绪：自动进入本地待发队列排队，状态保持 sending（微小等待图标），不报任何网络错误
        if (!isConnected || isUpgrading) {
            store.addToPendingSendQueue({
                sessionId: 'main',
                messageId,
                content,
                attachments,
            });
            if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
                this.connect();
            }
            return messageId;
        }

        const sent = this.sendRaw({
            type: 'chat',
            sessionId: 'main',
            messageId,
            content,
            attachments,
        });

        if (!sent) {
            // 发送失败兜底入队
            store.addToPendingSendQueue({
                sessionId: 'main',
                messageId,
                content,
                attachments,
            });
        }

        return messageId;
    }

    /**
     * 自动静默补发待发队列中的积压消息（FIFO 串行推进）
     * 遵循服务端单会话单任务约束：仅在当前无进行中任务时补发第一条，
     * 待收到服务端成功回执后移出队列，并在上一任务执行完毕后自动推进下一条。
     */
    public async flushPendingSendQueue(): Promise<void> {
        const store = useAssistantStore.getState();
        if (store.isServerUpgrading) {
            return;
        }
        // 若当前有任务正在执行中，等待其终态收尾后再推进队列下一条
        if (store.taskState === 'processing' || store.taskState === 'awaiting_approval') {
            return;
        }

        const queue = store.pendingSendQueue;
        if (queue.length === 0) return;

        const nextItem = queue[0];
        let attachments = nextItem.attachments;

        // 若附件在持久化脱水后缺少 Base64/content，依据本地 uri 异步重新读取补全
        if (attachments && attachments.length > 0) {
            try {
                attachments = await Promise.all(
                    attachments.map(async (att) => {
                        if (att.data || att.content || !att.uri) {
                            return att;
                        }
                        const isImg = att.type === 'image';
                        const res = await fsService.readAttachment(
                            att.uri,
                            750 * 1024,
                            isImg ? 'image/jpeg' : att.mimeType,
                            att.name
                        );
                        return {
                            ...att,
                            mimeType: isImg ? 'image/jpeg' : (att.mimeType || 'application/octet-stream'),
                            content: res.content,
                            data: res.data,
                        };
                    })
                );
            } catch {
                // 原文件失效：中止发送残缺指令，将消息标记为明确错误并移出队列
                const existing = store.messages.find((m) => m.id === nextItem.messageId);
                store.addOrUpdateMessage({
                    id: nextItem.messageId,
                    seq: existing?.seq ?? store.currentSeq,
                    role: 'user',
                    content: nextItem.content,
                    timestamp: existing?.timestamp ?? Date.now(),
                    status: 'error',
                    errorMessage: i18n.t('chat.retryAttachmentFailed', '附件原文件已失效，无法重新发送'),
                    attachments: nextItem.attachments,
                });
                store.removeFromPendingSendQueue(nextItem.messageId);
                // 推进后续排队消息
                this.flushPendingSendQueue();
                return;
            }
        }

        // 异步 I/O 完成后二次校验：核验该项是否仍处于待发队列中且无活跃冲突
        const currentStore = useAssistantStore.getState();
        if (
            currentStore.isServerUpgrading ||
            currentStore.taskState === 'processing' ||
            currentStore.taskState === 'awaiting_approval'
        ) {
            return;
        }
        if (!currentStore.pendingSendQueue.some((q) => q.messageId === nextItem.messageId)) {
            return;
        }

        this.sendRaw({
            type: 'chat',
            sessionId: nextItem.sessionId || 'main',
            messageId: nextItem.messageId,
            content: nextItem.content,
            attachments,
        });
        // 收到服务端确认前保持保留在队列中，防止网络闪断丢消息
    }

    /**
     * 响应人工审批
     */
    public respondApproval(approvalId: string, approved: boolean, reason?: string): boolean {
        const store = useAssistantStore.getState();
        const sent = this.sendRaw({
            type: 'approval_response',
            approvalId,
            approved,
            reason,
        });
        if (sent) {
            // 仅移除已应答的这张卡，同一会话的其余并发审批保持展示
            store.removePendingApproval(approvalId);
            return true;
        }
        return false;
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
                if (msg.success) {
                    // 仅在鉴权真正成功后才重置重连尝试计数，防止闪断网络进入 1s 高频重试死循环
                    this.reconnectAttempts = 0;
                } else {
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

            case 'service_upgrading': {
                store.setIsServerUpgrading(true);
                // 收到升级预告，重置重连计数以便进入 1 秒快速重连周期
                this.reconnectAttempts = 0;
                break;
            }

            case 'sync_result': {
                // 重连并完成对账，服务端已恢复正常，解除升级态
                store.setIsServerUpgrading(false);
                store.setCurrentSeq(msg.currentSeq);
                store.setTaskState(msg.taskState);
                // 队列字段优先；回退兼容仅返回单审批的旧服务端
                const approvals = msg.pendingApprovals ?? (msg.pendingApproval ? [msg.pendingApproval] : []);
                store.setPendingApprovals(
                    approvals.map((a) => ({
                        approvalId: a.approvalId,
                        prompt: a.prompt,
                        toolName: a.toolName,
                        params: a.params,
                        status: 'pending',
                    }))
                );

                // 过滤掉小于等于 clearedSeq 的历史消息（用户已清空的历史边界）
                const validServerMessages = msg.messages.filter(
                    (m) => (m.seq ?? 0) > (store.clearedSeq ?? 0)
                );
                const serverIdSet = new Set(validServerMessages.map((m) => m.id));
                const localMessages = store.messages;
                const pendingIds = new Set(store.pendingSendQueue.map((q) => q.messageId));

                const msgMap = new Map<string, AssistantMessage>();
                // 先写入本地已有的所有消息；排队中消息保持 sending 态，其余未确认消息转 error
                for (const m of localMessages) {
                    if (m.status === 'sending' && !serverIdSet.has(m.id)) {
                        if (pendingIds.has(m.id)) {
                            // 消息仍在本地队列中等待补发，保持 sending 态，不报错
                            msgMap.set(m.id, m);
                        } else {
                            msgMap.set(m.id, {
                                ...m,
                                status: 'error',
                                errorMessage: m.errorMessage || i18n.t('assistant.sendInterrupted', '发送中断，请重试'),
                            });
                        }
                    } else {
                        msgMap.set(m.id, m);
                    }
                }
                // 服务端下发的有效消息优先覆盖更新
                for (const m of validServerMessages) {
                    msgMap.set(m.id, m);
                    if (pendingIds.has(m.id)) {
                        store.removeFromPendingSendQueue(m.id);
                    }
                }

                const merged = Array.from(msgMap.values()).sort(
                    (a, b) => a.timestamp - b.timestamp
                );
                store.setMessages(merged);

                // 对账完成后，自动静默补发待发队列中的排队消息
                this.flushPendingSendQueue();
                break;
            }

            case 'message_ack': {
                const existing = store.messages.find((m) => m.id === msg.messageId);
                const isError = msg.status === 'error';

                // 服务端在优雅停机排空期拒绝新任务：客户端将其重新加入本地排队队列并置为升级中态，不向用户报错
                if (isError && msg.error === 'service_upgrading') {
                    store.setIsServerUpgrading(true);
                    this.reconnectAttempts = 0;
                    store.addOrUpdateMessage({
                        id: msg.messageId,
                        seq: msg.seq,
                        role: 'user',
                        content: existing ? existing.content : (msg.content || ''),
                        timestamp: existing ? existing.timestamp : Date.now(),
                        status: 'sending',
                        attachments: existing?.attachments,
                    });
                    store.addToPendingSendQueue({
                        sessionId: 'main',
                        messageId: msg.messageId,
                        content: existing ? existing.content : (msg.content || ''),
                        attachments: existing?.attachments,
                    });
                    break;
                }

                // 服务端会话忙碌（如手动停止后底层子进程尚未完全释放收尾）：排队消息保持 sending 态，稍后自动重试
                if (isError && msg.error === 'session_busy') {
                    store.addOrUpdateMessage({
                        id: msg.messageId,
                        seq: msg.seq,
                        role: 'user',
                        content: existing ? existing.content : (msg.content || ''),
                        timestamp: existing ? existing.timestamp : Date.now(),
                        status: 'sending',
                        attachments: existing?.attachments,
                    });
                    store.addToPendingSendQueue({
                        sessionId: 'main',
                        messageId: msg.messageId,
                        content: existing ? existing.content : (msg.content || ''),
                        attachments: existing?.attachments,
                    });
                    setTimeout(() => {
                        this.flushPendingSendQueue();
                    }, 500);
                    break;
                }

                store.addOrUpdateMessage({
                    id: msg.messageId,
                    seq: msg.seq,
                    role: 'user',
                    content: existing ? existing.content : (msg.content || ''),
                    timestamp: existing ? existing.timestamp : Date.now(),
                    status: isError ? 'error' : 'sent',
                    errorMessage: isError ? (msg.error || '发送失败') : undefined,
                    attachments: existing?.attachments || msg.attachments,
                });
                store.setCurrentSeq(msg.seq);
                // 收到服务端终态回执（成功或明确失败）：均移出本地待发队列释放队首
                store.removeFromPendingSendQueue(msg.messageId);
                // 若为终态失败回执，后续不会产生任务执行与状态回调，主动推进队列中的下一条积压消息
                if (isError) {
                    this.flushPendingSendQueue();
                }
                break;
            }

            case 'event_chunk': {
                store.setCurrentSeq(msg.seq);

                // 支持全量文本校准（如终态 final 事件）与增量流式追加
                const existing = store.messages.find((m) => m.id === msg.messageId);
                if (msg.content !== undefined) {
                    store.addOrUpdateMessage({
                        id: msg.messageId,
                        seq: msg.seq,
                        role: 'assistant',
                        content: msg.content,
                        timestamp: existing ? existing.timestamp : Date.now(),
                        status: 'processing',
                    });
                } else if (!existing) {
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
                // 追加到待审批队列：同一会话并发多个工具各自请求审批时逐卡展示
                store.addPendingApproval({
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
                    // 任务已终态：未决审批卡随任务结束一并撤除
                    store.setPendingApprovals([]);
                    // 精准定位会话中最新一条处于 processing 的助理消息，避免被并发或被拦截的用户气泡干扰
                    const messages = store.messages;
                    const asstMsg = [...messages].reverse().find(
                        (m) => m.role === 'assistant' && m.status === 'processing'
                    );
                    if (asstMsg) {
                        store.addOrUpdateMessage({
                            ...asstMsg,
                            status: msg.state === 'completed' ? 'done' : msg.state === 'error' ? 'error' : 'done',
                            errorMessage: msg.error,
                            stopReason: msg.stopReason,
                        });
                    }

                    // 上一个任务已结束，串行推进待发队列中的下一条排队消息
                    // 若为停止操作，轻量缓冲 300ms 避开服务端底层子进程异步收尾间隙
                    if (msg.state === 'stopped') {
                        setTimeout(() => {
                            this.flushPendingSendQueue();
                        }, 300);
                    } else {
                        this.flushPendingSendQueue();
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
