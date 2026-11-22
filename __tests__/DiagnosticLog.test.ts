import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { fsService, UserStorageError } from '../src/services/FileSystemService';
import * as connectionDiagnostics from '../src/services/connectionDiagnostics';
import {
    buildEnvironmentReport,
    collectDiagnosticLogContent,
    exportDiagnosticLogToFile,
    formatDiagnosticFileName,
} from '../src/services/diagnosticLog';
import {
    readOperationReports,
    recordOperation,
    resetOperationDiagnosticsState,
} from '../src/services/operationDiagnostics';
import { useAssistantStore } from '../src/store/useAssistantStore';
import { useFileMetadataStore } from '../src/store/useFileMetadataStore';
import { useSettingsStore } from '../src/store/useSettingsStore';
import { serverFileService } from '../src/services/ServerFileService';
import { downloadToFile, DownloadTimeoutError } from '../src/services/NativeDownloadService';
import { syncService } from '../src/services/SyncService';
import { cloudService } from '../src/services/CloudService';
import { AssistantClient } from '../src/services/AssistantClient';

jest.mock('expo-network', () => ({
    getNetworkStateAsync: jest.fn().mockResolvedValue({ isConnected: true }),
}));

jest.mock('../src/services/NativeDownloadService', () => {
    const actual = jest.requireActual('../src/services/NativeDownloadService');
    return {
        ...actual,
        downloadToFile: jest.fn(),
    };
});

describe('综合诊断日志与关键操作失败记录', () => {
    beforeEach(async () => {
        jest.clearAllMocks();
        await AsyncStorage.clear();
        await resetOperationDiagnosticsState();
        useAssistantStore.setState({
            serverUrl: 'https://secret.example.com:8443',
            serverToken: 'super-secret-token-xyz',
            connectionState: 'connected',
            credentialsStatus: 'ready',
            credentialsError: null,
            outboxStatus: 'ready',
            pendingSendQueue: [],
            pendingCancelQueue: [],
            isServerUpgrading: false,
            permissionMode: 'workspace-write',
            agentModelSelection: { provider: 'deepseek-official', model: 'deepseek-chat' },
            messages: [
                {
                    id: 'm1',
                    seq: 1,
                    role: 'user',
                    content: '绝对不能出现在日志里的聊天正文',
                    timestamp: 1700000000000,
                    status: 'done',
                },
            ],
        });
        useSettingsStore.setState({
            cloudProvider: 'webdav',
            webDavConfig: {
                server: 'https://private-dav.example.com/dav/',
                username: 'private-user@example.com',
            },
        });
        useFileMetadataStore.setState({
            metadata: {
                'a.md': { syncedHash: '1', localHash: '2', lastModified: null, uploadState: 'failed' },
                'b.md': { syncedHash: '1', localHash: '2', lastModified: null, uploadState: 'conflict-failed' },
            },
        });
    });

    afterEach(() => {
        AssistantClient.getInstance().disconnect();
        jest.restoreAllMocks();
    });

    it('recordOperation 记录结构化枚举、60秒内去重并限制保留最近50条', async () => {
        let now = 1_700_000_000_000;
        jest.spyOn(Date, 'now').mockImplementation(() => now);

        recordOperation('server_file', 'http_error', { httpStatus: 500 });
        recordOperation('server_file', 'http_error', { httpStatus: 500 }); // 60 秒内相同失败去重
        recordOperation('server_file', 'http_error', { httpStatus: 502 }); // 状态码不同允许记录
        now += 61_000;
        recordOperation('server_file', 'http_error', { httpStatus: 500 }); // 超过 60 秒允许再记

        const initial = await readOperationReports();
        expect(initial).toHaveLength(3);
        const parsed = initial.map(line => JSON.parse(line));
        expect(parsed[0]).toMatchObject({
            type: 'operation',
            operation: 'server_file',
            outcome: 'http_error',
            httpStatus: 500,
        });
        expect(parsed[1].httpStatus).toBe(502);

        for (let i = 0; i < 60; i += 1) {
            now += 61_000;
            recordOperation('cloud_sync', 'upload_failed', { count: i + 1 });
        }
        const capped = await readOperationReports();
        expect(capped).toHaveLength(50);
        expect(JSON.parse(capped[0]).count).toBe(60);
    });

    it('formatDiagnosticFileName 生成本地时间可读文件名', () => {
        const sample = new Date(2026, 10, 22, 17, 5, 9);
        expect(formatDiagnosticFileName(sample)).toBe('lvtian-diagnostics-20261122-170509.txt');
    });

    it('buildEnvironmentReport 与 collectDiagnosticLogContent 汇总三类信息且不包含任何敏感凭据或正文', async () => {
        recordOperation('cloud_sync', 'upload_conflict');
        jest.spyOn(connectionDiagnostics, 'readConnectionDiagnostics').mockResolvedValue({
            content: '{"time":"2026-11-22T09:00:00.000Z","event":"socket_open"}\n',
            missedWrites: 2,
        });

        const env = JSON.parse(buildEnvironmentReport(2));
        expect(env).toMatchObject({
            type: 'environment',
            platform: Platform.OS,
            serverConfigured: true,
            connectionState: 'connected',
            credentialsStatus: 'ready',
            cloudProvider: 'webdav',
            cloudFailedCount: 1,
            cloudConflictCount: 1,
            connectionMissedWrites: 2,
        });

        const text = await collectDiagnosticLogContent();
        expect(text).not.toContain('secret.example.com');
        expect(text).not.toContain('super-secret-token-xyz');
        expect(text).not.toContain('private-dav.example.com');
        expect(text).not.toContain('private-user@example.com');
        expect(text).not.toContain('绝对不能出现在日志里的聊天正文');

        const lines = text.trim().split('\n').map(line => JSON.parse(line));
        expect(lines.map(item => item.type ?? item.event)).toEqual([
            'environment',
            'operation',
            'socket_open',
        ]);
    });

    it('exportDiagnosticLogToFile 正确处理保存成功、取消、受限目录与其他失败', async () => {
        jest.spyOn(connectionDiagnostics, 'readConnectionDiagnostics').mockResolvedValue({
            content: '',
            missedWrites: 0,
        });
        const saveSpy = jest.spyOn(fsService, 'saveTextToUserStorage');

        saveSpy.mockResolvedValueOnce({
            status: 'saved',
            fileName: 'lvtian-diagnostics-20261122-170509.txt',
            uri: 'content://saved/log.txt',
        });
        await expect(exportDiagnosticLogToFile()).resolves.toEqual({
            status: 'saved',
            fileName: 'lvtian-diagnostics-20261122-170509.txt',
            uri: 'content://saved/log.txt',
        });
        expect(saveSpy).toHaveBeenCalledWith(
            expect.stringMatching(/^lvtian-diagnostics-\d{8}-\d{6}\.txt$/),
            expect.any(String),
            'text/plain',
        );

        saveSpy.mockResolvedValueOnce({ status: 'cancelled' });
        await expect(exportDiagnosticLogToFile()).resolves.toEqual({ status: 'cancelled' });

        saveSpy.mockRejectedValueOnce(new UserStorageError('DOWNLOADS_FOLDER_RESTRICTED'));
        await expect(exportDiagnosticLogToFile()).resolves.toEqual({
            status: 'error',
            code: 'DOWNLOADS_FOLDER_RESTRICTED',
        });

        saveSpy.mockRejectedValueOnce(new Error('/data/user/0/private/path exploded'));
        await expect(exportDiagnosticLogToFile()).resolves.toEqual({
            status: 'error',
            code: 'EXPORT_FAILED',
        });
    });

    it('脆弱环节（下载超时、同步冲突、发送附件异常）均会记入操作诊断且不泄露原文', async () => {
        jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        jest.spyOn(console, 'error').mockImplementation(() => undefined);

        jest.mocked(downloadToFile).mockRejectedValueOnce(new DownloadTimeoutError());
        await expect(
            serverFileService.downloadFile('/secret/file.pdf', 'file:///cache/file.pdf'),
        ).rejects.toMatchObject({ code: 'DOWNLOAD_TIMEOUT' });

        jest.spyOn(cloudService, 'isConfigured').mockReturnValue(true);
        jest.spyOn(cloudService, 'uploadFile').mockRejectedValueOnce({
            code: 'PreconditionFailed',
            message: 'ETag mismatch for private-note.md',
        });
        await expect(syncService.uploadFile('private-note.md')).resolves.toBe(false);

        const client = AssistantClient.getInstance();
        useAssistantStore.setState({
            connectionState: 'connected',
            outboxStatus: 'ready',
            pendingSendQueue: [
                {
                    sessionId: 'main',
                    messageId: 'msg-bad-att',
                    content: 'hello',
                    attachments: [{ type: 'file', name: 'secret-doc.pdf' }],
                },
            ],
        });
        await client.flushPendingSendQueue();

        const reports = (await readOperationReports()).map(line => JSON.parse(line));
        expect(reports).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ operation: 'server_file', outcome: 'download_timeout' }),
                expect.objectContaining({ operation: 'cloud_sync', outcome: 'upload_conflict' }),
                expect.objectContaining({ operation: 'chat_send', outcome: 'attachment_uri_missing' }),
            ]),
        );
        const rawText = JSON.stringify(reports);
        expect(rawText).not.toContain('private-note.md');
        expect(rawText).not.toContain('secret-doc.pdf');
    });
});
