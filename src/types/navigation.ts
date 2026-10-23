import { NavigatorScreenParams } from '@react-navigation/native';

export type MainTabParamList = {
    Chat: undefined;
    Flash: undefined;
    Todo: undefined;
    Moments: undefined;
    Me: undefined;
};

export type RootStackParamList = {
    MainTabs: NavigatorScreenParams<MainTabParamList>;
    Preview: { filePath: string; source?: 'server' | 'webdav' | 'local'; title?: string };
    Editor: { filePath: string; source?: 'server' | 'webdav' | 'local'; flashNoteId?: string; initialContent?: string; title?: string; expectedMtime?: number };
    CloudRepoConfig: undefined; // WebDAV 配置页面
    FlashNoteConfig: undefined; // 闪念笔记设置页面
    CacheManager: undefined; // 缓存管理页面
    About: undefined; // 关于页面
    PermissionInfo: undefined; // 权限说明页面
    AssistantConfig: undefined; // 助理服务配置页面
    ServerFileList: { initialPath?: string } | undefined; // 系统文件（由「我」页进入）
    CloudFileList: { prefix?: string } | undefined; // 云盘文件（由「我」页进入）
};
