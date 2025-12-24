import React from 'react';
import { createMaterialTopTabNavigator } from '@react-navigation/material-top-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import Icon from '@expo/vector-icons/MaterialIcons';
import { useTranslation } from 'react-i18next';

import { FlashScreen } from '../screens/FlashScreen';
import { TodoScreen } from '../screens/TodoScreen';
import { AgentScreen } from '../screens/AgentScreen';
import { NoteNavigator } from './NoteNavigator';
import { SettingsScreen } from '../screens/SettingsScreen';
import { MainTabParamList } from '../types/navigation';

import { theme } from '../utils/theme';

// 1. Create Stacks for screens that need headers (Flash, Todo, Settings)
// This is necessary because MaterialTopTabs does not provide a built-in header.
const FlashStack = createNativeStackNavigator();
const TodoStack = createNativeStackNavigator();
const SettingsStack = createNativeStackNavigator();

const FlashStackScreen = () => {
    const { t } = useTranslation();
    return (
        <FlashStack.Navigator
            screenOptions={{
                headerTitleAlign: 'center',
                headerShadowVisible: false,
                headerStyle: { backgroundColor: theme.colors.background },
            }}
        >
            <FlashStack.Screen
                name="FlashScreen"
                component={FlashScreen}
                options={{ title: t('tabs.timeline') }}
            />
        </FlashStack.Navigator>
    );
};

const TodoStackScreen = () => {
    const { t } = useTranslation();
    return (
        <TodoStack.Navigator
            screenOptions={{
                headerTitleAlign: 'center',
                headerShadowVisible: false,
                headerStyle: { backgroundColor: theme.colors.background },
            }}
        >
            <TodoStack.Screen
                name="TodoScreen"
                component={TodoScreen}
                options={{ title: t('tabs.todo') }}
            />
        </TodoStack.Navigator>
    );
};

const SettingsStackScreen = () => {
    const { t } = useTranslation();
    return (
        <SettingsStack.Navigator
            screenOptions={{
                headerTitleAlign: 'center',
                headerShadowVisible: false,
                headerStyle: { backgroundColor: theme.colors.background },
            }}
        >
            <SettingsStack.Screen
                name="SettingsScreen"
                component={SettingsScreen}
                options={{ title: t('tabs.settings') }}
            />
        </SettingsStack.Navigator>
    );
};

const Tab = createMaterialTopTabNavigator<MainTabParamList>();

// Icons
// MaterialTopTabs passes { focused, color } (no size by default)
const FlashIcon = ({ color }: { color: string }) => (
    <Icon name="flash-on" color={color} size={24} />
);

const TodoIcon = ({ color }: { color: string }) => (
    <Icon name="task-alt" color={color} size={24} />
);

const AgentIcon = ({ color }: { color: string }) => (
    <Icon name="auto-awesome" color={color} size={24} />
);

const NoteIcon = ({ color }: { color: string }) => (
    <Icon name="folder" color={color} size={24} />
);

const SettingsIcon = ({ color }: { color: string }) => (
    <Icon name="settings" color={color} size={24} />
);

export const TabNavigator = () => {
    const { t } = useTranslation();

    return (
        <Tab.Navigator
            tabBarPosition="bottom"
            initialLayout={{ width: 0 }}
            screenOptions={{
                swipeEnabled: true,
                animationEnabled: false, // Disable animation on click
                tabBarShowIcon: true,
                tabBarShowLabel: true,
                tabBarIndicatorStyle: { height: 0 }, // Hide the indicator line
                tabBarStyle: {
                    backgroundColor: theme.colors.surface,
                    borderTopWidth: 1,
                    borderTopColor: '#e0e0e0',
                    elevation: 8, // Shadow for Android
                },
                tabBarActiveTintColor: theme.colors.primary,
                tabBarInactiveTintColor: 'gray',
                tabBarLabelStyle: {
                    fontSize: 10,
                    textTransform: 'none',
                    margin: 0,
                },
                tabBarIconStyle: {
                    width: 24,
                    height: 24,
                },
            }}
        >
            <Tab.Screen
                name="Flash"
                component={FlashStackScreen}
                options={{
                    title: t('tabs.timeline'),
                    tabBarIcon: FlashIcon,
                }}
            />
            <Tab.Screen
                name="Todo"
                component={TodoStackScreen}
                options={{
                    title: t('tabs.todo'),
                    tabBarIcon: TodoIcon,
                }}
            />
            <Tab.Screen
                name="Agent"
                component={AgentScreen}
                options={{
                    title: t('tabs.agent'),
                    tabBarIcon: AgentIcon,
                }}
            />
            <Tab.Screen
                name="Note"
                component={NoteNavigator}
                options={{
                    title: t('tabs.browser'),
                    tabBarIcon: NoteIcon,
                }}
            />
            <Tab.Screen
                name="Settings"
                component={SettingsStackScreen}
                options={{
                    title: t('tabs.settings'),
                    tabBarIcon: SettingsIcon,
                }}
            />
        </Tab.Navigator>
    );
};
