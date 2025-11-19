import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, TextInput, TouchableOpacity, Alert, ScrollView, ActivityIndicator } from 'react-native';
import * as Keychain from 'react-native-keychain';
import { useTranslation } from 'react-i18next';
import { useSettingsStore } from '../store/useSettingsStore';
import { theme } from '../utils/theme';
import { markdownThemes, MarkdownThemeKey } from '../utils/markdownThemes';
import { TencentCOSProvider } from '../services/TencentCOSProvider'; // Import provider for testing

export const SettingsScreen = () => {
    const { t } = useTranslation();
    const { cosConfig, setCosConfig, flashNoteConfig, setFlashNoteConfig, markdownTheme, setMarkdownTheme } = useSettingsStore();

    const [secretId, setSecretId] = useState('');
    const [secretKey, setSecretKey] = useState('');
    const [bucket, setBucket] = useState(cosConfig.bucket);
    const [region, setRegion] = useState(cosConfig.region);
    const [flashNotePath, setFlashNotePath] = useState(flashNoteConfig.path);
    const [flashNoteFilename, setFlashNoteFilename] = useState(flashNoteConfig.filename);
    const [isCosLoading, setIsCosLoading] = useState(false);
    const [isFlashNoteLoading, setIsFlashNoteLoading] = useState(false);

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

    const handleSaveCosConfig = async () => {
        if (!secretId || !secretKey || !bucket || !region) {
            Alert.alert(t('settings.failure'), t('settings.error.notEmpty'));
            return;
        }

        setIsCosLoading(true);

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
            setIsCosLoading(false);
        }
    };

    const handleSaveFlashNoteConfig = () => {
        if (!flashNotePath || !flashNoteFilename) {
            Alert.alert(t('settings.failure'), t('settings.error.notEmpty'));
            return;
        }
        setIsFlashNoteLoading(true);
        // No validation needed for local paths for now, or simple check
        setFlashNoteConfig({ path: flashNotePath, filename: flashNoteFilename });
        setIsFlashNoteLoading(false);
        Alert.alert(t('settings.success'), t('settings.success'));
    };

    return (
        <ScrollView style={styles.container} keyboardShouldPersistTaps="handled">
            <Text style={styles.header}>{t('settings.cosConfig')}</Text>

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

            <TouchableOpacity style={styles.button} onPress={handleSaveCosConfig} disabled={isCosLoading}>
                {isCosLoading ? (
                    <ActivityIndicator color={theme.colors.white} />
                ) : (
                    <Text style={styles.buttonText}>{t('settings.saveCos')}</Text>
                )}
            </TouchableOpacity>

            <View style={styles.divider} />

            <Text style={styles.header}>{t('settings.flashNote')}</Text>

            <View style={styles.inputGroup}>
                <Text style={styles.label}>{t('settings.flashNotePath')}</Text>
                <TextInput
                    style={styles.input}
                    value={flashNotePath}
                    onChangeText={setFlashNotePath}
                    placeholder="notes/"
                />
            </View>

            <View style={styles.inputGroup}>
                <Text style={styles.label}>{t('settings.flashNoteFilename')}</Text>
                <TextInput
                    style={styles.input}
                    value={flashNoteFilename}
                    onChangeText={setFlashNoteFilename}
                    placeholder="flash_notes.md"
                />
            </View>

            <TouchableOpacity style={styles.button} onPress={handleSaveFlashNoteConfig} disabled={isFlashNoteLoading}>
                {isFlashNoteLoading ? (
                    <ActivityIndicator color={theme.colors.white} />
                ) : (
                    <Text style={styles.buttonText}>{t('settings.saveFlashNote')}</Text>
                )}
            </TouchableOpacity>

            <View style={styles.divider} />

            <Text style={styles.header}>{t('settings.markdownStyle')}</Text>
            <View style={styles.themeContainer}>
                {(Object.keys(markdownThemes) as MarkdownThemeKey[]).map((themeKey) => (
                    <TouchableOpacity
                        key={themeKey}
                        style={[
                            styles.themeButton,
                            markdownTheme === themeKey && styles.themeButtonActive,
                        ]}
                        onPress={() => setMarkdownTheme(themeKey)}
                    >
                        <Text
                            style={[
                                styles.themeButtonText,
                                markdownTheme === themeKey && styles.themeButtonTextActive,
                            ]}
                        >
                            {t(`settings.themes.${themeKey}`)}
                        </Text>
                    </TouchableOpacity>
                ))}
            </View>

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
    themeContainer: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: theme.spacing.s,
    },
    themeButton: {
        paddingVertical: theme.spacing.s,
        paddingHorizontal: theme.spacing.m,
        borderRadius: 20,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface,
    },
    themeButtonActive: {
        backgroundColor: theme.colors.primary,
        borderColor: theme.colors.primary,
    },
    themeButtonText: {
        color: theme.colors.text,
        fontSize: 14,
    },
    themeButtonTextActive: {
        color: theme.colors.white,
        fontWeight: 'bold',
    },
});
