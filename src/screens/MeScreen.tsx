import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import Icon from '@expo/vector-icons/MaterialIcons';
import { useSettingsStore } from '../store/useSettingsStore';
import { useAssistantStore } from '../store/useAssistantStore';
import { theme } from '../utils/theme';
import { RootStackParamList } from '../types/navigation';

type SettingsScreenNavigationProp = NativeStackNavigationProp<RootStackParamList>;

export const MeScreen = () => {
    const { t } = useTranslation();
    const navigation = useNavigation<SettingsScreenNavigationProp>();

    const {
        webDavConfig,
        cloudProvider,
        markdownTheme,
        fontSize,
    } = useSettingsStore();

    const {
        serverUrl,
        connectionState,
        permissionMode,
    } = useAssistantStore();

    const isConnected = connectionState === 'connected';

    return (
        <ScrollView style={styles.container} contentContainerStyle={styles.contentContainer} keyboardShouldPersistTaps="handled">
            {/* 顶部核心大卡片：绿天服务端 */}
            <TouchableOpacity
                style={styles.heroCard}
                onPress={() => navigation.navigate('AssistantConfig')}
                activeOpacity={0.8}
            >
                <View style={styles.heroContent}>
                    <View style={styles.heroHeaderRow}>
                        <View style={styles.heroTitleContainer}>
                            <View style={styles.heroIconWrap}>
                                <Icon name="dns" size={24} color={theme.colors.primary} />
                            </View>
                            <Text style={styles.heroTitle}>{t('settings.serverTitle', '绿天服务端')}</Text>
                        </View>
                        <View style={[styles.heroStatusTag, isConnected && styles.connectedTag]}>
                            <View style={[styles.statusDot, isConnected && styles.connectedDot]} />
                            <Text style={[styles.heroStatusName, isConnected && styles.connectedName]}>
                                {isConnected
                                    ? t('settings.assistantConnected', '已连接')
                                    : connectionState === 'connecting' || connectionState === 'reconnecting'
                                    ? t('settings.assistantConnecting', '连接中...')
                                    : serverUrl
                                    ? t('settings.assistantDisconnected', '未连接')
                                    : t('settings.notConfigured', '未配置')}
                            </Text>
                        </View>
                    </View>

                    <View style={styles.heroStatusRow}>
                        <Text style={styles.heroStatusText} numberOfLines={1} ellipsizeMode="tail">
                            {serverUrl ? serverUrl : t('settings.serverSubtitle', '配置服务地址与访问令牌以连接服务端')}
                        </Text>
                        <Icon name="chevron-right" size={20} color={theme.colors.textSecondary} />
                    </View>
                </View>
            </TouchableOpacity>

            {/* 分组一：AI 智能体与中枢 */}
            <View style={styles.groupSection}>
                <Text style={styles.groupHeaderTitle}>{t('settings.groups.agent', 'AI 智能体与中枢')}</Text>
                <View style={styles.groupCard}>
                    {/* AI 智能体配置 */}
                    <TouchableOpacity
                        style={styles.rowItem}
                        onPress={() => navigation.navigate('AgentConfig')}
                        activeOpacity={0.7}
                    >
                        <View style={styles.rowLeft}>
                            <Icon name="smart-toy" size={22} color={theme.colors.primary} style={styles.rowIcon} />
                            <Text style={styles.rowTitle}>{t('settings.agentConfig', 'AI 智能体配置')}</Text>
                        </View>
                        <View style={styles.rowRight}>
                            <Text style={styles.rowSubtitle} numberOfLines={1}>
                                {permissionMode === 'danger-full-access'
                                    ? t('assistant.permissionDanger', '完全权限模式')
                                    : t('assistant.permissionWorkspace', '安全工作区模式')}
                            </Text>
                            <Icon name="chevron-right" size={20} color={theme.colors.textSecondary} />
                        </View>
                    </TouchableOpacity>

                    <View style={styles.divider} />

                    {/* 系统工作区文件 */}
                    <TouchableOpacity
                        style={styles.rowItem}
                        onPress={() => navigation.navigate('ServerFileList')}
                        activeOpacity={0.7}
                    >
                        <View style={styles.rowLeft}>
                            <Icon name="folder" size={22} color={theme.colors.textSecondary} style={styles.rowIcon} />
                            <Text style={styles.rowTitle}>{t('tabs.files', '系统文件')}</Text>
                        </View>
                        <View style={styles.rowRight}>
                            <Icon name="chevron-right" size={20} color={theme.colors.textSecondary} />
                        </View>
                    </TouchableOpacity>
                </View>
            </View>

            {/* 分组二：云端存储与网盘 */}
            <View style={styles.groupSection}>
                <Text style={styles.groupHeaderTitle}>{t('settings.groups.cloud', '云端存储与网盘')}</Text>
                <View style={styles.groupCard}>
                    {/* 云端同步 (WebDAV / 坚果云) */}
                    <TouchableOpacity
                        style={styles.rowItem}
                        onPress={() => navigation.navigate('CloudRepoConfig')}
                        activeOpacity={0.7}
                    >
                        <View style={styles.rowLeft}>
                            <Icon name="cloud-sync" size={22} color={theme.colors.primary} style={styles.rowIcon} />
                            <Text style={styles.rowTitle}>{t('settings.cloudSyncWebDav', '云端同步 (WebDAV / 坚果云)')}</Text>
                        </View>
                        <View style={styles.rowRight}>
                            <Text style={styles.rowSubtitle} numberOfLines={1}>
                                {cloudProvider === 'webdav' && webDavConfig.server
                                    ? t('settings.configured', '已配置')
                                    : t('settings.notConfigured', '未配置')}
                            </Text>
                            <Icon name="chevron-right" size={20} color={theme.colors.textSecondary} />
                        </View>
                    </TouchableOpacity>

                    <View style={styles.divider} />

                    {/* 云盘文件 */}
                    <TouchableOpacity
                        style={styles.rowItem}
                        onPress={() => navigation.navigate('CloudFileList')}
                        activeOpacity={0.7}
                    >
                        <View style={styles.rowLeft}>
                            <Icon name="cloud" size={22} color={theme.colors.textSecondary} style={styles.rowIcon} />
                            <Text style={styles.rowTitle}>{t('browser.cloudFiles', '云盘文件')}</Text>
                        </View>
                        <View style={styles.rowRight}>
                            <Icon name="chevron-right" size={20} color={theme.colors.textSecondary} />
                        </View>
                    </TouchableOpacity>
                </View>
            </View>

            {/* 分组三：功能与系统 */}
            <View style={styles.groupSection}>
                <Text style={styles.groupHeaderTitle}>{t('settings.groups.general', '功能与系统')}</Text>
                <View style={styles.groupCard}>
                    {/* 闪念笔记设置 */}
                    <TouchableOpacity
                        style={styles.rowItem}
                        onPress={() => navigation.navigate('FlashNoteConfig')}
                        activeOpacity={0.7}
                    >
                        <View style={styles.rowLeft}>
                            <Icon name="bolt" size={22} color={theme.colors.textSecondary} style={styles.rowIcon} />
                            <Text style={styles.rowTitle}>{t('settings.flashNoteConfig', '闪念笔记设置')}</Text>
                        </View>
                        <View style={styles.rowRight}>
                            <Icon name="chevron-right" size={20} color={theme.colors.textSecondary} />
                        </View>
                    </TouchableOpacity>

                    <View style={styles.divider} />

                    {/* APP 设置（字体大小与 Markdown 样式） */}
                    <TouchableOpacity
                        style={styles.rowItem}
                        onPress={() => navigation.navigate('AppSettings')}
                        activeOpacity={0.7}
                    >
                        <View style={styles.rowLeft}>
                            <Icon name="tune" size={22} color={theme.colors.textSecondary} style={styles.rowIcon} />
                            <Text style={styles.rowTitle}>{t('settings.appSettings', 'APP 设置')}</Text>
                        </View>
                        <View style={styles.rowRight}>
                            <Text style={styles.rowSubtitle} numberOfLines={1}>
                                {`${t(`settings.fontSizesShort.${fontSize}`)} · ${t(`settings.themes.${markdownTheme}`)}`}
                            </Text>
                            <Icon name="chevron-right" size={20} color={theme.colors.textSecondary} />
                        </View>
                    </TouchableOpacity>

                    <View style={styles.divider} />

                    {/* 关于绿天 */}
                    <TouchableOpacity
                        style={styles.rowItem}
                        onPress={() => navigation.navigate('About')}
                        activeOpacity={0.7}
                    >
                        <View style={styles.rowLeft}>
                            <Icon name="info-outline" size={22} color={theme.colors.textSecondary} style={styles.rowIcon} />
                            <Text style={styles.rowTitle}>{t('about.title', '关于绿天')}</Text>
                        </View>
                        <View style={styles.rowRight}>
                            <Icon name="chevron-right" size={20} color={theme.colors.textSecondary} />
                        </View>
                    </TouchableOpacity>
                </View>
            </View>
        </ScrollView>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: theme.colors.background,
    },
    contentContainer: {
        paddingTop: theme.spacing.md,
        paddingBottom: theme.spacing.xl,
        paddingHorizontal: theme.spacing.md,
    },
    // 顶部 Hero 大卡片
    heroCard: {
        backgroundColor: theme.colors.surface,
        borderRadius: theme.radius.sm,
        padding: theme.spacing.md,
        marginBottom: theme.spacing.md,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.04,
        shadowRadius: 4,
        elevation: 1,
        borderWidth: 1,
        borderColor: theme.colors.border,
    },
    heroContent: {
        flexDirection: 'column',
    },
    heroHeaderRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: theme.spacing.md,
    },
    heroTitleContainer: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    heroIconWrap: {
        width: 36,
        height: 36,
        borderRadius: 18,
        backgroundColor: theme.colors.primaryLight,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: theme.spacing.sm,
    },
    heroTitle: {
        fontSize: 17,
        fontWeight: 'bold',
        color: theme.colors.text,
    },
    heroStatusTag: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#F3F4F6',
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 12,
    },
    statusDot: {
        width: 6,
        height: 6,
        borderRadius: 3,
        backgroundColor: '#9CA3AF',
        marginRight: 5,
    },
    connectedTag: {
        backgroundColor: theme.colors.successBg,
    },
    connectedDot: {
        backgroundColor: theme.colors.success,
    },
    heroStatusName: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        fontWeight: '600',
    },
    connectedName: {
        color: theme.colors.successText,
    },
    heroStatusRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
    },
    heroStatusText: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        flex: 1,
        marginRight: 8,
    },
    // 分组容器
    groupSection: {
        marginBottom: theme.spacing.md,
    },
    groupHeaderTitle: {
        fontSize: 13,
        fontWeight: '600',
        color: theme.colors.textSecondary,
        marginBottom: 6,
        marginLeft: 4,
    },
    groupCard: {
        backgroundColor: theme.colors.surface,
        borderRadius: theme.radius.sm,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.03,
        shadowRadius: 3,
        elevation: 0.5,
        overflow: 'hidden',
    },
    rowItem: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingVertical: 14,
        paddingHorizontal: theme.spacing.md,
    },
    rowLeft: {
        flexDirection: 'row',
        alignItems: 'center',
        flex: 1,
    },
    rowIcon: {
        marginRight: 12,
        width: 24,
        textAlign: 'center',
    },
    rowTitle: {
        fontSize: 15,
        color: theme.colors.text,
    },
    rowRight: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    rowSubtitle: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        marginRight: 4,
        maxWidth: 140,
    },
    divider: {
        height: StyleSheet.hairlineWidth,
        backgroundColor: theme.colors.divider,
        marginLeft: 52, // Indent to align with text label
    },
});
