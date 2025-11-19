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
        }),
        {
            name: 'settings-storage',
            storage: createJSONStorage(() => AsyncStorage),
        }
    )
);
