import NetInfo from "@react-native-community/netinfo";
import { DeviceEventEmitter } from 'react-native';
import { cloudService, UPLOAD_COMPLETED_EVENT } from './CloudService';
import { fsService } from './FileSystemService';
import { useFileMetadataStore } from '../store/useFileMetadataStore';
import { normalizePath } from '../utils/pathUtils';
import { shadowFileService } from './ShadowFileService';
import { mergeUtils } from '../utils/mergeUtils';
import { BATCH_SYNC_STATUS_CHANGED_EVENT } from '../constants/events';

export type SyncStatus = 'synced' | 'conflict' | 'checking' | 'error' | 'offline' | 'not-configured';
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
    localFiles?: string[];
    smartMerge?: boolean;
}

class SyncService {
    private autoRetryCache = new Set<string>(); // Cache for files that have been auto-retried once

    /**
     * 检查文件的同步状态
     * 不会执行任何修改操作（不自动上传/下载）
     */
    async checkSyncStatus(filePath: string): Promise<SyncCheckResult> {
        const { getMetadata } = useFileMetadataStore.getState();
        const localMetadata = getMetadata(filePath);

        // 1. 检查网络状态 (优先于配置检查，离线时应直接显示本地内容)
        const netState = await NetInfo.fetch();
        if (netState.isConnected === false) {
            return { status: 'offline', conflictType: null };
        }

        // 2. 检查云端配置
        // 必须先检查是否初始化完成，否则可能在启动过程中误报未配置
        if (!cloudService.isInitialized()) {
            return { status: 'checking', conflictType: null };
        }

        if (!cloudService.isConfigured()) {
            return { status: 'not-configured', conflictType: null };
        }
        if (localMetadata?.uploadState === 'uploading') {
            return { status: 'checking', conflictType: null };
        }

        // 自动重试逻辑：如果是普通失败，仅重试一次
        if (localMetadata?.uploadState === 'failed') {
            if (!this.autoRetryCache.has(filePath)) {
                this.autoRetryCache.add(filePath);
                this.uploadFile(filePath).catch(console.error);
                return { status: 'checking', conflictType: null };
            }
            // 否则，不再重试，返回 error 状态 (UI 将根据 uploadState='failed' 显示重试 Banner)
            return { status: 'error', conflictType: null };
        }

        // 冲突逻辑：如果是乐观锁失败，直接视为双向冲突
        if (localMetadata?.uploadState === 'conflict-failed') {
            return { status: 'conflict', conflictType: 'bidirectional', localHash: localMetadata.localHash, syncedHash: localMetadata.syncedHash, cloudHash: null };
        }

        try {
            const cloudMetadata = await cloudService.headFile(filePath);
            const localHash = localMetadata?.localHash ?? null;
            const syncedHash = localMetadata?.syncedHash ?? null;
            const cloudHash = cloudMetadata?.etag ?? null;

            console.log(`[SyncDebug] Checking ${filePath}: local=${localHash}, synced=${syncedHash}, cloud=${cloudHash}`);

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
                // 如果之前标记为失败，清除它
                // (注意：前面的 Early Return 已经处理了 failed/conflict-failed，能走到这里说明状态已重置或为 null，
                // 但为了保险起见，如果是 null 以外的残留状态（虽然 TS 认为只有 null），可以保留清理逻辑，但必须绕过 TS 检查
                // 或者更简单：既然 localHash === cloudHash (synced)，那么 uploadState 理应被置空。)
                // useFileMetadataStore.getState().setUploadState(filePath, null); 
                // 其实 setMetadata 内部已经把 uploadState 置为 null 了（见 store 定义）。
                // 所以这里的 check 是完全多余的。直接移除。
                return { status: 'synced', conflictType: null, localHash, syncedHash, cloudHash };
            }

            // 情况 C: 哈希不匹配 (冲突/需要同步)

            // 情况 C: 哈希不匹配 (冲突/需要同步)

            // Special: 检查本地文件是否存在但无 Metadata (未受控文件) -> 这种情况现在按正常逻辑处理（即视为 cloudNewer，自动覆盖）

            // C1: 仅云端更新 (localHash == syncedHash) -> 云端较新 (需要下载)
            if (localHash === syncedHash) {
                console.log(`[SyncDebug] ${filePath}: Detected Cloud Newer (local==synced)`);
                return { status: 'conflict', conflictType: 'cloudNewer', localHash, syncedHash, cloudHash };
            }

            // C2: 仅本地更新 (cloudHash == syncedHash) -> 本地较新 (需要上传)
            if (cloudHash === syncedHash) {
                console.log(`[SyncDebug] ${filePath}: Detected Local Newer (cloud==synced)`);
                return { status: 'conflict', conflictType: 'localNewer', localHash, syncedHash, cloudHash };
            }

            // C3: 双向冲突
            console.log(`[SyncDebug] ${filePath}: Detected Bidirectional Conflict`);
            return { status: 'conflict', conflictType: 'bidirectional', localHash, syncedHash, cloudHash };

        } catch (error: any) {
            // 处理断网或其他网络错误
            if (error?.message === 'Network request failed' || error?.message?.includes('Network request failed')) {
                return { status: 'offline', conflictType: null };
            }

            console.error('Sync Check Error:', error);
            // 如果之前本地上传失败，视为冲突/本地较新，以便用户重试
            // 如果之前本地上传失败，视为冲突/本地较新，以便用户重试
            // Update: 这里也是 redundant，因为前面已经 Early Return 了。
            // 如果走到这里 catch error，说明是 HEAD 请求或者网络挂了。
            // 此时 localMetadata.uploadState 只能是 null 或 undefined (因为 failed/conflict-failed 早就 return 了)。
            // 所以这个 if 永远为假。直接移除。

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
     * 批量同步文件 (Batch Sync)
     * 统一处理云端和本地文件，执行标准同步检查
     * 
     * @param cloudFiles 云端文件列表 (含 ETag)
     * @param localFiles 本地文件列表 (可选)
     * @param options 配置项
     */
    async syncBatchFiles(
        cloudFiles: import('./CloudService').CloudFileItem[],
        fileFilter?: (filename: string) => boolean,
        options: SyncOptions = {}
    ): Promise<{ synced: number; errors: number; conflicts: number; conflictedFiles: string[]; errorFiles: string[] }> {
        const { getMetadata } = useFileMetadataStore.getState();
        const results = { synced: 0, errors: 0, conflicts: 0, conflictedFiles: [] as string[], errorFiles: [] as string[] };
        const localFileList = options.localFiles || [];

        // 1. 构建全量文件集合 (Union of Cloud & Local)
        const allFiles = new Set<string>();
        const cloudMap = new Map<string, import('./CloudService').CloudFileItem>();

        cloudFiles.forEach(f => {
            const path = normalizePath(f.key);
            if (fileFilter && !fileFilter(path)) return;
            cloudMap.set(path, f);
            allFiles.add(path);
        });

        localFileList.forEach(f => {
            const path = normalizePath(f);
            if (fileFilter && !fileFilter(path)) return;
            allFiles.add(path);
        });

        console.log(`[BatchSync] Processing ${allFiles.size} unique files from cloud+local`);

        const tasks: Array<() => Promise<void>> = [];

        // 2. 遍历集合并生成任务
        for (const path of allFiles) {
            const cloudItem = cloudMap.get(path);
            const localMetadata = getMetadata(path);

            const syncedHash = localMetadata?.syncedHash ?? null;
            const localHash = localMetadata?.localHash ?? null;
            const cloudHash = cloudItem?.etag ?? null;

            console.log(`[BatchSync] File: ${path}, Cloud ETag: ${cloudHash}, Synced: ${syncedHash}, Local: ${localHash}`);

            // --- 逻辑与 checkSyncStatus 保持一致 ---

            // 情况 A: 云端不存在 (Local Only)
            if (!cloudItem) {
                tasks.push(async () => {
                    const exists = await fsService.exists(path);
                    if (exists) {
                        if (!localMetadata) {
                            console.log(`[BatchSync] ${path}: New local file detected (No Metadata) -> Uploading`);
                            await this.uploadFile(path, options);
                            results.synced++;
                        } else {
                            console.log(`[BatchSync] ${path}: Local exists but missing on cloud -> Re-uploading`);
                            await this.uploadFile(path, options);
                            results.synced++;
                        }
                    } else {
                        console.log(`[BatchSync] ${path}: Missing on both (Skipped)`);
                    }
                });
                continue;
            }

            // 情况 B: 哈希匹配 (已同步)
            if (localHash === cloudHash) {
                console.log(`[BatchSync] ${path}: Synced (skipped)`);
                // 自愈 Metadata
                if (syncedHash !== cloudHash) {
                    useFileMetadataStore.getState().setMetadata(path, cloudHash!, localHash, cloudItem.lastModified);
                }
                continue;
            }

            // 情况 C: 冲突/更新

            // C1: Cloud Newer
            if (localHash === syncedHash && syncedHash !== cloudHash) {
                tasks.push(async () => {
                    console.log(`[BatchSync] ${path}: Cloud update detected -> Downloading`);
                    await this.performDownload(path, options);
                    results.synced++;
                });
                continue;
            }

            // C2: Local Newer
            if (cloudHash === syncedHash && localHash !== syncedHash) {
                tasks.push(async () => {
                    console.log(`[BatchSync] ${path}: Local update detected -> Uploading`);
                    await this.uploadFile(path, options);
                    results.synced++;
                });
                continue;
            }

            // C3: 复杂情况 / 冲突
            if (!localMetadata) {
                tasks.push(async () => {
                    const exists = await fsService.exists(path);
                    if (exists) {
                        console.log(`[BatchSync] ${path}: Conflict (Unmanaged Local + Cloud Exists)`);
                        results.conflicts++;
                        results.conflictedFiles.push(path);
                    } else {
                        console.log(`[BatchSync] ${path}: New cloud file -> Downloading`);
                        await this.performDownload(path, options);
                        results.synced++;
                    }
                });
                continue;
            }

            console.log(`[BatchSync] ${path}: Conflict detected (Bidirectional)`);

            if (options.smartMerge) {
                tasks.push(async () => {
                    const merged = await this.trySmartMerge(path, options);
                    if (merged) {
                        results.synced++;
                    } else {
                        results.conflicts++;
                        results.conflictedFiles.push(path);
                    }
                });
            } else {
                results.conflicts++;
                results.conflictedFiles.push(path);
            }
        }

        // 3. 并发执行任务
        const CHUNK_SIZE = 5;
        for (let i = 0; i < tasks.length; i += CHUNK_SIZE) {
            const chunk = tasks.slice(i, i + CHUNK_SIZE);
            await Promise.all(chunk.map(t => t().catch(e => {
                console.error('[BatchSync] Task failed', e);
                results.errors++;
                // Note: We can't easily get path here in current structure, but errors are less common
            })));
        }

        return results;
    }

    /**
     * 尝试自动同步文件
     * 处理 'Cloud Newer' (自动下载) 和 'Local Newer' (自动上传)
     * 返回操作后的最终状态
     */
    async syncFile(filePath: string, options: SyncOptions = {}): Promise<SyncStatus> {
        const check = await this.checkSyncStatus(filePath);
        console.log(`[SyncDebug] syncFile ${filePath} status result:`, check.status, check.conflictType);

        if (check.status === 'synced') return 'synced';

        if (check.status === 'conflict') {
            if (check.conflictType === 'cloudNewer') {
                console.log(`[SyncService] Auto-downloading ${filePath}`);
                const success = await this.performDownload(filePath, options);
                return success ? 'synced' : 'error';
            }
            if (check.conflictType === 'localNewer') {
                console.log(`[SyncService] Auto-uploading ${filePath}`);
                const success = await this.uploadFile(filePath, options);
                return success ? 'synced' : 'conflict';
            }
            // 双向冲突 -> 无法自动同步
            if (options.smartMerge) {
                const merged = await this.trySmartMerge(filePath, options);
                if (merged) return 'synced';
            }
            return 'conflict';
        }

        return check.status;
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

        const netState = await NetInfo.fetch();
        if (netState.isConnected === false) {
            console.log('[SyncService] Offline, skipping upload:', filePath);
            return false;
        }

        try {
            setUploadState(filePath, 'uploading');

            // Broadcast uploading status for real-time UI feedback
            DeviceEventEmitter.emit(BATCH_SYNC_STATUS_CHANGED_EVENT, {
                status: 'checking',
                conflicts: [],
                uploadErrors: []
            });

            // 1. 处理乐观锁
            let expectedEtag: string | undefined;
            if (options.withLock) {
                const metadata = getMetadata(filePath);
                expectedEtag = metadata?.syncedHash || undefined;
                console.log('[Upload] File:', filePath, 'Expected ETag:', expectedEtag, 'Metadata:', JSON.stringify(metadata));
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

                // Broadcast success status for real-time UI feedback
                DeviceEventEmitter.emit(BATCH_SYNC_STATUS_CHANGED_EVENT, {
                    status: 'synced',
                    conflicts: [],
                    uploadErrors: []
                });

                this.autoRetryCache.delete(filePath); // Clear retry cache on success
                return true;
            }
            return false;
        } catch (error: any) {
            if (error.code === 'PreconditionFailed') {
                console.warn('SyncService Upload prevented (Optimistic Lock):', error.message);
                setUploadState(filePath, 'conflict-failed');
                // ... emit conflict ...
                DeviceEventEmitter.emit(BATCH_SYNC_STATUS_CHANGED_EVENT, {
                    status: 'conflict',
                    conflicts: [filePath],
                    uploadErrors: []
                });
            } else if (error.message && (error.message.includes('ENOENT') || error.message.includes('No such file') || error.message.includes('FileNotFound'))) {
                // Race Condition Handler: File was deleted before upload could start
                console.log('[SyncService] Upload skipped: File deleted locally (ENOENT):', filePath);
                // Treat as "success" or just clean up? 
                // We should clean up metadata upload state
                // Since file is gone, metadata should ideally be gone too, but if not:
                setUploadState(filePath, null); // Clear uploading state
                this.autoRetryCache.delete(filePath);

                // Do NOT emit error
                return false;
            } else {
                console.error('SyncService Upload failed:', error);
                setUploadState(filePath, 'failed');

                // Broadcast error status for real-time UI feedback
                DeviceEventEmitter.emit(BATCH_SYNC_STATUS_CHANGED_EVENT, {
                    status: 'error',
                    conflicts: [],
                    uploadErrors: [filePath]
                });
            }

            DeviceEventEmitter.emit(UPLOAD_COMPLETED_EVENT, { filePath, success: false });
            return false;
        }
    }

    async performDownload(filePath: string, options: SyncOptions = {}): Promise<boolean> {
        const { setMetadata } = useFileMetadataStore.getState();
        try {
            const result = await cloudService.downloadFile(filePath, filePath);
            console.log('[Download] Downloaded', filePath, 'etag:', result.etag);
            setMetadata(filePath, result.etag, result.etag, result.lastModified);
            console.log('[Download] Set metadata - syncedHash:', result.etag, 'localHash:', result.etag);

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
        console.log('[ResolveConflict] Strategy:', strategy, 'File:', filePath);
        if (strategy === 'useCloud') {
            await this.performDownload(filePath, { useShadow: true });
        } else if (strategy === 'useLocal') {
            await this.uploadFile(filePath);
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
                this.uploadFile(backupPath);
            } catch (e) {
                console.error('Failed to create backup copy:', e);
                throw e;
            }

            // 下载云端版本
            await this.performDownload(filePath, { useShadow: true });
        }
    }

    /**
     * 尝试智能三路合并
     * Returns true if merge succeeded and uploaded, false if execution failed or conflict remains
     */
    private async trySmartMerge(filePath: string, options: SyncOptions): Promise<boolean> {
        try {
            console.log(`[SyncService] Attempting Smart Merge for ${filePath}`);

            // 1. 获取 Base (Shadow)
            const baseContent = await shadowFileService.getShadow(filePath);
            if (baseContent === null) {
                console.log(`[SyncService] Smart Merge aborted: No shadow file (Base) found.`);
                return false;
            }

            // 2. 获取 Local
            const localContent = await fsService.readFile(filePath);

            // 3. Download Cloud (Theirs) to memory
            const tempRelativePath = `.merge_temp/temp_merge_${Date.now()}.md`;

            // Ensure temp directory exists
            await fsService.createDirectory('.merge_temp');

            // Get absolute path for CloudService (which likely needs file:// URI)
            const absoluteTempPath = fsService.getAbsolutePath(tempRelativePath);

            await cloudService.downloadFile(filePath, absoluteTempPath);
            const cloudContent = await fsService.readFile(tempRelativePath);

            // Cleanup temp
            await fsService.deleteFile(tempRelativePath);

            // 4. Perform Merge
            const result = mergeUtils.threeWayMerge(baseContent, localContent, cloudContent);

            if (result.hasConflict) {
                console.log(`[SyncService] Smart Merge failed: Conflict in content.`);
                return false;
            }

            console.log(`[SyncService] Smart Merge Success! Writing merged content and uploading.`);

            await fsService.writeFile(filePath, result.mergedContent);

            const uploadSuccess = await this.uploadFile(filePath, { ...options, useShadow: true });

            return uploadSuccess;

        } catch (e) {
            console.error(`[SyncService] Smart Merge exception:`, e);
            return false;
        }
    }

    /**
     * Clear local cache files
     * @param options.includeUnsynced If true, deletes ALL files including modified/uploading/failed ones.
     */
    async clearCache(options: { includeUnsynced: boolean }): Promise<void> {
        const { getMetadata, removeMetadata, clearAll: clearAllMetadata } = useFileMetadataStore.getState();
        const { clearAll: clearAllFileList } = require('../store/useFileListStore').useFileListStore.getState();
        // Dynamic require to avoid circular dependency if file list store imports sync service (unlikely but safe)

        try {
            console.log('[SyncService] Starting cache clear. includeUnsynced:', options.includeUnsynced);

            if (options.includeUnsynced) {
                // Destructive clear: Delete EVERYTHING in root
                // We can just delete root contents? Or use listFilesRecursive to be precise?
                // fsService.deleteFile works on directories too.
                // But we want to keep the root folder structure?
                // Actually cache manager logic was deleting files individually.

                // Let's use recursive list to be safe and consistent
                const allFiles = await fsService.listFilesRecursive('');

                for (const file of allFiles) {
                    try {
                        await fsService.deleteFile(file.path);
                    } catch (e) {
                        console.warn(`[SyncService] Failed to delete ${file.path}`, e);
                    }
                }

                // Clear Stores
                clearAllMetadata();
                clearAllFileList();
                console.log('[SyncService] Cache cleared completely.');

            } else {
                // Safe clear: Only synced files
                const allFiles = await fsService.listFilesRecursive('');

                for (const file of allFiles) {
                    const relativePath = decodeURIComponent(file.path.replace(fsService.getRootPath(), '').replace(/^\/+/, ''));
                    const metadata = getMetadata(relativePath);

                    // Logic from CasheManagerScreen
                    const isModified = metadata?.localHash === 'LOCAL_MODIFIED'; // Hardcoded constant import issue avoidance
                    const isUploading = metadata?.uploadState === 'uploading';
                    const isFailed = metadata?.uploadState === 'failed';

                    const isSafeToDelete = !isModified && !isUploading && !isFailed;

                    if (isSafeToDelete) {
                        try {
                            await fsService.deleteFile(file.path);
                            // Clean metadata
                            // Metadata store key logic might need unify, but let's try standard relative path
                            const rawPath = relativePath;
                            const decodedPath = decodeURIComponent(rawPath);

                            removeMetadata(rawPath);
                            if (rawPath !== decodedPath) removeMetadata(decodedPath);

                        } catch (e) {
                            console.warn(`[SyncService] Failed to delete safe file ${file.path}`, e);
                        }
                    }
                }
                console.log('[SyncService] Safe cache clear completed.');
            }

        } catch (error) {
            console.error('[SyncService] clearCache failed:', error);
            throw error;
        }
    }
}

export const syncService = new SyncService();