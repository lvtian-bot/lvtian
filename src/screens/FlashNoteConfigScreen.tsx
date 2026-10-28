import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Alert } from 'react-native';
import { useTranslation } from 'react-i18next';
import { theme } from '../utils/theme';
import { auxFontSizes } from '../utils/fontSize';
import { normalizePath } from '../utils/pathUtils';
import { useSettingsStore } from '../store/useSettingsStore';
import { flashNoteService } from '../services/FlashNoteService';
import {
    SettingsChoice,
    SettingsFieldInput,
    SettingsGroup,
    SettingsGroupLabel,
    SettingsPrimaryButton,
    SettingsRow,
    SettingsSheet,
    SettingsToast,
    useSettingsToast,
} from '../components/settings';

const SUFFIX_REFERENCE = '\n>';
const SUFFIX_EMOJI = '\n👉';

export const FlashNoteConfigScreen = () => {
    const { t } = useTranslation();
    const { flashNoteConfig, setFlashNoteConfig } = useSettingsStore();
    const { toast, showToast } = useSettingsToast();

    const fullPathValue = flashNoteConfig.path
        ? `${flashNoteConfig.path}/${flashNoteConfig.filename}`
        : flashNoteConfig.filename;

    const [fullPath, setFullPath] = useState(fullPathValue);
    const [historyFolderPath, setHistoryFolderPath] = useState(flashNoteConfig.historyFolderPath || '');
    const [customSuffix, setCustomSuffix] = useState(
        flashNoteConfig.suffix === SUFFIX_REFERENCE || flashNoteConfig.suffix === SUFFIX_EMOJI
            ? ''
            : flashNoteConfig.suffix
    );

    const [suffixOpen, setSuffixOpen] = useState(false);
    const [saving, setSaving] = useState(false);

    // store 变更（含保存与远端同步）后回填表单
    useEffect(() => {
        setFullPath(fullPathValue);
        setHistoryFolderPath(flashNoteConfig.historyFolderPath || '');
    }, [fullPathValue, flashNoteConfig.historyFolderPath]);

    const suffixDisplay = (() => {
        if (!flashNoteConfig.suffix) return t('settings.suffixPresets.none');
        if (flashNoteConfig.suffix === SUFFIX_REFERENCE) return t('flashNoteConfigScreen.referenceShort', '换行引用');
        if (flashNoteConfig.suffix === SUFFIX_EMOJI) return t('flashNoteConfigScreen.emojiShort', '换行表情');
        return flashNoteConfig.suffix.replace(/\n/g, '↵');
    })();

    const openSuffixEditor = () => {
        setCustomSuffix(
            flashNoteConfig.suffix === SUFFIX_REFERENCE || flashNoteConfig.suffix === SUFFIX_EMOJI
                ? ''
                : flashNoteConfig.suffix
        );
        setSuffixOpen(true);
    };

    const handleSaveMainConfig = async () => {
        if (!fullPath.trim()) {
            Alert.alert(t('settings.failure'), t('settings.error.notEmpty'));
            return;
        }

        setSaving(true);
        try {
            const lastSlashIndex = fullPath.lastIndexOf('/');
            const path = lastSlashIndex > 0 ? fullPath.substring(0, lastSlashIndex) : '';
            const filename = lastSlashIndex > 0 ? fullPath.substring(lastSlashIndex + 1) : fullPath;

            setFlashNoteConfig({
                ...flashNoteConfig,
                path,
                filename,
            });
            await flashNoteService.syncAll();

            showToast(t('flashNoteConfigScreen.mainSavedToast', '已保存，主文件已同步'));
        } catch (error) {
            console.error('Failed to save main config:', error);
            Alert.alert(t('settings.failure'), t('flashNoteConfigScreen.saveSyncFailed'));
        } finally {
            setSaving(false);
        }
    };

    const handleSaveHistoryConfig = async () => {
        setSaving(true);
        try {
            const normalizedHistoryPath = historyFolderPath ? normalizePath(historyFolderPath) : '';
            setFlashNoteConfig({
                ...flashNoteConfig,
                historyFolderPath: normalizedHistoryPath,
            });
            await flashNoteService.syncAll();

            showToast(t('flashNoteConfigScreen.historySavedToast', '已保存，历史归档已扫描'));
        } catch (error) {
            console.error('Failed to sync history:', error);
            Alert.alert(t('settings.failure'), t('flashNoteConfigScreen.saveSuccessHistorySyncFailed'));
        } finally {
            setSaving(false);
        }
    };

    const handleSelectPresetSuffix = (suffix: string) => {
        setFlashNoteConfig({ suffix });
        showToast(t('flashNoteConfigScreen.suffixSavedToast', '结尾后缀已保存'));
    };

    const handleApplyCustomSuffix = () => {
        setFlashNoteConfig({ suffix: customSuffix });
        showToast(t('flashNoteConfigScreen.suffixSavedToast', '结尾后缀已保存'));
    };

    return (
        <View style={styles.container}>
            <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
                <SettingsGroupLabel>{t('flashNoteConfigScreen.storageGroup', '存储')}</SettingsGroupLabel>
                <SettingsGroup>
                    <View style={styles.formArea}>
                        <SettingsFieldInput
                            label={t('settings.flashNoteLocation', '存储位置')}
                            value={fullPath}
                            onChangeText={setFullPath}
                            placeholder="notes/flash_notes.md"
                            hint={t('flashNoteConfigScreen.mergePathExample')}
                        />
                        <SettingsPrimaryButton
                            label={t('common.save')}
                            onPress={handleSaveMainConfig}
                            loading={saving}
                        />
                    </View>
                </SettingsGroup>

                <SettingsGroup>
                    <View style={styles.formArea}>
                        <SettingsFieldInput
                            label={t('settings.historyFolderPath')}
                            value={historyFolderPath}
                            onChangeText={setHistoryFolderPath}
                            placeholder="archive/flash_notes"
                            hint={t('flashNoteConfigScreen.historySubtitle', '按月拆分的历史闪念')}
                        />
                        <SettingsPrimaryButton
                            label={t('common.save')}
                            onPress={handleSaveHistoryConfig}
                            loading={saving}
                        />
                    </View>
                </SettingsGroup>

                <SettingsGroupLabel>{t('flashNoteConfigScreen.formatGroup', '格式')}</SettingsGroupLabel>
                <SettingsGroup>
                    <SettingsRow
                        icon="format-quote-close"
                        title={t('settings.flashNoteSuffixRow', '结尾后缀')}
                        value={suffixDisplay}
                        onPress={openSuffixEditor}
                        last
                    />
                </SettingsGroup>

                <Text style={styles.note}>
                    {t('flashNoteConfigScreen.footerNote', '修改存储位置或归档目录后，将自动同步主文件并扫描云端历史归档。')}
                </Text>
            </ScrollView>

            <SettingsSheet
                visible={suffixOpen}
                title={t('settings.flashNoteSuffixRow', '结尾后缀')}
                onClose={() => setSuffixOpen(false)}
            >
                <View style={styles.choices}>
                    <SettingsChoice
                        title={t('settings.suffixPresets.none')}
                        selected={!flashNoteConfig.suffix}
                        onPress={() => handleSelectPresetSuffix('')}
                    />
                    <SettingsChoice
                        title={`\n> ${t('flashNoteConfigScreen.reference')}`}
                        desc={t('flashNoteConfigScreen.referenceDesc', '下一条闪念另起一行引用')}
                        selected={flashNoteConfig.suffix === SUFFIX_REFERENCE}
                        onPress={() => handleSelectPresetSuffix(SUFFIX_REFERENCE)}
                    />
                    <SettingsChoice
                        title={`\n👉 ${t('flashNoteConfigScreen.emojiSuffix', '(表情)')}`}
                        desc={t('flashNoteConfigScreen.emojiDesc', '下一条闪念以表情开头')}
                        selected={flashNoteConfig.suffix === SUFFIX_EMOJI}
                        onPress={() => handleSelectPresetSuffix(SUFFIX_EMOJI)}
                    />
                </View>
                <SettingsFieldInput
                    label={t('settings.customSuffix')}
                    value={customSuffix}
                    onChangeText={setCustomSuffix}
                    placeholder="\n> "
                />
                <SettingsPrimaryButton
                    label={t('flashNoteConfigScreen.applyCustomSuffix', '应用自定义后缀')}
                    onPress={handleApplyCustomSuffix}
                />
            </SettingsSheet>

            <SettingsToast message={toast} />
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
    formArea: {
        paddingHorizontal: 15,
        paddingTop: 6,
        paddingBottom: 15,
    },
    choices: {
        paddingHorizontal: 6,
        paddingBottom: 8,
    },
    note: {
        fontSize: auxFontSizes.secondary,
        color: theme.colors.textTertiary,
        lineHeight: 18,
        textAlign: 'center',
        marginTop: 14,
        marginHorizontal: 8,
    },
});
