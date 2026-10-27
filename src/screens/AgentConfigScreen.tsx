import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import Icon from '@expo/vector-icons/MaterialIcons';
import { theme } from '../utils/theme';
import { useAssistantStore } from '../store/useAssistantStore';
import { AssistantClient } from '../services/AssistantClient';
import { AgentModelOption } from '../types/assistantProtocol';
import { RootStackParamList } from '../types/navigation';
import { SettingsRow, settingsGroupStyle } from '../components/SettingsRow';
import { OptionPickerModal, PickerOption } from '../components/OptionPickerModal';
import { useAgentRemoteSetting } from '../hooks/useAgentRemoteSetting';

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

    const permissionOptions: PickerOption[] = useMemo(
        () =>
            PERMISSION_MODES.map((mode) => ({
                key: mode,
                label: permissionLabel(mode),
                desc:
                    mode === 'danger-full-access'
                        ? t('assistant.permissionDangerBrief', {
                              defaultValue: '完整系统权限且免审批，适合运维与开发场景',
                          })
                        : t('assistant.permissionWorkspaceBrief', {
                              defaultValue: '仅在工作区内读写，敏感操作需审批',
                          }),
            })),
        // 权限选项固定且文案仅随语言变化
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [t]
    );

    const modelOptions: PickerOption[] = useMemo(
        () =>
            agentModelOptions.map((option: AgentModelOption) => ({
                key: `${option.provider}/${option.model}`,
                label: modelLabel(option),
                desc:
                    option.provider === 'deepseek-official'
                        ? t('assistant.modelDeepseekFlashDesc', {
                              defaultValue: 'DeepSeek 官方直连，响应快、成本低，适合日常任务',
                          })
                        : t('assistant.modelGptSolDesc', { defaultValue: '经第三方 Codex 路由接入的模型' }),
            })),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [agentModelOptions, t]
    );

    const openPicker = (picker: 'permission' | 'model') => {
        if (!serverUrl || !serverToken) {
            // 未配置服务：借 switchTo 的统一凭据检查给出提示，不打开弹层
            permissionSetting.switchTo('workspace-write');
            return;
        }
        setActivePicker(picker);
    };

    const modelValueText = modelSetting.value
        ? modelLabel(modelSetting.value)
        : agentModelOptions.length === 0
        ? t('assistant.remoteValuePending', { defaultValue: '读取中…' })
        : '—';

    return (
        <ScrollView style={styles.container} contentContainerStyle={styles.content}>
            {!isConnected && (
                <TouchableOpacity
                    style={styles.offlineHint}
                    onPress={() => navigation.navigate('AssistantConfig')}
                    activeOpacity={0.7}
                >
                    <Icon name="cloud-off" size={15} color="#E65100" />
                    <Text style={styles.offlineHintText}>
                        {t('settings.assistantDisconnected', { defaultValue: '服务端未连接' })}
                    </Text>
                    <Icon name="chevron-right" size={16} color="#E65100" />
                </TouchableOpacity>
            )}

            <View style={settingsGroupStyle.group}>
                <SettingsRow
                    label={t('assistant.permissionTitle', { defaultValue: '执行权限' })}
                    value={permissionSetting.value ? permissionLabel(permissionSetting.value) : undefined}
                    busy={permissionSetting.switching}
                    onPress={() => openPicker('permission')}
                />
                <View style={settingsGroupStyle.separator} />
                <SettingsRow
                    label={t('assistant.modelTitle', { defaultValue: '助理模型' })}
                    value={modelValueText}
                    busy={modelSetting.switching}
                    onPress={() => openPicker('model')}
                />
            </View>

            <OptionPickerModal
                visible={activePicker === 'permission'}
                title={t('assistant.permissionPickerTitle', { defaultValue: '选择执行权限' })}
                options={permissionOptions}
                selectedKey={permissionSetting.value ?? undefined}
                onSelect={(option) => permissionSetting.switchTo(option.key as PermissionMode)}
                onClose={() => setActivePicker(null)}
            />

            <OptionPickerModal
                visible={activePicker === 'model'}
                title={t('assistant.modelPickerTitle', { defaultValue: '选择助理模型' })}
                options={modelOptions}
                selectedKey={
                    modelSetting.value
                        ? `${modelSetting.value.provider}/${modelSetting.value.model}`
                        : undefined
                }
                onSelect={(option) => {
                    const separatorIndex = option.key.indexOf('/');
                    modelSetting.switchTo({
                        provider: option.key.slice(0, separatorIndex),
                        model: option.key.slice(separatorIndex + 1),
                    });
                }}
                onClose={() => setActivePicker(null)}
            />
        </ScrollView>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: theme.colors.background,
    },
    content: {
        padding: theme.spacing.m,
    },
    offlineHint: {
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'flex-start',
        marginBottom: theme.spacing.s,
        paddingVertical: 2,
    },
    offlineHintText: {
        fontSize: 12,
        color: '#E65100',
        marginHorizontal: 4,
    },
});
