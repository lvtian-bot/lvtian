import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { outboxKey, readOutbox, writeOutbox, type ChatOutbox } from '../services/chatOutbox';
import {
    ConnectionConfigError,
    CredentialsErrorCode,
    credentialsErrorCode,
    loadConnectionCredentials,
    saveConnectionCredentials,
} from '../services/connectionConfig';
import {
    AssistantMessage,
    ConnectionState,
    TaskExecutionState,
    ApprovalRequest,
    ToolCallState,
    ChatAttachment,
    AgentSkill,
} from '../types/assistantProtocol';

// Defer disposable cache writes until its first read finishes; server connection
// and the independent outbox do not wait for it.
let credentialsInitialized = false;
const CHAT_CACHE_KEY = 'lvtian-chat-cache-v2';
let chatHydrationSucceeded = false;
let cacheIdentityStarted = '';
let cacheSuperseded = false;
let outboxGeneration = 0;
const outboxWrites = new Map<string, Promise<void>>();
let operationTail: Promise<unknown> = Promise.resolve();
function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = operationTail.then(operation);
    operationTail = result.catch(() => undefined);
    return result;
}

const chatStorage = {
    getItem: (name: string) => AsyncStorage.getItem(name),
    setItem: async (name: string, value: string): Promise<void> => {
        if (!credentialsInitialized || !chatHydrationSucceeded) return;
        try {
            await AsyncStorage.setItem(name, value);
        } catch { /* disposable cache; the server remains authoritative */ }
    },
    removeItem: (name: string) => AsyncStorage.removeItem(name),
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
const isCounter = (value: unknown): boolean =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0;
const validOptionalArray = (value: unknown, check: (entry: unknown) => boolean): boolean =>
    value === undefined || (Array.isArray(value) && value.every(check));
const isAttachment = (value: unknown): boolean => isRecord(value)
    && (value.type === 'image' || value.type === 'file') && typeof value.name === 'string';
const isMessage = (value: unknown): boolean => isRecord(value)
    && typeof value.id === 'string' && typeof value.content === 'string'
    && ['user', 'assistant', 'system'].includes(String(value.role))
    && isCounter(value.timestamp)
    && (value.seq === undefined || isCounter(value.seq))
    && ['sending', 'sent', 'queued', 'processing', 'done', 'error'].includes(String(value.status))
    && validOptionalArray(value.attachments, isAttachment)
    && validOptionalArray(value.toolCalls, (tool) => isRecord(tool)
        && typeof tool.id === 'string' && typeof tool.name === 'string'
        && ['running', 'done', 'failed'].includes(String(tool.status)))
    && validOptionalArray(value.toolCallPositions, (position) => isRecord(position)
        && typeof position.toolCallId === 'string' && isCounter(position.textOffset));

/** Validate cache containers/render-critical fields, not a second protocol schema. */
function parseChatCache(value: unknown): Partial<AssistantState> {
    if (value === undefined) return {};
    if (!isRecord(value)
        || !validOptionalArray(value.messages, isMessage)) {
        throw new Error('chat_hydration_failed');
    }
    return value as Partial<AssistantState>;
}

interface AssistantState {
    serverUrl: string;
    serverToken: string;
    connectionState: ConnectionState;
    connectionError: string | null;
    messages: AssistantMessage[];
    taskState: TaskExecutionState;
    /** 待审批队列：同一会话并发多个工具各自请求审批时按序展示与应答 */
    pendingApprovals: ApprovalRequest[];
    currentSeq: number;
    credentialsStatus: 'loading' | 'ready' | 'error';
    credentialsError: CredentialsErrorCode | null;
    outboxStatus: 'loading' | 'ready';
    markChatAuthoritative: () => void;
    permissionMode: 'workspace-write' | 'danger-full-access';
    /** 服务端当前助理模型选择（provider 路由 + 模型 ID），未拉取到时为 null */
    agentModelSelection: { provider: string; model: string } | null;
    /** 服务端下发的模型可选项清单（持久化作进页秒显，连接后核对更新） */
    agentModelOptions: Array<{ provider: string; model: string }>;
    /** 服务端是否正在优雅升级中 */
    isServerUpgrading: boolean;
    /** 待发送消息队列（离线/升级期间乐观入队，重连对账后自动静默补发） */
    pendingSendQueue: Array<{ sessionId: string; messageId: string; content: string; attachments?: ChatAttachment[] }>;
    /** 待撤销排队消息队列（离线取消时入队，重连对账后自动静默补发） */
    pendingCancelQueue: string[];
    /** 服务端加载的可用技能列表 */
    skills: AgentSkill[];

    // Actions
    setPermissionMode: (mode: 'workspace-write' | 'danger-full-access') => void;
    setAgentModelSelection: (selection: { provider: string; model: string } | null) => void;
    setAgentModelOptions: (options: Array<{ provider: string; model: string }>) => void;
    setSkills: (skills: AgentSkill[]) => void;
    setServerConfig: (url: string, token: string) => Promise<void>;
    loadSavedCredentials: () => Promise<{ url: string; token: string }>;
    setConnectionState: (state: ConnectionState, error?: string | null) => void;
    setMessages: (messages: AssistantMessage[]) => void;
    addOrUpdateMessage: (message: AssistantMessage) => void;
    removeMessage: (messageId: string) => void;
    cancelPendingMessage: (messageId: string) => void;
    appendDeltaToMessage: (messageId: string, delta: string) => void;
    setToolCallForMessage: (messageId: string, toolCall: ToolCallState) => void;
    setTaskState: (state: TaskExecutionState) => void;
    setPendingApprovals: (approvals: ApprovalRequest[]) => void;
    addPendingApproval: (approval: ApprovalRequest) => void;
    removePendingApproval: (approvalId: string) => void;
    setCurrentSeq: (seq: number) => void;
    clearedSeq: number;
    clearChat: () => void;
    setIsServerUpgrading: (upgrading: boolean) => void;
    addToPendingSendQueue: (item: { sessionId: string; messageId: string; content: string; attachments?: ChatAttachment[] }) => void;
    removeFromPendingSendQueue: (messageId: string) => void;
    clearPendingSendQueue: () => void;
    addToPendingCancelQueue: (messageId: string) => void;
    removeFromPendingCancelQueue: (messageId: string) => void;
}

export const useAssistantStore = create<AssistantState>()(
    persist(
        (set, get) => {
            return {
                serverUrl: '',
                serverToken: '',
                connectionState: 'disconnected',
                connectionError: null,
                messages: [],
                taskState: 'idle',
                pendingApprovals: [],
                currentSeq: 0,
                clearedSeq: 0,
                credentialsStatus: 'loading',
                credentialsError: null,
                outboxStatus: 'ready',
                markChatAuthoritative: () => { cacheSuperseded = true; },
                permissionMode: 'workspace-write',
                agentModelSelection: null,
                agentModelOptions: [],
                isServerUpgrading: false,
                pendingSendQueue: [],
                pendingCancelQueue: [],
                skills: [],

                setPermissionMode: (mode) => set({ permissionMode: mode }),
                setAgentModelSelection: (agentModelSelection) => set({ agentModelSelection }),
                setAgentModelOptions: (agentModelOptions) => set({ agentModelOptions }),
                setSkills: (skills) => set({ skills }),

                setServerConfig: (url, token) => serialize(async () => {
                    const cleanUrl = url.trim().replace(/\/+$/, '');
                    const cleanToken = token.trim();
                    set({ credentialsStatus: 'loading', credentialsError: null });
                    try {
                        // Explicit user-supplied configuration authorizes replacement;
                        // it must not depend on reading a corrupt legacy/chat record.
                        const identityUnknown = !credentialsInitialized;
                        const currentUrl = get().serverUrl;
                        const currentToken = get().serverToken;
                        await saveConnectionCredentials(cleanUrl, cleanToken);
                        credentialsInitialized = true;

                        // 切换身份或尚未读出旧身份时，清除旧服务器的聊天与对账状态。
                        if (identityUnknown || currentUrl !== cleanUrl || currentToken !== cleanToken) {
                            outboxGeneration += 1;
                            cacheSuperseded = true;
                            cacheIdentityStarted = '';
                            set({
                                serverUrl: cleanUrl,
                                serverToken: cleanToken,
                                outboxStatus: 'loading',
                                messages: [],
                                currentSeq: 0,
                                clearedSeq: 0,
                                taskState: 'idle',
                                pendingApprovals: [],
                                isServerUpgrading: false,
                                pendingSendQueue: [],
                                pendingCancelQueue: [],
                                skills: [],
                                agentModelSelection: null,
                                agentModelOptions: [],
                            });
                        } else {
                            set({ serverUrl: cleanUrl, serverToken: cleanToken });
                        }
                        set({ credentialsStatus: 'ready', credentialsError: null });
                        startChatStorage(cleanUrl, cleanToken);
                    } catch (error) {
                        const code = credentialsErrorCode(error);
                        set({ credentialsStatus: 'error', credentialsError: code });
                        throw new ConnectionConfigError(code);
                    }
                }),

                loadSavedCredentials: () => serialize(async () => {
                    set({ credentialsStatus: 'loading', credentialsError: null });
                    try {
                        const currentUrl = get().serverUrl;
                        const currentToken = get().serverToken;
                        const credentials = await loadConnectionCredentials();
                        const identityChanged = credentialsInitialized
                            && (currentUrl !== credentials.url || currentToken !== credentials.token);
                        if (identityChanged) {
                            outboxGeneration += 1;
                            cacheSuperseded = true;
                            cacheIdentityStarted = '';
                        }
                        credentialsInitialized = true;
                        set({
                            serverUrl: credentials.url,
                            serverToken: credentials.token,
                            credentialsStatus: 'ready',
                            credentialsError: null,
                            ...(identityChanged ? {
                                outboxStatus: 'loading' as const,
                                messages: [], currentSeq: 0, clearedSeq: 0,
                                pendingSendQueue: [], pendingCancelQueue: [], pendingApprovals: [],
                                taskState: 'idle' as const, isServerUpgrading: false,
                                skills: [], agentModelSelection: null, agentModelOptions: [],
                            } : {}),
                        });
                        startChatStorage(credentials.url, credentials.token);
                        return credentials;
                    } catch (error) {
                        const code = credentialsErrorCode(error);
                        set({ credentialsStatus: 'error', credentialsError: code });
                        throw new ConnectionConfigError(code);
                    }
                }),

                setConnectionState: (connectionState, connectionError = null) =>
                    set({ connectionState, connectionError }),

                setMessages: (messages) => set({ messages }),

                addOrUpdateMessage: (message) =>
                    set((state) => {
                        const idx = state.messages.findIndex((m) => m.id === message.id);
                        if (idx >= 0) {
                            const updated = [...state.messages];
                            const current = updated[idx];
                            updated[idx] = {
                                ...current,
                                ...message,
                                content:
                                    message.content !== undefined && message.content !== ''
                                        ? message.content
                                        : current.content,
                            };
                            return { messages: updated };
                        }
                        return { messages: [...state.messages, message] };
                    }),

                removeMessage: (messageId) =>
                    set((state) => ({
                        messages: state.messages.filter((m) => m.id !== messageId),
                        pendingSendQueue: state.pendingSendQueue.filter((item) => item.messageId !== messageId),
                    })),

                cancelPendingMessage: (messageId) => set((state) => ({
                    messages: state.messages.filter(message => message.id !== messageId),
                    pendingSendQueue: state.pendingSendQueue.filter(item => item.messageId !== messageId),
                    pendingCancelQueue: state.pendingCancelQueue.includes(messageId)
                        ? state.pendingCancelQueue : [...state.pendingCancelQueue, messageId],
                })),

                appendDeltaToMessage: (messageId, delta) =>
                    set((state) => {
                        const idx = state.messages.findIndex((m) => m.id === messageId);
                        if (idx >= 0) {
                            const updated = [...state.messages];
                            const target = updated[idx];
                            updated[idx] = {
                                ...target,
                                content: target.content + delta,
                                status: 'processing',
                            };
                            return { messages: updated };
                        }
                        return state;
                    }),

                setToolCallForMessage: (messageId, toolCall) =>
                    set((state) => {
                        const idx = state.messages.findIndex((m) => m.id === messageId);
                        if (idx >= 0) {
                            const updated = [...state.messages];
                            const target = updated[idx];
                            const existingTools = target.toolCalls ? [...target.toolCalls] : [];
                            const positions = target.toolCallPositions ?? existingTools.map((tool) => ({
                                toolCallId: tool.id, textOffset: 0,
                            }));
                            const toolIdx = existingTools.findIndex((t) => t.id === toolCall.id);
                            if (toolIdx >= 0) {
                                existingTools[toolIdx] = toolCall;
                            } else {
                                existingTools.push(toolCall);
                            }
                            updated[idx] = {
                                ...target,
                                toolCalls: existingTools,
                                toolCallPositions: toolIdx >= 0 ? positions : [
                                    ...positions, { toolCallId: toolCall.id, textOffset: target.content.length },
                                ],
                            };
                            return { messages: updated };
                        }
                        return state;
                    }),

                setTaskState: (taskState) => set({ taskState }),

                setPendingApprovals: (pendingApprovals) => set({ pendingApprovals }),

                addPendingApproval: (approval) =>
                    set((state) => ({
                        pendingApprovals: state.pendingApprovals.some((a) => a.approvalId === approval.approvalId)
                            ? state.pendingApprovals
                            : [...state.pendingApprovals, approval],
                    })),

                removePendingApproval: (approvalId) =>
                    set((state) => ({
                        pendingApprovals: state.pendingApprovals.filter((a) => a.approvalId !== approvalId),
                    })),

                setCurrentSeq: (currentSeq) => set({ currentSeq }),

                clearChat: () =>
                    set((state) => {
                        const maxSeq = Math.max(
                            state.currentSeq,
                            state.clearedSeq,
                            ...state.messages.map((m) => m.seq ?? 0)
                        );
                        return {
                            messages: [],
                            currentSeq: 0,
                            clearedSeq: maxSeq,
                            taskState: 'idle',
                            pendingApprovals: [],
                            pendingSendQueue: [],
                            pendingCancelQueue: [],
                        };
                    }),

                setIsServerUpgrading: (isServerUpgrading) => set({ isServerUpgrading }),

                addToPendingSendQueue: (item) =>
                    set((state) => {
                        const idx = state.pendingSendQueue.findIndex((q) => q.messageId === item.messageId);
                        if (idx >= 0) {
                            const updated = [...state.pendingSendQueue];
                            updated[idx] = { ...updated[idx], ...item };
                            return { pendingSendQueue: updated };
                        }
                        return { pendingSendQueue: [...state.pendingSendQueue, item] };
                    }),

                removeFromPendingSendQueue: (messageId) =>
                    set((state) => ({
                        pendingSendQueue: state.pendingSendQueue.filter((q) => q.messageId !== messageId),
                    })),

                clearPendingSendQueue: () => set({ pendingSendQueue: [] }),

                addToPendingCancelQueue: (messageId) =>
                    set((state) => ({
                        pendingCancelQueue: state.pendingCancelQueue.includes(messageId)
                            ? state.pendingCancelQueue
                            : [...state.pendingCancelQueue, messageId],
                    })),

                removeFromPendingCancelQueue: (messageId) =>
                    set((state) => ({
                        pendingCancelQueue: state.pendingCancelQueue.filter((id) => id !== messageId),
                    })),
            };
        },
        {
            name: CHAT_CACHE_KEY,
            skipHydration: true,
            storage: createJSONStorage(() => chatStorage),
            merge: (persisted, current) => {
                if (cacheSuperseded || current.messages.length > 0 || !isRecord(persisted)
                    || persisted.identity !== outboxKey(current.serverUrl, current.serverToken)) return current;
                const saved = parseChatCache(persisted);
                return { ...current, messages: saved.messages ?? [] };
            },
            partialize: (state) => {
                const cacheableMessages = state.messages
                    .filter((m) => m.status === 'sent' || m.status === 'queued' || m.status === 'done')
                    .map((m) => {
                        if (!m.attachments || m.attachments.length === 0) {
                            return m;
                        }
                        // 移除 base64 data 与超长 raw content，保留轻量元数据与本地文件路径 uri，
                        // 既能在冷启动重启后按 uri 重新读取附件以支持重试，又避免将庞大 Base64 塞入 AsyncStorage 突破 2MB 限制
                        const sanitizedAttachments = m.attachments.map((att) => ({
                            type: att.type,
                            name: att.name,
                            mimeType: att.mimeType,
                            size: att.size,
                            uri: att.uri,
                        }));
                        return {
                            ...m,
                            attachments: sanitizedAttachments,
                        };
                    });
                // Keep the newest complete messages within a conservative size
                // budget, avoiding oversized Android AsyncStorage rows.
                const persistedMessages: AssistantMessage[] = [];
                let cacheCharacters = 0;
                for (let i = cacheableMessages.length - 1; i >= 0; i -= 1) {
                    const size = JSON.stringify(cacheableMessages[i]).length;
                    if (cacheCharacters + size > 128 * 1024) break;
                    cacheCharacters += size;
                    persistedMessages.unshift(cacheableMessages[i]);
                }
                return {
                    identity: outboxKey(state.serverUrl, state.serverToken),
                    messages: persistedMessages,
                };
            },
            onRehydrateStorage: () => {
                chatHydrationSucceeded = false;
                return (_state, error) => {
                    Promise.resolve().then(async () => {
                        if (error) {
                            try { await AsyncStorage.removeItem(CHAT_CACHE_KEY); } catch { /* cache is disposable */ }
                        }
                        chatHydrationSucceeded = true;
                        useAssistantStore.setState({});
                    });
                };
            },
        }
    )
);

// Chat snapshots and the durable outbox are independent of credentials and each other.
function startChatStorage(url: string, token: string): void {
    if (!url) { cacheIdentityStarted = ''; return; }
    const identity = outboxKey(url, token);
    if (cacheIdentityStarted !== identity) {
        cacheIdentityStarted = identity;
        cacheSuperseded = false;
        Promise.resolve(useAssistantStore.persist.rehydrate()).catch(() => {});
        initializeOutbox().catch(() => {});
    }
}

async function initializeOutbox(): Promise<void> {
    const state = useAssistantStore.getState();
    if (!state.serverUrl || state.credentialsStatus !== 'ready') return;
    const key = outboxKey(state.serverUrl, state.serverToken);
    const generation = ++outboxGeneration;
    useAssistantStore.setState({ outboxStatus: 'loading' });
    try {
        // An unreadable queue is disposable; continue with messages created in
        // this session and replace the unusable record when storage allows it.
        const saved = await readOutbox(key).catch(() => ({ pendingSendQueue: [], pendingCancelQueue: [] }));
        const current = useAssistantStore.getState();
        if (generation !== outboxGeneration || key !== outboxKey(current.serverUrl, current.serverToken)) return;
        const cancelled = new Set([...saved.pendingCancelQueue, ...current.pendingCancelQueue]);
        const messages = new Map(saved.pendingSendQueue.map(item => [item.messageId, item]));
        for (const item of current.pendingSendQueue) messages.set(item.messageId, item);
        for (const id of cancelled) messages.delete(id);
        if (cacheSuperseded) {
            for (const message of current.messages) {
                if (message.status === 'sent' || message.status === 'queued') messages.delete(message.id);
            }
        }
        const pendingSendQueue = Array.from(messages.values());
        const displayed = new Set(current.messages.map(message => message.id));
        const pendingMessages: AssistantMessage[] = pendingSendQueue.filter(item => !displayed.has(item.messageId)).map(item => ({
            id: item.messageId, seq: 0, role: 'user', content: item.content, timestamp: Date.now(),
            status: 'sending', attachments: item.attachments,
        }));
        useAssistantStore.setState({
            messages: [...current.messages, ...pendingMessages], pendingSendQueue,
            pendingCancelQueue: Array.from(cancelled), outboxStatus: 'ready',
        });
    } catch { /* connection and in-memory messages remain usable */ }
}

function persistOutbox(key: string, outbox: ChatOutbox): void {
    const previous = outboxWrites.get(key) ?? Promise.resolve();
    const write = previous.catch(() => undefined).then(() => writeOutbox(key, outbox)).catch(() => {});
    outboxWrites.set(key, write);
    write.then(() => { if (outboxWrites.get(key) === write) outboxWrites.delete(key); });
}

useAssistantStore.subscribe((state, previous) => {
    if (state.outboxStatus !== 'ready' || state.credentialsStatus !== 'ready' || !state.serverUrl) return;
    if (state.pendingSendQueue === previous.pendingSendQueue && state.pendingCancelQueue === previous.pendingCancelQueue) return;
    persistOutbox(outboxKey(state.serverUrl, state.serverToken), {
        pendingSendQueue: state.pendingSendQueue, pendingCancelQueue: state.pendingCancelQueue,
    });
});

// The retired mixed record is disposable and is not read or migrated.
Promise.resolve().then(() => AsyncStorage.removeItem('lvtian-assistant-storage')).catch(() => undefined);
Promise.resolve().then(() => useAssistantStore.getState().loadSavedCredentials()).catch(() => undefined);
