import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import 'react-native-get-random-values';

// 简单的 ID 生成器
const safeGenerateId = () => Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);

export interface ChatMessage {
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: number;
}

export interface ChatSession {
    id: string;
    title: string;
    messages: ChatMessage[];
    createdAt: number;
    updatedAt: number;
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
    switchSession: (sessionId: string) => void;
    deleteSession: (sessionId: string) => void;
    updateSessionTitle: (sessionId: string, title: string) => void;
    
    // Message Actions (Targeting current session)
    addMessage: (role: 'user' | 'assistant' | 'system', content: string) => void;
    clearCurrentSession: () => void; // Clear messages in current session

    // UI State
    isLoading: boolean;
    setLoading: (loading: boolean) => void;
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
                const newSessionId = safeGenerateId();
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

            switchSession: (sessionId) => {
                set({ currentSessionId: sessionId });
            },

            deleteSession: (sessionId) => {
                set((state) => {
                    const newSessions = state.sessions.filter(s => s.id !== sessionId);
                    // If we deleted the current session, switch to the first one available, or null
                    let newCurrentId = state.currentSessionId;
                    if (state.currentSessionId === sessionId) {
                        newCurrentId = newSessions.length > 0 ? newSessions[0].id : null;
                    }
                    return {
                        sessions: newSessions,
                        currentSessionId: newCurrentId
                    };
                });
            },

            updateSessionTitle: (sessionId, title) => {
                set((state) => ({
                    sessions: state.sessions.map(s => 
                        s.id === sessionId ? { ...s, title } : s
                    )
                }));
            },

            addMessage: (role, content) => {
                const { currentSessionId, createSession } = get();
                let targetSessionId = currentSessionId;

                // Auto-create session if none exists
                if (!targetSessionId) {
                    targetSessionId = createSession();
                }

                set((state) => ({
                    sessions: state.sessions.map(s => {
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
                    })
                }));
            },

            clearCurrentSession: () => {
                const { currentSessionId } = get();
                if (!currentSessionId) return;
                
                set((state) => ({
                    sessions: state.sessions.map(s => 
                        s.id === currentSessionId ? { ...s, messages: [] } : s
                    )
                }));
            },

            setLoading: (loading) => set({ isLoading: loading }),
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