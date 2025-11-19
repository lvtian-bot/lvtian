import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

export interface FileMetadata {
    etag: string | null;
    lastModified: string | null; // ISO string
}

interface FileMetadataState {
    metadata: Record<string, FileMetadata>;
    setMetadata: (filePath: string, etag: string, lastModified: string) => void;
    getMetadata: (filePath: string) => FileMetadata | null;
    invalidateMetadata: (filePath: string) => void;
}

export const useFileMetadataStore = create<FileMetadataState>()(
    persist(
        (set, get) => ({
            metadata: {},
            setMetadata: (filePath, etag, lastModified) =>
                set((state) => ({
                    metadata: {
                        ...state.metadata,
                        [filePath]: { etag, lastModified },
                    },
                })),
            getMetadata: (filePath) => {
                const state = get();
                return state.metadata[filePath] || null;
            },
            invalidateMetadata: (filePath) =>
                set((state) => ({
                    metadata: {
                        ...state.metadata,
                        [filePath]: { ...state.metadata[filePath], etag: null },
                    },
                })),
        }),
        {
            name: 'file-metadata-storage',
            storage: createJSONStorage(() => AsyncStorage),
        }
    )
);
