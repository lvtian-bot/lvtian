import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, TextInput, TouchableOpacity, Alert, ActivityIndicator, ScrollView, KeyboardAvoidingView, Platform } from 'react-native';
import * as Keychain from 'react-native-keychain';
import { useTranslation } from 'react-i18next';
import { useSettingsStore } from '../store/useSettingsStore';
import { theme } from '../utils/theme';
import { TencentCOSProvider } from '../services/TencentCOSProvider';
import Icon from 'react-native-vector-icons/MaterialCommunityIcons';

export const CloudRepoConfigScreen = () => {
    const { t } = useTranslation();
    const { cosConfig, setCosConfig } = useSettingsStore();

    const [secretId, setSecretId] = useState('');
    const [secretKey, setSecretKey] = useState('');
    const [bucket, setBucket] = useState(cosConfig.bucket);
    const [region, setRegion] = useState(cosConfig.region);
    const [isCosLoading, setIsCosLoading] = useState(false);
    const [showSecretKey, setShowSecretKey] = useState(false);

    useEffect(() => {
        const loadCredentials = async () => {
            try {
                const credentials = await Keychain.getGenericPassword();
                if (credentials) {
                    setSecretId(credentials.username);
                    setSecretKey(credentials.password);
                }
            } catch (error) {
                console.error('Failed to load credentials', error);
            }
        };
        loadCredentials();
    }, []);

    const handleSaveCosConfig = async () => {
        if (!secretId || !secretKey || !bucket || !region) {
            Alert.alert(t('settings.failure'), t('settings.error.notEmpty'));
            return;
        }

        setIsCosLoading(true);

        try {
            const testProvider = new TencentCOSProvider(secretId, secretKey, bucket, region);

            await new Promise((resolve, reject) => {
                // @ts-ignore
                testProvider.cos.getBucket({ Bucket: bucket, Region: region, MaxKeys: 0 }, (err, data) => {
                    if (err) return reject(err);
                    resolve(data);
                });
            });

            await Keychain.setGenericPassword(secretId, secretKey);
            setCosConfig({ bucket, region });

            Alert.alert(t('settings.success'), t('settings.success'));
        } catch (error: any) {
            console.error('Failed to save settings:', error);
            let errorMessage = t('settings.error.validation');
            if (error && error.code) {
                switch (error.code) {
                    case 'SignatureDoesNotMatch':
                        errorMessage = t('settings.error.auth');
                        break;
                    case 'NoSuchBucket':
                        errorMessage = t('settings.error.bucket');
                        break;
                    case 'NetworkError':
                        errorMessage = t('settings.error.network');
                        break;
                }
            }
            Alert.alert(t('settings.failure'), errorMessage);
        } finally {
            setIsCosLoading(false);
        }
    };

    const renderInput = (
        label: string,
        value: string,
        onChangeText: (text: string) => void,
        placeholder: string,
        iconName: string,
        isPassword = false
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
                    secureTextEntry={isPassword && !showSecretKey}
                    autoCapitalize="none"
                />
                {isPassword && (
                    <TouchableOpacity onPress={() => setShowSecretKey(!showSecretKey)} style={styles.eyeIcon}>
                        <Icon name={showSecretKey ? 'eye-off' : 'eye'} size={20} color={theme.colors.textSecondary} />
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
            <ScrollView contentContainerStyle={styles.scrollContent}>
                <View style={styles.header}>
                    <View style={styles.headerIconContainer}>
                        <Icon name="cloud-upload" size={40} color={theme.colors.primary} />
                    </View>
                    <Text style={styles.headerTitle}>{t('settings.cloudProvider.tencentCOS')}</Text>
                    <Text style={styles.headerSubtitle}>{t('settings.cloudProvider.subtitle')}</Text>
                </View>

                <View style={styles.card}>
                    <Text style={styles.cardTitle}>{t('settings.cloudProvider.authInfo')}</Text>
                    {renderInput(t('settings.cloudProvider.secretId'), secretId, setSecretId, 'AKID...', 'identifier')}
                    {renderInput(t('settings.cloudProvider.secretKey'), secretKey, setSecretKey, 'Key...', 'key', true)}
                </View>

                <View style={styles.card}>
                    <Text style={styles.cardTitle}>{t('settings.cloudProvider.bucketConfig')}</Text>
                    {renderInput(t('settings.cloudProvider.bucketName'), bucket, setBucket, 'example-1250000000', 'bucket')}
                    {renderInput(t('settings.cloudProvider.region'), region, setRegion, 'ap-guangzhou', 'map-marker')}
                </View>

                <TouchableOpacity
                    style={[styles.saveButton, isCosLoading && styles.saveButtonDisabled]}
                    onPress={handleSaveCosConfig}
                    disabled={isCosLoading}
                    activeOpacity={0.8}
                >
                    {isCosLoading ? (
                        <ActivityIndicator color={theme.colors.white} />
                    ) : (
                        <>
                            <Icon name="check-circle-outline" size={20} color={theme.colors.white} style={{ marginRight: 8 }} />
                            <Text style={styles.saveButtonText}>{t('settings.saveCos')}</Text>
                        </>
                    )}
                </TouchableOpacity>

                <Text style={styles.helpText}>
                    {t('settings.cloudProvider.helpText')}
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
        padding: theme.spacing.m,
        paddingBottom: theme.spacing.xl,
    },
    header: {
        alignItems: 'center',
        marginBottom: theme.spacing.l,
        marginTop: theme.spacing.m,
    },
    headerIconContainer: {
        width: 80,
        height: 80,
        borderRadius: 40,
        backgroundColor: theme.colors.surface,
        justifyContent: 'center',
        alignItems: 'center',
        marginBottom: theme.spacing.s,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.1,
        shadowRadius: 8,
        elevation: 4,
    },
    headerTitle: {
        fontSize: 24,
        fontWeight: 'bold',
        color: theme.colors.text,
        marginBottom: 4,
    },
    headerSubtitle: {
        fontSize: 14,
        color: theme.colors.textSecondary,
    },
    card: {
        backgroundColor: theme.colors.surface,
        borderRadius: 12,
        padding: theme.spacing.l,
        marginBottom: theme.spacing.m,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.05,
        shadowRadius: 4,
        elevation: 2,
        borderWidth: 1,
        borderColor: theme.colors.border,
    },
    cardTitle: {
        fontSize: 16,
        fontWeight: 'bold',
        color: theme.colors.text,
        marginBottom: theme.spacing.m,
        borderLeftWidth: 3,
        borderLeftColor: theme.colors.primary,
        paddingLeft: theme.spacing.s,
    },
    inputContainer: {
        marginBottom: theme.spacing.m,
    },
    inputLabel: {
        fontSize: 14,
        color: theme.colors.text,
        marginBottom: 6,
        fontWeight: '500',
    },
    inputWrapper: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: theme.colors.background,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        paddingHorizontal: theme.spacing.s,
        height: 48,
    },
    inputIcon: {
        marginRight: theme.spacing.s,
    },
    input: {
        flex: 1,
        color: theme.colors.text,
        fontSize: 16,
        height: '100%',
    },
    eyeIcon: {
        padding: 4,
    },
    saveButton: {
        backgroundColor: theme.colors.primary,
        borderRadius: 12,
        height: 56,
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'center',
        marginTop: theme.spacing.s,
        shadowColor: theme.colors.primary,
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.2,
        shadowRadius: 8,
        elevation: 4,
    },
    saveButtonDisabled: {
        opacity: 0.7,
    },
    saveButtonText: {
        color: theme.colors.white,
        fontSize: 18,
        fontWeight: 'bold',
    },
    helpText: {
        marginTop: theme.spacing.l,
        textAlign: 'center',
        color: theme.colors.textSecondary,
        fontSize: 12,
        lineHeight: 18,
        paddingHorizontal: theme.spacing.m,
    },
});
