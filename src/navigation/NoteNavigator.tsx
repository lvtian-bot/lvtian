import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { NoteScreen } from '../screens/NoteScreen';
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
                name="NoteList"
                component={NoteScreen}
                options={({ route }) => ({
                    title: t('tabs.browser'),
                    // Only show title on the root screen, or maybe just 'Browser' everywhere?
                    // Or "Folder Name" for sub-folders?
                    // For now, consistent title is fine, or dynamic title based on prefix could be nice.
                    // Let's stick to standard behavior for now.
                })}
            />
        </Stack.Navigator>
    );
};
