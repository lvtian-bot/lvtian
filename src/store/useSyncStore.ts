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

// Counter for generating unique IDs
let idCounter = 0;

/**
 * Generates a unique ID using timestamp + counter
 * More reliable than Math.random() which could theoretically collide
 */
const generateUniqueId = (): string => {
    const timestamp = Date.now();
    const counter = idCounter++;
    return `${timestamp}-${counter}`;
};

export const useSyncStore = create<SyncState>()(
    persist(
        (set) => ({
            uploadQueue: [],
            addToQueue: (filePath, key) =>
                set((state) => ({
                    uploadQueue: [
                        ...state.uploadQueue,
                        {
                            id: generateUniqueId(),
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
