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
                try {
                    if (token) {
                        await SecureStore.setItemAsync(ASSISTANT_TOKEN_KEY, token);
                    } else {
                        await SecureStore.deleteItemAsync(ASSISTANT_TOKEN_KEY);
                    }
                } catch (err) {
                    console.warn('[useAssistantStore] 保存 Token 到 SecureStore 失败:', err);
                }
                set({ serverUrl: cleanUrl, serverToken: token });
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
            partialize: (state) => ({
                serverUrl: state.serverUrl,
                // serverToken 不在此序列化，走 SecureStore
                messages: state.messages,
                currentSeq: state.currentSeq,
            }),
            onRehydrateStorage: () => (state) => {
                if (state) {
                    state.setHasHydrated(true);
                }
            },
        }
    )
);
