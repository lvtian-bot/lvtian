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
                options={{
                    title: t('tabs.files'),
                }}
            />
        </Stack.Navigator>
    );
};
