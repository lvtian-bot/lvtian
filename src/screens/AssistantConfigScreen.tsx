import React, { useState, useEffect, useRef } from 'react';
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
    const { serverUrl, serverToken, setServerConfig, permissionMode, setPermissionMode, taskState } = useAssistantStore();
    const isTaskRunning = taskState === 'processing' || taskState === 'awaiting_approval';

    const [url, setUrl] = useState(serverUrl);
    const [token, setToken] = useState(serverToken);
    const [selectedMode, setSelectedMode] = useState<'workspace-write' | 'danger-full-access'>(
        permissionMode || 'workspace-write'
    );
    const [showToken, setShowToken] = useState(false);
    const [testing, setTesting] = useState(false);
    const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
    const [saving, setSaving] = useState(false);
    const hasUserSelectedRef = useRef(false);

    // 凭据同步：只在 store 中的 serverUrl / serverToken 变更时初始化表单，避免权限刷新覆盖未保存的输入
    useEffect(() => {
        setUrl(serverUrl);
        setToken(serverToken);
    }, [serverUrl, serverToken]);

    // 权限模式同步：从已保存的服务端获取最新权限并保持本地选择态一致（若用户已手动选择则不覆盖）
    useEffect(() => {
        if (permissionMode && !hasUserSelectedRef.current) {
            setSelectedMode(permissionMode);
        }
        if (serverUrl && serverToken) {
            AssistantClient.fetchPermissionMode(serverUrl, serverToken).then((remoteMode) => {
                if (remoteMode && !hasUserSelectedRef.current) {
                    setSelectedMode(remoteMode);
                    setPermissionMode(remoteMode);
                }
            });
        }
    }, [permissionMode, serverUrl, serverToken, setPermissionMode]);

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
        if (res.permissionMode) {
            hasUserSelectedRef.current = true;
            setSelectedMode(res.permissionMode);
        }
        setTestResult({
            success: res.success,
            message: res.message + (res.version ? ` (v${res.version})` : ''),
        });
    };

    const handleSelectMode = (mode: 'workspace-write' | 'danger-full-access') => {
        if (isTaskRunning) {
            Alert.alert(
                t('settings.failure', '失败'),
                t('assistant.taskRunningCannotSwitch', '当前有正在执行的任务，请先在聊天界面停止任务后再切换权限模式')
            );
            return;
        }
        hasUserSelectedRef.current = true;
        if (mode === selectedMode) return;
        if (mode === 'danger-full-access') {
            Alert.alert(
                t('assistant.permissionDangerAlertTitle', '确认切换至完全权限？'),
                t(
                    'assistant.permissionDangerAlertContent',
                    '切换后助理将拥有当前服务器用户的所有执行权限，并为您即时生成当前对话的心智备忘录以接力新会话。是否继续？'
                ),
                [
                    { text: t('common.cancel', '取消'), style: 'cancel' },
                    {
                        text: t('common.confirm', '确认切换'),
                        style: 'destructive',
                        onPress: () => setSelectedMode('danger-full-access'),
                    },
                ]
            );
        } else {
            setSelectedMode('workspace-write');
        }
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
        if (isTaskRunning && selectedMode !== permissionMode) {
            Alert.alert(
                t('settings.failure', '失败'),
                t('assistant.taskRunningCannotSwitch', '当前有正在执行的任务，请先在聊天界面停止任务后再切换权限模式')
            );
            return;
        }

        setSaving(true);
        try {
            // 1. 先验证并同步权限模式至服务端（若失败则不修改本地配置，避免状态半持久化分裂）
            const permResult = await AssistantClient.updatePermissionMode(url, token, selectedMode);
            if (!permResult.success) {
                setSaving(false);
                const failMessage = permResult.code === 'TASK_RUNNING'
                    ? (permResult.message || t('assistant.taskRunningCannotSwitch', '当前有正在执行的任务，请先在聊天界面停止任务后再切换权限模式'))
                    : t('assistant.permissionSwitchFailed', '切换权限模式失败，请检查服务连接');
                Alert.alert(t('settings.failure', '失败'), failMessage);
                return;
            }

            // 2. 权限同步成功后，原子持久化凭据与权限状态
            await setServerConfig(url, token);
            setPermissionMode(selectedMode);

            // 3. 强制重新发起长连接
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
                    <Icon name="smart-toy" size={32} color={theme.colors.primary} />
                    <View style={styles.headerTextWrap}>
                        <Text style={styles.headerTitle}>{t('assistant.title', '绿天个人助理服务')}</Text>
                        <Text style={styles.headerDesc}>
                            {t('assistant.desc', '连接运行在您的电脑或 VPS 上的独立助理服务')}
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
                        placeholder={t('assistant.serverUrlPlaceholder', '例如 http://192.168.1.100:3000 或域名')}
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

                {/* 助理执行权限设置 */}
                <View style={styles.permissionCard}>
                    <View style={styles.sectionTitleRow}>
                        <Icon name="security" size={20} color={theme.colors.primary} />
                        <Text style={styles.sectionTitleText}>
                            {t('assistant.permissionTitle', '助理执行权限')}
                        </Text>
                    </View>

                    {/* 选项 1：安全工作区模式 */}
                    <TouchableOpacity
                        style={[
                            styles.modeOption,
                            selectedMode === 'workspace-write' && styles.modeOptionSelected,
                        ]}
                        onPress={() => handleSelectMode('workspace-write')}
                        activeOpacity={0.7}
                    >
                        <View style={styles.modeRadio}>
                            <View
                                style={[
                                    styles.radioOuter,
                                    selectedMode === 'workspace-write' && styles.radioOuterActive,
                                ]}
                            >
                                {selectedMode === 'workspace-write' && <View style={styles.radioInner} />}
                            </View>
                        </View>
                        <View style={styles.modeTextWrap}>
                            <View style={styles.modeHeaderRow}>
                                <Text
                                    style={[
                                        styles.modeTitle,
                                        selectedMode === 'workspace-write' && styles.modeTitleActive,
                                    ]}
                                >
                                    {t('assistant.permissionWorkspace', '安全工作区模式')}
                                </Text>
                                <View style={styles.recommendedBadge}>
                                    <Text style={styles.recommendedBadgeText}>
                                        {t('common.recommended', '推荐')}
                                    </Text>
                                </View>
                            </View>
                            <Text style={styles.modeDesc}>
                                {t(
                                    'assistant.permissionWorkspaceDesc',
                                    '助理仅在专属工作区目录内读写，敏感操作需手动审批。适合日常文档笔记与安全优先场景。'
                                )}
                            </Text>
                        </View>
                    </TouchableOpacity>

                    {/* 选项 2：完全权限模式 */}
                    <TouchableOpacity
                        style={[
                            styles.modeOption,
                            selectedMode === 'danger-full-access' && styles.modeOptionSelected,
                            styles.modeOptionMarginTop,
                        ]}
                        onPress={() => handleSelectMode('danger-full-access')}
                        activeOpacity={0.7}
                    >
                        <View style={styles.modeRadio}>
                            <View
                                style={[
                                    styles.radioOuter,
                                    selectedMode === 'danger-full-access' && styles.radioOuterActive,
                                ]}
                            >
                                {selectedMode === 'danger-full-access' && <View style={styles.radioInner} />}
                            </View>
                        </View>
                        <View style={styles.modeTextWrap}>
                            <Text
                                style={[
                                    styles.modeTitle,
                                    selectedMode === 'danger-full-access' && styles.modeTitleActive,
                                ]}
                            >
                                {t('assistant.permissionDanger', '完全权限模式')}
                            </Text>
                            <Text style={styles.modeDesc}>
                                {t(
                                    'assistant.permissionDangerDesc',
                                    '助理具备服务器完整执行能力，跨目录与系统命令免审批。切换时将自动提炼对话备忘录无缝接力。适合系统运维与开发场景。'
                                )}
                            </Text>
                        </View>
                    </TouchableOpacity>
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
    permissionCard: {
        backgroundColor: theme.colors.surface,
        borderRadius: 12,
        padding: 16,
        marginBottom: 16,
        elevation: 1,
    },
    sectionTitleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 14,
    },
    sectionTitleText: {
        fontSize: 15,
        fontWeight: 'bold',
        color: theme.colors.text,
        marginLeft: 8,
    },
    modeOption: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        padding: 12,
        borderRadius: 10,
        borderWidth: 1.5,
        borderColor: '#e0e0e0',
        backgroundColor: theme.colors.background,
    },
    modeOptionMarginTop: {
        marginTop: 10,
    },
    modeOptionSelected: {
        borderColor: theme.colors.primary,
        backgroundColor: '#f1f8e9',
    },
    modeRadio: {
        marginTop: 2,
        marginRight: 10,
    },
    radioOuter: {
        width: 18,
        height: 18,
        borderRadius: 9,
        borderWidth: 2,
        borderColor: theme.colors.textSecondary,
        alignItems: 'center',
        justifyContent: 'center',
    },
    radioOuterActive: {
        borderColor: theme.colors.primary,
    },
    radioInner: {
        width: 10,
        height: 10,
        borderRadius: 5,
        backgroundColor: theme.colors.primary,
    },
    modeTextWrap: {
        flex: 1,
    },
    modeHeaderRow: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    modeTitle: {
        fontSize: 14,
        fontWeight: 'bold',
        color: theme.colors.text,
    },
    modeTitleActive: {
        color: theme.colors.primary,
    },
    recommendedBadge: {
        backgroundColor: '#c8e6c9',
        paddingHorizontal: 6,
        paddingVertical: 2,
        borderRadius: 4,
        marginLeft: 8,
    },
    recommendedBadgeText: {
        fontSize: 11,
        color: '#2e7d32',
        fontWeight: 'bold',
    },
    modeDesc: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        marginTop: 4,
        lineHeight: 18,
    },
});
