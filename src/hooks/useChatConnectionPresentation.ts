import { useCallback, useEffect, useRef, useState } from 'react';
import { AssistantClient } from '../services/AssistantClient';
import { useAssistantStore } from '../store/useAssistantStore';
import {
    CONNECTING_GRACE_MS,
    MIN_STATUS_VISIBLE_MS,
    UNREACHABLE_BANNER_DELAY_MS,
    deriveTargetHeaderMode,
    isAuthConnectionError,
    type ChatConnectionBanner,
    type ChatHeaderConnectionMode,
} from '../utils/chatConnectionPresentation';

export interface ChatConnectionPresentation {
    headerMode: ChatHeaderConnectionMode;
    banner: ChatConnectionBanner;
    retryConnection: () => void;
}

/**
 * 协调主聊天导航顶栏与聊天区顶部横幅的连接状态提示：
 * 1) 正常建连前 2 秒静默不提示，避免冷启动/热切画面跳动；
 * 2) 超过 2 秒才在顶栏轻量显示「连接中…/更新中…」，出现后至少停留 0.6 秒；
 * 3) 明确无网络时立即在顶栏提示「等待网络…」；
 * 4) 仅在服务端升级、鉴权失败或连续 8 秒连不上时展开顶部横幅。
 */
export function useChatConnectionPresentation(): ChatConnectionPresentation {
    const serverUrl = useAssistantStore((state) => state.serverUrl);
    const credentialsStatus = useAssistantStore((state) => state.credentialsStatus);
    const connectionState = useAssistantStore((state) => state.connectionState);
    const connectionPhase = useAssistantStore((state) => state.connectionPhase);
    const connectionError = useAssistantStore((state) => state.connectionError);
    const connectionErrorKind = useAssistantStore((state) => state.connectionErrorKind);
    const isNetworkOffline = useAssistantStore((state) => state.isNetworkOffline);
    const isServerUpgrading = useAssistantStore((state) => state.isServerUpgrading);

    const hasServerConfig = Boolean(serverUrl);
    const credentialsReady = credentialsStatus === 'ready';
    const isAuthError = isAuthConnectionError(connectionState, connectionErrorKind);
    const targetHeaderMode = deriveTargetHeaderMode({
        hasServerConfig,
        credentialsReady,
        isServerUpgrading,
        connectionState,
        connectionPhase,
        connectionErrorKind,
        isNetworkOffline,
    });

    const [headerMode, setHeaderMode] = useState<ChatHeaderConnectionMode>(() => (
        targetHeaderMode === 'waiting_network' ? 'waiting_network' : 'title'
    ));
    const [showUnreachableBanner, setShowUnreachableBanner] = useState(false);
    const [unreachableWindowVersion, setUnreachableWindowVersion] = useState(0);

    const headerModeRef = useRef<ChatHeaderConnectionMode>(headerMode);
    const targetHeaderModeRef = useRef<ChatHeaderConnectionMode>(targetHeaderMode);
    targetHeaderModeRef.current = targetHeaderMode;

    const shownAtRef = useRef<number | null>(
        headerMode !== 'title' ? Date.now() : null,
    );
    const graceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const minHoldTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const unreachableTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const disconnectedSinceRef = useRef<number | null>(null);

    const commitHeaderMode = useCallback((next: ChatHeaderConnectionMode) => {
        const prev = headerModeRef.current;
        if (next === 'title') {
            shownAtRef.current = null;
        } else if (prev === 'title' || shownAtRef.current === null) {
            shownAtRef.current = Date.now();
        }
        headerModeRef.current = next;
        setHeaderMode(next);
    }, []);

    const clearGraceTimer = useCallback(() => {
        if (graceTimerRef.current) {
            clearTimeout(graceTimerRef.current);
            graceTimerRef.current = null;
        }
    }, []);

    const clearMinHoldTimer = useCallback(() => {
        if (minHoldTimerRef.current) {
            clearTimeout(minHoldTimerRef.current);
            minHoldTimerRef.current = null;
        }
    }, []);

    const clearUnreachableTimer = useCallback(() => {
        if (unreachableTimerRef.current) {
            clearTimeout(unreachableTimerRef.current);
            unreachableTimerRef.current = null;
        }
    }, []);

    useEffect(() => {
        const immediateTitleReset = !hasServerConfig || !credentialsReady || isServerUpgrading || isAuthError;
        if (immediateTitleReset) {
            clearGraceTimer();
            clearMinHoldTimer();
            commitHeaderMode('title');
            return;
        }

        if (targetHeaderMode === 'waiting_network') {
            clearGraceTimer();
            clearMinHoldTimer();
            commitHeaderMode('waiting_network');
            return;
        }

        if (targetHeaderMode === 'title') {
            // 已进入 connected：若顶栏尚未显示状态则继续保持标题；若已显示则确保至少停留 600ms。
            clearGraceTimer();
            if (headerModeRef.current === 'title') {
                clearMinHoldTimer();
                return;
            }
            const shownAt = shownAtRef.current;
            const elapsed = shownAt === null ? MIN_STATUS_VISIBLE_MS : Date.now() - shownAt;
            const remaining = MIN_STATUS_VISIBLE_MS - elapsed;
            if (remaining <= 0) {
                clearMinHoldTimer();
                commitHeaderMode('title');
                return;
            }
            if (!minHoldTimerRef.current) {
                minHoldTimerRef.current = setTimeout(() => {
                    minHoldTimerRef.current = null;
                    if (targetHeaderModeRef.current === 'title') {
                        commitHeaderMode('title');
                    }
                }, remaining);
            }
            return;
        }

        // 在线未连接（connecting / updating）：
        clearMinHoldTimer();
        if (headerModeRef.current !== 'title') {
            // 已经处于可见状态（例如由 waiting_network 恢复联网，或 connecting -> updating），直接刷新文案。
            clearGraceTimer();
            if (headerModeRef.current !== targetHeaderMode) {
                commitHeaderMode(targetHeaderMode);
            }
            return;
        }

        // 仍在静默期内：同一未连接周期内不重置 2 秒计时器。
        if (!graceTimerRef.current) {
            graceTimerRef.current = setTimeout(() => {
                graceTimerRef.current = null;
                const latest = targetHeaderModeRef.current;
                if (latest !== 'title') {
                    commitHeaderMode(latest);
                }
            }, CONNECTING_GRACE_MS);
        }
    }, [
        hasServerConfig,
        credentialsReady,
        isServerUpgrading,
        isAuthError,
        targetHeaderMode,
        clearGraceTimer,
        clearMinHoldTimer,
        commitHeaderMode,
    ]);

    useEffect(() => {
        const shouldWaitForReachability =
            hasServerConfig
            && credentialsReady
            && !isServerUpgrading
            && !isAuthError
            && !isNetworkOffline
            && connectionState !== 'connected';

        if (!shouldWaitForReachability) {
            clearUnreachableTimer();
            disconnectedSinceRef.current = null;
            setShowUnreachableBanner(false);
            return;
        }

        if (showUnreachableBanner) {
            clearUnreachableTimer();
            return;
        }

        const now = Date.now();
        if (disconnectedSinceRef.current === null) {
            disconnectedSinceRef.current = now;
        }
        const elapsed = now - disconnectedSinceRef.current;
        const remaining = UNREACHABLE_BANNER_DELAY_MS - elapsed;
        if (remaining <= 0) {
            clearUnreachableTimer();
            setShowUnreachableBanner(true);
            return;
        }

        if (!unreachableTimerRef.current) {
            unreachableTimerRef.current = setTimeout(() => {
                unreachableTimerRef.current = null;
                setShowUnreachableBanner(true);
            }, remaining);
        }
    }, [
        hasServerConfig,
        credentialsReady,
        isServerUpgrading,
        isAuthError,
        isNetworkOffline,
        connectionState,
        showUnreachableBanner,
        unreachableWindowVersion,
        clearUnreachableTimer,
    ]);

    useEffect(() => () => {
        clearGraceTimer();
        clearMinHoldTimer();
        clearUnreachableTimer();
    }, [clearGraceTimer, clearMinHoldTimer, clearUnreachableTimer]);

    const retryConnection = useCallback(() => {
        clearUnreachableTimer();
        disconnectedSinceRef.current = Date.now();
        setShowUnreachableBanner(false);
        setUnreachableWindowVersion((v) => v + 1);
        AssistantClient.getInstance().connect(true).catch(() => {});
    }, [clearUnreachableTimer]);

    let banner: ChatConnectionBanner = { kind: 'none' };
    if (hasServerConfig && credentialsReady) {
        if (isServerUpgrading) {
            banner = { kind: 'upgrading' };
        } else if (isAuthError) {
            banner = { kind: 'auth_error', message: connectionError };
        } else if (!isNetworkOffline && connectionState !== 'connected' && showUnreachableBanner) {
            banner = { kind: 'unreachable' };
        }
    }

    return {
        headerMode,
        banner,
        retryConnection,
    };
}
