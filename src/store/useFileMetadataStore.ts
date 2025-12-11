import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type UploadState = 'uploading' | 'failed' | 'conflict-failed' | null;

export interface FileMetadata {
    // 三重哈希核心字段
    syncedHash: string | null;  // 上次成功同步时的云端哈希
    localHash: string | null;   // 本地记录的云端哈希（本地修改时会被篡改以触发同步）
    lastModified: string | null; // ISO string
    uploadState: UploadState;
}

interface FileMetadataState {
    metadata: Record<string, FileMetadata>;
    setMetadata: (filePath: string, syncedHash: string | null, localHash: string | null, lastModified: string | null) => void;
    setUploadState: (filePath: string, state: UploadState) => void;
    markFileAsModified: (filePath: string) => void;
    getMetadata: (filePath: string) => FileMetadata | undefined;
    clearUploadingState: () => void;
    resetUploadingToFailed: () => void;
    removeMetadata: (filePath: string) => void; // Add this line
}

export const useFileMetadataStore = create<FileMetadataState>()(
    persist(
        (set, get) => ({
            metadata: {},
            setMetadata: (filePath, syncedHash, localHash, lastModified) =>
                set((state) => ({
                    metadata: {
                        ...state.metadata,
                        [filePath]: {
                            syncedHash,
                            localHash,
                            lastModified,
                            uploadState: null,
                        },
                    },
                })),
            setUploadState: (filePath, uploadState) =>
                set((state) => ({
                    metadata: {
                        ...state.metadata,
                        [filePath]: {
                            ...(state.metadata[filePath] || { syncedHash: null, localHash: null, lastModified: null }),
                            uploadState,
                        },
                    },
                })),
            markFileAsModified: (filePath) =>
                set((state) => ({
                    metadata: {
                        ...state.metadata,
                        [filePath]: {
                            ...(state.metadata[filePath] || { syncedHash: null, lastModified: null, uploadState: null }),
                            localHash: LOCAL_MODIFIED_HASH,
                        },
                    },
                })),
            getMetadata: (filePath) => {
                const state = get();
                return state.metadata[filePath];
            },
            clearUploadingState: () =>
                set((state) => {
                    const newMetadata = { ...state.metadata };
                    let hasChanges = false;
                    Object.keys(newMetadata).forEach((key) => {
                        if (newMetadata[key].uploadState === 'uploading') {
                            newMetadata[key] = { ...newMetadata[key], uploadState: null };
                            hasChanges = true;
                        }
                    });
                    return hasChanges ? { metadata: newMetadata } : state;
                }),
            resetUploadingToFailed: () =>
                set((state) => {
                    const newMetadata = { ...state.metadata };
                    let hasChanges = false;
                    Object.keys(newMetadata).forEach((key) => {
                        if (newMetadata[key].uploadState === 'uploading') {
                            newMetadata[key] = { ...newMetadata[key], uploadState: 'failed' };
                            hasChanges = true;
                        }
                    });
                    return hasChanges ? { metadata: newMetadata } : state;
                }),
            removeMetadata: (filePath) =>
                set((state) => {
                    const newMetadata = { ...state.metadata };
                    const exists = filePath in newMetadata;
                    if (exists) {
                        delete newMetadata[filePath];
                        console.log(`[MetadataStore] Successfully removed metadata for: '${filePath}'`);
                    } else {
                        console.log(`[MetadataStore] Warning: Attempted to remove non-existent metadata for: '${filePath}'`);
                    }
                    return { metadata: newMetadata };
                }),
        }),
        {
            name: 'file-metadata-storage',
            storage: createJSONStorage(() => AsyncStorage),
            onRehydrateStorage: () => (state) => {
                state?.resetUploadingToFailed();
            },
        }
    )
);

export const LOCAL_MODIFIED_HASH = 'LOCAL_MODIFIED';

