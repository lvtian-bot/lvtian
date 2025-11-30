import { useState, useCallback, useEffect } from 'react';
import { DeviceEventEmitter } from 'react-native';
import { syncService, SyncStatus, ConflictType } from '../services/SyncService';
import { UPLOAD_COMPLETED_EVENT, CLOUD_INIT_COMPLETED_EVENT } from '../services/CloudService';

export const useCloudSync = (filePath: string | string[]) => {
    const [syncStatus, setSyncStatus] = useState<SyncStatus>('checking');
    const [conflictType, setConflictType] = useState<ConflictType>(null);
    const [isSyncing, setIsSyncing] = useState(false);

    // Helper to get array of paths
    const getFilePaths = useCallback(() => {
        if (Array.isArray(filePath)) return filePath;
        return filePath ? [filePath] : [];
    }, [filePath]);

    const checkSync = useCallback(async () => {
        const paths = getFilePaths();
        if (paths.length === 0) return;

        // For multiple files, we aggregate status
        // If any is checking -> checking
        // If any is conflict -> conflict
        // If any is offline -> offline
        // If all synced -> synced

        let aggregatedStatus: SyncStatus = 'synced';
        let aggregatedConflict: ConflictType = null;
        let hasChecking = false;

        for (const path of paths) {
            const result = await syncService.checkSyncStatus(path);

            if (result.status === 'checking') hasChecking = true;

            if (result.status === 'conflict') {
                aggregatedStatus = 'conflict';
                aggregatedConflict = result.conflictType; // Just take the last one for now
            } else if (result.status === 'offline' && aggregatedStatus !== 'conflict') {
                aggregatedStatus = 'offline';
            } else if (result.status === 'not-configured' && aggregatedStatus !== 'conflict' && aggregatedStatus !== 'offline') {
                aggregatedStatus = 'not-configured';
            } else if (result.status === 'error' && aggregatedStatus !== 'conflict') {
                aggregatedStatus = 'error';
            }
        }

        if (hasChecking && aggregatedStatus !== 'conflict') {
            setSyncStatus('checking');
        } else {
            setSyncStatus(aggregatedStatus);
        }
        setConflictType(aggregatedConflict);
    }, [getFilePaths]);

    const performAutoSync = useCallback(async () => {
        const paths = getFilePaths();
        if (paths.length === 0) return;

        setIsSyncing(true);
        try {
            // Sync all files
            const results = await Promise.all(paths.map(path => syncService.syncFile(path)));

            // Re-check status after sync attempts
            await checkSync();
        } catch (error) {
            console.error('Auto sync failed', error);
        } finally {
            setIsSyncing(false);
        }
    }, [getFilePaths, checkSync]);

    const resolveConflict = useCallback(async (strategy: 'useCloud' | 'useLocal' | 'saveCopy') => {
        const paths = getFilePaths();
        if (paths.length === 0) return;

        setIsSyncing(true);
        try {
            // Apply resolution to all files (or just the conflicted ones? usually UI implies single file context for resolution)
            // But for Todo list, we probably won't have complex conflict resolution UI for *all* files at once.
            // This method is mostly used by TimelineScreen which is single file.
            // For TodoScreen, we might not expose manual resolution buttons yet.
            // But to be safe, we apply to all provided paths.
            for (const path of paths) {
                await syncService.resolveConflict(path, strategy);
            }
            await checkSync();
        } catch (error) {
            console.error('Resolve conflict failed', error);
            setSyncStatus('error');
        } finally {
            setIsSyncing(false);
        }
    }, [getFilePaths, checkSync]);

    useEffect(() => {
        checkSync();
    }, [checkSync]);

    useEffect(() => {
        const uploadSub = DeviceEventEmitter.addListener(UPLOAD_COMPLETED_EVENT, (data: { filePath: string }) => {
            const paths = getFilePaths();
            if (paths.includes(data.filePath)) {
                checkSync();
            }
        });

        const initSub = DeviceEventEmitter.addListener(CLOUD_INIT_COMPLETED_EVENT, () => {
            checkSync();
        });

        return () => {
            uploadSub.remove();
            initSub.remove();
        };
    }, [getFilePaths, checkSync]);

    return {
        syncStatus,
        conflictType,
        isSyncing,
        checkSync,
        performAutoSync,
        resolveConflict
    };
};
