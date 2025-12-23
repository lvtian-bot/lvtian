// 更新主设置页面：仿微信设计 + 独立卡片优化
import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Modal, FlatList, Pressable } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSettingsStore } from '../store/useSettingsStore';
import { theme } from '../utils/theme';
import { markdownThemes, MarkdownThemeKey } from '../utils/markdownThemes';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../types/navigation';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';

type SettingsScreenNavigationProp = NativeStackNavigationProp<RootStackParamList>;

export const SettingsScreen = () => {
    const { t } = useTranslation();
    const navigation = useNavigation<SettingsScreenNavigationProp>();

    // Config Store
    const {
        cosConfig,
        webDavConfig,
        cloudProvider,
        markdownTheme,
        setMarkdownTheme
    } = useSettingsStore();

    // Markdown主题选择模态框
    const [themeModalVisible, setThemeModalVisible] = useState(false);
    const themes = Object.keys(markdownThemes) as MarkdownThemeKey[];

    return (
        <ScrollView style={styles.container} keyboardShouldPersistTaps="handled">

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
                                {cloudProvider === 'tencent' ? t('settings.cloudProvider.tencentCOS') :
                                    cloudProvider === 'webdav' ? 'WebDAV' : t('settings.notConfigured')}
                            </Text>
                        </View>
                    </View>

                    <View style={styles.cardStatusRow}>
                        <Text style={styles.cardStatusText} numberOfLines={1} ellipsizeMode="tail">
                            {cloudProvider === 'tencent' && cosConfig.bucket && cosConfig.region
                                ? `${t('settings.configured')} · ${cosConfig.bucket}`
                                : cloudProvider === 'webdav' && webDavConfig.server
                                    ? `${t('settings.configured')} · ${webDavConfig.server}`
                                    : t('settings.cloudProvider.subtitle')}
                        </Text>
                        <Icon name="chevron-right" size={20} color={theme.colors.textSecondary} />
                    </View>
                </View>
            </TouchableOpacity>

            {/* 闪念笔记配置 - 独立小卡片 */}
            <TouchableOpacity
                style={styles.smallCard}
                onPress={() => navigation.navigate('FlashNoteConfig')}
                activeOpacity={0.8}
            >
                <View style={styles.smallCardLeft}>
                    <Icon name="flash-outline" size={22} color={theme.colors.textSecondary} style={styles.smallCardIcon} />
                    <Text style={styles.smallCardTitle}>{t('settings.flashNoteConfig')}</Text>
                </View>
                <Icon name="chevron-right" size={20} color={theme.colors.textSecondary} />
            </TouchableOpacity>

            {/* AI Settings - Independent Small Card */}
            <TouchableOpacity
                style={styles.smallCard}
                onPress={() => navigation.navigate('AIConfig')}
                activeOpacity={0.8}
            >
                <View style={styles.smallCardLeft}>
                    <Icon name="robot-outline" size={22} color={theme.colors.textSecondary} style={styles.smallCardIcon} />
                    <Text style={styles.smallCardTitle}>{t('settings.aiConfig')}</Text>
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
                    <Icon name="palette-outline" size={22} color={theme.colors.textSecondary} style={styles.smallCardIcon} />
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
                    <Icon name="trash-can-outline" size={22} color={theme.colors.textSecondary} style={styles.smallCardIcon} />
                    <Text style={styles.smallCardTitle}>{t('settings.cacheManager')}</Text>
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
    },
    // 云端存储卡片样式
    card: {
        backgroundColor: theme.colors.surface,
        marginHorizontal: theme.spacing.m,
        marginBottom: theme.spacing.l,
        borderRadius: 12,
        padding: theme.spacing.l,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.05,
        shadowRadius: 4,
        elevation: 2,
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
        marginHorizontal: theme.spacing.m,
        marginBottom: theme.spacing.s,
        borderRadius: 12,
        paddingVertical: 16,
        paddingHorizontal: theme.spacing.m,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.03,
        shadowRadius: 2,
        elevation: 1,
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
