import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import Icon from 'react-native-vector-icons/MaterialIcons';
import { useTranslation } from 'react-i18next';

import { TimelineScreen } from '../screens/TimelineScreen';
import { BrowserScreen } from '../screens/BrowserScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { MainTabParamList } from '../types/navigation';

import { theme } from '../utils/theme';

const Tab = createBottomTabNavigator<MainTabParamList>();

const TimelineIcon = ({ color, size }: { color: string; size: number }) => (
    <Icon name="flash-on" color={color} size={size} />
);

const BrowserIcon = ({ color, size }: { color: string; size: number }) => (
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
                name="Timeline"
                component={TimelineScreen}
                options={{
                    headerShown: true,
                    title: t('tabs.timeline'),
                    tabBarIcon: TimelineIcon,
                }}
            />
            <Tab.Screen
                name="Browser"
                component={BrowserScreen}
                options={{
                    headerShown: true,
                    title: t('tabs.browser'),
                    tabBarIcon: BrowserIcon,
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
