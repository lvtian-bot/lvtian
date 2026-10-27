import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { theme } from '../utils/theme';
import { useAssistantStore } from '../store/useAssistantStore';
import { AssistantClient } from '../services/AssistantClient';
import { type AgentModelOption } from '../types/assistantProtocol';
import { RootStackParamList } from '../types/navigation';
import { useAgentRemoteSetting } from '../hooks/useAgentRemoteSetting';
import {
    SettingsChoice,
    SettingsGroup,
    SettingsGroupLabel,
    SettingsRow,
    SettingsSheet,
    SettingsStatusCard,
} from '../components/settings';

type NavigationProp = NativeStackNavigationProp<RootStackParamList>;
type PermissionMode = 'workspace-write' | 'danger-full-access';
type ModelSelection = { provider: string; model: string };

const PERMISSION_MODES: PermissionMode[] = ['workspace-write', 'danger-full-access'];

export const AgentConfigScreen = () => {
    const { t } = useTranslation();
    const navigation = useNavigation<NavigationProp>();
    const {
        serverUrl,
        serverToken,
        connectionState,
        setPermissionMode,
        agentModelOptions,
    } = useAssistantStore();

    const isConnected = connectionState === 'connected';

    const permissionLabel = (mode: PermissionMode): string =>
        mode === 'danger-full-access'
            ? t('assistant.permissionDanger', { defaultValue: '完全权限模式' })
            : t('assistant.permissionWorkspace', { defaultValue: '安全工作区模式' });

    const modelLabel = (selection: ModelSelection): string => {
        if (selection.provider === 'deepseek-official' && selection.model === 'deepseek-flash') {
            return t('assistant.modelDeepseekFlashName', { defaultValue: 'DeepSeek V4.1-Flash' });
        }
        if (selection.provider === 'openai-codex' && selection.model === 'gpt-6.1-sol') {
            return t('assistant.modelGptSolName', { defaultValue: 'GPT-6.1-Sol' });
        }
        return selection.model;
    };

    const modelDesc = (option: AgentModelOption): string =>
        option.provider === 'deepseek-official'
            ? t('assistant.modelDeepseekFlashDesc', {
                  defaultValue: 'DeepSeek 官方直连，响应快、成本低，适合日常任务',
              })
            : t('assistant.modelGptSolDesc', { defaultValue: '经第三方 Codex 路由接入的模型' });

    // 权限与模型共用同一套远程设置状态机：本地缓存秒显、连接后核对、切换与超时核对
    const permissionSetting = useAgentRemoteSetting<PermissionMode>({
        readLocal: () => useAssistantStore.getState().permissionMode,
        writeLocal: setPermissionMode,
        fetchRemote: AssistantClient.fetchPermissionMode,
        applyRemote: (url, token, mode) => AssistantClient.updatePermissionMode(url, token, mode),
        isSameValue: (a, b) => a === b,
        confirmBeforeApply: (mode) =>
            mode === 'danger-full-access'
                ? {
                      title: t('assistant.permissionDangerAlertTitle', { defaultValue: '确认切换至完全权限？' }),
                      content: t('assistant.permissionDangerAlertContent', {
                          defaultValue:
                              '切换后助理将拥有当前服务器用户的所有执行权限，并为您即时生成当前对话的心智备忘录以接力新会话。是否继续？',
                      }),
                      confirmText: t('common.confirm', { defaultValue: '确认切换' }),
                      cancelText: t('common.cancel', { defaultValue: '取消' }),
                  }
                : null,
        texts: {
            valueLabel: permissionLabel,
            noticeTitle: t('settings.notice', { defaultValue: '提示' }),
            successTitle: t('settings.success', { defaultValue: '成功' }),
            unconfiguredNotice: t('assistant.remoteUnconfigured', {
                defaultValue: '请先配置并连接服务，再调整服务端设置',
            }),
            taskRunning: t('assistant.remoteTaskRunning', {
                defaultValue: '当前有正在执行的任务，请先停止任务后再切换设置',
            }),
            applySuccess: t('assistant.remoteApplySuccess', { defaultValue: '已切换并完成会话交接' }),
            applyFailed: t('assistant.remoteApplyFailed', { defaultValue: '切换失败，请检查服务连接' }),
            applyUnconfirmed: t('assistant.remoteUnconfirmed', {
                defaultValue: '切换请求超时，结果未确认；请稍后重新查看实际生效值',
            }),
            applySettledDifferent: (actual) =>
                t('assistant.remoteSettledDifferent', {
                    defaultValue: '切换请求超时，服务端当前实际生效为「{{label}}」，已按服务端状态刷新',
                    label: actual,
                }),
        },
    });

    const modelSetting = useAgentRemoteSetting<ModelSelection>({
        readLocal: () => useAssistantStore.getState().agentModelSelection,
        writeLocal: (selection) => useAssistantStore.getState().setAgentModelSelection(selection),
        fetchRemote: async (url, token) => {
            const data = await AssistantClient.fetchModelSelection(url, token);
            if (!data) return null;
            useAssistantStore.getState().setAgentModelOptions(data.options);
            return { provider: data.provider, model: data.model };
        },
        applyRemote: (url, token, selection) =>
            AssistantClient.updateModelSelection(url, token, selection.provider, selection.model),
        isSameValue: (a, b) => a.provider === b.provider && a.model === b.model,
        confirmBeforeApply: (selection) => ({
            title: t('assistant.modelSwitchConfirmTitle', { defaultValue: '确认切换模型？' }),
            content: t('assistant.modelSwitchConfirmContent', {
                defaultValue: '切换将重启助理会话并自动提炼备忘录无缝接力。确认切换到「{{model}}」？',
                model: modelLabel(selection),
            }),
            confirmText: t('common.confirm', { defaultValue: '确认' }),
            cancelText: t('common.cancel', { defaultValue: '取消' }),
        }),
        texts: {
            valueLabel: modelLabel,
            noticeTitle: t('settings.notice', { defaultValue: '提示' }),
            successTitle: t('settings.success', { defaultValue: '成功' }),
            unconfiguredNotice: t('assistant.remoteUnconfigured', {
                defaultValue: '请先配置并连接服务，再调整服务端设置',
            }),
            taskRunning: t('assistant.remoteTaskRunning', {
                defaultValue: '当前有正在执行的任务，请先停止任务后再切换设置',
            }),
            applySuccess: t('assistant.remoteApplySuccess', { defaultValue: '已切换并完成会话交接' }),
            applyFailed: t('assistant.remoteApplyFailed', { defaultValue: '切换失败，请检查服务连接' }),
            applyUnconfirmed: t('assistant.remoteUnconfirmed', {
                defaultValue: '切换请求超时，结果未确认；请稍后重新查看实际生效值',
            }),
            applySettledDifferent: (actual) =>
                t('assistant.remoteSettledDifferent', {
                    defaultValue: '切换请求超时，服务端当前实际生效为「{{label}}」，已按服务端状态刷新',
                    label: actual,
                }),
        },
    });

    const [activePicker, setActivePicker] = useState<'permission' | 'model' | null>(null);

    const openPicker = (picker: 'permission' | 'model') => {
        if (!serverUrl || !serverToken) {
            // 未配置服务：借 switchTo 的统一凭据检查给出提示，不打开弹层
            permissionSetting.switchTo('workspace-write');
            return;
        }
        // 打开弹层前重查服务端：选中标记立即对齐实际生效值，上次核对失败时此处即为重试入口
        (picker === 'permission' ? permissionSetting : modelSetting).refresh();
        setActivePicker(picker);
    };

    const modelValueText = modelSetting.value
        ? modelLabel(modelSetting.value)
        : agentModelOptions.length === 0
        ? t('assistant.remoteValuePending', { defaultValue: '读取中…' })
        : '—';

    const permissionSelected = permissionSetting.value ?? 'workspace-write';

    return (
        <View style={styles.container}>
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
                        ? `${t('assistant.currentModel', '当前模型')} · ${modelValueText}`
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
                    value={permissionSetting.value ? permissionLabel(permissionSetting.value) : undefined}
                    busy={permissionSetting.switching}
                    onPress={() => openPicker('permission')}
                />
                <SettingsRow
                    icon="chip"
                    title={t('assistant.modelTitle', '助理模型')}
                    value={modelValueText}
                    busy={modelSetting.switching}
                    onPress={() => openPicker('model')}
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

            <SettingsSheet
                visible={activePicker === 'permission'}
                title={t('assistant.permissionRow', '执行权限')}
                onClose={() => setActivePicker(null)}
            >
                <View style={styles.choices}>
                    {PERMISSION_MODES.map((mode) => (
                        <SettingsChoice
                            key={mode}
                            title={permissionLabel(mode)}
                            desc={
                                mode === 'danger-full-access'
                                    ? t('assistant.permissionDangerBrief', {
                                          defaultValue: '完整系统权限且免审批，适合运维与开发场景',
                                      })
                                    : t('assistant.permissionWorkspaceBrief', {
                                          defaultValue: '仅在工作区内读写，敏感操作需审批',
                                      })
                            }
                            badge={mode === 'workspace-write' ? t('common.recommended') : undefined}
                            danger={mode === 'danger-full-access'}
                            selected={permissionSelected === mode}
                            onPress={() => {
                                setActivePicker(null);
                                permissionSetting.switchTo(mode);
                            }}
                        />
                    ))}
                </View>
            </SettingsSheet>

            <SettingsSheet
                visible={activePicker === 'model'}
                title={t('assistant.modelTitle', '助理模型')}
                onClose={() => setActivePicker(null)}
            >
                <View style={styles.choices}>
                    {agentModelOptions.length === 0 ? (
                        <TouchableOpacity
                            style={styles.loadingButton}
                            onPress={() => modelSetting.refresh()}
                            activeOpacity={0.7}
                        >
                            <Text style={styles.loadingText}>
                                {t('assistant.remoteValuePending', { defaultValue: '读取中…' })}
                            </Text>
                            <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                        </TouchableOpacity>
                    ) : (
                        agentModelOptions.map((option: AgentModelOption) => {
                            return (
                                <SettingsChoice
                                    key={`${option.provider}/${option.model}`}
                                    title={modelLabel(option)}
                                    desc={modelDesc(option)}
                                    selected={Boolean(
                                        modelSetting.value
                                            && modelSetting.value.provider === option.provider
                                            && modelSetting.value.model === option.model
                                    )}
                                    onPress={() => {
                                        setActivePicker(null);
                                        modelSetting.switchTo({
                                            provider: option.provider,
                                            model: option.model,
                                        });
                                    }}
                                />
                            );
                        })
                    )}
                </View>
            </SettingsSheet>
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: theme.colors.background,
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
});
