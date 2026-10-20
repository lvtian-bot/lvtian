import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, TextInput, TouchableOpacity, Alert, ActivityIndicator, ScrollView, KeyboardAvoidingView, Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { useTranslation } from 'react-i18next';
import { useSettingsStore } from '../store/useSettingsStore';
import { theme } from '../utils/theme';
import { WebDavProvider } from '../services/WebDavProvider';
import { cloudService } from '../services/CloudService';
import { syncService } from '../services/SyncService';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';

export const CloudRepoConfigScreen = () => {
    const { t } = useTranslation();
    const { webDavConfig, setWebDavConfig, setCloudProvider, cloudProvider } = useSettingsStore();

    // WebDAV State
    const [server, setServer] = useState(webDavConfig.server);
    const [username, setUsername] = useState(webDavConfig.username);
    const [password, setPassword] = useState('');
    const [showWebDavPassword, setShowWebDavPassword] = useState(false);

    const [isLoading, setIsLoading] = useState(false);

    useEffect(() => {
        const loadCredentials = async () => {
            try {
                const storedPassword = await SecureStore.getItemAsync('WEBDAV_PASSWORD');
                if (storedPassword) setPassword(storedPassword);
            } catch (error) {
                console.error('Failed to load credentials', error);
            }
        };
        loadCredentials();
    }, []);

    const handleSave = async () => {
        setIsLoading(true);
        let needsConfirmation = false;

        try {
            if (!server || !username || !password) {
                Alert.alert(t('settings.failure'), t('settings.error.notEmpty'));
                return;
            }

            // Verify WebDAV connection
            const testProvider = new WebDavProvider({ server, username, password });
            await testProvider.listFiles('');

            // Check if server changed while previously configured
            const isRepoChanged = cloudProvider === 'webdav' && server !== webDavConfig.server;
            needsConfirmation = isRepoChanged;

            const performSave = async () => {
                await SecureStore.setItemAsync('WEBDAV_PASSWORD', password);
                setWebDavConfig({ server, username });
                setCloudProvider('webdav');

                // Sync with CloudService (Re-init)
                await cloudService.initProvider();

                Alert.alert(t('settings.success'), t('settings.success'));
            };

            if (needsConfirmation) {
                Alert.alert(
                    t('settings.warning'),
                    t('settings.switchCloudWarning'),
                    [
                        { text: t('common.cancel'), style: 'cancel', onPress: () => { } },
                        {
                            text: t('common.confirm'),
                            style: 'destructive',
                            onPress: async () => {
                                setIsLoading(true);
                                try {
                                    await syncService.clearCache({ includeUnsynced: true });
                                    await performSave();
                                } catch (e) {
                                    console.error('Failed during destructive save:', e);
                                    Alert.alert(t('common.error'), 'Failed to switch service');
                                } finally {
                                    setIsLoading(false);
                                }
                            }
                        }
                    ]
                );
                return;
            }

            await performSave();

        } catch (error: any) {
            console.error('Failed to save settings:', error);
            let errorMessage = t('settings.error.validation');

            if (error?.message?.includes('401')) errorMessage = t('settings.error.auth');
            else if (error?.code === 'NetworkError' || error?.message?.includes('Network request failed')) errorMessage = t('settings.error.network');
            else if (error?.message) errorMessage = error.message;

            Alert.alert(t('settings.failure'), errorMessage);
        } finally {
            if (!needsConfirmation) {
                setIsLoading(false);
            }
        }
    };

    const renderInput = (
        label: string,
        value: string,
        onChangeText: (text: string) => void,
        placeholder: string,
        iconName: any,
        isPassword = false,
        showPassword = false,
        togglePassword?: () => void
    ) => (
        <View style={styles.inputContainer}>
            <Text style={styles.inputLabel}>{label}</Text>
            <View style={styles.inputWrapper}>
                <Icon name={iconName} size={20} color={theme.colors.textSecondary} style={styles.inputIcon} />
                <TextInput
                    style={styles.input}
                    value={value}
                    onChangeText={onChangeText}
                    placeholder={placeholder}
                    placeholderTextColor={theme.colors.textSecondary}
                    secureTextEntry={isPassword && !showPassword}
                    autoCapitalize="none"
                />
                {isPassword && togglePassword && (
                    <TouchableOpacity onPress={togglePassword} style={styles.eyeIcon}>
                        <Icon name={showPassword ? 'eye-off' : 'eye'} size={20} color={theme.colors.textSecondary} />
                    </TouchableOpacity>
                )}
            </View>
        </View>
    );

    return (
        <KeyboardAvoidingView
            style={styles.container}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
            <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
                <View style={styles.card}>
                    <View style={styles.infoBox}>
                        <Icon name="information-outline" size={20} color={theme.colors.primary} style={styles.infoIcon} />
                        <Text style={styles.infoText}>{t('settings.cloudProvider.webdav.recommendNutstore')}</Text>
                    </View>
                    <Text style={styles.cardTitle}>{t('settings.cloudProvider.webdav.configTitle')}</Text>
                    {renderInput(t('settings.cloudProvider.webdav.serverAddress'), server, setServer, 'https://dav.jianguoyun.com/dav/', 'web')}
                    {renderInput(t('settings.cloudProvider.webdav.username'), username, setUsername, 'email@example.com', 'account')}
                    {renderInput(t('settings.cloudProvider.webdav.password'), password, setPassword, 'App Password', 'lock', true, showWebDavPassword, () => setShowWebDavPassword(!showWebDavPassword))}
                </View>

                <TouchableOpacity
                    style={[styles.saveButton, isLoading && styles.saveButtonDisabled]}
                    onPress={handleSave}
                    disabled={isLoading}
                    activeOpacity={0.8}
                >
                    {isLoading ? (
                        <ActivityIndicator color={theme.colors.white} />
                    ) : (
                        <>
                            <Icon name="check-circle-outline" size={20} color={theme.colors.white} style={styles.saveIcon} />
                            <Text style={styles.saveButtonText}>
                                {t('settings.save')} WebDAV
                            </Text>
                        </>
                    )}
                </TouchableOpacity>

                <Text style={styles.helpText}>
                    {t('settings.cloudProvider.webdav.helpText')}
                </Text>
            </ScrollView>
        </KeyboardAvoidingView>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: theme.colors.background,
    },
    scrollContent: {
        padding: 16,
    },
    card: {
        backgroundColor: theme.colors.surface,
        borderRadius: 12,
        padding: 16,
        marginBottom: 16,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.05,
        shadowRadius: 2,
        elevation: 2,
    },
    cardTitle: {
        fontSize: 16,
        fontWeight: 'bold',
        color: theme.colors.text,
        marginBottom: 16,
    },
    inputContainer: {
        marginBottom: 16,
    },
    inputLabel: {
        fontSize: 14,
        color: theme.colors.textSecondary,
        marginBottom: 8,
    },
    inputWrapper: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: theme.colors.background,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: '#e0e0e0',
        paddingHorizontal: 12,
    },
    inputIcon: {
        marginRight: 8,
    },
    input: {
        flex: 1,
        height: 48,
        fontSize: 15,
        color: theme.colors.text,
    },
    eyeIcon: {
        padding: 8,
    },
    saveButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.primary,
        height: 48,
        borderRadius: 8,
        marginTop: 8,
        marginBottom: 16,
        elevation: 2,
    },
    saveButtonDisabled: {
        opacity: 0.6,
    },
    saveIcon: {
        marginRight: 8,
    },
    saveButtonText: {
        color: theme.colors.white,
        fontSize: 16,
        fontWeight: 'bold',
    },
    helpText: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        lineHeight: 18,
        textAlign: 'center',
        paddingHorizontal: 8,
    },
    infoBox: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#e3f2fd',
        padding: 12,
        borderRadius: 8,
        marginBottom: 16,
    },
    infoIcon: {
        marginRight: 8,
    },
    infoText: {
        flex: 1,
        fontSize: 13,
        color: '#0d47a1',
        lineHeight: 18,
    },
});
