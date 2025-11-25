import { create } from 'zustand';

interface ShareState {
    pendingShareContent: string | null;
    setPendingShare: (content: string) => void;
    clearPendingShare: () => void;
}

export const useShareStore = create<ShareState>((set) => ({
    pendingShareContent: null,
    setPendingShare: (content: string) => set({ pendingShareContent: content }),
    clearPendingShare: () => set({ pendingShareContent: null }),
}));
