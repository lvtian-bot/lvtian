import React, { useState, useEffect } from 'react';
import {
    View,
    Text,
    StyleSheet,
    TextInput,
    TouchableOpacity,
    Alert,
    ActivityIndicator,
    ScrollView,
    KeyboardAvoidingView,
    Platform,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import * as Clipboard from 'expo-clipboard';
import Icon from '@expo/vector-icons/MaterialIcons';
import { theme } from '../utils/theme';
import { useAssistantStore } from '../store/useAssistantStore';
import { AssistantClient } from '../services/AssistantClient';
import { RootStackParamList } from '../types/navigation';

type NavigationProp = NativeStackNavigationProp<RootStackParamList>;

export const AssistantConfigScreen = () => {
    const { t } = useTranslation();
    const navigation = useNavigation<NavigationProp>();
    const { serverUrl, serverToken, setServerConfig, connectionState } = useAssistantStore();

    const [url, setUrl] = useState(serverUrl);
    const [token, setToken] = useState(serverToken);
    const [showToken, setShowToken] = useState(false);
    const [testing, setTesting] = useState(false);
    const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
    const [saving, setSaving] = useState(false);

    // 凭据同步：只在 store 中的 serverUrl / serverToken 变更时初始化表单
    useEffect(() => {
        setUrl(serverUrl);
        setToken(serverToken);
    }, [serverUrl, serverToken]);

    const handlePasteFromClipboard = async () => {
        try {
            const text = await Clipboard.getStringAsync();
            if (!text.trim()) {
                Alert.alert(t('settings.notice', '提示'), t('assistant.clipboardEmpty', '剪贴板内容为空'));
                return;
            }
            const parsed = AssistantClient.parseConnectionUrl(text);
            if (parsed.url) {
                setUrl(parsed.url);
            }
            if (parsed.token) {
                setToken(parsed.token);
            }
            setTestResult(null);
            Alert.alert(t('settings.success', '成功'), t('assistant.clipboardExtracted', '已从剪贴板自动提取服务配置'));
        } catch (_err) {
            Alert.alert(t('settings.failure', '失败'), t('assistant.clipboardFail', '读取剪贴板失败'));
        }
    };

    const handleTestConnection = async () => {
        if (!url.trim()) {
            Alert.alert(t('settings.failure', '失败'), t('assistant.urlRequired', '服务地址不能为空'));
            return;
        }

        setTesting(true);
        setTestResult(null);

        const res = await AssistantClient.testConnection(url, token);
        setTesting(false);
        setTestResult({
            success: res.success,
            message: res.message + (res.version ? ` (v${res.version})` : ''),
        });
    };

    const handleSave = async () => {
        if (!url.trim()) {
            Alert.alert(t('settings.failure', '失败'), t('assistant.urlRequired', '服务地址不能为空'));
            return;
        }
        if (!token.trim()) {
            Alert.alert(t('settings.failure', '失败'), t('assistant.tokenRequired', '访问令牌（Token）不能为空'));
            return;
        }

        setSaving(true);
        try {
            await setServerConfig(url, token);
            AssistantClient.getInstance().connect(true);
            setSaving(false);
            Alert.alert(t('settings.success', '成功'), t('assistant.saveSuccess', '配置已保存并开始连接'), [
                {
                    text: t('common.confirm', '确定'),
                    onPress: () => navigation.goBack(),
                },
            ]);
        } catch (err: unknown) {
            setSaving(false);
            const msg = err instanceof Error ? err.message : String(err);
            Alert.alert(t('settings.failure', '失败'), `${t('assistant.saveFailed', '保存配置失败')}: ${msg}`);
        }
    };

    return (
        <KeyboardAvoidingView
            style={styles.container}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
            <ScrollView style={styles.scroll} keyboardShouldPersistTaps="handled">
                <View style={styles.headerCard}>
                    <Icon name="dns" size={32} color={theme.colors.primary} />
                    <View style={styles.headerTextWrap}>
                        <Text style={styles.headerTitle}>{t('settings.serverConfig', '服务端连接配置')}</Text>
                        <Text style={styles.headerDesc}>
                            {t('settings.serverSubtitle', '配置运行在您的电脑或 VPS 上的独立服务端地址与访问令牌')}
                        </Text>
                    </View>
                </View>

                {/* 快捷一键导入按钮 */}
                <TouchableOpacity
                    style={styles.clipboardBtn}
                    onPress={handlePasteFromClipboard}
                    activeOpacity={0.7}
                >
                    <Icon name="content-paste" size={20} color={theme.colors.primary} />
                    <Text style={styles.clipboardBtnText}>{t('assistant.pasteConfig', '一键粘贴完整配置链接')}</Text>
                </TouchableOpacity>

                {/* 表单项 */}
                <View style={styles.formCard}>
                    <Text style={styles.label}>{t('assistant.serverUrl', '服务地址 (URL)')}</Text>
                    <TextInput
                        style={styles.input}
                        placeholder={t('assistant.serverUrlPlaceholder', '例如 https://agent.example.com 或内网地址')}
                        placeholderTextColor={theme.colors.textSecondary}
                        value={url}
                        onChangeText={(val) => {
                            setUrl(val);
                            setTestResult(null);
                        }}
                        autoCapitalize="none"
                        autoCorrect={false}
                        keyboardType="url"
                    />
                    <Text style={styles.hint}>
                        {t('assistant.serverUrlHint', '支持局域网 IP、Tailscale 虚拟内网或公网反代域名')}
                    </Text>

                    <Text style={[styles.label, styles.tokenLabel]}>{t('assistant.token', '访问令牌 (Token)')}</Text>
                    <View style={styles.tokenInputWrap}>
                        <TextInput
                            style={[styles.input, styles.tokenInput]}
                            placeholder={t('assistant.tokenPlaceholder', '服务端生成的 32 位访问令牌')}
                            placeholderTextColor={theme.colors.textSecondary}
                            value={token}
                            onChangeText={(val) => {
                                setToken(val);
                                setTestResult(null);
                            }}
                            secureTextEntry={!showToken}
                            autoCapitalize="none"
                            autoCorrect={false}
                        />
                        <TouchableOpacity
                            style={styles.eyeBtn}
                            onPress={() => setShowToken(!showToken)}
                        >
                            <Icon
                                name={showToken ? 'visibility-off' : 'visibility'}
                                size={22}
                                color={theme.colors.textSecondary}
                            />
                        </TouchableOpacity>
                    </View>
                    <Text style={styles.hint}>
                        {t('assistant.tokenHint', '令牌将加密保存在手机安全存储（SecureStore）中')}
                    </Text>
                </View>

                {/* 测试结果提示 */}
                {testResult && (
                    <View
                        style={[
                            styles.resultBox,
                            testResult.success ? styles.resultSuccess : styles.resultFail,
                        ]}
                    >
                        <Icon
                            name={testResult.success ? 'check-circle' : 'error'}
                            size={20}
                            color={testResult.success ? '#2e7d32' : '#c62828'}
                        />
                        <Text
                            style={[
                                styles.resultText,
                                testResult.success ? styles.textSuccess : styles.textFail,
                            ]}
                        >
                            {testResult.message}
                        </Text>
                    </View>
                )}

                {/* 操作按钮 */}
                <View style={styles.btnRow}>
                    <TouchableOpacity
                        style={[styles.actionBtn, styles.testBtn]}
                        onPress={handleTestConnection}
                        disabled={testing || saving}
                    >
                        {testing ? (
                            <ActivityIndicator size="small" color={theme.colors.primary} />
                        ) : (
                            <Text style={styles.testBtnText}>{t('assistant.testConnection', '测试连接')}</Text>
                        )}
                    </TouchableOpacity>

                    <TouchableOpacity
                        style={[styles.actionBtn, styles.saveBtn]}
                        onPress={handleSave}
                        disabled={testing || saving}
                    >
                        {saving ? (
                            <ActivityIndicator size="small" color="#fff" />
                        ) : (
                            <Text style={styles.saveBtnText}>{t('assistant.save', '保存并连接')}</Text>
                        )}
                    </TouchableOpacity>
                </View>

                {/* 成功连接后引导进入 AI 智能体配置 */}
                {connectionState === 'connected' && (
                    <TouchableOpacity
                        style={styles.agentLinkCard}
                        onPress={() => navigation.navigate('AgentConfig')}
                        activeOpacity={0.7}
                    >
                        <View style={styles.agentLinkLeft}>
                            <Icon name="smart-toy" size={22} color={theme.colors.primary} style={styles.agentLinkIcon} />
                            <View>
                                <Text style={styles.agentLinkTitle}>{t('settings.agentConfig', 'AI 智能体配置')}</Text>
                                <Text style={styles.agentLinkDesc}>
                                    {t('settings.agentConfigSubtitle', '配置运行在服务端的 AI 代理权限与能力')}
                                </Text>
                            </View>
                        </View>
                        <Icon name="chevron-right" size={20} color={theme.colors.textSecondary} />
                    </TouchableOpacity>
                )}
            </ScrollView>
        </KeyboardAvoidingView>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: theme.colors.background,
    },
    scroll: {
        padding: 16,
    },
    headerCard: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: theme.colors.surface,
        borderRadius: 12,
        padding: 16,
        marginBottom: 16,
        elevation: 1,
    },
    headerTextWrap: {
        marginLeft: 12,
        flex: 1,
    },
    headerTitle: {
        fontSize: 16,
        fontWeight: 'bold',
        color: theme.colors.text,
    },
    headerDesc: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        marginTop: 4,
    },
    clipboardBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#e8f5e9',
        borderRadius: 10,
        paddingVertical: 12,
        marginBottom: 16,
        borderWidth: 1,
        borderColor: '#c8e6c9',
    },
    clipboardBtnText: {
        fontSize: 14,
        fontWeight: '600',
        color: theme.colors.primary,
        marginLeft: 8,
    },
    formCard: {
        backgroundColor: theme.colors.surface,
        borderRadius: 12,
        padding: 16,
        marginBottom: 16,
        elevation: 1,
    },
    label: {
        fontSize: 14,
        fontWeight: 'bold',
        color: theme.colors.text,
        marginBottom: 6,
    },
    tokenLabel: {
        marginTop: 16,
    },
    input: {
        backgroundColor: '#f5f5f5',
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
        fontSize: 14,
        color: theme.colors.text,
        borderWidth: 1,
        borderColor: '#e0e0e0',
    },
    tokenInputWrap: {
        position: 'relative',
        justifyContent: 'center',
    },
    tokenInput: {
        paddingRight: 42,
    },
    eyeBtn: {
        position: 'absolute',
        right: 10,
        padding: 4,
    },
    hint: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        marginTop: 4,
    },
    resultBox: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: 12,
        borderRadius: 8,
        marginBottom: 16,
    },
    resultSuccess: {
        backgroundColor: '#e8f5e9',
        borderWidth: 1,
        borderColor: '#a5d6a7',
    },
    resultFail: {
        backgroundColor: '#ffebee',
        borderWidth: 1,
        borderColor: '#ffcdd2',
    },
    resultText: {
        fontSize: 13,
        marginLeft: 8,
        flex: 1,
    },
    textSuccess: {
        color: '#2e7d32',
    },
    textFail: {
        color: '#c62828',
    },
    btnRow: {
        flexDirection: 'row',
        gap: 12,
        marginBottom: 32,
    },
    actionBtn: {
        flex: 1,
        borderRadius: 10,
        paddingVertical: 13,
        alignItems: 'center',
        justifyContent: 'center',
    },
    testBtn: {
        backgroundColor: theme.colors.surface,
        borderWidth: 1,
        borderColor: theme.colors.primary,
    },
    testBtnText: {
        color: theme.colors.primary,
        fontSize: 15,
        fontWeight: '600',
    },
    saveBtn: {
        backgroundColor: theme.colors.primary,
    },
    saveBtnText: {
        color: '#fff',
        fontSize: 15,
        fontWeight: '600',
    },
    agentLinkCard: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        backgroundColor: theme.colors.surface,
        borderRadius: 12,
        padding: 16,
        marginBottom: 24,
        borderWidth: 1,
        borderColor: theme.colors.border,
        elevation: 0.5,
    },
    agentLinkLeft: {
        flexDirection: 'row',
        alignItems: 'center',
        flex: 1,
    },
    agentLinkIcon: {
        marginRight: 12,
    },
    agentLinkTitle: {
        fontSize: 15,
        fontWeight: '600',
        color: theme.colors.text,
    },
    agentLinkDesc: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        marginTop: 2,
    },
});
