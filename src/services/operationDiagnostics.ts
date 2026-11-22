import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Updates from 'expo-updates';

export type OperationReasons = {
    credentials:
        | 'connection_config_read_failed'
        | 'connection_config_invalid'
        | 'connection_config_write_failed'
        | 'credentials_read_failed'
        | 'credentials_write_failed'
        | 'credentials_rollback_failed';
    chat_storage:
        | 'outbox_read_failed'
        | 'outbox_read_timeout'
        | 'outbox_invalid'
        | 'outbox_write_failed'
        | 'cache_rehydrate_failed';
    chat_send:
        | 'attachment_uri_missing'
        | 'attachment_not_found'
        | 'attachment_too_large'
        | 'attachment_read_failed'
        | 'attachment_read_empty'
        | 'attachment_unknown_error'
        | 'send_raw_failed';
    remote_setting:
        | 'permission_unconfirmed'
        | 'permission_network_error'
        | 'permission_rejected'
        | 'model_unconfirmed'
        | 'model_network_error'
        | 'model_rejected';
    cloud_sync:
        | 'upload_conflict'
        | 'upload_failed'
        | 'download_failed'
        | 'shadow_update_failed'
        | 'smart_merge_no_shadow'
        | 'smart_merge_conflict'
        | 'smart_merge_exception'
        | 'flash_batch_sync_failed';
    server_file:
        | 'unauthorized'
        | 'timeout'
        | 'network'
        | 'http_error'
        | 'download_timeout'
        | 'download_failed';
    download: 'backup_restore_failed';
    automatic_task:
        | 'unauthorized'
        | 'timeout'
        | 'network'
        | 'redirect_blocked'
        | 'invalid_response'
        | 'http_error'
        | 'connection_not_ready'
        | 'invalid_endpoint'
        | 'invalid_token'
        | 'other';
    connector:
        | 'invalid_connection'
        | 'redirect_blocked'
        | 'request_failed'
        | 'invalid_status'
        | 'invalid_authorization_url'
        | 'timeout'
        | 'network';
};

export type OperationDiagnosticDetails = {
    httpStatus?: number;
    elapsedMs?: number;
    count?: number;
};

const STORAGE_KEY = 'lvtian:operationDiagnostics:v1';
const MAX_REPORTS = 50;
const DEDUP_WINDOW_MS = 60_000;

let writes: Promise<void> = Promise.resolve();
const lastFailure = new Map<keyof OperationReasons, { outcome: string; timestamp: number; httpStatus?: number }>();

async function readRows(): Promise<string[]> {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    try {
        const rows: unknown = JSON.parse(raw);
        return Array.isArray(rows) ? rows.filter((row): row is string => typeof row === 'string') : [];
    } catch {
        return [];
    }
}

/**
 * 仅记录固定枚举结果与安全标量，禁止写入 URL、令牌、路径或业务正文。
 */
export function recordOperation<K extends keyof OperationReasons>(
    operation: K,
    outcome: OperationReasons[K],
    details: OperationDiagnosticDetails = {},
): void {
    const timestamp = Date.now();
    const { httpStatus, elapsedMs, count } = details;
    const normalizedHttpStatus = Number.isInteger(httpStatus) ? httpStatus : undefined;

    const previous = lastFailure.get(operation);
    const age = previous ? timestamp - previous.timestamp : Infinity;
    if (
        previous?.outcome === outcome &&
        previous.httpStatus === normalizedHttpStatus &&
        age >= 0 &&
        age < DEDUP_WINDOW_MS
    ) {
        return;
    }
    lastFailure.set(operation, { outcome, timestamp, httpStatus: normalizedHttpStatus });

    const report = JSON.stringify({
        type: 'operation',
        time: new Date(timestamp).toISOString(),
        runtimeVersion: Updates.runtimeVersion ?? null,
        updateId: Updates.updateId ?? null,
        operation,
        outcome,
        httpStatus: normalizedHttpStatus,
        elapsedMs: typeof elapsedMs === 'number' && Number.isFinite(elapsedMs) ? elapsedMs : undefined,
        count: typeof count === 'number' && Number.isInteger(count) ? count : undefined,
    });

    writes = writes
        .then(async () => {
            const rows = await readRows();
            await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify([report, ...rows].slice(0, MAX_REPORTS)));
        })
        .catch(() => {
            console.warn('[Diagnostics] Could not save operation report');
        });
}

/** 读取持久化的关键操作失败记录 */
export async function readOperationReports(): Promise<string[]> {
    await writes;
    try {
        return await readRows();
    } catch {
        console.warn('[Diagnostics] Could not read operation reports');
        return [];
    }
}

/** 仅供测试清理内存去重缓存与等待中的写入队列 */
export async function resetOperationDiagnosticsState(): Promise<void> {
    lastFailure.clear();
    await writes;
}
