import React, { useState, useEffect, useRef } from 'react';
import {
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
    Alert,
    ActivityIndicator,
    ScrollView,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import Icon from '@expo/vector-icons/MaterialIcons';
import { theme } from '../utils/theme';
import { useAssistantStore } from '../store/useAssistantStore';
import { AssistantClient } from '../services/AssistantClient';
import { RootStackParamList } from '../types/navigation';

type NavigationProp = NativeStackNavigationProp<RootStackParamList>;

export const AgentConfigScreen = () => {
    const { t } = useTranslation();
    const navigation = useNavigation<NavigationProp>();
    const {
        serverUrl,
        serverToken,
        permissionMode,
        setPermissionMode,
        taskState,
        connectionState,
    } = useAssistantStore();

    const isConnected = connectionState === 'connected';
    const isTaskRunning = taskState === 'processing' || taskState === 'awaiting_approval';

    const [selectedMode, setSelectedMode] = useState<'workspace-write' | 'danger-full-access'>(
        permissionMode || 'workspace-write'
    );
    const [switchingPerm, setSwitchingPerm] = useState(false);
    const hasUserSelectedRef = useRef(false);

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

    const applyPermissionSwitch = async (targetMode: 'workspace-write' | 'danger-full-access') => {
        if (!serverUrl || !serverToken) {
            Alert.alert(
                t('settings.notice', '提示'),
                t('assistant.serverConfigRequiredFirst', '请先配置并连接服务，再调整服务端权限模式')
            );
            return;
        }

        setSwitchingPerm(true);
        try {
            const res = await AssistantClient.updatePermissionMode(serverUrl, serverToken, targetMode);
            setSwitchingPerm(false);
            if (res.success) {
                hasUserSelectedRef.current = true;
                setSelectedMode(targetMode);
                setPermissionMode(targetMode);
                Alert.alert(
                    t('settings.success', '成功'),
                    t('assistant.permissionSwitchSuccess', '权限已成功切换并完成会话交接')
                );
            } else {
                const failMessage = res.code === 'TASK_RUNNING'
                    ? t('assistant.taskRunningCannotSwitch', '当前有正在执行的任务，请先在聊天界面停止任务后再切换权限模式')
                    : t('assistant.permissionSwitchFailed', '切换权限模式失败，请检查服务连接');
                Alert.alert(t('settings.failure', '失败'), failMessage);
            }
        } catch {
            setSwitchingPerm(false);
            Alert.alert(
                t('settings.failure', '失败'),
                t('assistant.permissionSwitchFailed', '切换权限模式失败，请检查服务连接')
            );
        }
    };

    const handleSelectMode = (mode: 'workspace-write' | 'danger-full-access') => {
        if (isTaskRunning) {
            Alert.alert(
                t('settings.failure', '失败'),
                t('assistant.taskRunningCannotSwitch', '当前有正在执行的任务，请先在聊天界面停止任务后再切换权限模式')
            );
            return;
        }
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
                        onPress: () => applyPermissionSwitch('danger-full-access'),
                    },
                ]
            );
        } else {
            applyPermissionSwitch('workspace-write');
        }
    };

    return (
        <ScrollView style={styles.container} contentContainerStyle={styles.content}>
            {/* 顶栏状态与说明卡片 */}
            <View style={styles.headerCard}>
                <View style={styles.headerIconWrap}>
                    <Icon name="smart-toy" size={28} color={theme.colors.primary} />
                </View>
                <View style={styles.headerTextWrap}>
                    <Text style={styles.headerTitle}>{t('settings.agentConfig', 'AI 智能体配置')}</Text>
                    <Text style={styles.headerDesc}>
                        {t('settings.agentConfigSubtitle', '手机远程配置运行在服务端的 AI 代理权限与中枢能力')}
                    </Text>
                </View>
            </View>

            {/* 未连接服务端时的提示横幅 */}
            {!isConnected && (
                <TouchableOpacity
                    style={styles.notConnectedBanner}
                    onPress={() => navigation.navigate('AssistantConfig')}
                    activeOpacity={0.8}
                >
                    <Icon name="warning" size={20} color="#E65100" style={styles.bannerIcon} />
                    <View style={styles.bannerTextWrap}>
                        <Text style={styles.bannerTitle}>{t('settings.assistantDisconnected', '服务端未连接')}</Text>
                        <Text style={styles.bannerDesc}>
                            {t('assistant.serverConfigRequiredFirst', '请先配置并连接服务，再调整服务端权限模式')}
                        </Text>
                    </View>
                    <Icon name="chevron-right" size={20} color="#E65100" />
                </TouchableOpacity>
            )}

            {/* 智能体执行权限卡片 */}
            <View style={styles.card}>
                <View style={styles.sectionTitleRow}>
                    <Icon name="security" size={20} color={theme.colors.primary} />
                    <Text style={styles.sectionTitleText}>
                        {t('assistant.permissionTitle', '助理执行权限')}
                    </Text>
                    {switchingPerm && (
                        <ActivityIndicator size="small" color={theme.colors.primary} style={styles.switchingIndicator} />
                    )}
                </View>

                {/* 选项 1：安全工作区模式 */}
                <TouchableOpacity
                    style={[
                        styles.modeOption,
                        selectedMode === 'workspace-write' && styles.modeOptionSelected,
                    ]}
                    onPress={() => handleSelectMode('workspace-write')}
                    activeOpacity={0.7}
                    disabled={switchingPerm || !isConnected}
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
                    disabled={switchingPerm || !isConnected}
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

            {/* 模型与中枢架构说明（为后续模型切换预留） */}
            <View style={styles.card}>
                <View style={styles.sectionTitleRow}>
                    <Icon name="psychology" size={20} color={theme.colors.primary} />
                    <Text style={styles.sectionTitleText}>
                        {t('settings.agentHubTitle', '大模型中枢与执行能力')}
                    </Text>
                </View>
                <View style={styles.infoRow}>
                    <Text style={styles.infoLabel}>{t('settings.agentHubEngine', '执行中枢')}</Text>
                    <Text style={styles.infoValue}>{t('settings.agentHubEngineDesc', 'DeepSeek Harness (ACP 协议)')}</Text>
                </View>
                <View style={styles.infoRow}>
                    <Text style={styles.infoLabel}>{t('settings.agentHubMemory', '长期记忆')}</Text>
                    <Text style={styles.infoValue}>{t('settings.agentHubMemoryDesc', 'SOUL.md / MEMORY.md 持续沉淀')}</Text>
                </View>
                <View style={[styles.infoRow, { borderBottomWidth: 0 }]}>
                    <Text style={styles.infoLabel}>{t('settings.agentHubModel', '模型选择')}</Text>
                    <Text style={styles.infoValueMuted}>
                        {t('settings.agentHubModelDesc', '由服务端统一调度 (后续版本支持端侧切换)')}
                    </Text>
                </View>
            </View>
        </ScrollView>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: theme.colors.background,
    },
    content: {
        padding: theme.spacing.md,
    },
    headerCard: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: theme.colors.surface,
        borderRadius: theme.radius.sm,
        padding: theme.spacing.md,
        marginBottom: theme.spacing.md,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.03,
        shadowRadius: 4,
        elevation: 0.5,
    },
    headerIconWrap: {
        width: 44,
        height: 44,
        borderRadius: 22,
        backgroundColor: theme.colors.primaryLight,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: theme.spacing.md,
    },
    headerTextWrap: {
        flex: 1,
    },
    headerTitle: {
        fontSize: 16,
        fontWeight: 'bold',
        color: theme.colors.text,
        marginBottom: 2,
    },
    headerDesc: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        lineHeight: 18,
    },
    notConnectedBanner: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: '#FFF3E0',
        borderRadius: theme.radius.sm,
        padding: theme.spacing.md,
        marginBottom: theme.spacing.md,
        borderWidth: 1,
        borderColor: '#FFE0B2',
    },
    bannerIcon: {
        marginRight: theme.spacing.sm,
    },
    bannerTextWrap: {
        flex: 1,
    },
    bannerTitle: {
        fontSize: 14,
        fontWeight: 'bold',
        color: '#E65100',
    },
    bannerDesc: {
        fontSize: 12,
        color: '#BF360C',
        marginTop: 2,
    },
    card: {
        backgroundColor: theme.colors.surface,
        borderRadius: theme.radius.sm,
        padding: theme.spacing.md,
        marginBottom: theme.spacing.md,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.03,
        shadowRadius: 4,
        elevation: 0.5,
    },
    sectionTitleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: theme.spacing.md,
    },
    sectionTitleText: {
        fontSize: 15,
        fontWeight: 'bold',
        color: theme.colors.text,
        marginLeft: theme.spacing.sm,
    },
    switchingIndicator: {
        marginLeft: theme.spacing.sm,
    },
    modeOption: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: theme.radius.sm,
        padding: theme.spacing.md,
        backgroundColor: theme.colors.background,
    },
    modeOptionMarginTop: {
        marginTop: theme.spacing.sm,
    },
    modeOptionSelected: {
        borderColor: theme.colors.primary,
        backgroundColor: theme.colors.primaryLight + '30',
    },
    modeRadio: {
        marginRight: 10,
        marginTop: 2,
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
        marginBottom: 4,
    },
    modeTitle: {
        fontSize: 14,
        fontWeight: '600',
        color: theme.colors.text,
    },
    modeTitleActive: {
        color: theme.colors.primary,
    },
    recommendedBadge: {
        marginLeft: 8,
        backgroundColor: '#E8F5E9',
        paddingHorizontal: 6,
        paddingVertical: 1,
        borderRadius: 4,
    },
    recommendedBadgeText: {
        fontSize: 10,
        color: '#2E7D32',
        fontWeight: '600',
    },
    modeDesc: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        lineHeight: 18,
    },
    infoRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingVertical: 12,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
    },
    infoLabel: {
        fontSize: 14,
        color: theme.colors.text,
    },
    infoValue: {
        fontSize: 13,
        color: theme.colors.textSecondary,
        fontWeight: '500',
    },
    infoValueMuted: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        fontStyle: 'italic',
    },
});
