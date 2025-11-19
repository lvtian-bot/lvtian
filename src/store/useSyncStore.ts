import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

export interface QueueItem {
    id: string;
    filePath: string;
    key: string;
    status: 'pending' | 'uploading' | 'failed' | 'success';
    retryCount: number;
    timestamp: number;
}

interface SyncState {
    uploadQueue: QueueItem[];
    addToQueue: (filePath: string, key: string) => void;
    removeFromQueue: (id: string) => void;
    updateItemStatus: (id: string, status: QueueItem['status']) => void;
    incrementRetry: (id: string) => void;
    clearQueue: () => void;
}

export const useSyncStore = create<SyncState>()(
    persist(
        (set) => ({
            uploadQueue: [],
            addToQueue: (filePath, key) =>
                set((state) => ({
                    uploadQueue: [
                        ...state.uploadQueue,
                        {
                            id: Math.random().toString(36).substr(2, 9),
                            filePath,
                            key,
                            status: 'pending',
                            retryCount: 0,
                            timestamp: Date.now(),
                        },
                    ],
                })),
            removeFromQueue: (id) =>
                set((state) => ({
                    uploadQueue: state.uploadQueue.filter((item) => item.id !== id),
                })),
            updateItemStatus: (id, status) =>
                set((state) => ({
                    uploadQueue: state.uploadQueue.map((item) =>
                        item.id === id ? { ...item, status } : item
                    ),
                })),
            incrementRetry: (id) =>
                set((state) => ({
                    uploadQueue: state.uploadQueue.map((item) =>
                        item.id === id ? { ...item, retryCount: item.retryCount + 1 } : item
                    ),
                })),
            clearQueue: () => set({ uploadQueue: [] }),
        }),
        {
            name: 'sync-storage',
            storage: createJSONStorage(() => AsyncStorage),
        }
    )
);
