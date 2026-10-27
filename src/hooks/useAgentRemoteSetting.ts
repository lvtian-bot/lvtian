import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import { useAssistantStore } from '../store/useAssistantStore';

/** 切换请求的服务端返回；未确认特指超时中止（服务端可能已写入，须重查核对） */
export interface RemoteApplyResult {
    success: boolean;
    changed?: boolean;
    code?: string;
    message?: string;
}

/** 切换前可选的二次确认弹窗内容（如完全权限的高危确认） */
export interface ConfirmSpec {
    title: string;
    content: string;
    confirmText: string;
    cancelText: string;
}

/** Hook 输出给页面的文案与取值映射：文案由页面以 i18n 提供，Hook 不感知具体设置项 */
export interface RemoteSettingTexts<T> {
    /** 值的展示名（用于弹层选择、超时核对后的差异提示） */
    valueLabel: (value: T) => string;
    noticeTitle: string;
    successTitle: string;
    unconfiguredNotice: string;
    taskRunning: string;
    applySuccess: string;
    applyFailed: string;
    applyUnconfirmed: string;
    /** 超时核对后发现服务端实际值与目标不同：提示“实际生效为 X，已按服务端刷新” */
    applySettledDifferent: (actualLabel: string) => string;
}

export interface RemoteSettingDefinition<T> {
    /** 从 store 读取本地持久化值（进页秒显），返回 null 表示本地尚无值 */
    readLocal: () => T | null;
    /** 将值写入 store 持久化 */
    writeLocal: (value: T) => void;
    /** 向服务端核对当前值（含可选项清单的写入 store），失败返回 null */
    fetchRemote: (serverUrl: string, serverToken: string) => Promise<T | null>;
    /** 发起切换，返回服务端结果 */
    applyRemote: (serverUrl: string, serverToken: string, value: T) => Promise<RemoteApplyResult>;
    /** 值相同判定（目标与当前一致时视为无需切换） */
    isSameValue: (a: T, b: T) => boolean;
    /** 可选：切换前二次确认（返回 null 则直接切换） */
    confirmBeforeApply?: (value: T) => ConfirmSpec | null;
    texts: RemoteSettingTexts<T>;
}

export interface AgentRemoteSetting<T> {
    /** 当前生效值：本地持久化秒显，连接后随服务端核对更新 */
    value: T | null;
    /** 切换请求进行中（行右侧加载指示） */
    switching: boolean;
    /** 手动重查入口（如首次核对失败后的重试） */
    refresh: () => void;
    /**
     * 发起切换：负责任务运行门禁、凭据检查、二次确认、请求与超时核对，
     * 并以 Alert 反馈结果；页面只管调用，不再各自实现状态机。
     */
    switchTo: (value: T) => void;
}

/**
 * 服务端远程设置项的统一状态机（权限模式、助理模型等共用）：
 * - 进页用 store 持久化值秒显，连接就绪后向服务端核对并静默更新；
 * - 本地切换仅丢弃切换前发起的过期核对结果，之后发起的核对始终如实跟随服务端；
 * - 切换请求超时不判失败：服务端可能已写入，立即重查核对实际生效值并对齐本地。
 * 两个设置项通过传入各自 definition 复用同一实现，页面层不写平行逻辑。
 */
export function useAgentRemoteSetting<T>(definition: RemoteSettingDefinition<T>): AgentRemoteSetting<T> {
    const { serverUrl, serverToken, connectionState } = useAssistantStore();
    const [value, setValue] = useState<T | null>(() => definition.readLocal());
    const [switching, setSwitching] = useState(false);
    /** 用户最近一次本地切换时刻：仅用于丢弃在此之前发起的过期核对响应 */
    const lastLocalSwitchAtRef = useRef(0);
    const switchingRef = useRef(false);

    const { fetchRemote, applyRemote, texts, isSameValue, writeLocal } = definition;

    const refresh = useCallback(() => {
        const url = useAssistantStore.getState().serverUrl;
        const token = useAssistantStore.getState().serverToken;
        if (!url || !token) {
            return;
        }
        const requestedAt = Date.now();
        fetchRemote(url, token).then((remote) => {
            if (remote !== null && requestedAt >= lastLocalSwitchAtRef.current) {
                setValue(remote);
                writeLocal(remote);
            }
        });
    }, [fetchRemote, writeLocal]);

    const isConnected = connectionState === 'connected';
    useEffect(() => {
        if (isConnected) {
            refresh();
        }
    }, [isConnected, serverUrl, serverToken, refresh]);

    const applyNow = useCallback(
        async (url: string, token: string, target: T) => {
            setSwitching(true);
            switchingRef.current = true;
            try {
                const res = await applyRemote(url, token, target);
                if (res.success) {
                    lastLocalSwitchAtRef.current = Date.now();
                    setValue(target);
                    writeLocal(target);
                    Alert.alert(texts.successTitle, texts.applySuccess);
                    return;
                }
                if (res.code === 'REQUEST_UNCONFIRMED') {
                    // 超时中止：服务端可能已写入，重查核对实际生效值并对齐
                    const remote = await fetchRemote(url, token);
                    if (remote !== null) {
                        setValue(remote);
                        writeLocal(remote);
                        if (isSameValue(remote, target)) {
                            lastLocalSwitchAtRef.current = Date.now();
                            Alert.alert(texts.successTitle, texts.applySuccess);
                        } else {
                            Alert.alert(texts.noticeTitle, texts.applySettledDifferent(texts.valueLabel(remote)));
                        }
                    } else {
                        Alert.alert(texts.noticeTitle, texts.applyUnconfirmed);
                    }
                    return;
                }
                Alert.alert(
                    texts.noticeTitle,
                    res.code === 'TASK_RUNNING' ? texts.taskRunning : texts.applyFailed
                );
            } catch {
                Alert.alert(texts.noticeTitle, texts.applyFailed);
            } finally {
                setSwitching(false);
                switchingRef.current = false;
            }
        },
        [applyRemote, fetchRemote, isSameValue, texts, writeLocal]
    );

    const switchTo = useCallback(
        (target: T) => {
            const { serverUrl: url, serverToken: token, taskState: task } = useAssistantStore.getState();
            if (!url || !token) {
                Alert.alert(texts.noticeTitle, texts.unconfiguredNotice);
                return;
            }
            if (switchingRef.current) {
                return;
            }
            if (task === 'processing' || task === 'awaiting_approval') {
                Alert.alert('', texts.taskRunning);
                return;
            }
            if (value !== null && isSameValue(value, target)) {
                return;
            }

            const confirm = definition.confirmBeforeApply?.(target) ?? null;
            if (confirm) {
                Alert.alert(confirm.title, confirm.content, [
                    { text: confirm.cancelText, style: 'cancel' },
                    { text: confirm.confirmText, onPress: () => applyNow(url, token, target) },
                ]);
            } else {
                applyNow(url, token, target);
            }
        },
        [applyNow, definition, isSameValue, texts, value]
    );

    return { value, switching, refresh, switchTo };
}
