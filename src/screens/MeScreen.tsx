// 更新主设置页面：仿微信设计 + 独立卡片优化
import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Modal, FlatList, Pressable } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSettingsStore } from '../store/useSettingsStore';
import { useAssistantStore } from '../store/useAssistantStore';
import { theme } from '../utils/theme';
import { markdownThemes, MarkdownThemeKey } from '../utils/markdownThemes';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../types/navigation';
import Icon from '@expo/vector-icons/MaterialIcons';

type SettingsScreenNavigationProp = NativeStackNavigationProp<RootStackParamList>;

export const MeScreen = () => {
    const { t } = useTranslation();
    const navigation = useNavigation<SettingsScreenNavigationProp>();

    // Config Store - include hydration status
    const {
        webDavConfig,
        cloudProvider,
        markdownTheme,
        setMarkdownTheme
    } = useSettingsStore();

    const {
        serverUrl,
        connectionState,
    } = useAssistantStore();

    // Markdown主题选择模态框
    const [themeModalVisible, setThemeModalVisible] = useState(false);
    const themes = Object.keys(markdownThemes) as MarkdownThemeKey[];

    return (
        <ScrollView style={styles.container} keyboardShouldPersistTaps="handled">

            {/* 绿天个人助理服务配置卡片 */}
            <TouchableOpacity
                style={styles.card}
                onPress={() => navigation.navigate('AssistantConfig')}
                activeOpacity={0.8}
            >
                <View style={styles.cardContent}>
                    <View style={styles.cardHeaderRow}>
                        <View style={styles.cardTitleContainer}>
                            <Icon name="smart-toy" size={28} color={theme.colors.primary} style={styles.cardIcon} />
                            <Text style={styles.cardTitle}>{t('settings.assistantTitle', '绿天助理服务')}</Text>
                        </View>
                        <View style={[styles.cardServiceTag, connectionState === 'connected' && styles.connectedTag]}>
                            <Text style={[styles.cardServiceName, connectionState === 'connected' && styles.connectedName]}>
                                {connectionState === 'connected'
                                    ? t('settings.assistantConnected', '已连接')
                                    : connectionState === 'connecting' || connectionState === 'reconnecting'
                                    ? t('settings.assistantConnecting', '连接中...')
                                    : serverUrl
                                    ? t('settings.assistantDisconnected', '未连接')
                                    : t('settings.notConfigured', '未配置')}
                            </Text>
                        </View>
                    </View>

                    <View style={styles.cardStatusRow}>
                        <Text style={styles.cardStatusText} numberOfLines={1} ellipsizeMode="tail">
                            {serverUrl ? serverUrl : t('settings.assistantSubtitle', '配置服务地址与访问令牌以连接助理')}
                        </Text>
                        <Icon name="chevron-right" size={20} color={theme.colors.textSecondary} />
                    </View>
                </View>
            </TouchableOpacity>

            {/* Cloud Configuration Card */}
            <TouchableOpacity
                style={styles.card}
                onPress={() => navigation.navigate('CloudRepoConfig')}
                activeOpacity={0.8}
            >
                <View style={styles.cardContent}>
                    <View style={styles.cardHeaderRow}>
                        <View style={styles.cardTitleContainer}>
                            <Icon name="cloud-sync" size={28} color={theme.colors.primary} style={styles.cardIcon} />
                            <Text style={styles.cardTitle}>{t('settings.cloudRepoConfig')}</Text>
                        </View>
                        <View style={styles.cardServiceTag}>
                            <Text style={styles.cardServiceName}>
                                {cloudProvider === 'webdav' ? 'WebDAV' : t('settings.notConfigured')}
                            </Text>
                        </View>
                    </View>

                    <View style={styles.cardStatusRow}>
                        <Text style={styles.cardStatusText} numberOfLines={1} ellipsizeMode="tail">
                            {cloudProvider === 'webdav' && webDavConfig.server
                                ? `${t('settings.configured')} · ${webDavConfig.server}`
                                : t('settings.cloudProvider.subtitle')}
                        </Text>
                        <Icon name="chevron-right" size={20} color={theme.colors.textSecondary} />
                    </View>
                </View>
            </TouchableOpacity>

            {/* 文件入口 - 系统文件 */}
            <TouchableOpacity
                style={styles.smallCard}
                onPress={() => navigation.navigate('ServerFileList')}
                activeOpacity={0.8}
            >
                <View style={styles.smallCardLeft}>
                    <Icon name="folder" size={22} color={theme.colors.textSecondary} style={styles.smallCardIcon} />
                    <Text style={styles.smallCardTitle}>{t('tabs.files')}</Text>
                </View>
                <Icon name="chevron-right" size={20} color={theme.colors.textSecondary} />
            </TouchableOpacity>

            {/* 文件入口 - 云盘文件 */}
            <TouchableOpacity
                style={styles.smallCard}
                onPress={() => navigation.navigate('CloudFileList')}
                activeOpacity={0.8}
            >
                <View style={styles.smallCardLeft}>
                    <Icon name="cloud" size={22} color={theme.colors.textSecondary} style={styles.smallCardIcon} />
                    <Text style={styles.smallCardTitle}>{t('browser.cloudFiles', { defaultValue: '云盘文件' })}</Text>
                </View>
                <Icon name="chevron-right" size={20} color={theme.colors.textSecondary} />
            </TouchableOpacity>

            {/* 闪念笔记配置 - 独立小卡片 */}
            <TouchableOpacity
                style={styles.smallCard}
                onPress={() => navigation.navigate('FlashNoteConfig')}
                activeOpacity={0.8}
            >
                <View style={styles.smallCardLeft}>
                    <Icon name="bolt" size={22} color={theme.colors.textSecondary} style={styles.smallCardIcon} />
                    <Text style={styles.smallCardTitle}>{t('settings.flashNoteConfig')}</Text>
                </View>
                <Icon name="chevron-right" size={20} color={theme.colors.textSecondary} />
            </TouchableOpacity>

            {/* Markdown主题设置 - 独立小卡片 */}
            <TouchableOpacity
                style={styles.smallCard}
                onPress={() => setThemeModalVisible(true)}
                activeOpacity={0.8}
            >
                <View style={styles.smallCardLeft}>
                    <Icon name="palette" size={22} color={theme.colors.textSecondary} style={styles.smallCardIcon} />
                    <Text style={styles.smallCardTitle}>{t('settings.markdownStyle')}</Text>
                </View>
                <View style={styles.smallCardRight}>
                    <Text style={styles.smallCardSubtitle}>{t(`settings.themes.${markdownTheme}`)}</Text>
                    <Icon name="chevron-right" size={20} color={theme.colors.textSecondary} />
                </View>
            </TouchableOpacity>

            {/* 缓存管理 - 独立小卡片 */}
            <TouchableOpacity
                style={styles.smallCard}
                onPress={() => navigation.navigate('CacheManager')}
                activeOpacity={0.8}
            >
                <View style={styles.smallCardLeft}>
                    <Icon name="delete-outline" size={22} color={theme.colors.textSecondary} style={styles.smallCardIcon} />
                    <Text style={styles.smallCardTitle}>{t('settings.cacheManager')}</Text>
                </View>
                <Icon name="chevron-right" size={20} color={theme.colors.textSecondary} />
            </TouchableOpacity>

            {/* 关于 - 独立小卡片 */}
            <TouchableOpacity
                style={styles.smallCard}
                onPress={() => navigation.navigate('About')}
                activeOpacity={0.8}
            >
                <View style={styles.smallCardLeft}>
                    <Icon name="info-outline" size={22} color={theme.colors.textSecondary} style={styles.smallCardIcon} />
                    <Text style={styles.smallCardTitle}>{t('about.title')}</Text>
                </View>
                <Icon name="chevron-right" size={20} color={theme.colors.textSecondary} />
            </TouchableOpacity>

            {/* Markdown主题选择模态框 */}
            <Modal
                visible={themeModalVisible}
                transparent
                animationType="fade"
                onRequestClose={() => setThemeModalVisible(false)}
            >
                <TouchableOpacity
                    style={styles.modalOverlay}
                    activeOpacity={1}
                    onPress={() => setThemeModalVisible(false)}
                >
                    <Pressable style={styles.modalContent} onPress={() => { }}>
                        <Text style={styles.modalTitle}>{t('settings.markdownStyle')}</Text>
                        <FlatList
                            data={themes}
                            renderItem={({ item }) => (
                                <TouchableOpacity
                                    style={[
                                        styles.themeItem,
                                        markdownTheme === item && styles.themeItemActive
                                    ]}
                                    onPress={() => {
                                        setMarkdownTheme(item);
                                        setThemeModalVisible(false);
                                    }}
                                >
                                    <Text style={[
                                        styles.themeItemText,
                                        markdownTheme === item && styles.themeItemTextActive
                                    ]}>
                                        {t(`settings.themes.${item}`)}
                                    </Text>
                                    {markdownTheme === item && (
                                        <Icon name="check" size={20} color={theme.colors.primary} />
                                    )}
                                </TouchableOpacity>
                            )}
                            keyExtractor={item => item}
                            style={styles.themeList}
                        />
                        <TouchableOpacity
                            style={styles.closeButton}
                            onPress={() => setThemeModalVisible(false)}
                        >
                            <Text style={styles.closeButtonText}>{t('common.close')}</Text>
                        </TouchableOpacity>
                    </Pressable>
                </TouchableOpacity>
            </Modal>

        </ScrollView>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: theme.colors.background,
        paddingTop: theme.spacing.m,
        paddingHorizontal: theme.spacing.s, // Add padding to container instead of margins on cards
    },
    // 云端存储卡片样式
    card: {
        backgroundColor: theme.colors.surface,
        marginBottom: theme.spacing.s, // Reduced from l to s
        borderRadius: theme.radius.sm, // Reduced from 12 to 8 (radius.sm)
        padding: theme.spacing.m, // Reduced from l to m
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 }, // height 2 -> 1
        shadowOpacity: 0.03, // 0.05 -> 0.03
        shadowRadius: 4,
        elevation: 0.5, // 2 -> 0.5
    },
    cardContent: {
        flexDirection: 'column',
    },
    cardHeaderRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: theme.spacing.m,
    },
    cardTitleContainer: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    cardIcon: {
        marginRight: theme.spacing.s,
    },
    cardTitle: {
        fontSize: 18,
        fontWeight: 'bold',
        color: theme.colors.text,
    },
    cardServiceTag: {
        backgroundColor: theme.colors.primaryLight,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 4,
    },
    connectedTag: {
        backgroundColor: theme.colors.successBg,
    },
    connectedName: {
        color: theme.colors.successText,
    },
    cardServiceName: {
        fontSize: 12,
        color: theme.colors.primary,
        fontWeight: '600',
    },
    cardStatusRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
    },
    cardStatusText: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        flex: 1,
        marginRight: 8,
    },
    // 独立小卡片样式
    smallCard: {
        backgroundColor: theme.colors.surface,
        marginBottom: theme.spacing.s,
        borderRadius: theme.radius.sm, // 12 -> 8
        paddingVertical: 12, // Reduced from 16 to 12
        paddingHorizontal: theme.spacing.m,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.03,
        shadowRadius: 4, // 2 -> 4
        elevation: 0.5, // 1 -> 0.5
    },
    smallCardLeft: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    smallCardIcon: {
        marginRight: theme.spacing.m,
        width: 24,
        textAlign: 'center',
    },
    smallCardTitle: {
        fontSize: 16,
        color: theme.colors.text,
    },
    smallCardRight: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    smallCardSubtitle: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        marginRight: 4,
    },
    // Modal Styles
    modalOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        justifyContent: 'center',
        alignItems: 'center',
    },
    modalContent: {
        width: '80%',
        backgroundColor: theme.colors.white,
        borderRadius: 16,
        padding: theme.spacing.l,
        maxHeight: '60%',
        elevation: 5,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.25,
        shadowRadius: 4,
    },
    modalTitle: {
        fontSize: 20,
        fontWeight: 'bold',
        marginBottom: theme.spacing.l,
        textAlign: 'center',
        color: theme.colors.text,
    },
    themeList: {
        flexGrow: 0,
    },
    themeItem: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingVertical: theme.spacing.m,
        paddingHorizontal: theme.spacing.s,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
    },
    themeItemActive: {
        backgroundColor: theme.colors.primaryLight + '40',
        borderRadius: 8,
        borderBottomWidth: 0,
    },
    themeItemText: {
        fontSize: 16,
        color: theme.colors.text,
    },
    themeItemTextActive: {
        color: theme.colors.primary,
        fontWeight: 'bold',
    },
    closeButton: {
        marginTop: theme.spacing.l,
        backgroundColor: theme.colors.primary,
        paddingVertical: theme.spacing.m,
        borderRadius: 12,
        alignItems: 'center',
    },
    closeButtonText: {
        color: theme.colors.white,
        fontSize: 16,
        fontWeight: 'bold',
    },
});
