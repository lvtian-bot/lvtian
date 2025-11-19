import { NavigatorScreenParams } from '@react-navigation/native';

export type MainTabParamList = {
    Timeline: undefined;
    Browser: undefined;
    Settings: undefined;
};

export type RootStackParamList = {
    MainTabs: NavigatorScreenParams<MainTabParamList>;
    Editor: { filePath: string; isNew?: boolean };
};


