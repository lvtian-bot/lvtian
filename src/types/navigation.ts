import { NavigatorScreenParams } from '@react-navigation/native';

export type NoteStackParamList = {
    NoteList: { prefix?: string };
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
    Preview: { filePath: string };
    Editor: { filePath: string; flashNoteId?: string; initialContent?: string };
    CloudRepoConfig: undefined; // WebDAV 配置页面
    FlashNoteConfig: undefined; // 闪念笔记设置页面
    CacheManager: undefined; // 缓存管理页面
    About: undefined; // 关于页面
    PermissionInfo: undefined; // 权限说明页面
    Me: undefined; // 设置页面
};
