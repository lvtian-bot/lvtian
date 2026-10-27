import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import {
    AssistantMessage,
    ConnectionState,
    TaskExecutionState,
    ApprovalRequest,
    ToolCallState,
    ChatAttachment,
    AgentSkill,
} from '../types/assistantProtocol';

const ASSISTANT_TOKEN_KEY = 'lvtian_assistant_token';

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
    hasHydrated: boolean;
    permissionMode: 'workspace-write' | 'danger-full-access';
    /** 服务端当前助理模型选择（provider 路由 + 模型 ID），未拉取到时为 null */
    agentModelSelection: { provider: string; model: string } | null;
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
        (set, get) => ({
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
            permissionMode: 'workspace-write',
            agentModelSelection: null,
            isServerUpgrading: false,
            pendingSendQueue: [],
            pendingCancelQueue: [],
            skills: [],

            setHasHydrated: (hydrated) => set({ hasHydrated: hydrated }),
            setPermissionMode: (mode) => set({ permissionMode: mode }),
            setAgentModelSelection: (agentModelSelection) => set({ agentModelSelection }),
            setSkills: (skills) => set({ skills }),

            setServerConfig: async (url, token) => {
                const cleanUrl = url.trim().replace(/\/+$/, '');
                const cleanToken = token.trim();
                const currentUrl = get().serverUrl;

                // 持久化 Token 到 SecureStore，如失败则向外抛错以便界面捕获
                try {
                    if (cleanToken) {
                        await SecureStore.setItemAsync(ASSISTANT_TOKEN_KEY, cleanToken);
                    } else {
                        await SecureStore.deleteItemAsync(ASSISTANT_TOKEN_KEY);
                    }
                } catch (err) {
                    console.error('[useAssistantStore] 写入 SecureStore 失败:', err);
                    throw new Error('安全凭据存储失败，请检查系统安全存储或权限');
                }

                // 如果切换了不同的服务器地址或访问令牌（代表新服务实例），重置本地旧服务器的对话与对账序列状态（含清空截断线）
                const currentToken = get().serverToken;
                if ((currentUrl && currentUrl !== cleanUrl) || (currentToken && currentToken !== cleanToken)) {
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
                        skills: [],
                        agentModelSelection: null,
                    });
                } else {
                    set({ serverUrl: cleanUrl, serverToken: cleanToken });
                }
            },

            loadSavedCredentials: async () => {
                let token = '';
                try {
                    token = (await SecureStore.getItemAsync(ASSISTANT_TOKEN_KEY)) || '';
                } catch (err) {
                    console.warn('[useAssistantStore] 从 SecureStore 读取 Token 失败:', err);
                }
                const url = get().serverUrl;
                set({ serverToken: token });
                return { url, token };
            },

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
        }),
        {
            name: 'lvtian-assistant-storage',
            storage: createJSONStorage(() => AsyncStorage),
            partialize: (state) => {
                const persistedMessages = state.messages
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
                // 持久化的游标必须与持久化的消息快照严格绑定：
                // 若直接持久化已被流式 chunk 推高的 state.currentSeq，而进行中的消息被排除，
                // 应用冷启动重连时向服务端发送 sync(lastSeq = currentSeq)，服务端会判定客户端已拥有该消息并跳过返回，
                // 导致正在流式输出的消息永久丢失；因此持久化的 currentSeq 必须锚定已持久化消息的最大 seq（无消息时为 0）。
                const durableSeq = persistedMessages.reduce(
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
                    serverUrl: state.serverUrl,
                    // serverToken 不在此序列化，走 SecureStore
                    // 仅持久化非 processing 状态的已确认消息，避免流式打字期间每个 chunk 触发全量 AsyncStorage 序列化导致 UI 卡顿
                    messages: persistedMessages,
                    currentSeq: durableSeq,
                    clearedSeq: state.clearedSeq ?? 0,
                    pendingSendQueue: sanitizedPendingSendQueue,
                    pendingCancelQueue: state.pendingCancelQueue ?? [],
                    permissionMode: state.permissionMode ?? 'workspace-write',
                    agentModelSelection: state.agentModelSelection ?? null,
                };
            },
            onRehydrateStorage: () => (state) => {
                if (state) {
                    state.setHasHydrated(true);
                }
            },
        }
    )
);
