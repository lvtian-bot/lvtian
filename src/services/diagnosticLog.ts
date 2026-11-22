import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { fsService, UserStorageError } from './FileSystemService';
import { readConnectionDiagnostics } from './connectionDiagnostics';
import { readOperationReports } from './operationDiagnostics';
import { useAssistantStore } from '../store/useAssistantStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { useFileMetadataStore } from '../store/useFileMetadataStore';

export type DiagnosticExportResult =
    | { status: 'saved'; fileName: string; uri: string }
    | { status: 'cancelled' }
    | { status: 'error'; code: 'DOWNLOADS_FOLDER_RESTRICTED' | 'EXPORT_FAILED' };

/** 生成本地时间可读的诊断日志文件名 */
export function formatDiagnosticFileName(now: Date = new Date()): string {
    const pad = (value: number) => String(value).padStart(2, '0');
    const year = now.getFullYear();
    const month = pad(now.getMonth() + 1);
    const day = pad(now.getDate());
    const hour = pad(now.getHours());
    const minute = pad(now.getMinutes());
    const second = pad(now.getSeconds());
    return `lvtian-diagnostics-${year}${month}${day}-${hour}${minute}${second}.txt`;
}

function getDeviceTimezone(): string | null {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
    } catch {
        return null;
    }
}

/** 生成当前设备与各核心模块状态的实时环境快照（不含凭据、地址或正文） */
export function buildEnvironmentReport(connectionMissedWrites: number): string {
    try {
        const assistantState = useAssistantStore.getState();
        const settingsState = useSettingsStore.getState();
        const metadataMap = useFileMetadataStore.getState().metadata || {};

        let cloudFailedCount = 0;
        let cloudConflictCount = 0;
        for (const meta of Object.values(metadataMap)) {
            if (meta?.uploadState === 'failed') cloudFailedCount += 1;
            else if (meta?.uploadState === 'conflict-failed') cloudConflictCount += 1;
        }

        return JSON.stringify({
            type: 'environment',
            time: new Date().toISOString(),
            platform: Platform.OS,
            osVersion: String(Platform.Version),
            appVersion: Constants.expoConfig?.version ?? null,
            runtimeVersion: Updates.runtimeVersion ?? null,
            updateId: Updates.updateId ?? null,
            timezone: getDeviceTimezone(),
            serverConfigured: Boolean(assistantState.serverUrl),
            connectionState: assistantState.connectionState,
            credentialsStatus: assistantState.credentialsStatus,
            credentialsError: assistantState.credentialsError,
            outboxStatus: assistantState.outboxStatus,
            pendingSendCount: Array.isArray(assistantState.pendingSendQueue)
                ? assistantState.pendingSendQueue.length
                : 0,
            pendingCancelCount: Array.isArray(assistantState.pendingCancelQueue)
                ? assistantState.pendingCancelQueue.length
                : 0,
            isServerUpgrading: assistantState.isServerUpgrading,
            permissionMode: assistantState.permissionMode,
            modelConfigured: Boolean(assistantState.agentModelSelection),
            cloudProvider: settingsState.cloudProvider,
            cloudFailedCount,
            cloudConflictCount,
            connectionMissedWrites,
        });
    } catch {
        return JSON.stringify({
            type: 'environment',
            time: new Date().toISOString(),
            error: 'environment_report_failed',
        });
    }
}

/** 汇总环境快照、全应用操作异常记录与连接事件日志 */
export async function collectDiagnosticLogContent(): Promise<string> {
    const [connectionResult, operationLines] = await Promise.all([
        readConnectionDiagnostics(),
        readOperationReports(),
    ]);
    const envReport = buildEnvironmentReport(connectionResult.missedWrites);
    const connectionLines = connectionResult.content.split('\n');
    const lines = [envReport, ...operationLines, ...connectionLines]
        .map(line => line.trim())
        .filter(Boolean);
    return lines.join('\n') + '\n';
}

/** 将综合诊断日志直接保存到用户选定的本地存储目录 */
export async function exportDiagnosticLogToFile(): Promise<DiagnosticExportResult> {
    try {
        const content = await collectDiagnosticLogContent();
        const fileName = formatDiagnosticFileName();
        const result = await fsService.saveTextToUserStorage(fileName, content, 'text/plain');
        if (result.status === 'cancelled') {
            return { status: 'cancelled' };
        }
        return {
            status: 'saved',
            fileName: result.fileName,
            uri: result.uri,
        };
    } catch (error: unknown) {
        if (error instanceof UserStorageError && error.code === 'DOWNLOADS_FOLDER_RESTRICTED') {
            return { status: 'error', code: 'DOWNLOADS_FOLDER_RESTRICTED' };
        }
        return { status: 'error', code: 'EXPORT_FAILED' };
    }
}
