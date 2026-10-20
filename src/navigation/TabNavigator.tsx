import React from 'react';
import { TouchableOpacity, StyleSheet } from 'react-native';
import { createMaterialTopTabNavigator } from '@react-navigation/material-top-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import Icon from '@expo/vector-icons/MaterialIcons';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';

import { ChatScreen } from '../screens/ChatScreen';
import { FlashScreen } from '../screens/FlashScreen';
import { TodoScreen } from '../screens/TodoScreen';
import { MomentsScreen } from '../screens/MomentsScreen';
import { NoteNavigator } from './NoteNavigator';
import { MainTabParamList } from '../types/navigation';

import { theme } from '../utils/theme';

const styles = StyleSheet.create({
    settingsButton: {
        marginRight: 16,
    },
});

const SettingsButton = () => {
    const navigation = useNavigation<any>();
    return (
        <TouchableOpacity
            onPress={() => navigation.navigate('Me')}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            style={styles.settingsButton}
            activeOpacity={0.7}
        >
            <Icon name="settings" size={22} color={theme.colors.textSecondary} />
        </TouchableOpacity>
    );
};

const renderSettingsButton = () => <SettingsButton />;

const ChatStack = createNativeStackNavigator();
const FlashStack = createNativeStackNavigator();
const TodoStack = createNativeStackNavigator();
const MomentsStack = createNativeStackNavigator();

const ChatStackScreen = () => {
    const { t } = useTranslation();
    return (
        <ChatStack.Navigator
            screenOptions={{
                headerTitleAlign: 'center',
                headerShadowVisible: false,
                headerStyle: { backgroundColor: theme.colors.background },
                headerRight: renderSettingsButton,
            }}
        >
            <ChatStack.Screen
                name="ChatScreen"
                component={ChatScreen}
                options={{ title: t('tabs.chat') }}
            />
        </ChatStack.Navigator>
    );
};

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
                headerRight: renderSettingsButton,
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

const MomentsStackScreen = () => {
    const { t } = useTranslation();
    return (
        <MomentsStack.Navigator
            screenOptions={{
                headerTitleAlign: 'center',
                headerShadowVisible: false,
                headerStyle: { backgroundColor: theme.colors.background },
                headerRight: renderSettingsButton,
            }}
        >
            <MomentsStack.Screen
                name="MomentsScreen"
                component={MomentsScreen}
                options={{ title: t('tabs.moments') }}
            />
        </MomentsStack.Navigator>
    );
};

const Tab = createMaterialTopTabNavigator<MainTabParamList>();

const ChatIcon = ({ color }: { color: string }) => (
    <Icon name="chat" color={color} size={24} />
);

const FlashIcon = ({ color }: { color: string }) => (
    <Icon name="flash-on" color={color} size={24} />
);

const TodoIcon = ({ color }: { color: string }) => (
    <Icon name="task-alt" color={color} size={24} />
);

const MomentsIcon = ({ color }: { color: string }) => (
    <Icon name="dynamic-feed" color={color} size={24} />
);

const FilesIcon = ({ color }: { color: string }) => (
    <Icon name="folder" color={color} size={24} />
);

export const TabNavigator = () => {
    const { t } = useTranslation();
    const insets = useSafeAreaInsets();

    return (
        <Tab.Navigator
            tabBarPosition="bottom"
            initialRouteName="Flash"
            backBehavior="initialRoute"
            initialLayout={{ width: 0 }}
            screenOptions={{
                swipeEnabled: false,
                animationEnabled: false,
                tabBarShowIcon: true,
                tabBarShowLabel: true,
                tabBarIndicatorStyle: { height: 0 },
                tabBarStyle: {
                    backgroundColor: theme.colors.surface,
                    borderTopWidth: 1,
                    borderTopColor: '#e0e0e0',
                    elevation: 8,
                    paddingBottom: insets.bottom,
                    paddingTop: 0,
                },
                tabBarActiveTintColor: theme.colors.primary,
                tabBarInactiveTintColor: 'gray',
                tabBarItemStyle: {
                    paddingVertical: 6,
                },
                tabBarLabelStyle: {
                    fontSize: 10,
                    textTransform: 'none',
                    margin: 0,
                },
            }}
        >
            <Tab.Screen
                name="Chat"
                component={ChatStackScreen}
                options={{
                    title: t('tabs.chat'),
                    tabBarIcon: ChatIcon,
                }}
            />
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
                name="Moments"
                component={MomentsStackScreen}
                options={{
                    title: t('tabs.moments'),
                    tabBarIcon: MomentsIcon,
                }}
            />
            <Tab.Screen
                name="Files"
                component={NoteNavigator}
                options={{
                    title: t('tabs.files'),
                    tabBarIcon: FilesIcon,
                }}
            />
        </Tab.Navigator>
    );
};
