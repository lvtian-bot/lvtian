import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { useTranslation } from 'react-i18next';
import Icon from '@expo/vector-icons/MaterialIcons';
import { theme } from '../utils/theme';
import { useSettingsStore, FontSizePreference } from '../store/useSettingsStore';
import { markdownThemes, MarkdownThemeKey } from '../utils/markdownThemes';
import { getFontSizeMetrics } from '../utils/fontSize';

export const AppSettingsScreen = () => {
    const { t } = useTranslation();
    const { fontSize, setFontSize, markdownTheme, setMarkdownTheme } = useSettingsStore();

    const themes = Object.keys(markdownThemes) as MarkdownThemeKey[];
    const metrics = getFontSizeMetrics(fontSize);

    const fontOptions: Array<{ key: FontSizePreference; label: string; desc: string }> = [
        {
            key: 'small',
            label: t('settings.fontSizesShort.small', '小'),
            desc: t('settings.fontSizes.small', '小 (紧凑)'),
        },
        {
            key: 'standard',
            label: t('settings.fontSizesShort.standard', '默认'),
            desc: t('settings.fontSizes.standard', '默认 (舒适)'),
        },
        {
            key: 'large',
            label: t('settings.fontSizesShort.large', '大'),
            desc: t('settings.fontSizes.large', '大 (清晰)'),
        },
    ];

    return (
        <ScrollView style={styles.container} contentContainerStyle={styles.content}>
            {/* 字体大小设置 */}
            <View style={styles.section}>
                <View style={styles.sectionHeader}>
                    <Icon name="format-size" size={20} color={theme.colors.primary} style={styles.sectionIcon} />
                    <Text style={styles.sectionTitle}>{t('settings.fontSize', '字体大小')}</Text>
                </View>

                {/* 档位选择器 */}
                <View style={styles.segmentContainer}>
                    {fontOptions.map((opt) => {
                        const isSelected = fontSize === opt.key;
                        return (
                            <TouchableOpacity
                                key={opt.key}
                                style={[styles.segmentButton, isSelected && styles.segmentButtonActive]}
                                onPress={() => setFontSize(opt.key)}
                                activeOpacity={0.7}
                            >
                                <Text style={[styles.segmentText, isSelected && styles.segmentTextActive]}>
                                    {opt.label}
                                </Text>
                            </TouchableOpacity>
                        );
                    })}
                </View>

                {/* 实时效果预览卡片 */}
                <View style={styles.previewCard}>
                    <Text style={styles.previewCaption}>
                        {t('settings.current', '当前:')} {t(`settings.fontSizes.${fontSize}`)}
                    </Text>
                    <View style={styles.previewBubble}>
                        <Text style={[styles.previewHeading, { fontSize: metrics.chatHeading2 }]}>
                            预览示例文档
                        </Text>
                        <Text
                            style={[
                                styles.previewBody,
                                {
                                    fontSize: metrics.chatBody,
                                    lineHeight: metrics.chatLineHeight,
                                },
                            ]}
                        >
                            绿天 AI 代理已为您连接。调整字体大小将实时应用于 AI 聊天对话、闪念时间线及 Markdown 笔记预览中。
                        </Text>
                    </View>
                </View>
            </View>

            {/* Markdown 样式风格 */}
            <View style={styles.section}>
                <View style={styles.sectionHeader}>
                    <Icon name="palette" size={20} color={theme.colors.primary} style={styles.sectionIcon} />
                    <Text style={styles.sectionTitle}>{t('settings.markdownStyle', 'Markdown样式')}</Text>
                </View>

                <View style={styles.themeList}>
                    {themes.map((item, index) => {
                        const isSelected = markdownTheme === item;
                        const isLast = index === themes.length - 1;
                        return (
                            <TouchableOpacity
                                key={item}
                                style={[styles.themeItem, isLast && styles.themeItemLast]}
                                onPress={() => setMarkdownTheme(item)}
                                activeOpacity={0.7}
                            >
                                <Text style={[styles.themeItemText, isSelected && styles.themeItemTextActive]}>
                                    {t(`settings.themes.${item}`)}
                                </Text>
                                {isSelected ? (
                                    <Icon name="check" size={20} color={theme.colors.primary} />
                                ) : (
                                    <View style={styles.radioPlaceholder} />
                                )}
                            </TouchableOpacity>
                        );
                    })}
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
    content: {
        padding: theme.spacing.md,
    },
    section: {
        backgroundColor: theme.colors.surface,
        borderRadius: theme.radius.sm,
        padding: theme.spacing.md,
        marginBottom: theme.spacing.md,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.03,
        shadowRadius: 4,
        elevation: 0.5,
    },
    sectionHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: theme.spacing.md,
    },
    sectionIcon: {
        marginRight: theme.spacing.sm,
    },
    sectionTitle: {
        fontSize: 16,
        fontWeight: 'bold',
        color: theme.colors.text,
    },
    segmentContainer: {
        flexDirection: 'row',
        backgroundColor: theme.colors.inputBg,
        borderRadius: theme.radius.sm,
        padding: 4,
        marginBottom: theme.spacing.md,
    },
    segmentButton: {
        flex: 1,
        paddingVertical: 10,
        alignItems: 'center',
        borderRadius: 6,
    },
    segmentButtonActive: {
        backgroundColor: theme.colors.surface,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.08,
        shadowRadius: 2,
        elevation: 1,
    },
    segmentText: {
        fontSize: 15,
        color: theme.colors.textSecondary,
        fontWeight: '500',
    },
    segmentTextActive: {
        color: theme.colors.primary,
        fontWeight: 'bold',
    },
    previewCard: {
        backgroundColor: theme.colors.background,
        borderRadius: theme.radius.sm,
        padding: theme.spacing.md,
        borderWidth: 1,
        borderColor: theme.colors.border,
    },
    previewCaption: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        marginBottom: theme.spacing.sm,
    },
    previewBubble: {
        backgroundColor: theme.colors.surface,
        borderRadius: theme.radius.sm,
        padding: theme.spacing.md,
        borderLeftWidth: 3,
        borderLeftColor: theme.colors.primary,
    },
    previewHeading: {
        fontWeight: '700',
        color: theme.colors.text,
        marginBottom: 6,
    },
    previewBody: {
        color: theme.colors.text,
    },
    themeList: {
        backgroundColor: theme.colors.background,
        borderRadius: theme.radius.sm,
        overflow: 'hidden',
    },
    themeItem: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingVertical: 14,
        paddingHorizontal: theme.spacing.md,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
    },
    themeItemLast: {
        borderBottomWidth: 0,
    },
    themeItemText: {
        fontSize: 15,
        color: theme.colors.text,
    },
    themeItemTextActive: {
        color: theme.colors.primary,
        fontWeight: '600',
    },
    radioPlaceholder: {
        width: 20,
        height: 20,
    },
});
