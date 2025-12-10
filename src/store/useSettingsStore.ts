import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { MarkdownThemeKey } from '../utils/markdownThemes';

interface SettingsState {
    themeMode: 'light' | 'dark' | 'system';
    setThemeMode: (mode: 'light' | 'dark' | 'system') => void;
    cosConfig: {
        // Note: secretId and secretKey are stored in expo-secure-store (encrypted)
        // Only non-sensitive config is stored here
        bucket: string;
        region: string;
    };
    setCosConfig: (config: Partial<SettingsState['cosConfig']>) => void;
    flashNoteConfig: {
        path: string;
        filename: string;
        suffix: string;
        historyPattern?: 'none' | 'dash-yyyymm' | 'underscore-yyyymm' | 'dash-yyyy' | 'chinese-yyyymm';
        historyFolderPath: string; // New field for separate history folder
    };
    showFlashNotesInCache: boolean;
    setShowFlashNotesInCache: (show: boolean) => void;
    setFlashNoteConfig: (config: Partial<SettingsState['flashNoteConfig']>) => void;
    markdownTheme: MarkdownThemeKey;
    setMarkdownTheme: (theme: MarkdownThemeKey) => void;
    hasHydrated: boolean;
    setHasHydrated: (state: boolean) => void;
}

export const useSettingsStore = create<SettingsState>()(
    persist(
        (set) => ({
            themeMode: 'system',
            setThemeMode: (mode) => set({ themeMode: mode }),
            cosConfig: {
                bucket: '',
                region: '',
            },
            setCosConfig: (config) =>
                set((state) => ({ cosConfig: { ...state.cosConfig, ...config } })),
            flashNoteConfig: {
                path: '',
                filename: 'flash_notes.md',
                suffix: '',
                historyPattern: 'none',
                historyFolderPath: '', // Default to empty, meaning same as main path
            },
            setFlashNoteConfig: (config) =>
                set((state) => ({ flashNoteConfig: { ...state.flashNoteConfig, ...config } })),
            showFlashNotesInCache: false, // Default to not show flash notes in cache list
            setShowFlashNotesInCache: (show) => set({ showFlashNotesInCache: show }),
            markdownTheme: 'default',
            setMarkdownTheme: (theme) => set({ markdownTheme: theme }),
            hasHydrated: false,
            setHasHydrated: (state) => set({ hasHydrated: state }),
        }),
        {
            name: 'settings-storage',
            storage: createJSONStorage(() => AsyncStorage),
            onRehydrateStorage: () => (state) => {
                state?.setHasHydrated(true);
            },
        }
    )
);
