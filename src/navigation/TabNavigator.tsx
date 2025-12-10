import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import Icon from '@expo/vector-icons/MaterialIcons';
import { useTranslation } from 'react-i18next';

import { FlashScreen } from '../screens/FlashScreen';
import { TodoScreen } from '../screens/TodoScreen';
import { NoteNavigator } from './NoteNavigator';
import { SettingsScreen } from '../screens/SettingsScreen';
import { MainTabParamList } from '../types/navigation';

import { theme } from '../utils/theme';

const Tab = createBottomTabNavigator<MainTabParamList>();

const FlashIcon = ({ color, size }: { color: string; size: number }) => (
    <Icon name="flash-on" color={color} size={size} />
);

const TodoIcon = ({ color, size }: { color: string; size: number }) => (
    <Icon name="task-alt" color={color} size={size} />
);

const NoteIcon = ({ color, size }: { color: string; size: number }) => (
    <Icon name="folder" color={color} size={size} />
);

const SettingsIcon = ({ color, size }: { color: string; size: number }) => (
    <Icon name="settings" color={color} size={size} />
);

export const TabNavigator = () => {
    const { t } = useTranslation();

    return (
        <Tab.Navigator
            screenOptions={{
                headerTitleAlign: 'center',
                headerShadowVisible: false,
                headerStyle: {
                    backgroundColor: theme.colors.background,
                },
            }}
        >
            <Tab.Screen
                name="Flash"
                component={FlashScreen}
                options={{
                    headerShown: true,
                    title: t('tabs.timeline'),
                    tabBarIcon: FlashIcon,
                }}
            />
            <Tab.Screen
                name="Todo"
                component={TodoScreen}
                options={{
                    headerShown: true,
                    title: t('tabs.todo') || '待办',
                    tabBarIcon: TodoIcon,
                }}
            />
            <Tab.Screen
                name="Note"
                component={NoteNavigator}
                options={{
                    headerShown: false, // Stack navigator handles header
                    title: t('tabs.browser'),
                    tabBarIcon: NoteIcon,
                }}
            />
            <Tab.Screen
                name="Settings"
                component={SettingsScreen}
                options={{
                    headerShown: true,
                    title: t('tabs.settings'),
                    tabBarIcon: SettingsIcon,
                }}
            />
        </Tab.Navigator>
    );
};
