import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type UploadState = 'uploading' | 'failed' | 'conflict-failed' | null;

export interface FileMetadata {
    etag: string | null;
    lastModified: string | null; // ISO string
    uploadState: UploadState;
}

interface FileMetadataState {
    metadata: Record<string, FileMetadata>;
    setMetadata: (filePath: string, etag: string | null, lastModified: string | null) => void;
    setUploadState: (filePath: string, state: UploadState) => void;
    getMetadata: (filePath: string) => FileMetadata | undefined;
    clearUploadingState: () => void;
    resetUploadingToFailed: () => void;
}

export const useFileMetadataStore = create<FileMetadataState>()(
    persist(
        (set, get) => ({
            metadata: {},
            setMetadata: (filePath, etag, lastModified) =>
                set((state) => ({
                    metadata: {
                        ...state.metadata,
                        [filePath]: {
                            etag,
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
                            ...(state.metadata[filePath] || { etag: null, lastModified: null }),
                            uploadState,
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
