import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { TabNavigator } from './TabNavigator';
import { PreviewScreen } from '../screens/PreviewScreen';
import { EditorScreen } from '../screens/EditorScreen';
import { CloudRepoConfigScreen } from '../screens/CloudRepoConfigScreen'; // 新增
import { FlashNoteConfigScreen } from '../screens/FlashNoteConfigScreen'; // 新增
import { CacheManagerScreen } from '../screens/CacheManagerScreen'; // 新增
import { AboutScreen } from '../screens/AboutScreen'; // 新增
import { PermissionInfoScreen } from '../screens/PermissionInfoScreen'; // 新增
import { MeScreen } from '../screens/MeScreen'; // 新增
import { AssistantConfigScreen } from '../screens/AssistantConfigScreen'; // 新增：助理服务配置
import { RootStackParamList } from '../types/navigation';
import { useTranslation } from 'react-i18next'; // 新增

const Stack = createNativeStackNavigator<RootStackParamList>();

export const AppNavigator = () => {
    const { t } = useTranslation(); // 新增

    return (
        <Stack.Navigator>
            <Stack.Screen name="MainTabs" component={TabNavigator} options={{ headerShown: false }} />
            <Stack.Screen name="Preview" component={PreviewScreen} options={{ headerShown: false }} />
            <Stack.Screen name="Editor" component={EditorScreen} options={{ headerShown: false }} />
            {/* 新增：云端仓库配置二级页面 */}
            <Stack.Screen
                name="CloudRepoConfig"
                component={CloudRepoConfigScreen}
                options={{
                    headerShown: true,
                    title: t('settings.cloudRepoConfig')
                }}
            />
            {/* 新增：闪念笔记设置二级页面 */}
            <Stack.Screen
                name="FlashNoteConfig"
                component={FlashNoteConfigScreen}
                options={{
                    headerShown: true,
                    title: t('settings.flashNoteConfig')
                }}
            />
            {/* 新增：缓存管理页面 */}
            <Stack.Screen
                name="CacheManager"
                component={CacheManagerScreen}
                options={{
                    headerShown: true,
                    title: t('settings.cacheManager')
                }}
            />
            {/* 新增：关于页面 */}
            <Stack.Screen
                name="About"
                component={AboutScreen}
                options={{
                    headerShown: true,
                    title: t('about.title')
                }}
            />
            {/* 新增：权限说明页面 */}
            <Stack.Screen
                name="PermissionInfo"
                component={PermissionInfoScreen}
                options={{
                    headerShown: true,
                    title: t('about.permissions.title')
                }}
            />
            {/* 新增：我页面 */}
            <Stack.Screen
                name="Me"
                component={MeScreen}
                options={{
                    headerShown: true,
                    title: t('tabs.me')
                }}
            />
            {/* 新增：助理服务配置页面 */}
            <Stack.Screen
                name="AssistantConfig"
                component={AssistantConfigScreen}
                options={{
                    headerShown: true,
                    title: t('settings.assistantConfig', '助理服务配置')
                }}
            />
        </Stack.Navigator>
    );
};
