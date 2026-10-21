import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { ServerFileScreen } from '../screens/ServerFileScreen';
import { CloudNoteScreen } from '../screens/CloudNoteScreen';
import { NoteStackParamList } from '../types/navigation';
import { useTranslation } from 'react-i18next';
import { theme } from '../utils/theme';

const Stack = createNativeStackNavigator<NoteStackParamList>();

export const NoteNavigator = () => {
    const { t } = useTranslation();

    return (
        <Stack.Navigator
            screenOptions={{
                headerStyle: {
                    backgroundColor: theme.colors.background,
                },
                headerShadowVisible: false,
                headerTitleAlign: 'center',
            }}
        >
            <Stack.Screen
                name="ServerFileList"
                component={ServerFileScreen}
                options={{
                    title: t('tabs.files'),
                }}
            />
            <Stack.Screen
                name="CloudFileList"
                component={CloudNoteScreen}
                options={{
                    title: t('browser.cloudFiles', { defaultValue: '云盘文件' }),
                }}
            />
        </Stack.Navigator>
    );
};
