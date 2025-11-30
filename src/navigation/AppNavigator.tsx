import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { TabNavigator } from './TabNavigator';
import { PreviewScreen } from '../screens/PreviewScreen';
import { EditorScreen } from '../screens/EditorScreen';
import { CloudRepoConfigScreen } from '../screens/CloudRepoConfigScreen'; // 新增
import { FlashNoteConfigScreen } from '../screens/FlashNoteConfigScreen'; // 新增
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
                    title: t('settings.cloudRepoConfig') || '云端仓库配置' // 可以在i18n中配置
                }}
            />
            {/* 新增：闪念笔记设置二级页面 */}
            <Stack.Screen
                name="FlashNoteConfig"
                component={FlashNoteConfigScreen}
                options={{
                    headerShown: true,
                    title: t('settings.flashNoteConfig') || '闪念笔记设置' // 可以在i18n中配置
                }}
            />
        </Stack.Navigator>
    );
};
