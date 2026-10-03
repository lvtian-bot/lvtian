import { NavigatorScreenParams } from '@react-navigation/native';

export type NoteStackParamList = {
    NoteList: { prefix?: string };
};

export type MainTabParamList = {
    Flash: undefined;
    Todo: undefined;
    Note: NavigatorScreenParams<NoteStackParamList>;
    Me: undefined;
};

export type RootStackParamList = {
    MainTabs: NavigatorScreenParams<MainTabParamList>;
    Preview: { filePath: string };
    Editor: { filePath: string; flashNoteId?: string; initialContent?: string };
    CloudRepoConfig: undefined; // 新增：云端仓库配置二级页面
    FlashNoteConfig: undefined; // 新增：闪念笔记设置二级页面
    CacheManager: undefined; // 新增：缓存管理页面
    About: undefined; // 新增：关于页面
    PermissionInfo: undefined; // 新增：权限说明页面
    Me: undefined; // 新增：设置页面 -> 我页面
};


