import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, TextInput, TouchableOpacity, Alert, ActivityIndicator, ScrollView, KeyboardAvoidingView, Platform, LayoutAnimation, UIManager } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { useTranslation } from 'react-i18next';
import { useSettingsStore } from '../store/useSettingsStore';
import { theme } from '../utils/theme';
import { TencentCOSProvider } from '../services/TencentCOSProvider';
import { WebDavProvider } from '../services/WebDavProvider'; // Import WebDavProvider
import { cloudService } from '../services/CloudService'; // Import cloudService
import Icon from '@expo/vector-icons/MaterialCommunityIcons';

// Enable LayoutAnimation on Android
if (Platform.OS === 'android') {
    if (UIManager.setLayoutAnimationEnabledExperimental) {
        // Check if we are NOT using the New Architecture (Fabric) to avoid warnings
        // @ts-ignore
        if (!global?.nativeFabricUIManager) {
            UIManager.setLayoutAnimationEnabledExperimental(true);
        }
    }
}

export const CloudRepoConfigScreen = () => {
    const { t } = useTranslation();
    const { cosConfig, setCosConfig, webDavConfig, setWebDavConfig, setCloudProvider, cloudProvider } = useSettingsStore();

    // Tab State: 'tencent' | 'webdav'
    const [activeTab, setActiveTab] = useState<'tencent' | 'webdav'>(cloudProvider === 'webdav' ? 'webdav' : 'tencent');

    // Tencent State
    const [secretId, setSecretId] = useState('');
    const [secretKey, setSecretKey] = useState('');
    const [bucket, setBucket] = useState(cosConfig.bucket);
    const [region, setRegion] = useState(cosConfig.region);
    const [showCosSecretKey, setShowCosSecretKey] = useState(false);

    // WebDAV State
    const [server, setServer] = useState(webDavConfig.server);
    const [username, setUsername] = useState(webDavConfig.username);
    const [password, setPassword] = useState('');
    const [showWebDavPassword, setShowWebDavPassword] = useState(false);

    const [isLoading, setIsLoading] = useState(false);

    useEffect(() => {
        const loadCredentials = async () => {
            try {
                // Load COS
                const storedSecretId = await SecureStore.getItemAsync('COS_SECRET_ID');
                const storedSecretKey = await SecureStore.getItemAsync('COS_SECRET_KEY');
                if (storedSecretId) setSecretId(storedSecretId);
                if (storedSecretKey) setSecretKey(storedSecretKey);

                // Load WebDAV
                const storedPassword = await SecureStore.getItemAsync('WEBDAV_PASSWORD');
                if (storedPassword) setPassword(storedPassword);

            } catch (error) {
                console.error('Failed to load credentials', error);
            }
        };
        loadCredentials();
    }, []);

    const handleTabChange = (tab: 'tencent' | 'webdav') => {
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
        setActiveTab(tab);
    };

    const handleSave = async () => {
        setIsLoading(true);

        try {
            if (activeTab === 'tencent') {
                if (!secretId || !secretKey || !bucket || !region) {
                    Alert.alert(t('settings.failure'), t('settings.error.notEmpty'));
                    return;
                }

                // Verify COS
                const testProvider = new TencentCOSProvider(secretId, secretKey, bucket, region);
                await testProvider.listFiles(''); // Test connection

                // Save
                await SecureStore.setItemAsync('COS_SECRET_ID', secretId);
                await SecureStore.setItemAsync('COS_SECRET_KEY', secretKey);
                setCosConfig({ bucket, region });
                setCloudProvider('tencent');

            } else {
                if (!server || !username || !password) {
                    Alert.alert(t('settings.failure'), t('settings.error.notEmpty'));
                    return;
                }

                // Verify WebDAV
                const testProvider = new WebDavProvider({ server, username, password });
                await testProvider.listFiles(''); // Test connection

                // Save
                await SecureStore.setItemAsync('WEBDAV_PASSWORD', password);
                setWebDavConfig({ server, username });
                setCloudProvider('webdav');
            }

            // Sync with CloudService (Re-init)
            await cloudService.initProvider();

            Alert.alert(t('settings.success'), t('settings.success'));

        } catch (error: any) {
            console.error('Failed to save settings:', error);
            let errorMessage = t('settings.error.validation');

            // Basic error mapping
            if (error?.message?.includes('401')) errorMessage = t('settings.error.auth');
            else if (error?.code === 'SignatureDoesNotMatch') errorMessage = t('settings.error.auth');
            else if (error?.code === 'NoSuchBucket') errorMessage = t('settings.error.bucket');
            else if (error?.code === 'NetworkError' || error?.message?.includes('Network request failed')) errorMessage = t('settings.error.network');
            else if (error?.message) errorMessage = error.message;

            Alert.alert(t('settings.failure'), errorMessage);
        } finally {
            setIsLoading(false);
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

    const renderTabButton = (key: 'tencent' | 'webdav', title: string, icon: any) => (
        <TouchableOpacity
            style={[styles.tabButton, activeTab === key && styles.tabButtonActive]}
            onPress={() => handleTabChange(key)}
            activeOpacity={0.7}
        >
            <Icon
                name={icon}
                size={24}
                color={activeTab === key ? theme.colors.primary : theme.colors.textSecondary}
                style={{ marginBottom: 4 }}
            />
            <Text style={[styles.tabText, activeTab === key && styles.tabTextActive]}>
                {title}
            </Text>
        </TouchableOpacity>
    );

    return (
        <KeyboardAvoidingView
            style={styles.container}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
            <ScrollView contentContainerStyle={styles.scrollContent}>
                <View style={styles.header}>
                    <View style={styles.headerIconContainer}>
                        <Icon name={activeTab === 'tencent' ? 'cloud-upload' : 'server-network'} size={40} color={theme.colors.primary} />
                    </View>
                    <Text style={styles.headerTitle}>{t('settings.cloudRepoConfig')}</Text>
                    <Text style={styles.headerSubtitle}>{t('settings.cloudProvider.subtitle')}</Text>
                </View>

                {/* Tab Selector */}
                <View style={styles.tabContainer}>
                    {renderTabButton('tencent', t('settings.cloudProvider.tencentCOS'), 'cloud-upload-outline' as any)}
                    {renderTabButton('webdav', '坚果云 / WebDAV', 'server-network' as any)}
                </View>

                {activeTab === 'tencent' ? (
                    <>
                        <View style={styles.card}>
                            <Text style={styles.cardTitle}>{t('settings.cloudProvider.authInfo')}</Text>
                            {renderInput(t('settings.cloudProvider.secretId'), secretId, setSecretId, 'AKID...', 'identifier')}
                            {renderInput(t('settings.cloudProvider.secretKey'), secretKey, setSecretKey, 'Key...', 'key', true, showCosSecretKey, () => setShowCosSecretKey(!showCosSecretKey))}
                        </View>
                        <View style={styles.card}>
                            <Text style={styles.cardTitle}>{t('settings.cloudProvider.bucketConfig')}</Text>
                            {renderInput(t('settings.cloudProvider.bucketName'), bucket, setBucket, 'example-1250000000', 'bucket')}
                            {renderInput(t('settings.cloudProvider.region'), region, setRegion, 'ap-guangzhou', 'map-marker')}
                        </View>
                    </>
                ) : (
                    <>
                        <View style={styles.card}>
                            <View style={styles.infoBox}>
                                <Icon name="information-outline" size={20} color={theme.colors.primary} style={{ marginRight: 8 }} />
                                <Text style={styles.infoText}>推荐使用坚果云。请使用应用专用密码。</Text>
                            </View>
                            <Text style={styles.cardTitle}>WebDAV 配置</Text>
                            {renderInput('服务器地址 (Server)', server, setServer, 'https://dav.jianguoyun.com/dav/', 'web')}
                            {renderInput('账户 (Username)', username, setUsername, 'email@example.com', 'account')}
                            {renderInput('密码 (Password)', password, setPassword, 'App Password', 'lock', true, showWebDavPassword, () => setShowWebDavPassword(!showWebDavPassword))}
                        </View>
                    </>
                )}

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
                            <Icon name="check-circle-outline" size={20} color={theme.colors.white} style={{ marginRight: 8 }} />
                            <Text style={styles.saveButtonText}>
                                {t('settings.save')} {activeTab === 'tencent' ? 'COS' : 'WebDAV'}
                            </Text>
                        </>
                    )}
                </TouchableOpacity>

                <Text style={styles.helpText}>
                    {activeTab === 'tencent' ? t('settings.cloudProvider.helpText') : 'WebDAV 允许您将笔记同步到支持该协议的任何云存储服务，如坚果云、Nextcloud 等。'}
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
    tabContainer: {
        flexDirection: 'row',
        backgroundColor: theme.colors.surface,
        borderRadius: 12,
        padding: 4,
        marginBottom: theme.spacing.m,
        height: 70, // Fixed height for tabs
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.05,
        shadowRadius: 4,
        elevation: 2,
    },
    tabButton: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        borderRadius: 8,
    },
    tabButtonActive: {
        backgroundColor: theme.colors.primary + '15', // 10-20% opacity primary
    },
    tabText: {
        fontSize: 14,
        fontWeight: '600',
        color: theme.colors.textSecondary,
    },
    tabTextActive: {
        color: theme.colors.primary,
        fontWeight: 'bold',
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
    infoBox: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: theme.colors.primary + '10',
        padding: 10,
        borderRadius: 8,
        marginBottom: theme.spacing.m,
    },
    infoText: {
        color: theme.colors.text,
        fontSize: 12,
        flex: 1,
    },
});
