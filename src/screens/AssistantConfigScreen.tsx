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
import * as Clipboard from 'expo-clipboard';
import Icon from '@expo/vector-icons/MaterialIcons';
import { theme } from '../utils/theme';
import { useAssistantStore } from '../store/useAssistantStore';
import { AssistantClient } from '../services/AssistantClient';

export const AssistantConfigScreen = () => {
    const { t } = useTranslation();
    const navigation = useNavigation();
    const { serverUrl, serverToken, setServerConfig } = useAssistantStore();

    const [url, setUrl] = useState(serverUrl);
    const [token, setToken] = useState(serverToken);
    const [showToken, setShowToken] = useState(false);
    const [testing, setTesting] = useState(false);
    const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        setUrl(serverUrl);
        setToken(serverToken);
    }, [serverUrl, serverToken]);

    const handlePasteFromClipboard = async () => {
        try {
            const text = await Clipboard.getStringAsync();
            if (!text.trim()) {
                Alert.alert(t('settings.notice', '提示'), '剪贴板内容为空');
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
            Alert.alert(t('settings.success', '成功'), '已从剪贴板自动提取服务配置');
        } catch (_err) {
            Alert.alert(t('settings.failure', '失败'), '读取剪贴板失败');
        }
    };

    const handleTestConnection = async () => {
        if (!url.trim()) {
            Alert.alert(t('settings.failure', '失败'), '请先输入服务地址');
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
            Alert.alert(t('settings.failure', '失败'), '服务地址不能为空');
            return;
        }

        setSaving(true);
        try {
            await setServerConfig(url, token);
            // 强制重新发起长连接
            AssistantClient.getInstance().connect(true);
            setSaving(false);
            Alert.alert(t('settings.success', '成功'), '配置已保存并开始连接', [
                {
                    text: '确定',
                    onPress: () => navigation.goBack(),
                },
            ]);
        } catch (err: unknown) {
            setSaving(false);
            const msg = err instanceof Error ? err.message : String(err);
            Alert.alert(t('settings.failure', '失败'), `保存配置失败: ${msg}`);
        }
    };

    return (
        <KeyboardAvoidingView
            style={styles.container}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
            <ScrollView style={styles.scroll} keyboardShouldPersistTaps="handled">
                <View style={styles.headerCard}>
                    <Icon name="smart-toy" size={32} color={theme.colors.primary} />
                    <View style={styles.headerTextWrap}>
                        <Text style={styles.headerTitle}>绿天个人助理服务</Text>
                        <Text style={styles.headerDesc}>
                            连接运行在您的电脑或 VPS 上的独立助理服务
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
                    <Text style={styles.clipboardBtnText}>一键粘贴完整配置链接</Text>
                </TouchableOpacity>

                {/* 表单项 */}
                <View style={styles.formCard}>
                    <Text style={styles.label}>服务地址 (URL)</Text>
                    <TextInput
                        style={styles.input}
                        placeholder="例如 http://192.168.1.100:3000 或域名"
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
                        支持局域网 IP、Tailscale 虚拟内网或公网反代域名
                    </Text>

                    <Text style={[styles.label, styles.tokenLabel]}>访问密钥 (Token)</Text>
                    <View style={styles.tokenInputWrap}>
                        <TextInput
                            style={[styles.input, styles.tokenInput]}
                            placeholder="服务启动时生成的安全访问令牌"
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
                        令牌将加密保存在手机安全存储（SecureStore）中
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
                            <Text style={styles.testBtnText}>测试连接</Text>
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
                            <Text style={styles.saveBtnText}>保存并连接</Text>
                        )}
                    </TouchableOpacity>
                </View>
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
});
