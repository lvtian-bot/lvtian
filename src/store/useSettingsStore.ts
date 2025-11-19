import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { MarkdownThemeKey } from '../utils/markdownThemes';

interface SettingsState {
    themeMode: 'light' | 'dark' | 'system';
    setThemeMode: (mode: 'light' | 'dark' | 'system') => void;
    cosConfig: {
        // Note: secretId and secretKey are stored in react-native-keychain (encrypted)
        // Only non-sensitive config is stored here
        bucket: string;
        region: string;
    };
    setCosConfig: (config: Partial<SettingsState['cosConfig']>) => void;
    flashNoteConfig: {
        path: string;
        filename: string;
    };
    setFlashNoteConfig: (config: Partial<SettingsState['flashNoteConfig']>) => void;
    markdownTheme: MarkdownThemeKey;
    setMarkdownTheme: (theme: MarkdownThemeKey) => void;
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
            },
            setFlashNoteConfig: (config) =>
                set((state) => ({ flashNoteConfig: { ...state.flashNoteConfig, ...config } })),
            markdownTheme: 'default',
            setMarkdownTheme: (theme) => set({ markdownTheme: theme }),
        }),
        {
            name: 'settings-storage',
            storage: createJSONStorage(() => AsyncStorage),
        }
    )
);
