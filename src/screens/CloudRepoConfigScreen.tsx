import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, Alert } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { useTranslation } from 'react-i18next';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { theme } from '../utils/theme';
import { auxFontSizes } from '../utils/fontSize';
import { useSettingsStore } from '../store/useSettingsStore';
import { WebDavProvider } from '../services/WebDavProvider';
import { cloudService } from '../services/CloudService';
import { syncService } from '../services/SyncService';
import {
    SettingsFieldInput,
    SettingsGroup,
    SettingsGroupLabel,
    SettingsPrimaryButton,
    SettingsStatusCard,
    SettingsToast,
    useSettingsToast,
} from '../components/settings';

interface FormError {
    message: string;
}

export const CloudRepoConfigScreen = () => {
    const { t } = useTranslation();
    const { webDavConfig, setWebDavConfig, setCloudProvider, cloudProvider } = useSettingsStore();
    const { toast, showToast } = useSettingsToast();

    const [server, setServer] = useState(webDavConfig.server);
    const [username, setUsername] = useState(webDavConfig.username);
    const [password, setPassword] = useState('');
    const [saving, setSaving] = useState(false);
    const [formError, setFormError] = useState<FormError | null>(null);

    const isConfigured = cloudProvider === 'webdav' && Boolean(webDavConfig.server);

    useEffect(() => {
        const loadCredentials = async () => {
            try {
                const storedPassword = await SecureStore.getItemAsync('WEBDAV_PASSWORD');
                if (storedPassword) {
                    setPassword(storedPassword);
                }
            } catch (error) {
                console.error('Failed to load credentials', error);
            }
        };
        loadCredentials();
    }, []);

    const performSave = async () => {
        await SecureStore.setItemAsync('WEBDAV_PASSWORD', password);
        setWebDavConfig({ server, username });
        setCloudProvider('webdav');
        await cloudService.initProvider();
        showToast(t('settings.cloudSaveSuccess', '已验证连接并保存，云端同步正常'));
    };

    const handleSave = async () => {
        setSaving(true);
        setFormError(null);
        try {
            if (!server || !username || !password) {
                setFormError({ message: t('settings.error.notEmpty') });
                return;
            }

            // 验证 WebDAV 连接
            const testProvider = new WebDavProvider({ server, username, password });
            await testProvider.listFiles('');

            // 服务器地址变化且此前已配置：切换仓库需清空本地缓存
            const isRepoChanged = cloudProvider === 'webdav' && server !== webDavConfig.server;
            if (isRepoChanged) {
                Alert.alert(t('settings.warning', '警告'), t('settings.switchCloudWarning'), [
                    {
                        text: t('common.cancel'),
                        style: 'cancel',
                        onPress: () => { },
                    },
                    {
                        text: t('common.confirm'),
                        style: 'destructive',
                        onPress: async () => {
                            setSaving(true);
                            try {
                                await syncService.clearCache({ includeUnsynced: true });
                                await performSave();
                            } catch (e) {
                                console.error('Failed during destructive save:', e);
                                setFormError({ message: t('settings.switchFailed', '切换云服务失败') });
                            } finally {
                                setSaving(false);
                            }
                        },
                    },
                ]);
                return;
            }

            await performSave();
        } catch (error: unknown) {
            console.error('Failed to save settings:', error);
            const err = error as { message?: string; code?: string };
            let errorMessage = t('settings.error.validation');
            if (err?.message?.includes('401')) errorMessage = t('settings.error.auth');
            else if (err?.code === 'NetworkError' || err?.message?.includes('Network request failed')) {
                errorMessage = t('settings.error.network');
            } else if (err?.message) errorMessage = err.message;
            setFormError({ message: errorMessage });
        } finally {
            setSaving(false);
        }
    };

    const displayServer = webDavConfig.server
        ? webDavConfig.server.replace(/^https?:\/\//, '').replace(/\/$/, '')
        : '';

    return (
        <View style={styles.container}>
            <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
                <SettingsStatusCard
                    tone={isConfigured ? 'success' : 'muted'}
                    title={
                        isConfigured
                            ? t('settings.cloudStatusConnected', 'WebDAV · 已连接')
                            : t('settings.cloudStatusUnconfigured', 'WebDAV · 未配置')
                    }
                    subtitle={
                        isConfigured && displayServer
                            ? `${displayServer} · ${webDavConfig.username}`
                            : t('settings.cloudStatusUnconfiguredDesc', '尚未配置云端同步服务')
                    }
                    badge={isConfigured ? t('settings.cloudBadgeOk', '同步正常') : t('settings.cloudBadgeNone', '未配置')}
                />

                <View style={styles.hint}>
                    <MaterialCommunityIcons name="information-outline" size={14} color={theme.colors.textSecondary} />
                    <Text style={styles.hintText}>
                        {t('settings.cloudProvider.webdav.recommendNutstore')}
                    </Text>
                </View>

                <SettingsGroupLabel>{t('settings.connectionGroup', '连接信息')}</SettingsGroupLabel>
                <SettingsGroup>
                    <View style={styles.formArea}>
                        <SettingsFieldInput
                            label={t('settings.cloudProvider.webdav.serverAddress')}
                            value={server}
                            onChangeText={setServer}
                            placeholder="https://dav.jianguoyun.com/dav/"
                        />
                        <SettingsFieldInput
                            label={t('settings.cloudProvider.webdav.username')}
                            value={username}
                            onChangeText={setUsername}
                            placeholder="email@example.com"
                        />
                        <SettingsFieldInput
                            label={t('settings.cloudProvider.webdav.password')}
                            value={password}
                            onChangeText={setPassword}
                            placeholder="App Password"
                            secure
                        />
                        {formError ? (
                            <View style={styles.errorBox}>
                                <MaterialCommunityIcons
                                    name="close-circle"
                                    size={16}
                                    color={theme.colors.dangerText}
                                />
                                <Text style={styles.errorText}>{formError.message}</Text>
                            </View>
                        ) : null}
                        <SettingsPrimaryButton
                            label={t('settings.saveAndValidate')}
                            icon="shield-check-outline"
                            onPress={handleSave}
                            loading={saving}
                        />
                    </View>
                </SettingsGroup>

                <Text style={styles.note}>
                    {t('settings.cloudProvider.webdav.helpText')}
                    {isConfigured
                        ? '\n' + t('settings.cloudSwitchNote', '更换服务器地址将清空本地缓存并重新全量同步，操作前会再次确认。')
                        : ''}
                </Text>
            </ScrollView>

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
    hint: {
        flexDirection: 'row',
        gap: 8,
        alignItems: 'flex-start',
        backgroundColor: theme.colors.inputBg,
        borderRadius: 12,
        padding: 10,
        marginTop: 12,
        marginBottom: 4,
    },
    hintText: {
        flex: 1,
        fontSize: auxFontSizes.secondary,
        color: theme.colors.textSecondary,
        lineHeight: 18,
    },
    note: {
        fontSize: auxFontSizes.secondary,
        color: theme.colors.textTertiary,
        lineHeight: 18,
        textAlign: 'center',
        marginTop: 14,
        marginHorizontal: 8,
    },
    errorBox: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        marginTop: 12,
        padding: 10,
        borderRadius: 10,
        backgroundColor: theme.colors.dangerBg,
    },
    errorText: {
        flex: 1,
        fontSize: auxFontSizes.caption,
        color: theme.colors.dangerText,
    },
});
