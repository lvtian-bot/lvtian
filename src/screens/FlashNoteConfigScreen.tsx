// 直接复用原SettingsScreen的闪念笔记配置部分
// 仅修改路径和文件名的合并逻辑
import React, { useState } from 'react';
import { View, Text, StyleSheet, TextInput, TouchableOpacity, Alert, ActivityIndicator } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSettingsStore } from '../store/useSettingsStore';
import { theme } from '../utils/theme';
import { normalizePath } from '../utils/pathUtils';

export const FlashNoteConfigScreen = () => {
    const { t } = useTranslation();
    const { flashNoteConfig, setFlashNoteConfig } = useSettingsStore();

    // 合并路径和文件名输入框
    const [fullPath, setFullPath] = useState(() => {
        const path = flashNoteConfig.path ? `${flashNoteConfig.path}/${flashNoteConfig.filename}` : flashNoteConfig.filename;
        return normalizePath(path);
    });
    // 原后缀设置逻辑完全复用
    const [flashNoteSuffix, setFlashNoteSuffix] = useState(flashNoteConfig.suffix);
    // 新增独立保存的加载状态
    const [isSavingPath, setIsSavingPath] = useState(false);
    const [isSavingSuffix, setIsSavingSuffix] = useState(false);

    // 修改路径保存逻辑，将fullPath拆分为path和filename
    const handleSavePath = () => {
        if (!fullPath.trim()) {
            Alert.alert(t('settings.failure'), t('settings.error.notEmpty'));
            return;
        }
        setIsSavingPath(true);

        try {
            // 拆分fullPath为路径和文件名
            const lastSlashIndex = fullPath.lastIndexOf('/');
            const path = lastSlashIndex > 0 ? fullPath.substring(0, lastSlashIndex) : '';
            const filename = lastSlashIndex > 0 ? fullPath.substring(lastSlashIndex + 1) : fullPath;

            // 复用原有的setFlashNoteConfig逻辑
            setFlashNoteConfig({ ...flashNoteConfig, path, filename });
            Alert.alert(t('settings.success'), t('settings.success'));
        } catch (error) {
            console.error('Failed to save path:', error);
            Alert.alert(t('settings.failure'), '保存失败');
        } finally {
            setIsSavingPath(false);
        }
    };

    // 原后缀保存逻辑复用
    const handleSaveSuffix = () => {
        setIsSavingSuffix(true);
        try {
            setFlashNoteConfig({ ...flashNoteConfig, suffix: flashNoteSuffix });
            Alert.alert(t('settings.success'), t('settings.success'));
        } catch (error) {
            console.error('Failed to save suffix:', error);
            Alert.alert(t('settings.failure'), '保存失败');
        } finally {
            setIsSavingSuffix(false);
        }
    };

    // 原预设按钮逻辑完全复用
    const handleSelectPresetSuffix = (suffix: string) => {
        setFlashNoteSuffix(suffix);
    };

    return (
        <View style={{...styles.container, padding: theme.spacing.m}}>
            <Text style={styles.label}>{t('settings.flashNotePath')} + {t('settings.flashNoteFilename')}</Text>
            <Text style={styles.description}>合并路径，例：notes/flash_notes.md</Text>

            {/* 合并为一个路径输入框 */}
            <TextInput
                style={styles.input}
                value={fullPath}
                onChangeText={setFullPath}
                placeholder="notes/flash_notes.md 或 flash_notes.md"
            />

            {/* 路径设置的独立保存按钮 */}
            <TouchableOpacity
                style={styles.button}
                onPress={handleSavePath}
                disabled={isSavingPath}
            >
                {isSavingPath ? (
                    <ActivityIndicator color={theme.colors.white} />
                ) : (
                    <Text style={styles.buttonText}>保存路径配置</Text>
                )}
            </TouchableOpacity>

            <View style={styles.divider} />

            {/* 以下为原有的后缀设置部分，完全复用 */}
            <Text style={styles.label}>{t('settings.flashNoteSuffix')}</Text>
            <Text style={styles.description}>{t('settings.flashNoteSuffixDesc')}</Text>

            <View style={styles.suffixPresets}>
                <TouchableOpacity
                    style={[styles.presetButton, flashNoteSuffix === '' && styles.presetButtonActive]}
                    onPress={() => handleSelectPresetSuffix('')}
                >
                    <Text style={[styles.presetButtonText, flashNoteSuffix === '' && styles.presetButtonTextActive]}>
                        {t('settings.suffixPresets.none')}
                    </Text>
                </TouchableOpacity>
                <TouchableOpacity
                    style={[styles.presetButton, flashNoteSuffix === '\n>' && styles.presetButtonActive]}
                    onPress={() => handleSelectPresetSuffix('\n>')}
                >
                    <Text style={[styles.presetButtonText, flashNoteSuffix === '\n>' && styles.presetButtonTextActive]}>
                        \n&gt;
                    </Text>
                </TouchableOpacity>
                <TouchableOpacity
                    style={[styles.presetButton, flashNoteSuffix === '\n> ' && styles.presetButtonActive]}
                    onPress={() => handleSelectPresetSuffix('\n> ')}
                >
                    <Text style={[styles.presetButtonText, flashNoteSuffix === '\n> ' && styles.presetButtonTextActive]}>
                        \n&gt;
                    </Text>
                </TouchableOpacity>
            </View>

            <Text style={styles.label}>{t('settings.customSuffix')}</Text>
            <TextInput
                style={styles.input}
                value={flashNoteSuffix}
                onChangeText={setFlashNoteSuffix}
                placeholder="\n> "
                multiline
            />

            {/* 后缀设置的独立保存按钮 */}
            <TouchableOpacity
                style={styles.button}
                onPress={handleSaveSuffix}
                disabled={isSavingSuffix}
            >
                {isSavingSuffix ? (
                    <ActivityIndicator color={theme.colors.white} />
                ) : (
                    <Text style={styles.buttonText}>保存后缀配置</Text>
                )}
            </TouchableOpacity>
        </View>
    );
};

// 复用原SettingsScreen的样式
const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: theme.colors.background,
    },
    label: {
        fontSize: theme.typography.body.fontSize,
        marginBottom: theme.spacing.xs,
        color: theme.colors.textSecondary,
    },
    description: {
        fontSize: theme.typography.caption.fontSize,
        color: theme.colors.textSecondary,
        marginBottom: theme.spacing.s,
    },
    input: {
        backgroundColor: theme.colors.surface,
        padding: theme.spacing.s,
        borderRadius: 4,
        borderWidth: 1,
        borderColor: theme.colors.border,
        fontSize: 16,
        color: theme.colors.text,
        marginBottom: theme.spacing.s,
    },
    button: {
        backgroundColor: theme.colors.primary,
        padding: theme.spacing.m,
        borderRadius: 8,
        alignItems: 'center',
        marginBottom: theme.spacing.m,
    },
    buttonText: {
        color: theme.colors.white,
        fontSize: 16,
        fontWeight: 'bold',
    },
    divider: {
        height: 1,
        backgroundColor: theme.colors.border,
        marginVertical: theme.spacing.l,
    },
    suffixPresets: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: theme.spacing.s,
        marginBottom: theme.spacing.m,
    },
    presetButton: {
        paddingVertical: theme.spacing.xs,
        paddingHorizontal: theme.spacing.m,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface,
    },
    presetButtonActive: {
        backgroundColor: theme.colors.primary,
        borderColor: theme.colors.primary,
    },
    presetButtonText: {
        color: theme.colors.text,
        fontSize: 13,
    },
    presetButtonTextActive: {
        color: theme.colors.white,
        fontWeight: 'bold',
    },
});
