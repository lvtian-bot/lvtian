// 直接复用原SettingsScreen的闪念笔记配置部分
// 仅修改路径和文件名的合并逻辑
import React, { useState } from 'react';
import { View, Text, StyleSheet, TextInput, TouchableOpacity, Alert, ActivityIndicator, ScrollView, KeyboardAvoidingView, Platform } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSettingsStore } from '../store/useSettingsStore';
import { theme } from '../utils/theme';
import { normalizePath } from '../utils/pathUtils';
import { flashNoteService } from '../services/FlashNoteService';

export const FlashNoteConfigScreen = () => {
    const { t } = useTranslation();
    const { flashNoteConfig, setFlashNoteConfig } = useSettingsStore();

    // 合并路径和文件名输入框
    const [fullPath, setFullPath] = useState(() => {
        const path = flashNoteConfig.path ? `${flashNoteConfig.path}/${flashNoteConfig.filename}` : flashNoteConfig.filename;
        return normalizePath(path);
    });
    const [flashNoteSuffix, setFlashNoteSuffix] = useState(flashNoteConfig.suffix);
    
    // 历史归档配置
    const [historyPattern, setHistoryPattern] = useState(flashNoteConfig.historyPattern || 'none');
    const [historyFolderPath, setHistoryFolderPath] = useState(flashNoteConfig.historyFolderPath || '');

    // 统一保存状态
    const [isSyncingMain, setIsSyncingMain] = useState(false);
    const [isSavingSuffix, setIsSavingSuffix] = useState(false); // Fixed: Added state
    const [isSyncingHistory, setIsSyncingHistory] = useState(false);

    // 主文件配置保存逻辑
    const handleSaveMainConfig = async () => {
        if (!fullPath.trim()) {
            Alert.alert(t('settings.failure'), t('settings.error.notEmpty'));
            return;
        }

        setIsSyncingMain(true);

        try {
            // 1. 处理路径
            const lastSlashIndex = fullPath.lastIndexOf('/');
            const path = lastSlashIndex > 0 ? fullPath.substring(0, lastSlashIndex) : '';
            const filename = lastSlashIndex > 0 ? fullPath.substring(lastSlashIndex + 1) : fullPath;

            // 保存配置
            setFlashNoteConfig({
                ...flashNoteConfig,
                path,
                filename,
            });

            // 同步主文件
            await flashNoteService.syncMainFile();

            Alert.alert(t('settings.success'), t('settings.success'));
        } catch (error) {
            console.error('Failed to save main config:', error);
            Alert.alert(t('settings.failure'), t('flashNoteConfigScreen.saveSyncFailed'));
        } finally {
            setIsSyncingMain(false);
        }
    };

    // 后缀配置保存逻辑
    const handleSaveSuffixConfig = () => {
        setIsSavingSuffix(true);
        try {
            setFlashNoteConfig({ ...flashNoteConfig, suffix: flashNoteSuffix });
            Alert.alert(t('settings.success'), t('settings.success'));
        } catch (error) {
            Alert.alert(t('settings.failure'), t('flashNoteConfigScreen.saveFailed'));
        } finally {
            setIsSavingSuffix(false);
        }
    };

    // 历史配置保存逻辑
    const handleSaveHistoryConfig = async () => {
        setIsSyncingHistory(true);
        try {
             const normalizedHistoryPath = historyFolderPath ? normalizePath(historyFolderPath) : '';
             
             setFlashNoteConfig({
                ...flashNoteConfig,
                historyPattern,
                historyFolderPath: normalizedHistoryPath
            });
            
            await flashNoteService.syncHistoryFiles();
            
            Alert.alert(t('settings.success'), t('flashNoteConfigScreen.configSavedHistorySynced'));
        } catch (error) {
             console.error('Failed to sync history:', error);
             Alert.alert(t('settings.failure'), t('flashNoteConfigScreen.saveSuccessHistorySyncFailed'));
        } finally {
            setIsSyncingHistory(false);
        }
    };

    const handleSelectPresetSuffix = (suffix: string) => {
        setFlashNoteSuffix(suffix);
    };

    const SectionHeader = ({ title }: { title: string }) => (
        <View style={styles.sectionHeader}>
            <Text style={styles.sectionHeaderText}>{title}</Text>
        </View>
    );

    return (
        <KeyboardAvoidingView 
            style={styles.container} 
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            keyboardVerticalOffset={Platform.OS === 'ios' ? 64 : 0}
        >
            <ScrollView contentContainerStyle={styles.scrollContent}>
                
                {/* Section 1: Main File Configuration */}
                <SectionHeader title={t('flashNoteConfigScreen.mainFileConfig')} />
                <View style={styles.card}>
                    <Text style={styles.label}>{t('settings.flashNotePath')} + {t('settings.flashNoteFilename')}</Text>
                    <Text style={styles.description}>{t('flashNoteConfigScreen.mergePathExample')}</Text>
                    <TextInput
                        style={styles.input}
                        value={fullPath}
                        onChangeText={setFullPath}
                        placeholder="notes/flash_notes.md"
                        autoCapitalize="none"
                        autoCorrect={false}
                    />
                    <TouchableOpacity
                        style={styles.saveButton}
                        onPress={handleSaveMainConfig}
                        disabled={isSyncingMain}
                    >
                        {isSyncingMain ? (
                            <ActivityIndicator color={theme.colors.white} />
                        ) : (
                            <Text style={styles.saveButtonText}>{t('flashNoteConfigScreen.saveSyncMainFile')}</Text>
                        )}
                    </TouchableOpacity>
                </View>

                {/* Section 2: Suffix Configuration */}
                <SectionHeader title={t('flashNoteConfigScreen.formatSuffix')} />
                <View style={styles.card}>
                    <Text style={styles.label}>{t('settings.flashNoteSuffix')}</Text>
                    <Text style={styles.description}>{t('settings.flashNoteSuffixDesc')}</Text>

                    <View style={styles.chipContainer}>
                        {[
                            { label: t('settings.suffixPresets.none'), value: '' },
                            { label: `\\n> ${t('flashNoteConfigScreen.reference')}`, value: '\n>' },
                            { label: `\\n> ${t('flashNoteConfigScreen.referenceWithSpace')}`, value: '\n> ' }
                        ].map((preset) => (
                            <TouchableOpacity
                                key={preset.label}
                                style={[styles.chip, flashNoteSuffix === preset.value && styles.chipActive]}
                                onPress={() => handleSelectPresetSuffix(preset.value)}
                            >
                                <Text style={[styles.chipText, flashNoteSuffix === preset.value && styles.chipTextActive]}>
                                    {preset.label}
                                </Text>
                            </TouchableOpacity>
                        ))}
                    </View>

                    <Text style={[styles.label, { marginTop: theme.spacing.m }]}>{t('settings.customSuffix')}</Text>
                    <TextInput
                        style={styles.input}
                        value={flashNoteSuffix}
                        onChangeText={setFlashNoteSuffix}
                        placeholder="\n> "
                        autoCapitalize="none"
                        autoCorrect={false}
                    />
                    <TouchableOpacity
                        style={styles.saveButton}
                        onPress={handleSaveSuffixConfig}
                        disabled={isSavingSuffix}
                    >
                         {isSavingSuffix ? (
                            <ActivityIndicator color={theme.colors.white} />
                        ) : (
                            <Text style={styles.saveButtonText}>{t('flashNoteConfigScreen.saveSuffixConfig')}</Text>
                        )}
                    </TouchableOpacity>
                </View>

                {/* Section 3: History & Archive */}
                <SectionHeader title={t('flashNoteConfigScreen.historyArchive')} />
                <View style={styles.card}>
                    <Text style={styles.label}>{t('flashNoteConfigScreen.historyFileRecognitionMode')}</Text>
                    <Text style={styles.description}>{t('flashNoteConfigScreen.historyFileRecognitionDesc')}</Text>

                    <View style={styles.radioContainer}>
                        {[
                            { label: t('flashNoteConfigScreen.noHistory'), value: 'none' },
                            { label: t('flashNoteConfigScreen.dashYYYYMM'), value: 'dash-yyyymm' },
                            { label: t('flashNoteConfigScreen.underscoreYYYYMM'), value: 'underscore-yyyymm' },
                            { label: t('flashNoteConfigScreen.dashYYYY'), value: 'dash-yyyy' },
                            { label: t('flashNoteConfigScreen.chineseYYYYMM'), value: 'chinese-yyyymm' },
                        ].map((option) => (
                            <TouchableOpacity
                                key={option.value}
                                style={styles.radioButton}
                                onPress={() => setHistoryPattern(option.value as any)}
                            >
                                <View style={[styles.radioCircle, historyPattern === option.value && styles.radioCircleActive]} />
                                <Text style={styles.radioLabel}>{option.label}</Text>
                            </TouchableOpacity>
                        ))}
                    </View>

                    <View style={styles.divider} />

                    <Text style={styles.label}>{t('settings.historyFolderPath')}</Text>
                    <Text style={styles.description}>{t('settings.historyFolderPathDesc')}</Text>
                    <TextInput
                        style={styles.input}
                        value={historyFolderPath}
                        onChangeText={setHistoryFolderPath}
                        placeholder="archive/flash_notes"
                        autoCapitalize="none"
                        autoCorrect={false}
                    />
                    <TouchableOpacity
                        style={styles.saveButton}
                        onPress={handleSaveHistoryConfig}
                        disabled={isSyncingHistory}
                    >
                         {isSyncingHistory ? (
                            <ActivityIndicator color={theme.colors.white} />
                        ) : (
                            <Text style={styles.saveButtonText}>{t('flashNoteConfigScreen.saveSyncHistoryArchive')}</Text>
                        )}
                    </TouchableOpacity>
                </View>

            </ScrollView>
            
            {/* 全屏遮罩 (当正在同步时显示，防止用户操作) */}
            {(isSyncingMain || isSyncingHistory) && (
                <View style={styles.loadingOverlay}>
                    <View style={styles.loadingBox}>
                        <ActivityIndicator size="large" color={theme.colors.primary} />
                        <Text style={styles.loadingText}>
                            {isSyncingMain ? t('flashNoteConfigScreen.syncingMainFile') : t('flashNoteConfigScreen.scanningDownloadingHistory')}
                        </Text>
                    </View>
                </View>
            )}

        </KeyboardAvoidingView>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: theme.colors.background,
    },
    scrollContent: {
        padding: theme.spacing.m,
        paddingBottom: 40,
    },
    sectionHeader: {
        marginBottom: theme.spacing.xs,
        marginTop: theme.spacing.s,
        paddingHorizontal: theme.spacing.xs,
    },
    sectionHeaderText: {
        fontSize: 14,
        fontWeight: '600',
        color: theme.colors.primary,
        textTransform: 'uppercase',
        letterSpacing: 0.5,
    },
    card: {
        backgroundColor: theme.colors.surface,
        borderRadius: 12,
        padding: theme.spacing.m,
        marginBottom: theme.spacing.l,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.05,
        shadowRadius: 2,
        elevation: 1,
    },
    label: {
        fontSize: 15,
        fontWeight: '500',
        color: theme.colors.text,
        marginBottom: 4,
    },
    description: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        marginBottom: theme.spacing.s,
        lineHeight: 16,
    },
    input: {
        backgroundColor: theme.colors.background,
        paddingVertical: 10,
        paddingHorizontal: 12,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        fontSize: 16,
        color: theme.colors.text,
    },
    chipContainer: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 8,
    },
    chip: {
        paddingVertical: 6,
        paddingHorizontal: 12,
        borderRadius: 20,
        backgroundColor: theme.colors.background,
        borderWidth: 1,
        borderColor: theme.colors.border,
    },
    chipActive: {
        backgroundColor: theme.colors.primary,
        borderColor: theme.colors.primary,
    },
    chipText: {
        fontSize: 13,
        color: theme.colors.text,
    },
    chipTextActive: {
        color: theme.colors.white,
        fontWeight: '500',
    },
    radioContainer: {
        marginTop: theme.spacing.s,
    },
    radioButton: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 12,
    },
    radioCircle: {
        width: 20,
        height: 20,
        borderRadius: 10,
        borderWidth: 2,
        borderColor: theme.colors.textSecondary,
        marginRight: 10,
    },
    radioCircleActive: {
        borderColor: theme.colors.primary,
        backgroundColor: theme.colors.primary,
    },
    radioLabel: {
        fontSize: 15,
        color: theme.colors.text,
    },
    divider: {
        height: 1,
        backgroundColor: theme.colors.border,
        marginVertical: theme.spacing.m,
    },
    saveButton: {
        backgroundColor: theme.colors.primary,
        paddingVertical: 12,
        paddingHorizontal: 24,
        borderRadius: 8,
        width: '100%',
        alignItems: 'center',
        marginTop: theme.spacing.m,
    },
    saveButtonText: {
        color: theme.colors.white,
        fontSize: 16,
        fontWeight: '600',
    },
    loadingOverlay: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0,0,0,0.5)',
        justifyContent: 'center',
        alignItems: 'center',
        zIndex: 1000,
    },
    loadingBox: {
        backgroundColor: theme.colors.surface,
        padding: theme.spacing.l,
        borderRadius: 16,
        alignItems: 'center',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 8,
        elevation: 6,
    },
    loadingText: {
        marginTop: theme.spacing.m,
        fontSize: 16,
        color: theme.colors.text,
        fontWeight: '500',
    },
});
