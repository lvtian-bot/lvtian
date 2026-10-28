import { NavigatorScreenParams } from '@react-navigation/native';

export type MainTabParamList = {
    Chat: undefined;
    Flash: undefined;
    Todo: undefined;
    Moments: undefined;
    Me: undefined;
};

export type ChatStackParamList = {
    ChatScreen: undefined;
    WorkRecords: undefined;
};

export type RootStackParamList = {
    MainTabs: NavigatorScreenParams<MainTabParamList>;
    Preview: { filePath: string; source?: 'server' | 'webdav' | 'local'; title?: string };
    Editor: { filePath: string; source?: 'server' | 'webdav' | 'local'; flashNoteId?: string; initialContent?: string; title?: string; expectedMtime?: number };
    CloudRepoConfig: undefined; // WebDAV 配置页面
    FlashNoteConfig: undefined; // 闪念笔记设置页面
    About: undefined; // 关于页面
    PermissionInfo: undefined; // 权限说明页面
    AssistantConfig: undefined; // 服务端连接配置页面
    AgentConfig: undefined; // AI 智能体配置页面
    AppSettings: undefined; // APP 设置页面（字体大小与 Markdown 样式）
    ServerFileList: { initialPath?: string } | undefined; // 系统文件（由「我」页进入）
    CloudFileList: { prefix?: string } | undefined; // 云盘文件（由「我」页进入）
};
