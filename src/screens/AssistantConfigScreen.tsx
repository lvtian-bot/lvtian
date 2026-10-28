import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { useTranslation } from 'react-i18next';
import * as Clipboard from 'expo-clipboard';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { theme } from '../utils/theme';
import { auxFontSizes } from '../utils/fontSize';
import { useAssistantStore } from '../store/useAssistantStore';
import { AssistantClient } from '../services/AssistantClient';
import {
    SettingsFieldInput,
    SettingsGroup,
    SettingsGroupLabel,
    SettingsPrimaryButton,
    SettingsStatusCard,
    SettingsToast,
    useSettingsToast,
} from '../components/settings';

interface TestResult {
    success: boolean;
    message: string;
}

export const AssistantConfigScreen = () => {
    const { t } = useTranslation();
    const { serverUrl, serverToken, connectionState, setServerConfig } = useAssistantStore();
    const { toast, showToast } = useSettingsToast();

    const isConnected = connectionState === 'connected';
    const isConnecting = connectionState === 'connecting' || connectionState === 'reconnecting';

    const [url, setUrl] = useState(serverUrl);
    const [token, setToken] = useState(serverToken);
    const [testing, setTesting] = useState(false);
    const [testResult, setTestResult] = useState<TestResult | null>(null);

    // 凭据同步：只在 store 中的 serverUrl / serverToken 变更时初始化表单
    useEffect(() => {
        setUrl(serverUrl);
        setToken(serverToken);
    }, [serverUrl, serverToken]);

    const handlePasteFromClipboard = async () => {
        try {
            const text = await Clipboard.getStringAsync();
            if (!text.trim()) {
                showToast(t('assistant.clipboardEmpty', '剪贴板内容为空'));
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
            showToast(t('assistant.clipboardExtracted', '已从剪贴板自动提取服务配置'));
        } catch {
            showToast(t('assistant.clipboardFail', '读取剪贴板失败'));
        }
    };

    const handleTestAndSave = async () => {
        if (!url.trim()) {
            setTestResult({ success: false, message: t('assistant.urlRequired', '服务地址不能为空') });
            return;
        }
        if (!token.trim()) {
            setTestResult({ success: false, message: t('assistant.tokenRequired', '访问令牌（Token）不能为空') });
            return;
        }

        setTesting(true);
        setTestResult(null);

        const res = await AssistantClient.testConnection(url, token);
        if (!res.success) {
            setTesting(false);
            setTestResult({
                success: false,
                message: res.message,
            });
            return;
        }

        try {
            await setServerConfig(url, token);
            AssistantClient.getInstance().connect(true);
            setTesting(false);
            setTestResult({
                success: true,
                message: res.message + (res.version ? ` (v${res.version})` : ''),
            });
            showToast(t('assistant.testAndSaveSuccess', '连接测试成功，配置已保存'));
        } catch (err: unknown) {
            setTesting(false);
            const msg = err instanceof Error ? err.message : String(err);
            setTestResult({ success: false, message: `${t('assistant.saveFailed', '保存配置失败')}: ${msg}` });
        }
    };

    const displayHost = serverUrl ? serverUrl.replace(/^https?:\/\//, '').replace(/\/$/, '') : '';
    const statusTitle = isConnected
        ? t('assistant.serverOnline', '服务端在线')
        : t('assistant.serverOffline', '服务端未连接');
    const statusBadge = isConnected
        ? t('assistant.badgeConnected', '已连接')
        : isConnecting
        ? t('assistant.badgeConnecting', '连接中')
        : t('assistant.badgeDisconnected', '未连接');

    return (
        <View style={styles.container}>
            <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
                <SettingsStatusCard
                    tone={isConnected ? 'success' : 'muted'}
                    title={statusTitle}
                    subtitle={displayHost || t('assistant.serverNotSet', '未配置服务地址')}
                    badge={statusBadge}
                />

                <SettingsGroupLabel>{t('assistant.serverGroup', '服务端')}</SettingsGroupLabel>
                <SettingsGroup>
                    <View style={styles.formArea}>
                        <TouchableOpacity
                            style={styles.pasteBar}
                            onPress={handlePasteFromClipboard}
                            activeOpacity={0.7}
                        >
                            <MaterialCommunityIcons
                                name="content-paste"
                                size={16}
                                color={theme.colors.textSecondary}
                            />
                            <Text style={styles.pasteBarText}>
                                {t('assistant.pasteConfigBar', '一键粘贴服务端配置链接')}
                            </Text>
                        </TouchableOpacity>
                        <SettingsFieldInput
                            label={t('assistant.serverUrl', '服务地址 (URL)')}
                            value={url}
                            onChangeText={(val) => {
                                setUrl(val);
                                setTestResult(null);
                            }}
                            placeholder={t('assistant.serverUrlPlaceholder', '例如 https://agent.example.com 或内网地址')}
                            hint={t('assistant.serverUrlHint', '支持局域网 IP、Tailscale 虚拟内网或公网反代域名')}
                        />
                        <SettingsFieldInput
                            label={t('assistant.token', '访问令牌 (Token)')}
                            value={token}
                            onChangeText={(val) => {
                                setToken(val);
                                setTestResult(null);
                            }}
                            placeholder={t('assistant.tokenPlaceholder', '服务端生成的 32 位访问令牌')}
                            secure
                            hint={t('assistant.tokenHint', '令牌将加密保存在手机安全存储（SecureStore）中')}
                        />
                        {testResult ? (
                            <View
                                style={[
                                    styles.resultBox,
                                    testResult.success ? styles.resultSuccess : styles.resultFail,
                                ]}
                            >
                                <MaterialCommunityIcons
                                    name={testResult.success ? 'check-circle' : 'close-circle'}
                                    size={16}
                                    color={testResult.success ? theme.colors.successText : theme.colors.dangerText}
                                />
                                <Text
                                    style={[
                                        styles.resultText,
                                        testResult.success ? styles.resultTextSuccess : styles.resultTextFail,
                                    ]}
                                >
                                    {testResult.message}
                                </Text>
                            </View>
                        ) : null}
                        <SettingsPrimaryButton
                            label={t('assistant.testAndSave', '测试并保存')}
                            icon="shield-check-outline"
                            onPress={handleTestAndSave}
                            loading={testing}
                        />
                    </View>
                </SettingsGroup>

                <Text style={styles.note}>
                    {t('assistant.serverFooterNote', '令牌加密保存在手机安全存储（SecureStore）中，支持局域网 IP、Tailscale 虚拟内网或公网反代域名。')}
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
    pasteBar: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        backgroundColor: theme.colors.inputBg,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 12,
        paddingVertical: 10,
        marginBottom: 4,
    },
    pasteBarText: {
        fontSize: auxFontSizes.secondary,
        fontWeight: '600',
        color: theme.colors.textSecondary,
    },
    note: {
        fontSize: auxFontSizes.secondary,
        color: theme.colors.textTertiary,
        lineHeight: 18,
        textAlign: 'center',
        marginTop: 14,
        marginHorizontal: 8,
    },
    resultBox: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        marginTop: 12,
        padding: 10,
        borderRadius: 10,
    },
    resultSuccess: {
        backgroundColor: theme.colors.successBg,
    },
    resultFail: {
        backgroundColor: theme.colors.dangerBg,
    },
    resultText: {
        flex: 1,
        fontSize: auxFontSizes.caption,
    },
    resultTextSuccess: {
        color: theme.colors.successText,
    },
    resultTextFail: {
        color: theme.colors.dangerText,
    },
});
