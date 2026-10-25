import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { TabNavigator } from './TabNavigator';
import { PreviewScreen } from '../screens/PreviewScreen';
import { EditorScreen } from '../screens/EditorScreen';
import { ServerFileScreen } from '../screens/ServerFileScreen';
import { CloudNoteScreen } from '../screens/CloudNoteScreen';
import { CloudRepoConfigScreen } from '../screens/CloudRepoConfigScreen'; // 新增
import { FlashNoteConfigScreen } from '../screens/FlashNoteConfigScreen';
import { AboutScreen } from '../screens/AboutScreen';
import { PermissionInfoScreen } from '../screens/PermissionInfoScreen';
import { AssistantConfigScreen } from '../screens/AssistantConfigScreen';
import { AgentConfigScreen } from '../screens/AgentConfigScreen';
import { AppSettingsScreen } from '../screens/AppSettingsScreen';
import { RootStackParamList } from '../types/navigation';
import { useTranslation } from 'react-i18next';

const Stack = createNativeStackNavigator<RootStackParamList>();

export const AppNavigator = () => {
    const { t } = useTranslation();

    return (
        <Stack.Navigator>
            <Stack.Screen name="MainTabs" component={TabNavigator} options={{ headerShown: false }} />
            <Stack.Screen name="Preview" component={PreviewScreen} options={{ headerShown: false }} />
            <Stack.Screen name="Editor" component={EditorScreen} options={{ headerShown: false }} />
            {/* 云端仓库配置二级页面 */}
            <Stack.Screen
                name="CloudRepoConfig"
                component={CloudRepoConfigScreen}
                options={{
                    headerShown: true,
                    title: t('settings.cloudRepoConfig')
                }}
            />
            {/* 闪念笔记设置二级页面 */}
            <Stack.Screen
                name="FlashNoteConfig"
                component={FlashNoteConfigScreen}
                options={{
                    headerShown: true,
                    title: t('settings.flashNoteConfig')
                }}
            />
            {/* APP设置二级页面（字体大小与Markdown样式） */}
            <Stack.Screen
                name="AppSettings"
                component={AppSettingsScreen}
                options={{
                    headerShown: true,
                    title: t('settings.appSettings', 'APP 设置')
                }}
            />
            {/* 关于页面 */}
            <Stack.Screen
                name="About"
                component={AboutScreen}
                options={{
                    headerShown: true,
                    title: t('about.title')
                }}
            />
            {/* 权限说明页面 */}
            <Stack.Screen
                name="PermissionInfo"
                component={PermissionInfoScreen}
                options={{
                    headerShown: true,
                    title: t('about.permissions.title')
                }}
            />
            {/* 系统文件页面 */}
            <Stack.Screen
                name="ServerFileList"
                component={ServerFileScreen}
                options={{
                    headerShown: true,
                    title: t('tabs.files')
                }}
            />
            {/* 云盘文件页面 */}
            <Stack.Screen
                name="CloudFileList"
                component={CloudNoteScreen}
                options={{
                    headerShown: true,
                    title: t('browser.cloudFiles', { defaultValue: '云盘文件' })
                }}
            />
            {/* 服务端连接配置页面 */}
            <Stack.Screen
                name="AssistantConfig"
                component={AssistantConfigScreen}
                options={{
                    headerShown: true,
                    title: t('settings.serverConfig', '服务端连接配置')
                }}
            />
            {/* AI 智能体配置页面 */}
            <Stack.Screen
                name="AgentConfig"
                component={AgentConfigScreen}
                options={{
                    headerShown: true,
                    title: t('settings.agentConfig', 'AI 智能体配置')
                }}
            />
        </Stack.Navigator>
    );
};
