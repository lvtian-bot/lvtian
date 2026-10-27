import React, { useState, useEffect, useRef, useCallback } from 'react';
import { View, Text, StyleSheet, ScrollView, Alert, TouchableOpacity, ActivityIndicator } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { theme } from '../utils/theme';
import { useAssistantStore } from '../store/useAssistantStore';
import { AssistantClient } from '../services/AssistantClient';
import { type AgentModelOption } from '../types/assistantProtocol';
import { RootStackParamList } from '../types/navigation';
import {
    SettingsChoice,
    SettingsGroup,
    SettingsGroupLabel,
    SettingsRow,
    SettingsSheet,
    SettingsStatusCard,
    SettingsToast,
    useSettingsToast,
} from '../components/settings';

type NavigationProp = NativeStackNavigationProp<RootStackParamList>;

export const AgentConfigScreen = () => {
    const { t } = useTranslation();
    const navigation = useNavigation<NavigationProp>();
    const { toast, showToast } = useSettingsToast();
    const {
        serverUrl,
        serverToken,
        permissionMode,
        setPermissionMode,
        agentModelSelection,
        setAgentModelSelection,
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

    const [selectedModel, setSelectedModel] = useState<{ provider: string; model: string } | null>(
        agentModelSelection
    );
    const [modelOptions, setModelOptions] = useState<AgentModelOption[]>([]);
    const [switchingModel, setSwitchingModel] = useState(false);
    const [openSheet, setOpenSheet] = useState<'perm' | 'model' | null>(null);
    /** 用户最近一次本地切换模型的时刻：仅用于丢弃在此之前发起的过期查询结果 */
    const lastModelSwitchAtRef = useRef(0);

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

    /**
     * 拉取服务端模型选项与当前选择。
     * 依赖连接状态：断网或首次查询失败时弹层停留加载态，连接恢复后自动重查；
     * 加载行亦可点击手动重试。仅丢弃在用户本地切换之前发起的过期查询结果，
     * 其后发起的重连查询始终如实反映服务端状态（含其他客户端的修改）。
     */
    const loadModelSelection = useCallback(() => {
        if (!serverUrl || !serverToken) {
            return;
        }
        const requestedAt = Date.now();
        AssistantClient.fetchModelSelection(serverUrl, serverToken).then((data) => {
            if (data && requestedAt >= lastModelSwitchAtRef.current) {
                setModelOptions(data.options);
                const selection = { provider: data.provider, model: data.model };
                setSelectedModel(selection);
                setAgentModelSelection(selection);
            }
        });
    }, [serverUrl, serverToken, setAgentModelSelection]);

    useEffect(() => {
        if (isConnected) {
            loadModelSelection();
        }
    }, [isConnected, loadModelSelection]);

    /** 已知模型组合映射为本地化名称与说明，未知组合回退展示原始模型 ID */
    const resolveModelPresentation = (option: AgentModelOption): { title: string; desc: string } => {
        if (option.provider === 'deepseek-official' && option.model === 'deepseek-flash') {
            return {
                title: t('assistant.modelDeepseekFlashName', { defaultValue: 'DeepSeek V4.1-Flash' }),
                desc: t('assistant.modelDeepseekFlashDesc', {
                    defaultValue: 'DeepSeek 官方直连，响应快、成本低，适合日常任务。',
                }),
            };
        }
        if (option.provider === 'openai-codex' && option.model === 'gpt-6.1-sol') {
            return {
                title: t('assistant.modelGptSolName', { defaultValue: 'GPT-6.1-Sol' }),
                desc: t('assistant.modelGptSolDesc', {
                    defaultValue: '经第三方 Codex 路由接入的模型。',
                }),
            };
        }
        return {
            title: option.model,
            desc: t('assistant.modelUnknownDesc', { defaultValue: '服务端当前启用的模型。' }),
        };
    };

    const applyModelSwitch = async (option: AgentModelOption) => {
        if (!serverUrl || !serverToken) {
            showToast(t('assistant.serverConfigRequiredForModel'));
            return;
        }

        setSwitchingModel(true);
        try {
            const res = await AssistantClient.updateModelSelection(serverUrl, serverToken, option.provider, option.model);
            if (res.success) {
                setSwitchingModel(false);
                lastModelSwitchAtRef.current = Date.now();
                setSelectedModel(option);
                setAgentModelSelection(option);
                setOpenSheet(null);
                showToast(t('assistant.modelSwitchSuccess', { defaultValue: '模型已切换，新会话即刻生效' }));
                return;
            }

            // 超时中止不代表切换失败：服务端在交接前已写入新配置，须重查核对实际生效模型
            if (res.code === 'MODEL_SWITCH_UNCONFIRMED') {
                const remote = await AssistantClient.fetchModelSelection(serverUrl, serverToken);
                setSwitchingModel(false);
                if (remote) {
                    const actual = { provider: remote.provider, model: remote.model };
                    setModelOptions(remote.options);
                    setSelectedModel(actual);
                    setAgentModelSelection(actual);
                    setOpenSheet(null);
                    if (actual.provider === option.provider && actual.model === option.model) {
                        lastModelSwitchAtRef.current = Date.now();
                        showToast(t('assistant.modelSwitchSuccess', { defaultValue: '模型已切换，新会话即刻生效' }));
                    } else {
                        Alert.alert(
                            t('settings.notice', { defaultValue: '提示' }),
                            t('assistant.modelSwitchSettled', {
                                defaultValue:
                                    '切换请求超时，服务端当前实际生效模型为「{{model}}」，已按服务端状态刷新',
                                model: resolveModelPresentation(actual).title,
                            })
                        );
                    }
                } else {
                    Alert.alert(
                        t('settings.notice', { defaultValue: '提示' }),
                        t('assistant.modelSwitchUnconfirmed', {
                            defaultValue: '切换请求超时，结果未确认；请稍后重新进入本页查看实际生效模型',
                        })
                    );
                }
                return;
            }

            setSwitchingModel(false);
            const failMessage = res.code === 'TASK_RUNNING'
                ? t('assistant.taskRunningCannotSwitchModel', {
                      defaultValue: '当前有正在执行的任务，请先在聊天界面停止任务后再切换模型',
                  })
                : t('assistant.modelSwitchFailed', { defaultValue: '切换模型失败，请检查服务连接' });
            Alert.alert(t('settings.failure', { defaultValue: '失败' }), failMessage);
        } catch {
            setSwitchingModel(false);
            Alert.alert(
                t('settings.failure', { defaultValue: '失败' }),
                t('assistant.modelSwitchFailed', { defaultValue: '切换模型失败，请检查服务连接' })
            );
        }
    };

    const handleSelectModel = (option: AgentModelOption) => {
        if (switchingModel || !isConnected) {
            return;
        }
        if (selectedModel && selectedModel.provider === option.provider && selectedModel.model === option.model) {
            setOpenSheet(null);
            return;
        }
        if (isTaskRunning) {
            Alert.alert(
                t('settings.failure', { defaultValue: '失败' }),
                t('assistant.taskRunningCannotSwitchModel', {
                    defaultValue: '当前有正在执行的任务，请先在聊天界面停止任务后再切换模型',
                })
            );
            return;
        }
        const { title } = resolveModelPresentation(option);
        Alert.alert(
            t('assistant.modelSwitchConfirmTitle', { defaultValue: '确认切换模型？' }),
            t('assistant.modelSwitchConfirmContent', {
                defaultValue:
                    '切换模型将重启助理会话：当前对话会自动提炼备忘录并无缝接力；有任务运行时需先停止。确认切换到「{{model}}」？',
                model: title,
            }),
            [
                { text: t('common.cancel', { defaultValue: '取消' }), style: 'cancel' },
                {
                    text: t('common.confirm', { defaultValue: '确认' }),
                    onPress: () => applyModelSwitch(option),
                },
            ]
        );
    };

    const applyPermissionSwitch = async (targetMode: 'workspace-write' | 'danger-full-access') => {
        if (!serverUrl || !serverToken) {
            showToast(t('assistant.serverConfigRequiredFirst'));
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
                setOpenSheet(null);
                showToast(t('assistant.permissionSwitchSuccess', '权限已成功切换并完成会话交接'));
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
        if (switchingPerm) {
            return;
        }
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

    const handleRowPress = (sheet: 'perm' | 'model') => {
        if (!isConnected) {
            showToast(t('assistant.serverConfigRequiredFirst'));
            return;
        }
        setOpenSheet(sheet);
    };

    const permDisplay = selectedMode === 'danger-full-access'
        ? t('assistant.permissionDanger', '完全权限模式')
        : t('assistant.permissionWorkspace', '安全工作区模式');
    const modelDisplay = selectedModel
        ? resolveModelPresentation(selectedModel).title
        : t('assistant.modelNotLoaded', '未读取');

    return (
        <View style={styles.container}>
            <ScrollView contentContainerStyle={styles.content}>
                <SettingsStatusCard
                    icon="robot"
                    tone={isConnected ? 'success' : 'muted'}
                    title={
                        isConnected
                            ? t('settings.agentOnline', '智能体在线')
                            : t('settings.agentOffline', '智能体未连接')
                    }
                    subtitle={
                        isConnected
                            ? `${t('assistant.currentModel', '当前模型')} · ${modelDisplay}`
                            : t('settings.agentOfflineDesc', '请先配置并连接服务端')
                    }
                    badge={isConnected ? t('assistant.badgeConnected', '已连接') : t('assistant.badgeDisconnected', '未连接')}
                    onPress={isConnected ? undefined : () => navigation.navigate('AssistantConfig')}
                />

                <SettingsGroupLabel>{t('settings.agentExecGroup', '助理执行')}</SettingsGroupLabel>
                <SettingsGroup>
                    <SettingsRow
                        icon="shield-check-outline"
                        title={t('assistant.permissionRow', '执行权限')}
                        value={permDisplay}
                        onPress={() => handleRowPress('perm')}
                    />
                    <SettingsRow
                        icon="chip"
                        title={t('assistant.modelTitle', '助理模型')}
                        value={modelDisplay}
                        onPress={() => handleRowPress('model')}
                        last
                    />
                </SettingsGroup>

                <SettingsGroupLabel>{t('settings.agentHubGroup', '中枢与记忆')}</SettingsGroupLabel>
                <SettingsGroup>
                    <SettingsRow
                        icon="hub"
                        title={t('settings.agentHubEngine', '执行中枢')}
                        value={t('settings.agentHubEngineDesc', 'DeepSeek Harness (ACP 协议)')}
                    />
                    <SettingsRow
                        icon="brain"
                        title={t('settings.agentHubMemory', '长期记忆')}
                        value={t('settings.agentHubMemoryDesc', 'SOUL.md / MEMORY.md 持续沉淀')}
                        last
                    />
                </SettingsGroup>

                <Text style={styles.note}>
                    {t('settings.agentSwitchNote', '切换权限或模型会重启助理会话，当前对话将自动提炼备忘录并无缝接力。')}
                </Text>
            </ScrollView>

            <SettingsSheet
                visible={openSheet === 'perm'}
                title={t('assistant.permissionRow', '执行权限')}
                onClose={() => setOpenSheet(null)}
            >
                <View style={styles.choices}>
                    <SettingsChoice
                        title={t('assistant.permissionWorkspace', '安全工作区模式')}
                        desc={t('assistant.permissionWorkspaceDesc')}
                        badge={t('common.recommended')}
                        selected={selectedMode === 'workspace-write'}
                        disabled={switchingPerm}
                        onPress={() => handleSelectMode('workspace-write')}
                    />
                    <SettingsChoice
                        title={t('assistant.permissionDanger', '完全权限模式')}
                        desc={t('assistant.permissionDangerDesc')}
                        danger
                        selected={selectedMode === 'danger-full-access'}
                        disabled={switchingPerm}
                        onPress={() => handleSelectMode('danger-full-access')}
                    />
                    {switchingPerm ? (
                        <View style={styles.switchingRow}>
                            <ActivityIndicator size="small" color={theme.colors.primary} />
                        </View>
                    ) : null}
                </View>
            </SettingsSheet>

            <SettingsSheet
                visible={openSheet === 'model'}
                title={t('assistant.modelTitle', '助理模型')}
                onClose={() => setOpenSheet(null)}
            >
                <View style={styles.choices}>
                    {modelOptions.length === 0 ? (
                        <TouchableOpacity
                            style={styles.loadingButton}
                            onPress={loadModelSelection}
                            activeOpacity={0.7}
                        >
                            <Text style={styles.loadingText}>
                                {t('assistant.modelLoading', { defaultValue: '正在读取服务端模型配置...' })}
                            </Text>
                            <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                        </TouchableOpacity>
                    ) : (
                        modelOptions.map((option) => {
                            const isSelected = Boolean(
                                selectedModel
                                    && selectedModel.provider === option.provider
                                    && selectedModel.model === option.model
                            );
                            const { title, desc } = resolveModelPresentation(option);
                            return (
                                <SettingsChoice
                                    key={`${option.provider}/${option.model}`}
                                    title={title}
                                    desc={desc}
                                    selected={isSelected}
                                    disabled={switchingModel}
                                    onPress={() => handleSelectModel(option)}
                                />
                            );
                        })
                    )}
                    {switchingModel ? (
                        <View style={styles.switchingRow}>
                            <ActivityIndicator size="small" color={theme.colors.primary} />
                        </View>
                    ) : null}
                </View>
            </SettingsSheet>

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
    choices: {
        paddingHorizontal: 12,
        paddingBottom: 8,
    },
    note: {
        fontSize: 12,
        color: '#9AA3B2',
        lineHeight: 18,
        textAlign: 'center',
        marginTop: 14,
        marginHorizontal: 8,
    },
    loadingButton: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        paddingVertical: 10,
    },
    loadingText: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        fontStyle: 'italic',
    },
    switchingRow: {
        paddingVertical: 6,
        alignItems: 'center',
    },
});
