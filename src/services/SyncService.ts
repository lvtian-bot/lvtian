import NetInfo from "@react-native-community/netinfo";
import { DeviceEventEmitter } from 'react-native';
import { cloudService, UPLOAD_COMPLETED_EVENT } from './CloudService';
import { fsService } from './FileSystemService';
import { useFileMetadataStore } from '../store/useFileMetadataStore';
import { normalizePath } from '../utils/pathUtils';
import { shadowFileService } from './ShadowFileService';

export type SyncStatus = 'synced' | 'conflict' | 'checking' | 'error' | 'offline' | 'not-configured' | 'uploading' | 'downloading';
export type ConflictType = 'cloudNewer' | 'localNewer' | 'bidirectional' | null;

export interface SyncCheckResult {
    status: SyncStatus;
    conflictType: ConflictType;
    localHash?: string | null;
    syncedHash?: string | null;
    cloudHash?: string | null;
}

export interface UploadOptions {
    withLock?: boolean;
    useShadow?: boolean;
}

export interface SyncOptions {
    useShadow?: boolean;
}

class SyncService {

    /**
     * 检查文件的同步状态
     * 不会执行任何修改操作（不自动上传/下载）
     */
    async checkSyncStatus(filePath: string): Promise<SyncCheckResult> {
        const { getMetadata } = useFileMetadataStore.getState();
        const localMetadata = getMetadata(filePath);

        // 1. 检查云端配置
        // 必须先检查是否初始化完成，否则可能在启动过程中误报未配置
        if (!cloudService.isInitialized()) {
            return { status: 'checking', conflictType: null };
        }

        if (!cloudService.isConfigured()) {
            return { status: 'not-configured', conflictType: null };
        }

        // 2. 检查网络状态
        const netState = await NetInfo.fetch();
        if (netState.isConnected === false) {
            return { status: 'offline', conflictType: null };
        }

        // 3. 检查上传状态
        if (localMetadata?.uploadState === 'uploading') {
            return { status: 'uploading', conflictType: null };
        }

        try {
            const cloudMetadata = await cloudService.headFile(filePath);
            const localHash = localMetadata?.localHash ?? null;
            const syncedHash = localMetadata?.syncedHash ?? null;
            const cloudHash = cloudMetadata?.etag ?? null;

            // 情况 A: 云端文件不存在
            if (!cloudMetadata) {
                const localExists = await fsService.exists(filePath);
                if (localExists) {
                    // 本地存在，云端不存在 -> 视为本地较新 (需要上传)
                    return {
                        status: 'conflict',
                        conflictType: 'localNewer',
                        localHash, syncedHash, cloudHash
                    };
                }
                // 都不存在
                return { status: 'error', conflictType: null };
            }

            // 情况 B: 哈希匹配 (已同步)
            if (localHash === cloudHash) {
                // 自愈：如果 syncedHash 不匹配，更新它
                if (syncedHash !== cloudHash) {
                    useFileMetadataStore.getState().setMetadata(
                        filePath,
                        cloudHash,
                        localHash,
                        localMetadata?.lastModified || new Date().toISOString()
                    );
                }
                // 如果之前标记为失败，清除它
                if (localMetadata?.uploadState === 'failed' || localMetadata?.uploadState === 'conflict-failed') {
                    useFileMetadataStore.getState().setUploadState(filePath, null);
                }
                return { status: 'synced', conflictType: null, localHash, syncedHash, cloudHash };
            }

            // 情况 C: 哈希不匹配 (冲突/需要同步)

            // C1: 仅云端更新 (localHash == syncedHash) -> 云端较新 (需要下载)
            if (localHash === syncedHash) {
                return { status: 'conflict', conflictType: 'cloudNewer', localHash, syncedHash, cloudHash };
            }

            // C2: 仅本地更新 (cloudHash == syncedHash) -> 本地较新 (需要上传)
            if (cloudHash === syncedHash) {
                return { status: 'conflict', conflictType: 'localNewer', localHash, syncedHash, cloudHash };
            }

            // C3: 双向冲突
            return { status: 'conflict', conflictType: 'bidirectional', localHash, syncedHash, cloudHash };

        } catch (error: any) {
            // 处理断网或其他网络错误
            if (error?.message === 'Network request failed' || error?.message?.includes('Network request failed')) {
                return { status: 'offline', conflictType: null };
            }

            console.error('Sync Check Error:', error);
            // 如果之前本地上传失败，视为冲突/本地较新，以便用户重试
            if (localMetadata?.uploadState === 'failed' || localMetadata?.uploadState === 'conflict-failed') {
                return { status: 'conflict', conflictType: 'localNewer' };
            }

            // 检查本地文件是否存在，如果存在且出错，可能是网络或其他问题 -> Offline/Error
            try {
                if (await fsService.exists(filePath)) {
                    return { status: 'offline', conflictType: null };
                }
            } catch { }

            return { status: 'error', conflictType: null };
        }
    }

    /**
     * 尝试自动同步文件
     * 处理 'Cloud Newer' (自动下载) 和 'Local Newer' (自动上传)
     * 返回操作后的最终状态
     */
    /**
     * 尝试自动同步文件
     * 处理 'Cloud Newer' (自动下载) 和 'Local Newer' (自动上传)
     * 返回操作后的最终状态
     */
    async syncFile(filePath: string, options: SyncOptions = {}): Promise<SyncStatus> {
        const check = await this.checkSyncStatus(filePath);

        if (check.status === 'synced') return 'synced';

        if (check.status === 'conflict') {
            if (check.conflictType === 'cloudNewer') {
                console.log(`[SyncService] Auto-downloading ${filePath}`);
                const success = await this.performDownload(filePath, options);
                return success ? 'synced' : 'error';
            }
            if (check.conflictType === 'localNewer') {
                console.log(`[SyncService] Auto-uploading ${filePath}`);
                const success = await this.performUpload(filePath, options);
                return success ? 'synced' : 'conflict';
            }
            // 双向冲突 -> 无法自动同步
            return 'conflict';
        }

        return check.status;
    }

    async performUpload(filePath: string, options: UploadOptions = {}): Promise<boolean> {
        return this.uploadFile(filePath, options);
    }

    /**
     * 统一的上传文件方法
     * 包含状态设置、乐观锁处理、云端上传、元数据更新和事件通知
     */
    async uploadFile(filePath: string, options: UploadOptions = {}): Promise<boolean> {
        const { setMetadata, setUploadState, getMetadata } = useFileMetadataStore.getState();

        if (!cloudService.isConfigured()) {
            console.log('[SyncService] Cloud not configured, skipping upload');
            return false;
        }

        try {
            setUploadState(filePath, 'uploading');

            // 1. 处理乐观锁
            let expectedEtag: string | undefined;
            if (options.withLock) {
                expectedEtag = getMetadata(filePath)?.syncedHash || undefined;
            }

            // 2. 执行上传
            const result = await cloudService.uploadFile(filePath, filePath, expectedEtag);

            if (result) {
                // 3. 统一更新元数据
                setMetadata(filePath, result.etag, result.etag, result.lastModified);
                // setMetadata 会将 uploadState 重置为 null，但为了保险起见，或者如果 setMetadata 逻辑变了
                // 这里不需要手动 setUploadState(null) 因为 store 的 setMetadata 已经清理了 uploadState
                // 修正：store 的 setMetadata 设置 uploadState 为 null。

                // 4. 更新影子文件 (如果启用)
                if (options.useShadow) {
                    try {
                        const content = await fsService.readFile(filePath);
                        await shadowFileService.saveShadow(filePath, content);
                    } catch (e) {
                        console.error('[SyncService] Failed to update shadow after upload:', e);
                    }
                }

                DeviceEventEmitter.emit(UPLOAD_COMPLETED_EVENT, { filePath, success: true });
                return true;
            }
            return false;
        } catch (error: any) {
            console.error('SyncService Upload failed:', error);

            if (error.code === 'PreconditionFailed') {
                setUploadState(filePath, 'conflict-failed');
            } else {
                setUploadState(filePath, 'failed');
            }

            DeviceEventEmitter.emit(UPLOAD_COMPLETED_EVENT, { filePath, success: false });
            return false;
        }
    }

    async performDownload(filePath: string, options: SyncOptions = {}): Promise<boolean> {
        const { setMetadata } = useFileMetadataStore.getState();
        try {
            const result = await cloudService.downloadFile(filePath, filePath);
            setMetadata(filePath, result.etag, result.etag, result.lastModified);

            // 更新影子文件 (如果启用)
            if (options.useShadow) {
                try {
                    const content = await fsService.readFile(filePath);
                    await shadowFileService.saveShadow(filePath, content);
                } catch (e) {
                    console.error('[SyncService] Failed to update shadow after download:', e);
                }
            }

            DeviceEventEmitter.emit(UPLOAD_COMPLETED_EVENT, { filePath, success: true });
            return true;
        } catch (error) {
            console.error('SyncService Download failed:', error);
            return false;
        }
    }

    async resolveConflict(filePath: string, strategy: 'useCloud' | 'useLocal' | 'saveCopy'): Promise<void> {
        if (strategy === 'useCloud') {
            await this.performDownload(filePath);
        } else if (strategy === 'useLocal') {
            await this.performUpload(filePath);
        } else if (strategy === 'saveCopy') {
            const normalizedPath = normalizePath(filePath);
            const fileName = normalizedPath.split('/').pop() || '';
            const dir = normalizedPath.replace(fileName, '');
            const timestamp = new Date().getTime();
            const newName = `${fileName.replace('.md', '')}_old_${timestamp}.md`;
            const backupPath = normalizePath(`${dir}${newName}`);

            try {
                await fsService.moveFile(normalizedPath, backupPath);
                // 尝试后台上传副本
                this.performUpload(backupPath);
            } catch (e) {
                console.error('Failed to create backup copy:', e);
                throw e;
            }

            // 下载云端版本
            await this.performDownload(filePath);
        }
    }
}

export const syncService = new SyncService();