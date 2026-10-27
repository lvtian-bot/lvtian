import { AppState, type AppStateStatus } from 'react-native';
import i18n from '../i18n';
import { useAssistantStore } from '../store/useAssistantStore';
import { fsService } from './FileSystemService';
import { isAttachmentBudgetExceeded } from '../utils/attachmentBudget';
import {
    ClientMessage,
    ServerMessage,
    AssistantMessage,
    ChatAttachment,
    AgentSkill,
    AgentModelOption,
} from '../types/assistantProtocol';

export class AssistantClient {
    private static instance: AssistantClient | null = null;
    private static messageSeq = 0;
    private ws: WebSocket | null = null;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private pingTimer: ReturnType<typeof setInterval> | null = null;
    private pongTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
    private reconnectAttempts = 0;
    private isExplicitlyClosed = false;
    private activeUrl: string | null = null;
    private activeToken: string | null = null;
    private cancellingMessages: Map<string, AssistantMessage> = new Map();
    private currentAppState: AppStateStatus = (AppState.currentState as AppStateStatus) || 'active';
    private lastBackgroundTimestamp = 0;
    private appStateSubscription: { remove: () => void } | null = null;
    private pendingResetCallbacks: Map<string, Array<(success: boolean) => void>> = new Map();

    private constructor() {
        this.setupAppStateListener();
    }

    /**
     * 将 ws:// / wss:// 协议头标准化转换为 fetch 支持的 http:// / https://
     */
    public static toHttpUrl(rawUrl: string): string {
        const cleanUrl = rawUrl.trim().replace(/\/+$/, '');
        return cleanUrl.replace(/^ws:\/\//i, 'http://').replace(/^wss:\/\//i, 'https://');
    }

    public static getInstance(): AssistantClient {
        if (!AssistantClient.instance) {
            AssistantClient.instance = new AssistantClient();
        }
        return AssistantClient.instance;
    }

    private setupAppStateListener(): void {
        this.currentAppState = (AppState.currentState as AppStateStatus) || 'active';
        this.appStateSubscription = AppState.addEventListener('change', (nextAppState: AppStateStatus) => {
            const prevAppState = this.currentAppState;
            this.currentAppState = nextAppState;
            if (prevAppState.match(/inactive|background/) && nextAppState === 'active') {
                this.handleAppForeground();
            } else if (nextAppState.match(/inactive|background/)) {
                this.lastBackgroundTimestamp = Date.now();
            }
        });
    }

    /**
     * 应用切回前台（热启动唤醒）的极速重连机制：
     * 1. 清除任何正在排队的延迟重连定时器；
     * 2. 重置重连次数为 0，前台用户交互拥有最高连接优先级；
     * 3. 若切入后台超过 3 秒，移动端旧 Socket 极大概率已处于操作系统休眠或半开假死态，
     *    不再盲目等待心跳超时，立即果断推倒旧连接，0 毫秒极速重建；
     * 4. 若切入后台时间极短且 Socket 仍处于 OPEN，立即主动发送探活 Ping 并开启 3.5 秒熔断保护。
     */
    public handleAppForeground(): void {
        const store = useAssistantStore.getState();
        if (!store.serverUrl) return;

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        this.reconnectAttempts = 0;

        const backgroundDurationMs = this.lastBackgroundTimestamp > 0
            ? Date.now() - this.lastBackgroundTimestamp
            : 0;
        this.lastBackgroundTimestamp = 0;

        const isWsOpen = this.ws && this.ws.readyState === WebSocket.OPEN;
        const isWsConnecting = this.ws && this.ws.readyState === WebSocket.CONNECTING;

        // 若当前已有连接正处于握手建立中（CONNECTING），避免重复触发推倒重建
        if (isWsConnecting) {
            return;
        }

        if (!isWsOpen || backgroundDurationMs > 3000) {
            // 切后台超过 3 秒或连接已断：推倒旧连接，0ms 极速重建
            this.connect(true);
        } else {
            // 短暂停留：主动发送探活 Ping 并挂载假死熔断保护
            this.sendPingWithTimeout();
        }
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
    ): Promise<{ success: boolean; message: string; version?: string; permissionMode?: 'workspace-write' | 'danger-full-access' }> {
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

            const infoData = (await infoRes.json().catch(() => ({}))) as {
                permissionMode?: 'workspace-write' | 'danger-full-access';
            };

            return {
                success: true,
                message: i18n.t('assistant.testSuccess', '连接成功'),
                version: healthData.version,
                permissionMode: infoData.permissionMode,
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
     * 查询服务端当前 DSH 权限模式
     */
    public static async fetchPermissionMode(
        serverUrl: string,
        token: string
    ): Promise<'workspace-write' | 'danger-full-access' | null> {
        const cleanUrl = serverUrl.trim().replace(/\/+$/, '');
        const httpUrl = cleanUrl.replace(/^ws:\/\//i, 'http://').replace(/^wss:\/\//i, 'https://');
        if (!httpUrl || !token) return null;
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 6000);
            const res = await fetch(`${httpUrl}/api/permission`, {
                headers: { Authorization: `Bearer ${token.trim()}` },
                signal: controller.signal,
            });
            clearTimeout(timeoutId);
            if (!res.ok) return null;
            const data = (await res.json()) as { permissionMode?: 'workspace-write' | 'danger-full-access' };
            return data.permissionMode ?? 'workspace-write';
        } catch {
            return null;
        }
    }

    /**
     * 修改服务端 DSH 权限模式并触发统一会话交接
     */
    public static async updatePermissionMode(
        serverUrl: string,
        token: string,
        mode: 'workspace-write' | 'danger-full-access'
    ): Promise<{ success: boolean; changed?: boolean; code?: string; message?: string }> {
        const cleanUrl = serverUrl.trim().replace(/\/+$/, '');
        const httpUrl = cleanUrl.replace(/^ws:\/\//i, 'http://').replace(/^wss:\/\//i, 'https://');
        if (!httpUrl || !token) return { success: false, code: 'PARAM_INVALID' };
        try {
            const controller = new AbortController();
            // 权限切换可能包含服务端即时提炼《心智接力备忘录》的深度大模型调用，放宽超时至 60 秒
            const timeoutId = setTimeout(() => controller.abort(), 60000);
            const res = await fetch(`${httpUrl}/api/permission`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${token.trim()}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ permissionMode: mode }),
                signal: controller.signal,
            });
            clearTimeout(timeoutId);
            if (res.ok) {
                const data = (await res.json().catch(() => null)) as { changed?: boolean } | null;
                return { success: true, changed: data?.changed };
            }
            const data = (await res.json().catch(() => null)) as { code?: string; error?: string } | null;
            return {
                success: false,
                code: data?.code,
                message: data?.error,
            };
        } catch {
            return { success: false, code: 'NETWORK_ERROR' };
        }
    }

    /**
     * 查询服务端当前助理模型与可选项
     */
    public static async fetchModelSelection(
        serverUrl: string,
        token: string
    ): Promise<{ provider: string; model: string; options: AgentModelOption[] } | null> {
        const httpUrl = AssistantClient.toHttpUrl(serverUrl);
        if (!httpUrl || !token) return null;
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 6000);
            const res = await fetch(`${httpUrl}/api/model`, {
                headers: { Authorization: `Bearer ${token.trim()}` },
                signal: controller.signal,
            });
            clearTimeout(timeoutId);
            if (!res.ok) return null;
            const data = (await res.json()) as {
                provider?: string;
                model?: string;
                options?: AgentModelOption[];
            };
            if (!data.provider || !data.model) return null;
            return {
                provider: data.provider,
                model: data.model,
                options: Array.isArray(data.options) ? data.options : [],
            };
        } catch {
            return null;
        }
    }

    /**
     * 修改服务端助理模型并触发统一会话交接（新模型自下一个会话生效）
     */
    public static async updateModelSelection(
        serverUrl: string,
        token: string,
        provider: string,
        model: string
    ): Promise<{ success: boolean; changed?: boolean; code?: string; message?: string }> {
        const httpUrl = AssistantClient.toHttpUrl(serverUrl);
        if (!httpUrl || !token) return { success: false, code: 'PARAM_INVALID' };
        try {
            const controller = new AbortController();
            // 模型切换与会话交接共用流水线，可能包含服务端即时提炼《心智接力备忘录》的深度大模型调用，放宽超时至 60 秒
            const timeoutId = setTimeout(() => controller.abort(), 60000);
            const res = await fetch(`${httpUrl}/api/model`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${token.trim()}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ provider, model }),
                signal: controller.signal,
            });
            clearTimeout(timeoutId);
            if (res.ok) {
                const data = (await res.json().catch(() => null)) as { changed?: boolean } | null;
                return { success: true, changed: data?.changed };
            }
            const data = (await res.json().catch(() => null)) as { code?: string; error?: string } | null;
            return {
                success: false,
                code: data?.code,
                message: data?.error,
            };
        } catch {
            return { success: false, code: 'NETWORK_ERROR' };
        }
    }

    /**
     * 启动长连接
     */
    public async connect(forceReconnect = false): Promise<void> {
        this.isExplicitlyClosed = false;
        const store = useAssistantStore.getState();

        // 优先从 Zustand 内存读取 URL 与 Token，消除每次重连访问 SecureStore 的跨桥解密耗时
        let url = store.serverUrl;
        let token = store.serverToken;

        // 仅在内存无 Token 时降级读取 SecureStore（冷启动初次水合场景）
        if (!token || !url) {
            const creds = await store.loadSavedCredentials();
            url = creds.url;
            token = creds.token;
        }

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
        this.clearPongTimeout();
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
        const store = useAssistantStore.getState();
        const isUpgrading = store.isServerUpgrading;
        const isForeground = this.currentAppState === 'active';

        let delay: number;
        if (isForeground) {
            // 前台交互状态下取消惩罚性退避：前 3 次重试 0 毫秒（50ms 缓冲防重入）；第 4-6 次等待 1 秒；之后最多 3 秒
            if (this.reconnectAttempts <= 3) {
                delay = 50;
            } else if (this.reconnectAttempts <= 6) {
                delay = 1000;
            } else {
                delay = 3000;
            }
        } else if (isUpgrading && this.reconnectAttempts <= 5) {
            delay = 1000;
        } else {
            // 后台断开采用退避，避免无效重试占用电量
            delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1), 10000);
        }

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, delay);
    }

    private startPing(): void {
        this.stopPing();
        // 前台心跳设为 10 秒，更早发现假死链路
        this.pingTimer = setInterval(() => {
            this.sendPingWithTimeout();
        }, 10000);
    }

    private sendPingWithTimeout(): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

        this.clearPongTimeout();
        this.sendRaw({ type: 'ping' });

        // 挂载 3500ms 假死熔断保护：若 3.5 秒内无任何下行数据，判定当前网络为假死黑洞，立即推倒重连
        this.pongTimeoutTimer = setTimeout(() => {
            console.warn('[AssistantClient] 心跳应答超时（3.5s），判定当前网络为假死链路，立即重建连接');
            this.cleanUpWs();
            this.scheduleReconnect();
        }, 3500);
    }

    private clearPongTimeout(): void {
        if (this.pongTimeoutTimer) {
            clearTimeout(this.pongTimeoutTimer);
            this.pongTimeoutTimer = null;
        }
    }

    private stopPing(): void {
        this.clearPongTimeout();
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
        if (isAttachmentBudgetExceeded(attachments)) {
            throw new Error(i18n.t('chat.attachmentTooLarge', '附件体积过大（上限 10MB）'));
        }
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
                        if (att.data !== undefined || att.content !== undefined || !att.uri) {
                            return att;
                        }
                        const isImg = att.type === 'image';
                        const res = await fsService.readAttachment(
                            att.uri,
                            10 * 1024 * 1024,
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
                if (isAttachmentBudgetExceeded(attachments)) {
                    throw new Error('ATTACHMENT_TOO_LARGE');
                }
            } catch (error: unknown) {
                // 原文件失效或重新读取后附件合计超限：若在此期间会话已被清空或重置，不再写入旧消息
                const currentStore = useAssistantStore.getState();
                if (!currentStore.pendingSendQueue.some((q) => q.messageId === nextItem.messageId)) {
                    return;
                }
                const existing = currentStore.messages.find((m) => m.id === nextItem.messageId);
                currentStore.addOrUpdateMessage({
                    id: nextItem.messageId,
                    seq: existing?.seq ?? currentStore.currentSeq,
                    role: 'user',
                    content: nextItem.content,
                    timestamp: existing?.timestamp ?? Date.now(),
                    status: 'error',
                    errorMessage: error instanceof Error && error.message === 'ATTACHMENT_TOO_LARGE'
                        ? i18n.t('chat.attachmentTooLarge', '附件体积过大（上限 10MB）')
                        : i18n.t('chat.retryAttachmentFailed', '附件原文件已失效，无法重新发送'),
                    attachments: nextItem.attachments,
                });
                currentStore.removeFromPendingSendQueue(nextItem.messageId);
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
     * 重置会话上下文（无感新建会话，复用底层交接流水线）
     */
    public async resetSession(sessionId = 'main'): Promise<boolean> {
        // 1. 若 WebSocket 处于连接状态，仅通过 WS 发送并等待 session_reset_ack 回执，避免与 HTTP 兜底产生双重重置
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            return new Promise<boolean>((resolve) => {
                let resolved = false;
                const finish = (ok: boolean) => {
                    if (resolved) return;
                    resolved = true;
                    clearTimeout(timer);
                    const list = this.pendingResetCallbacks.get(sessionId) || [];
                    this.pendingResetCallbacks.set(
                        sessionId,
                        list.filter((cb) => cb !== finish)
                    );
                    resolve(ok);
                };

                const timer = setTimeout(() => {
                    // WS 等待超时直接判定失败（与修改权限模式统一放宽至 60 秒，覆盖即时心智提炼耗时），不追加破坏性的 HTTP 重试
                    console.warn('[AssistantClient] resetSession WS 回执超时');
                    finish(false);
                }, 60000);

                const list = this.pendingResetCallbacks.get(sessionId) || [];
                list.push(finish);
                this.pendingResetCallbacks.set(sessionId, list);

                const sent = this.sendRaw({
                    type: 'reset_session',
                    sessionId,
                });
                if (!sent) {
                    finish(false);
                }
            });
        }

        // 2. 若 WebSocket 未连接（离线/纯 HTTP 模式），走 HTTP 接口兜底
        return this.resetSessionHttpFallback(sessionId);
    }

    private async resetSessionHttpFallback(sessionId: string): Promise<boolean> {
        const store = useAssistantStore.getState();
        const rawUrl = store.serverUrl;
        const token = store.serverToken;
        if (rawUrl && token) {
            try {
                const httpUrl = AssistantClient.toHttpUrl(rawUrl);
                const controller = new AbortController();
                // 与修改权限模式统一放宽至 60 秒，覆盖服务端心智提炼的最大耗时
                const timeoutId = setTimeout(() => controller.abort(), 60000);
                const res = await fetch(`${httpUrl}/api/session/reset`, {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${token}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ sessionId }),
                    signal: controller.signal,
                });
                clearTimeout(timeoutId);
                return res.ok;
            } catch (err) {
                console.warn('[AssistantClient] resetSession 异常:', err);
            }
        }
        return false;
    }

    /**
     * 获取服务端可用技能列表并更新 Store
     */
    public async fetchSkills(): Promise<AgentSkill[]> {
        const store = useAssistantStore.getState();
        const rawUrl = store.serverUrl;
        const token = store.serverToken;
        if (!rawUrl || !token) {
            return [];
        }

        try {
            const httpUrl = AssistantClient.toHttpUrl(rawUrl);
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 6000);
            const res = await fetch(`${httpUrl}/api/skills`, {
                headers: {
                    Authorization: `Bearer ${token}`,
                },
                signal: controller.signal,
            });
            clearTimeout(timeoutId);
            if (res.ok) {
                const data = (await res.json()) as { skills?: AgentSkill[] };
                const skills = data.skills || [];
                // 核验当前活跃的配置是否仍与发起请求时一致，丢弃旧服务器的迟到响应
                const currentStore = useAssistantStore.getState();
                if (currentStore.serverUrl === rawUrl && currentStore.serverToken === token) {
                    currentStore.setSkills(skills);
                    return skills;
                }
            }
        } catch (err) {
            console.warn('[AssistantClient] 获取技能列表失败:', err);
        }
        return [];
    }

    /**
     * 取消排队中的消息
     * 本地立即将消息从聊天列表与待发队列中移除（文字退回输入框），同时向服务端发送撤销报文彻底删除该记录；
     * 无条件将撤销请求纳入 pendingCancelQueue 持久化队列，待收到服务端确认回执（message_deleted、增量对账剔除或 cancel_failed）后才出队；
     * 若处于离线或网络半开假死状态，待网络恢复重连对账后自动静默补发。
     * 支持传入 backupMessage 暂存，在服务端因任务已启动而拒绝撤销时自动安全恢复消息。
     */
    public cancelQueued(messageId: string, backupMessage?: AssistantMessage): boolean {
        const store = useAssistantStore.getState();
        const current = backupMessage || store.messages.find((m) => m.id === messageId);
        if (current) {
            this.cancellingMessages.set(messageId, current);
        }
        store.removeMessage(messageId);
        // 无条件先入持久化待撤销队列，杜绝半开连接下本地误判发送成功但服务端未收到导致漏撤销
        store.addToPendingCancelQueue(messageId);
        return this.sendRaw({
            type: 'cancel_queued',
            sessionId: 'main',
            messageId,
        });
    }

    /**
     * 自动静默补发离线期间积压的撤销排队报文
     * 注意：此处仅执行发送，不立即从 pendingCancelQueue 移除；
     * 必须等待服务端下发 message_deleted、sync_result(deletedMessageIds) 或 cancel_failed 确认后再真正出队。
     */
    public flushPendingCancelQueue(): void {
        const store = useAssistantStore.getState();
        const queue = store.pendingCancelQueue;
        if (queue.length === 0) return;
        for (const messageId of queue) {
            this.sendRaw({
                type: 'cancel_queued',
                sessionId: 'main',
                messageId,
            });
        }
    }

    /**
     * 处理服务端下发的事件报文
     */
    private handleServerMessage(msg: ServerMessage): void {
        // 收到服务端任何下行数据包均表明链路活跃，立即清除假死熔断定时器
        this.clearPongTimeout();

        const store = useAssistantStore.getState();

        switch (msg.type) {
            case 'auth_result': {
                if (msg.success) {
                    // 仅在鉴权真正成功后才重置重连尝试计数，防止闪断网络进入 1s 高频重试死循环
                    this.reconnectAttempts = 0;
                    this.fetchSkills().catch(() => {});
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

                // 服务端增量删除对账：剔除服务端已删除的排队消息，并同步清理本地待发队列与撤销暂存副本
                if (msg.deletedMessageIds && msg.deletedMessageIds.length > 0) {
                    for (const delId of msg.deletedMessageIds) {
                        msgMap.delete(delId);
                        store.removeFromPendingCancelQueue(delId);
                        store.removeFromPendingSendQueue(delId);
                        this.cancellingMessages.delete(delId);
                    }
                }

                const merged = Array.from(msgMap.values()).sort(
                    (a, b) => a.timestamp - b.timestamp
                );
                store.setMessages(merged);

                // 对账完成后，自动静默补发待撤销队列与待发队列
                this.flushPendingCancelQueue();
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

                const isQueued = msg.status === 'queued';
                store.addOrUpdateMessage({
                    id: msg.messageId,
                    seq: msg.seq,
                    role: 'user',
                    content: existing ? existing.content : (msg.content || ''),
                    timestamp: existing ? existing.timestamp : Date.now(),
                    status: isError ? 'error' : isQueued ? 'queued' : 'sent',
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
                            completedAt: msg.completedAt ?? (msg.state === 'completed' ? Date.now() : asstMsg.completedAt),
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

            case 'message_deleted': {
                this.cancellingMessages.delete(msg.messageId);
                store.removeMessage(msg.messageId);
                store.removeFromPendingCancelQueue(msg.messageId);
                store.removeFromPendingSendQueue(msg.messageId);
                break;
            }

            case 'cancel_failed': {
                store.removeFromPendingCancelQueue(msg.messageId);
                const backup = this.cancellingMessages.get(msg.messageId);
                // 仅当失败原因是任务已开始执行 (already_started) 时才恢复备份气泡；
                // 若原因是消息不存在 (not_found，如已被另一端成功撤销)，保持删除状态不复活
                if (msg.reason === 'already_started' && backup && !store.messages.some((m) => m.id === msg.messageId)) {
                    store.addOrUpdateMessage(backup);
                }
                this.cancellingMessages.delete(msg.messageId);
                break;
            }

            case 'session_reset_ack': {
                console.log('[AssistantClient] 会话上下文重置已完成:', msg.sessionId);
                const callbacks = this.pendingResetCallbacks.get(msg.sessionId) || [];
                this.pendingResetCallbacks.delete(msg.sessionId);
                callbacks.forEach((cb) => cb(msg.success !== false));
                break;
            }

            case 'pong': {
                // 心跳回执
                break;
            }
        }
    }
}
