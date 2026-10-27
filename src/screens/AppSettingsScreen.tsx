import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { useTranslation } from 'react-i18next';
import { theme } from '../utils/theme';
import { useSettingsStore, type FontSizePreference } from '../store/useSettingsStore';
import { markdownThemes, type MarkdownThemeKey } from '../utils/markdownThemes';
import { getFontSizeMetrics } from '../utils/fontSize';
import {
    SettingsChoice,
    SettingsGroup,
    SettingsGroupLabel,
    SettingsRow,
    SettingsSheet,
} from '../components/settings';

export const AppSettingsScreen = () => {
    const { t } = useTranslation();
    const { fontSize, setFontSize, markdownTheme, setMarkdownTheme } = useSettingsStore();

    const [openSheet, setOpenSheet] = useState<'font' | 'theme' | null>(null);

    const themes = Object.keys(markdownThemes) as MarkdownThemeKey[];
    const metrics = getFontSizeMetrics(fontSize);

    const fontOptions: Array<{ key: FontSizePreference; title: string; desc: string }> = [
        {
            key: 'small',
            title: t('settings.fontSizesShort.small', '小'),
            desc: t('settings.fontSizeSmallDesc', '紧凑，同屏显示更多内容'),
        },
        {
            key: 'standard',
            title: t('settings.fontSizesShort.standard', '默认'),
            desc: t('settings.fontSizeStandardDesc', '舒适平衡'),
        },
        {
            key: 'large',
            title: t('settings.fontSizesShort.large', '大'),
            desc: t('settings.fontSizeLargeDesc', '清晰，长时间阅读更轻松'),
        },
    ];

    return (
        <View style={styles.container}>
            <ScrollView contentContainerStyle={styles.content}>
                <SettingsGroupLabel>{t('settings.readingGroup', '阅读与显示')}</SettingsGroupLabel>
                <SettingsGroup>
                    <SettingsRow
                        icon="format-size"
                        title={t('settings.fontSize', '字体大小')}
                        subtitle={t('settings.fontSizeSubtitle', '聊天、闪念与笔记预览')}
                        value={t(`settings.fontSizesShort.${fontSize}`)}
                        onPress={() => setOpenSheet('font')}
                    />
                    <SettingsRow
                        icon="palette"
                        title={t('settings.markdownStyle', 'Markdown 样式')}
                        value={t(`settings.themes.${markdownTheme}`)}
                        onPress={() => setOpenSheet('theme')}
                        last
                    />
                </SettingsGroup>

                <Text style={styles.note}>{t('settings.instantEffectNote', '以上设置即时生效，无需保存。')}</Text>
            </ScrollView>

            <SettingsSheet
                visible={openSheet === 'font'}
                title={t('settings.fontSize', '字体大小')}
                onClose={() => setOpenSheet(null)}
            >
                <View style={styles.choices}>
                    {fontOptions.map((opt) => (
                        <SettingsChoice
                            key={opt.key}
                            title={opt.title}
                            desc={opt.desc}
                            selected={fontSize === opt.key}
                            onPress={() => setFontSize(opt.key)}
                        />
                    ))}
                </View>
                <View style={styles.preview}>
                    <View style={styles.previewDoc}>
                        <Text style={[styles.previewHeading, { fontSize: metrics.chatHeading2 }]}>
                            {t('settings.previewHeading', '预览示例文档')}
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
                            {t('settings.previewBody', '绿天 AI 代理已为您连接。调整字体大小将实时应用于 AI 聊天对话、闪念时间线及 Markdown 笔记预览中。')}
                        </Text>
                    </View>
                </View>
            </SettingsSheet>

            <SettingsSheet
                visible={openSheet === 'theme'}
                title={t('settings.markdownStyle', 'Markdown 样式')}
                onClose={() => setOpenSheet(null)}
            >
                <View style={styles.choices}>
                    {themes.map((item) => (
                        <SettingsChoice
                            key={item}
                            title={t(`settings.themes.${item}`)}
                            selected={markdownTheme === item}
                            onPress={() => setMarkdownTheme(item)}
                        />
                    ))}
                </View>
            </SettingsSheet>
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: theme.colors.background,
    },
    content: {
        padding: 16,
    },
    choices: {
        paddingHorizontal: 12,
        paddingBottom: 8,
    },
    preview: {
        marginHorizontal: 20,
        marginBottom: 8,
        backgroundColor: '#F7F8FA',
        borderWidth: 1,
        borderColor: '#ECEDEF',
        borderRadius: 12,
        padding: 12,
    },
    previewDoc: {
        backgroundColor: theme.colors.surface,
        borderLeftWidth: 3,
        borderLeftColor: theme.colors.primary,
        borderRadius: 8,
        paddingHorizontal: 13,
        paddingVertical: 11,
    },
    previewHeading: {
        fontWeight: '700',
        color: theme.colors.text,
        marginBottom: 6,
    },
    previewBody: {
        color: '#374151',
    },
    note: {
        fontSize: 13,
        color: '#9AA3B2',
        lineHeight: 18,
        textAlign: 'center',
        marginTop: 14,
        marginHorizontal: 8,
    },
});
