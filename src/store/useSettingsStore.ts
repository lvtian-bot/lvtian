import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

interface SettingsState {
    themeMode: 'light' | 'dark' | 'system';
    setThemeMode: (mode: 'light' | 'dark' | 'system') => void;
    cosConfig: {
        secretId: string;
        secretKey: string;
        bucket: string;
        region: string;
    };
    setCosConfig: (config: Partial<SettingsState['cosConfig']>) => void;
    flashNoteConfig: {
        path: string;
        filename: string;
    };
    setFlashNoteConfig: (config: Partial<SettingsState['flashNoteConfig']>) => void;
}

export const useSettingsStore = create<SettingsState>()(
    persist(
        (set) => ({
            themeMode: 'system',
            setThemeMode: (mode) => set({ themeMode: mode }),
            cosConfig: {
                secretId: '',
                secretKey: '',
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
        }),
        {
            name: 'settings-storage',
            storage: createJSONStorage(() => AsyncStorage),
        }
    )
);
