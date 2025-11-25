import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { CloudFileItem } from '../services/CloudService';

interface FileListState {
    // Map directory path (prefix) to list of files
    cachedLists: Record<string, CloudFileItem[]>;
    setCachedList: (path: string, items: CloudFileItem[]) => void;
    getCachedList: (path: string) => CloudFileItem[] | undefined;
}

export const useFileListStore = create<FileListState>()(
    persist(
        (set, get) => ({
            cachedLists: {},
            setCachedList: (path, items) =>
                set((state) => ({
                    cachedLists: {
                        ...state.cachedLists,
                        [path]: items,
                    },
                })),
            getCachedList: (path) => get().cachedLists[path],
        }),
        {
            name: 'file-list-storage',
            storage: createJSONStorage(() => AsyncStorage),
        }
    )
);
