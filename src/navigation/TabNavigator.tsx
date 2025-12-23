import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import Icon from '@expo/vector-icons/MaterialIcons';
import { useTranslation } from 'react-i18next';

import { FlashScreen } from '../screens/FlashScreen';
import { TodoScreen } from '../screens/TodoScreen';
import { AgentScreen } from '../screens/AgentScreen';
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

const AgentIcon = ({ color, size }: { color: string; size: number }) => (
    <Icon name="auto-awesome" color={color} size={size} />
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
            backBehavior="none"
            screenOptions={{
                headerTitleAlign: 'center',
                headerShadowVisible: false,
                headerStyle: {
                    backgroundColor: theme.colors.background,
                },
                tabBarStyle: {
                    backgroundColor: theme.colors.surface,
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
                    title: t('tabs.todo'),
                    tabBarIcon: TodoIcon,
                }}
            />
            <Tab.Screen
                name="Agent"
                component={AgentScreen}
                options={{
                    headerShown: false, // Custom header in screen
                    title: t('tabs.agent'),
                    tabBarIcon: AgentIcon,
                    tabBarStyle: {
                        borderTopWidth: 0, // Ensure no border matches main style
                        elevation: 0,
                        shadowOpacity: 0,
                        backgroundColor: theme.colors.surface, // Match Agent page background
                    },
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
        </Tab.Navigator >
    );
};
