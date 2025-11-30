import { NavigatorScreenParams } from '@react-navigation/native';

export type MainTabParamList = {
    Timeline: undefined;
    Todo: undefined;
    Browser: undefined;
    Settings: undefined;
};

export type RootStackParamList = {
    MainTabs: NavigatorScreenParams<MainTabParamList>;
    Preview: { filePath: string };
    Editor: { filePath: string };
    CloudRepoConfig: undefined; // 新增：云端仓库配置二级页面
    FlashNoteConfig: undefined; // 新增：闪念笔记设置二级页面
    CacheManager: undefined; // 新增：缓存管理页面
};


