import type { ConnectionErrorKind, ConnectionPhase, ConnectionState } from '../types/assistantProtocol';

export const CONNECTING_GRACE_MS = 2000;
export const MIN_STATUS_VISIBLE_MS = 600;
export const UNREACHABLE_BANNER_DELAY_MS = 8000;

export type ChatHeaderConnectionMode = 'title' | 'connecting' | 'updating' | 'waiting_network';

export type ChatConnectionBanner =
    | { kind: 'none' }
    | { kind: 'upgrading' }
    | { kind: 'auth_error'; message: string | null }
    | { kind: 'unreachable' };

export interface HeaderModeInput {
    hasServerConfig: boolean;
    credentialsReady: boolean;
    isServerUpgrading: boolean;
    connectionState: ConnectionState;
    connectionPhase: ConnectionPhase | null;
    connectionErrorKind: ConnectionErrorKind | null;
    isNetworkOffline: boolean;
}

/**
 * 判断当前是否属于需要人工修改配置的认证失败。
 */
export function isAuthConnectionError(
    connectionState: ConnectionState,
    connectionErrorKind: ConnectionErrorKind | null,
): boolean {
    return connectionState === 'error' && connectionErrorKind === 'auth';
}

/**
 * 推导非静默期下顶栏应展示的目标连接模式（未考虑 2s 宽限与 0.6s 最小停留）。
 */
export function deriveTargetHeaderMode(input: HeaderModeInput): ChatHeaderConnectionMode {
    if (
        !input.hasServerConfig
        || !input.credentialsReady
        || input.isServerUpgrading
        || isAuthConnectionError(input.connectionState, input.connectionErrorKind)
        || input.connectionState === 'connected'
    ) {
        return 'title';
    }
    if (input.isNetworkOffline) {
        return 'waiting_network';
    }
    return input.connectionPhase === 'sync' ? 'updating' : 'connecting';
}
