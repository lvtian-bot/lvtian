import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import 'react-native-get-random-values';

// 简单的 ID 生成器
const safeGenerateId = () => Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);

// 基于时间的会话 ID 生成器 (YYYYMMDD_HHmmss)
const generateSessionId = () => {
    const now = new Date();
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
};

export interface ChatMessage {
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: number;
}
import { AIChatStorageService } from '../services/AIChatStorageService';

export interface ChatSession {
    id: string;
    title: string;
    messages: ChatMessage[];
    createdAt: number;
    updatedAt: number;
    isPlaceholder?: boolean; // Cloud-only, content not loaded
}

export interface AIConfig {
    baseUrl: string;
    apiKey: string;
    model: string;
}

interface AIState {
    // Configuration
    config: AIConfig;
    setConfig: (config: Partial<AIConfig>) => void;

    // Sessions
    sessions: ChatSession[];
    currentSessionId: string | null;

    // Actions
    createSession: () => string; // Returns new session ID
    switchSession: (sessionId: string) => Promise<void>;
    deleteSession: (sessionId: string) => void;

    updateSessionTitle: (sessionId: string, title: string) => void;
    renameSession?: (sessionId: string, newTitle: string) => Promise<void>; // Optional if not used by UI directly



    // Message Actions (Targeting current session)
    addMessage: (role: 'user' | 'assistant' | 'system', content: string) => void;
    clearCurrentSession: () => void; // Clear messages in current session

    // UI State
    isLoading: boolean;
    setLoading: (loading: boolean) => void;

    // Sync
    syncFromLocalFiles: () => Promise<void>;
    syncWithCloud: () => Promise<void>;
}

export const useAIStore = create<AIState>()(
    persist(
        (set, get) => ({
            config: {
                baseUrl: 'https://api.openai.com/v1',
                apiKey: '',
                model: 'gpt-3.5-turbo',
            },
            sessions: [],
            currentSessionId: null,
            isLoading: false,

            setConfig: (newConfig) => set((state) => ({
                config: { ...state.config, ...newConfig }
            })),

            createSession: () => {
                const newSessionId = generateSessionId();
                const newSession: ChatSession = {
                    id: newSessionId,
                    title: 'New Chat',
                    messages: [],
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                };

                set((state) => ({
                    sessions: [newSession, ...state.sessions],
                    currentSessionId: newSessionId,
                }));
                return newSessionId;
            },

            switchSession: async (sessionId) => {
                const session = get().sessions.find(s => s.id === sessionId);
                if (session?.isPlaceholder) {
                    // Need download
                    set({ isLoading: true });
                    const fullSession = await AIChatStorageService.downloadSession(sessionId);
                    set({ isLoading: false });

                    if (fullSession) {
                        // Update store with full session
                        set(state => ({
                            sessions: state.sessions.map(s => s.id === sessionId ? fullSession : s),
                            currentSessionId: sessionId
                        }));
                    } else {
                        // Error handling? Just switch anyway or show error
                        set({ currentSessionId: sessionId });
                    }
                } else {
                    set({ currentSessionId: sessionId });
                    // Trigger Background Sync for Current Session
                    AIChatStorageService.syncCurrentSession(sessionId).then(updated => {
                        if (updated) {
                            set(state => ({
                                sessions: state.sessions.map(s => s.id === sessionId ? updated : s)
                            }));
                        }
                    });
                }
            },

            deleteSession: (sessionId) => {
                set((state) => {
                    const newSessions = state.sessions.filter(s => s.id !== sessionId);
                    // If we deleted the current session, switch to the first one available, or null
                    let newCurrentId = state.currentSessionId;
                    if (state.currentSessionId === sessionId) {
                        newCurrentId = newSessions.length > 0 ? newSessions[0].id : null;
                    }

                    // Side Effect: Delete file
                    AIChatStorageService.deleteSession(sessionId);

                    return {
                        sessions: newSessions,
                        currentSessionId: newCurrentId
                    };
                });
            },

            updateSessionTitle: (sessionId, title) => {
                set((state) => {
                    const updatedSessions = state.sessions.map(s =>
                        s.id === sessionId ? { ...s, title } : s
                    );

                    // Side Effect: Rename file
                    AIChatStorageService.renameSession(sessionId, title);

                    return { sessions: updatedSessions };
                });
            },

            addMessage: (role, content) => {
                const { currentSessionId, createSession } = get();
                let targetSessionId = currentSessionId;

                // Auto-create session if none exists
                if (!targetSessionId) {
                    targetSessionId = createSession();
                }

                set((state) => {
                    const nextSessions = state.sessions.map(s => {
                        if (s.id === targetSessionId) {
                            return {
                                ...s,
                                messages: [
                                    ...s.messages,
                                    {
                                        id: safeGenerateId(),
                                        role,
                                        content,
                                        timestamp: Date.now(),
                                    }
                                ],
                                updatedAt: Date.now(),
                            };
                        }
                        return s;
                    });

                    // Side Effect: Save file
                    const updatedSession = nextSessions.find(s => s.id === targetSessionId);
                    if (updatedSession) {
                        AIChatStorageService.saveSession(updatedSession);
                    }

                    return { sessions: nextSessions };
                });
            },

            clearCurrentSession: () => {
                const { currentSessionId } = get();
                if (!currentSessionId) return;

                set((state) => {
                    const nextSessions = state.sessions.map(s =>
                        s.id === currentSessionId ? { ...s, messages: [] } : s
                    );

                    // Side Effect: Save file
                    const updatedSession = nextSessions.find(s => s.id === currentSessionId);
                    if (updatedSession) {
                        AIChatStorageService.saveSession(updatedSession);
                    }

                    return { sessions: nextSessions };
                });
            },

            setLoading: (loading) => set({ isLoading: loading }),

            syncFromLocalFiles: async () => {
                const localSessions = await AIChatStorageService.listLocalSessions();
                set((state) => {
                    // Merge strategy: 
                    // 1. Create a map of existing sessions
                    const sessionMap = new Map(state.sessions.map(s => [s.id, s]));

                    // 2. Update/Add from files
                    localSessions.forEach(fileSession => {
                        const existing = sessionMap.get(fileSession.id);
                        if (!existing || fileSession.updatedAt > existing.updatedAt) {
                            sessionMap.set(fileSession.id, fileSession);
                        }
                    });

                    // 3. Convert back to array and sort
                    const mergedSessions = Array.from(sessionMap.values())
                        .sort((a, b) => b.updatedAt - a.updatedAt);

                    return { sessions: mergedSessions };
                });
            },

            syncWithCloud: async () => {
                const { setLoading, sessions } = get();
                // 1. Sync List (Upload missing locals, get cloud placeholders)
                const newPlaceholders = await AIChatStorageService.syncSessionList(sessions);

                if (newPlaceholders.length > 0) {
                    set((state) => {
                        const sessionMap = new Map(state.sessions.map(s => [s.id, s]));
                        newPlaceholders.forEach(p => sessionMap.set(p.id, p));

                        const merged = Array.from(sessionMap.values())
                            .sort((a, b) => b.updatedAt - a.updatedAt);
                        return { sessions: merged };
                    });
                }
            }
        }),
        {
            name: 'mdnote-ai-storage-v2', // Changed name to avoid conflict with v1
            storage: createJSONStorage(() => AsyncStorage),
            partialize: (state) => ({
                config: state.config,
                sessions: state.sessions,
                currentSessionId: state.currentSessionId
            }),
        }
    )
);