import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { MarkdownThemeKey } from '../utils/markdownThemes';

export type FontSizePreference = 'small' | 'standard' | 'large';

interface SettingsState {
    themeMode: 'light' | 'dark' | 'system';
    setThemeMode: (mode: 'light' | 'dark' | 'system') => void;
    fontSize: FontSizePreference;
    setFontSize: (size: FontSizePreference) => void;
    userAvatar?: string;
    setUserAvatar: (avatar?: string) => void;
    flashNoteConfig: {
        path: string;
        filename: string;
        suffix: string;
        historyPattern?: 'none' | 'dash-yyyymm' | 'underscore-yyyymm' | 'dash-yyyy' | 'chinese-yyyymm';
        historyFolderPath: string; // New field for separate history folder
    };
    setFlashNoteConfig: (config: Partial<SettingsState['flashNoteConfig']>) => void;

    // Cloud Provider Selection (WebDAV for flash notes)
    cloudProvider: 'webdav' | 'none';
    setCloudProvider: (provider: 'webdav' | 'none') => void;

    // WebDAV Config
    webDavConfig: {
        server: string;
        username: string;
        // Password is securely stored in expo-secure-store
    };
    setWebDavConfig: (config: Partial<SettingsState['webDavConfig']>) => void;

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
            fontSize: 'standard',
            setFontSize: (size) => set({ fontSize: size }),
            userAvatar: undefined,
            setUserAvatar: (avatar) => set({ userAvatar: avatar }),
            flashNoteConfig: {
                path: '',
                filename: 'flash_notes.md',
                suffix: '',
                historyPattern: 'none',
                historyFolderPath: '', // Default to empty, meaning same as main path
            },
            setFlashNoteConfig: (config) =>
                set((state) => ({ flashNoteConfig: { ...state.flashNoteConfig, ...config } })),

            cloudProvider: 'none',
            setCloudProvider: (provider) => set({ cloudProvider: provider }),

            webDavConfig: {
                server: 'https://dav.jianguoyun.com/dav/', // Default suggestion
                username: '',
            },
            setWebDavConfig: (config) =>
                set((state) => ({ webDavConfig: { ...state.webDavConfig, ...config } })),

            markdownTheme: 'default',
            setMarkdownTheme: (theme) => set({ markdownTheme: theme }),
            hasHydrated: false,
            setHasHydrated: (state) => set({ hasHydrated: state }),
        }),
        {
            name: 'settings-storage',
            storage: createJSONStorage(() => AsyncStorage),
            onRehydrateStorage: () => (state) => {
                const { setHasHydrated, setCloudProvider } = useSettingsStore.getState();
                setHasHydrated(true);
                if (state && (state.cloudProvider as string) !== 'webdav') {
                    setCloudProvider('none');
                }
            },
        }
    )
);
