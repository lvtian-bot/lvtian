import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
    ASSISTANT_CHAT_KEY,
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

// Zustand writes on every set, including hydration/status updates. Keep the legacy
// record untouched until connection migration is durably committed and the
// chat read or recovery attempt has finished.
let credentialsInitialized = false;
let chatHydrationSucceeded = false;
let reportingChatWriteError = false;
let connectionIdentityChanged = false;
let operationTail: Promise<unknown> = Promise.resolve();
function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = operationTail.then(operation);
    operationTail = result.catch(() => undefined);
    return result;
}

const chatStorage = {
    getItem: (name: string) => AsyncStorage.getItem(name),
    setItem: async (name: string, value: string): Promise<void> => {
        if (!credentialsInitialized || !chatHydrationSucceeded || reportingChatWriteError) return;
        try {
            await AsyncStorage.setItem(name, value);
        } catch {
            // The error setter suppresses its own persistence to avoid recursion.
            setChatCacheError('chat_cache_write_failed');
        }
    },
    removeItem: (name: string) => AsyncStorage.removeItem(name),
};
let setChatCacheError: (code: 'chat_cache_write_failed') => void = () => undefined;

const isRecord = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
const isCounter = (value: unknown): boolean =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0;
const isModel = (value: unknown): boolean => isRecord(value)
    && typeof value.provider === 'string' && typeof value.model === 'string';
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
        || !validOptionalArray(value.messages, isMessage)
        || !validOptionalArray(value.pendingSendQueue, (item) => isRecord(item)
            && typeof item.sessionId === 'string' && typeof item.messageId === 'string'
            && typeof item.content === 'string' && validOptionalArray(item.attachments, isAttachment))
        || !validOptionalArray(value.pendingCancelQueue, (id) => typeof id === 'string')
        || !validOptionalArray(value.agentModelOptions, isModel)
        || (value.currentSeq !== undefined && !isCounter(value.currentSeq))
        || (value.clearedSeq !== undefined && !isCounter(value.clearedSeq))
        || (value.permissionMode !== undefined
            && value.permissionMode !== 'workspace-write' && value.permissionMode !== 'danger-full-access')
        || (value.agentModelSelection !== undefined && value.agentModelSelection !== null
            && !isModel(value.agentModelSelection))) {
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
    /** Chat hydration attempt has settled; independent of credential readiness. */
    hasHydrated: boolean;
    credentialsStatus: 'loading' | 'ready' | 'error';
    credentialsError: CredentialsErrorCode | null;
    chatHydrationError: 'chat_hydration_failed' | null;
    chatCacheError: 'chat_cache_write_failed' | null;
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
    setHasHydrated: (hydrated: boolean) => void;
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
            setChatCacheError = (chatCacheError) => {
                reportingChatWriteError = true;
                try {
                    set({ chatCacheError });
                } finally {
                    reportingChatWriteError = false;
                }
            };
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
                hasHydrated: false,
                credentialsStatus: 'loading',
                credentialsError: null,
                chatHydrationError: null,
                chatCacheError: null,
                permissionMode: 'workspace-write',
                agentModelSelection: null,
                agentModelOptions: [],
                isServerUpgrading: false,
                pendingSendQueue: [],
                pendingCancelQueue: [],
                skills: [],

                setHasHydrated: (hydrated) => set({ hasHydrated: hydrated }),
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
                        if (identityUnknown || (currentUrl && currentUrl !== cleanUrl) || (currentToken && currentToken !== cleanToken)) {
                            connectionIdentityChanged = true;
                            set({
                                serverUrl: cleanUrl,
                                serverToken: cleanToken,
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
                    } catch (error) {
                        const code = credentialsErrorCode(error);
                        set({ credentialsStatus: 'error', credentialsError: code });
                        throw new ConnectionConfigError(code);
                    }
                }),

                loadSavedCredentials: () => serialize(async () => {
                    set({ credentialsStatus: 'loading', credentialsError: null });
                    try {
                        const credentials = await loadConnectionCredentials();
                        credentialsInitialized = true;
                        set({
                            serverUrl: credentials.url,
                            serverToken: credentials.token,
                            credentialsStatus: 'ready',
                            credentialsError: null,
                        });
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
            name: ASSISTANT_CHAT_KEY,
            storage: createJSONStorage(() => chatStorage),
            merge: (persisted, current) => {
                // After switching identity, memory owns the new chat. This also
                // protects explicit hydration retries from restoring the old cache.
                if (connectionIdentityChanged) return current;
                const saved = parseChatCache(persisted);
                return {
                    ...current,
                    messages: saved.messages ?? current.messages,
                    currentSeq: saved.currentSeq ?? current.currentSeq,
                    clearedSeq: saved.clearedSeq ?? current.clearedSeq,
                    pendingSendQueue: saved.pendingSendQueue ?? current.pendingSendQueue,
                    pendingCancelQueue: saved.pendingCancelQueue ?? current.pendingCancelQueue,
                    permissionMode: saved.permissionMode ?? current.permissionMode,
                    agentModelSelection: saved.agentModelSelection ?? current.agentModelSelection,
                    agentModelOptions: saved.agentModelOptions ?? current.agentModelOptions,
                };
            },
            partialize: (state) => {
                const cacheableMessages = state.messages
                    .filter((m) => m.status !== 'processing')
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
                const cacheTrimmed = persistedMessages.length !== cacheableMessages.length;
                // 持久化的游标必须与持久化的消息快照严格绑定：
                // 若直接持久化已被流式 chunk 推高的 state.currentSeq，而进行中的消息被排除，
                // 应用冷启动重连时向服务端发送 sync(lastSeq = currentSeq)，服务端会判定客户端已拥有该消息并跳过返回，
                // 导致正在流式输出的消息永久丢失；因此持久化的 currentSeq 必须锚定已持久化消息的最大 seq（无消息时为 0）。
                const durableSeq = cacheTrimmed ? 0 : persistedMessages.reduce(
                    (max, m) => Math.max(max, m.seq ?? 0),
                    0
                );
                // 待发送队列脱水：同样剥离附件庞大 Base64 数据，仅保留轻量元数据与本地 uri，避免突破 Android AsyncStorage 2MB 上限
                const sanitizedPendingSendQueue = state.pendingSendQueue.map((item) => {
                    if (!item.attachments || item.attachments.length === 0) {
                        return item;
                    }
                    const sanitizedAttachments = item.attachments.map((att) => ({
                        type: att.type,
                        name: att.name,
                        mimeType: att.mimeType,
                        size: att.size,
                        uri: att.uri,
                    }));
                    return {
                        ...item,
                        attachments: sanitizedAttachments,
                    };
                });
                return {
                    // Connection URL and token are never part of the chat cache.
                    // 仅持久化非 processing 状态的已确认消息，避免流式打字期间每个 chunk 触发全量 AsyncStorage 序列化导致 UI 卡顿
                    messages: persistedMessages,
                    currentSeq: durableSeq,
                    clearedSeq: state.clearedSeq ?? 0,
                    pendingSendQueue: sanitizedPendingSendQueue,
                    pendingCancelQueue: state.pendingCancelQueue ?? [],
                    permissionMode: state.permissionMode ?? 'workspace-write',
                    agentModelSelection: state.agentModelSelection ?? null,
                    agentModelOptions: state.agentModelOptions ?? [],
                };
            },
            onRehydrateStorage: () => {
                chatHydrationSucceeded = false;
                return (_state, error) => {
                    // Defer to support even a synchronous storage implementation:
                    // the exported store must exist before this callback accesses it.
                    Promise.resolve().then(async () => {
                        // Chat is disposable cache: clear an unreadable record so
                        // the next server sync can rebuild it. A failed deletion
                        // is reported but never prevents connecting.
                        let cleared = !error;
                        if (error) {
                            // The legacy connection URL may still be in this
                            // record; let its independent migration finish first.
                            await initialCredentials;
                            if (credentialsInitialized) {
                                try {
                                    await AsyncStorage.removeItem(ASSISTANT_CHAT_KEY);
                                    cleared = true;
                                } catch {
                                    cleared = false;
                                }
                            }
                        }
                        // After credentials have been migrated, replacing a bad
                        // cache is safe even when removeItem itself failed.
                        chatHydrationSucceeded = true;
                        useAssistantStore.setState({
                            hasHydrated: true,
                            chatHydrationError: error ? 'chat_hydration_failed' : null,
                            chatCacheError: cleared ? null : 'chat_cache_write_failed',
                        });
                    });
                };
            },
        }
    )
);

// Credentials are independent of chat hydration (including a failed or slow read).
const initialCredentials = Promise.resolve().then(() => useAssistantStore.getState().loadSavedCredentials()).catch(() => undefined);
