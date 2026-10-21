import { NavigatorScreenParams } from '@react-navigation/native';

export type NoteStackParamList = {
    ServerFileList: { initialPath?: string } | undefined;
    CloudFileList: { prefix?: string } | undefined;
};

export type MainTabParamList = {
    Chat: undefined;
    Flash: undefined;
    Todo: undefined;
    Moments: undefined;
    Files: NavigatorScreenParams<NoteStackParamList>;
};

export type RootStackParamList = {
    MainTabs: NavigatorScreenParams<MainTabParamList>;
    Preview: { filePath: string; source?: 'server' | 'webdav' | 'local'; title?: string };
    Editor: { filePath: string; source?: 'server' | 'webdav' | 'local'; flashNoteId?: string; initialContent?: string; title?: string };
    CloudRepoConfig: undefined; // WebDAV 配置页面
    FlashNoteConfig: undefined; // 闪念笔记设置页面
    CacheManager: undefined; // 缓存管理页面
    About: undefined; // 关于页面
    PermissionInfo: undefined; // 权限说明页面
    AssistantConfig: undefined; // 助理服务配置页面
    Me: undefined; // 设置页面
};
