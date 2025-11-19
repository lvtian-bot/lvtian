import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, TextInput, TouchableOpacity, Alert, ScrollView, ActivityIndicator } from 'react-native';
import * as Keychain from 'react-native-keychain';
import { useTranslation } from 'react-i18next';
import { useSettingsStore } from '../store/useSettingsStore';
import { theme } from '../utils/theme';
import { TencentCOSProvider } from '../services/TencentCOSProvider'; // Import provider for testing

export const SettingsScreen = () => {
    const { t } = useTranslation();
    const { cosConfig, setCosConfig } = useSettingsStore();

    const [secretId, setSecretId] = useState('');
    const [secretKey, setSecretKey] = useState('');
    const [bucket, setBucket] = useState(cosConfig.bucket);
    const [region, setRegion] = useState(cosConfig.region);
    const [isLoading, setIsLoading] = useState(false);

    useEffect(() => {
        loadCredentials();
    }, []);

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

    const handleSave = async () => {
        if (!secretId || !secretKey || !bucket || !region) {
            Alert.alert(t('settings.failure'), t('settings.error.notEmpty'));
            return;
        }

        setIsLoading(true);

        try {
            console.log('Validating new COS configuration...');
            const testProvider = new TencentCOSProvider(secretId, secretKey, bucket, region);
            
            await new Promise((resolve, reject) => {
                // @ts-ignore
                testProvider.cos.getBucket({ Bucket: bucket, Region: region, MaxKeys: 0 }, (err, data) => {
                    if (err) return reject(err);
                    resolve(data);
                });
            });

            console.log('Validation successful.');

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
            setIsLoading(false);
        }
    };

    return (
        <ScrollView style={styles.container} keyboardShouldPersistTaps="handled">
            <Text style={styles.header}>COS Configuration</Text>

            <View style={styles.inputGroup}>
                <Text style={styles.label}>Secret ID</Text>
                <TextInput
                    style={styles.input}
                    value={secretId}
                    onChangeText={setSecretId}
                    placeholder="AKID..."
                    secureTextEntry
                />
            </View>

            <View style={styles.inputGroup}>
                <Text style={styles.label}>Secret Key</Text>
                <TextInput
                    style={styles.input}
                    value={secretKey}
                    onChangeText={setSecretKey}
                    placeholder="Key..."
                    secureTextEntry
                />
            </View>

            <View style={styles.inputGroup}>
                <Text style={styles.label}>Bucket</Text>
                <TextInput
                    style={styles.input}
                    value={bucket}
                    onChangeText={setBucket}
                    placeholder="example-1250000000"
                />
            </View>

            <View style={styles.inputGroup}>
                <Text style={styles.label}>Region</Text>
                <TextInput
                    style={styles.input}
                    value={region}
                    onChangeText={setRegion}
                    placeholder="ap-guangzhou"
                />
            </View>

            <TouchableOpacity style={styles.button} onPress={handleSave} disabled={isLoading}>
                {isLoading ? (
                    <ActivityIndicator color={theme.colors.white} />
                ) : (
                    <Text style={styles.buttonText}>{t('settings.saveAndValidate')}</Text>
                )}
            </TouchableOpacity>

            <View style={styles.divider} />

        </ScrollView>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        padding: theme.spacing.m,
        backgroundColor: theme.colors.background,
    },
    header: {
        fontSize: theme.typography.h2.fontSize,
        fontWeight: 'bold',
        marginBottom: theme.spacing.m,
        color: theme.colors.text,
    },
    inputGroup: {
        marginBottom: theme.spacing.m,
    },
    label: {
        fontSize: theme.typography.body.fontSize,
        marginBottom: theme.spacing.xs,
        color: theme.colors.textSecondary,
    },
    input: {
        backgroundColor: theme.colors.surface,
        padding: theme.spacing.s,
        borderRadius: 4,
        borderWidth: 1,
        borderColor: theme.colors.border,
        fontSize: 16,
        color: theme.colors.text,
    },
    button: {
        backgroundColor: theme.colors.primary,
        padding: theme.spacing.m,
        borderRadius: 8,
        alignItems: 'center',
        marginTop: theme.spacing.s,
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
});
