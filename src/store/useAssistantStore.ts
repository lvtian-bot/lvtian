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
} from '../types/assistantProtocol';

const ASSISTANT_TOKEN_KEY = 'lvtian_assistant_token';

interface AssistantState {
    serverUrl: string;
    serverToken: string;
    connectionState: ConnectionState;
    connectionError: string | null;
    messages: AssistantMessage[];
    taskState: TaskExecutionState;
    pendingApproval: ApprovalRequest | null;
    currentSeq: number;
    hasHydrated: boolean;

    // Actions
    setHasHydrated: (hydrated: boolean) => void;
    setServerConfig: (url: string, token: string) => Promise<void>;
    loadSavedCredentials: () => Promise<{ url: string; token: string }>;
    setConnectionState: (state: ConnectionState, error?: string | null) => void;
    setMessages: (messages: AssistantMessage[]) => void;
    addOrUpdateMessage: (message: AssistantMessage) => void;
    appendDeltaToMessage: (messageId: string, delta: string) => void;
    setToolCallForMessage: (messageId: string, toolCall: ToolCallState) => void;
    setTaskState: (state: TaskExecutionState) => void;
    setPendingApproval: (approval: ApprovalRequest | null) => void;
    setCurrentSeq: (seq: number) => void;
    clearChat: () => void;
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
            pendingApproval: null,
            currentSeq: 0,
            hasHydrated: false,

            setHasHydrated: (hydrated) => set({ hasHydrated: hydrated }),

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

                // 如果切换了不同的服务器地址或访问令牌（代表新服务实例），重置本地旧服务器的对话与对账序列状态
                const currentToken = get().serverToken;
                if ((currentUrl && currentUrl !== cleanUrl) || (currentToken && currentToken !== cleanToken)) {
                    set({
                        serverUrl: cleanUrl,
                        serverToken: cleanToken,
                        messages: [],
                        currentSeq: 0,
                        taskState: 'idle',
                        pendingApproval: null,
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
                        const toolIdx = existingTools.findIndex((t) => t.id === toolCall.id);
                        if (toolIdx >= 0) {
                            existingTools[toolIdx] = toolCall;
                        } else {
                            existingTools.push(toolCall);
                        }
                        updated[idx] = {
                            ...target,
                            toolCalls: existingTools,
                        };
                        return { messages: updated };
                    }
                    return state;
                }),

            setTaskState: (taskState) => set({ taskState }),

            setPendingApproval: (pendingApproval) => set({ pendingApproval }),

            setCurrentSeq: (currentSeq) => set({ currentSeq }),

            clearChat: () => set({ messages: [], currentSeq: 0, taskState: 'idle', pendingApproval: null }),
        }),
        {
            name: 'lvtian-assistant-storage',
            storage: createJSONStorage(() => AsyncStorage),
            partialize: (state) => {
                const persistedMessages = state.messages.filter((m) => m.status !== 'processing');
                // 持久化的游标必须与持久化的消息快照严格绑定：
                // 若直接持久化已被流式 chunk 推高的 state.currentSeq，而进行中的消息被排除，
                // 应用冷启动重连时向服务端发送 sync(lastSeq = currentSeq)，服务端会判定客户端已拥有该消息并跳过返回，
                // 导致正在流式输出的消息永久丢失；因此持久化的 currentSeq 必须锚定已持久化消息的最大 seq（无消息时为 0）。
                const durableSeq = persistedMessages.reduce(
                    (max, m) => Math.max(max, m.seq ?? 0),
                    0
                );
                return {
                    serverUrl: state.serverUrl,
                    // serverToken 不在此序列化，走 SecureStore
                    // 仅持久化非 processing 状态的已确认消息，避免流式打字期间每个 chunk 触发全量 AsyncStorage 序列化导致 UI 卡顿
                    messages: persistedMessages,
                    currentSeq: durableSeq,
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
