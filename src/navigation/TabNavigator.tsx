import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import Icon from 'react-native-vector-icons/MaterialIcons';
import { useTranslation } from 'react-i18next';

import { TimelineScreen } from '../screens/TimelineScreen';
import { BrowserScreen } from '../screens/BrowserScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { MainTabParamList } from '../types/navigation';

const Tab = createBottomTabNavigator<MainTabParamList>();

export const TabNavigator = () => {
    const { t } = useTranslation();

    return (
        <Tab.Navigator>
            <Tab.Screen
                name="Timeline"
                component={TimelineScreen}
                options={{
                    headerShown: true,
                    title: t('tabs.timeline'),
                    headerTitleAlign: 'left',
                    tabBarIcon: ({ color, size }) => (
                        <Icon name="timeline" color={color} size={size} />
                    ),
                }}
            />
            <Tab.Screen
                name="Browser"
                component={BrowserScreen}
                options={{
                    headerShown: true,
                    title: t('tabs.browser'),
                    headerTitleAlign: 'left',
                    tabBarIcon: ({ color, size }) => (
                        <Icon name="folder" color={color} size={size} />
                    ),
                }}
            />
            <Tab.Screen
                name="Settings"
                component={SettingsScreen}
                options={{
                    headerShown: true,
                    title: t('tabs.settings'),
                    headerTitleAlign: 'left',
                    tabBarIcon: ({ color, size }) => (
                        <Icon name="settings" color={color} size={size} />
                    ),
                }}
            />
        </Tab.Navigator>
    );
};
