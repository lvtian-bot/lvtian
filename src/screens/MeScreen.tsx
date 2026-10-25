import React, { useEffect, useState, type ComponentProps } from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView, Image, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import * as ImagePicker from 'expo-image-picker';

import { fsService } from '../services/FileSystemService';
import { useSettingsStore } from '../store/useSettingsStore';
import { useAssistantStore } from '../store/useAssistantStore';
import { theme } from '../utils/theme';
import { RootStackParamList } from '../types/navigation';

type SettingsScreenNavigationProp = NativeStackNavigationProp<RootStackParamList>;

interface SettingsItemProps {
    label: string;
    icon: ComponentProps<typeof MaterialCommunityIcons>['name'];
    onPress: () => void;
    subtitle?: string;
    iconColor?: string;
}

const SettingsItem: React.FC<SettingsItemProps> = ({
    label,
    icon,
    onPress,
    subtitle,
    iconColor = theme.colors.textSecondary,
}) => (
    <Pressable
        style={({ pressed }) => [
            styles.settingsItem,
            pressed && styles.settingsItemPressed,
        ]}
        android_ripple={{ color: '#E5E7EB' }}
        onPress={onPress}
    >
        <View style={styles.settingsItemLeft}>
            <MaterialCommunityIcons
                name={icon}
                size={22}
                color={iconColor}
                style={styles.settingsItemIcon}
            />
            <Text style={styles.settingsItemText}>{label}</Text>
        </View>
        <View style={styles.settingsItemRight}>
            {subtitle ? (
                <Text style={styles.settingsItemSubtitle} numberOfLines={1}>
                    {subtitle}
                </Text>
            ) : null}
            <MaterialCommunityIcons
                name="chevron-right"
                size={20}
                color={theme.colors.textSecondary}
            />
        </View>
    </Pressable>
);

export const MeScreen = () => {
    const { t } = useTranslation();
    const navigation = useNavigation<SettingsScreenNavigationProp>();

    const {
        webDavConfig,
        cloudProvider,
        markdownTheme,
        fontSize,
        userAvatar,
        setUserAvatar,
    } = useSettingsStore();

    const {
        serverUrl,
        connectionState,
        permissionMode,
    } = useAssistantStore();

    const isConnected = connectionState === 'connected';

    // 头像加载容错
    const [avatarBroken, setAvatarBroken] = useState(false);
    useEffect(() => {
        setAvatarBroken(false);
    }, [userAvatar]);

    const avatarUri = fsService.resolveAvatarUri(userAvatar);

    const pickAvatarAsync = async (): Promise<void> => {
        try {
            const result = await ImagePicker.launchImageLibraryAsync({
                mediaTypes: ['images'],
                allowsEditing: true,
                aspect: [1, 1],
                quality: 0.8,
            });

            if (!result.canceled && result.assets && result.assets.length > 0) {
                const previous = userAvatar;
                const filename = await fsService.persistAvatar(result.assets[0].uri);
                setUserAvatar(filename);
                if (previous && previous !== filename) {
                    await fsService.deleteAvatar(previous);
                }
            }
        } catch (error) {
            Alert.alert(t('me.avatar.pickFailed', '头像选择失败'), String(error));
        }
    };

    const clearAvatarAsync = async (): Promise<void> => {
        try {
            const current = userAvatar;
            setUserAvatar(undefined);
            await fsService.deleteAvatar(current);
        } catch (error) {
            Alert.alert(t('me.avatar.clearFailed', '清除头像失败'), String(error));
        }
    };

    const handleAvatarPress = async () => {
        if (userAvatar) {
            Alert.alert(
                t('me.avatar.title', '绿天助理形象'),
                undefined,
                [
                    { text: t('common.cancel', '取消'), style: 'cancel' },
                    { text: t('me.avatar.change', '从相册更换'), onPress: () => { pickAvatarAsync(); } },
                    { text: t('me.avatar.clear', '恢复默认形象'), style: 'destructive', onPress: () => { clearAvatarAsync(); } },
                ]
            );
        } else {
            await pickAvatarAsync();
        }
    };

    const statusText = isConnected
        ? `${t('settings.assistantConnected', '已连接')}${serverUrl ? ` · ${serverUrl}` : ''}`
        : connectionState === 'connecting' || connectionState === 'reconnecting'
        ? t('settings.assistantConnecting', '连接中...')
        : serverUrl
        ? `${t('settings.assistantDisconnected', '未连接')} · ${serverUrl}`
        : t('settings.serverSubtitle', '未配置 · 点击连接服务端');

    return (
        <View style={styles.container}>
            <ScrollView
                style={styles.scroll}
                contentContainerStyle={styles.contentContainer}
                showsVerticalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
            >
                {/* 顶部：AI 助理专属形象卡片 */}
                <SafeAreaView edges={['top']} style={styles.safeArea}>
                    <View style={styles.userProfileCard}>
                        <Pressable
                            onPress={handleAvatarPress}
                            style={({ pressed }) => [
                                styles.avatarPressable,
                                pressed && { opacity: 0.8 },
                            ]}
                        >
                            <View style={styles.avatarContainer}>
                                {avatarUri && !avatarBroken ? (
                                    <View style={styles.avatar}>
                                        <Image
                                            source={{ uri: avatarUri }}
                                            style={styles.avatarImage}
                                            onError={() => setAvatarBroken(true)}
                                        />
                                    </View>
                                ) : (
                                    <View style={styles.avatar}>
                                        <Image
                                            source={require('../../assets/icon.png')}
                                            style={styles.avatarImage}
                                        />
                                    </View>
                                )}
                            </View>
                        </Pressable>

                        <Pressable
                            style={({ pressed }) => [
                                styles.userInfoPressable,
                                pressed && styles.userInfoPressed,
                            ]}
                            android_ripple={{ color: '#E5E7EB' }}
                            onPress={() => navigation.navigate('AssistantConfig')}
                        >
                            <View style={styles.userInfo}>
                                <Text style={styles.userName}>{t('app.name', '绿天')}</Text>
                                <View style={styles.statusRow}>
                                    <View style={[styles.statusDot, isConnected && styles.connectedDot]} />
                                    <Text style={styles.userSyncStatus} numberOfLines={1}>
                                        {statusText}
                                    </Text>
                                </View>
                            </View>
                            <MaterialCommunityIcons
                                name="chevron-right"
                                size={24}
                                color={theme.colors.textSecondary}
                            />
                        </Pressable>
                    </View>
                </SafeAreaView>

                {/* 卡片一：智能体与文件 */}
                <View style={styles.cardWrapper}>
                    <View style={styles.settingsGroup}>
                        <SettingsItem
                            label={t('settings.agentConfig', 'AI 智能体配置')}
                            icon="robot-outline"
                            onPress={() => navigation.navigate('AgentConfig')}
                            subtitle={
                                permissionMode === 'danger-full-access'
                                    ? t('assistant.permissionDanger', '完全权限模式')
                                    : t('assistant.permissionWorkspace', '安全工作区模式')
                            }
                        />
                        <View style={styles.separator} />
                        <SettingsItem
                            label={t('tabs.files', '系统文件')}
                            icon="folder-outline"
                            onPress={() => navigation.navigate('ServerFileList')}
                        />
                    </View>
                </View>

                {/* 卡片二：云端存储 */}
                <View style={styles.cardWrapper}>
                    <View style={styles.settingsGroup}>
                        <SettingsItem
                            label={t('settings.cloudSyncWebDav', '云端同步 (WebDAV / 坚果云)')}
                            icon="cloud-sync-outline"
                            onPress={() => navigation.navigate('CloudRepoConfig')}
                            subtitle={
                                cloudProvider === 'webdav' && webDavConfig.server
                                    ? t('settings.configured', '已配置')
                                    : t('settings.notConfigured', '未配置')
                            }
                        />
                        <View style={styles.separator} />
                        <SettingsItem
                            label={t('browser.cloudFiles', '云盘文件')}
                            icon="cloud-outline"
                            onPress={() => navigation.navigate('CloudFileList')}
                        />
                    </View>
                </View>

                {/* 卡片三：设置与关于 */}
                <View style={styles.cardWrapper}>
                    <View style={styles.settingsGroup}>
                        <SettingsItem
                            label={t('settings.flashNoteConfig', '闪念笔记设置')}
                            icon="lightning-bolt-outline"
                            onPress={() => navigation.navigate('FlashNoteConfig')}
                        />
                        <View style={styles.separator} />
                        <SettingsItem
                            label={t('settings.appSettings', 'APP 设置')}
                            icon="tune"
                            onPress={() => navigation.navigate('AppSettings')}
                            subtitle={`${t(`settings.fontSizesShort.${fontSize}`)} · ${t(`settings.themes.${markdownTheme}`)}`}
                        />
                        <View style={styles.separator} />
                        <SettingsItem
                            label={t('about.title', '关于绿天')}
                            icon="information-outline"
                            onPress={() => navigation.navigate('About')}
                        />
                    </View>
                </View>
            </ScrollView>
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: theme.colors.background,
    },
    scroll: {
        flex: 1,
    },
    contentContainer: {
        paddingTop: 0,
        paddingBottom: theme.spacing.xl,
    },
    safeArea: {
        backgroundColor: theme.colors.background,
    },
    userProfileCard: {
        backgroundColor: theme.colors.background,
        paddingHorizontal: theme.spacing.m,
        paddingTop: theme.spacing.m * 1.5,
        paddingBottom: theme.spacing.m,
        flexDirection: 'row',
        alignItems: 'center',
    },
    avatarPressable: {
        borderRadius: 12,
    },
    avatarContainer: {
        marginRight: theme.spacing.m,
    },
    avatar: {
        width: 64,
        height: 64,
        borderRadius: 12,
        backgroundColor: theme.colors.surface,
        justifyContent: 'center',
        alignItems: 'center',
        shadowColor: '#000',
        shadowOpacity: 0.08,
        shadowOffset: { width: 0, height: 2 },
        shadowRadius: 4,
        elevation: 2,
        overflow: 'hidden',
    },
    avatarImage: {
        width: '100%',
        height: '100%',
        borderRadius: 12,
    },
    userInfoPressable: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingVertical: 8,
        paddingHorizontal: 8,
        borderRadius: 8,
    },
    userInfoPressed: {
        backgroundColor: '#F3F4F6',
    },
    userInfo: {
        flex: 1,
        marginRight: theme.spacing.s,
    },
    userName: {
        fontSize: 18,
        fontWeight: '700',
        color: theme.colors.text,
        marginBottom: 6,
    },
    statusRow: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    statusDot: {
        width: 6,
        height: 6,
        borderRadius: 3,
        backgroundColor: '#9CA3AF',
        marginRight: 6,
    },
    connectedDot: {
        backgroundColor: theme.colors.success,
    },
    userSyncStatus: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        flexShrink: 1,
    },
    cardWrapper: {
        paddingHorizontal: theme.spacing.s,
        marginBottom: theme.spacing.s,
    },
    settingsGroup: {
        backgroundColor: theme.colors.surface,
        borderRadius: theme.radius.sm,
        shadowColor: '#000',
        shadowOpacity: 0.03,
        shadowOffset: { width: 0, height: 1 },
        shadowRadius: 4,
        elevation: 0.5,
        overflow: 'hidden',
    },
    settingsItem: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: theme.spacing.m,
        paddingVertical: 12,
        minHeight: 52,
    },
    settingsItemPressed: {
        backgroundColor: '#F3F4F6',
    },
    settingsItemLeft: {
        flexDirection: 'row',
        alignItems: 'center',
        flex: 1,
    },
    settingsItemIcon: {
        marginRight: theme.spacing.m,
        width: 24,
        textAlign: 'center',
    },
    settingsItemText: {
        fontSize: 16,
        color: theme.colors.text,
    },
    settingsItemRight: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    settingsItemSubtitle: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        marginRight: 4,
        maxWidth: 160,
    },
    separator: {
        height: StyleSheet.hairlineWidth,
        backgroundColor: theme.colors.border,
        marginLeft: theme.spacing.m + 24 + theme.spacing.m,
    },
});
