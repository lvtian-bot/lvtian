import { useState, useCallback, useEffect, useMemo } from 'react';
import { DeviceEventEmitter } from 'react-native';
import { flashNoteService, FLASH_NOTES_UPDATED_EVENT, BATCH_SYNC_STATUS_CHANGED_EVENT } from '../services/FlashNoteService';
import { fsService } from '../services/FileSystemService';
import { cloudService, CLOUD_INIT_COMPLETED_EVENT, UPLOAD_COMPLETED_EVENT } from '../services/CloudService';
import { SyncStatus, ConflictType } from '../services/SyncService';


interface UseFlashNoteListOptions<T> {
    /**
     * Function to parse content from a file into a list of items of type T
     */
    parser: (content: string, filePath: string) => T[];
    /**
     * Deprecated: Auto check is now handled via global batch sync status
     */
    enableAutoCheck?: boolean;
    /**
     * Initial number of files to load (default: 4)
     */
    initialLoadCount?: number;
    /**
     * Sorting function for the final combined list
     */
    sorter?: (a: T, b: T) => number;
}

export function useFlashNoteList<T>({
    parser,
    // enableAutoCheck = true, // Not used anymore
    initialLoadCount = 4,
    sorter
}: UseFlashNoteListOptions<T>) {
    const [data, setData] = useState<T[]>([]);
    const [loading, setLoading] = useState(false);
    const [refreshing, setRefreshing] = useState(false);

    // Sync State
    const [syncStatus, setSyncStatus] = useState<SyncStatus>('checking');
    const [conflictType, setConflictType] = useState<ConflictType>(null);
    const [isSyncing, setIsSyncing] = useState(false);
    const [conflictedFiles, setConflictedFiles] = useState<string[]>([]);
    const [uploadErrorFiles, setUploadErrorFiles] = useState<string[]>([]);

    // File path state
    const [allFilePaths, setAllFilePaths] = useState<string[]>([]);
    const [loadedFilePaths, setLoadedFilePaths] = useState<string[]>([]);
    const [nextFileIndex, setNextFileIndex] = useState(0);
    const [hasMore, setHasMore] = useState(true);

    // Sync integration - REPLACED with global batch status listening
    // const syncPaths = useMemo(() => { ... });
    // const { syncStatus ... } = useCloudSync(syncPaths);

    const checkSync = useCallback(async () => {
        // Trigger manual batch sync
        await flashNoteService.syncAll();
    }, []);

    const resolveConflict = useCallback(async (strategy: 'useCloud' | 'useLocal' | 'saveCopy', filePath?: string) => {
        if (filePath) {
            // Target specific file
            await flashNoteService.resolveConflictForFile(filePath, strategy);
        } else if (conflictedFiles.length > 0) {
            // Fallback: Resolve first detected conflict
            await flashNoteService.resolveConflictForFile(conflictedFiles[0], strategy);
        } else if (uploadErrorFiles.length > 0) {
            // For upload errors, 'useLocal' acts as retry upload
            if (strategy === 'useLocal') {
                await flashNoteService.resolveConflictForFile(uploadErrorFiles[0], 'useLocal');
            }
        }

        // After resolution, re-sync to update status lists
        await flashNoteService.syncAll();
    }, [conflictedFiles, uploadErrorFiles]);

    // Helper: Load content from specific file
    const loadFileContent = useCallback(async (filePath: string): Promise<T[]> => {
        try {
            if (await fsService.exists(filePath)) {
                const content = await fsService.readFile(filePath);
                return parser(content, filePath);
            }
        } catch (error) {
            console.error(`Failed to load content from ${filePath}:`, error);
        }
        return [];
    }, [parser]);

    // 1. Load Paths & Initial Data (Local Only)
    const fetchLocalData = useCallback(async () => {
        // Only set refreshing if it was manually triggered (handled via state outside/param?)
        // Actually, for local fetch we might not want to show spinner if it's fast.
        // But if called from handleRefresh, we want spinner.

        try {
            const paths = await flashNoteService.getSortedFilePaths();
            setAllFilePaths(paths);

            const countToLoad = Math.min(paths.length, initialLoadCount);
            if (countToLoad > 0) {
                const initialPaths = paths.slice(0, countToLoad);

                let combinedData: T[] = [];
                for (const path of initialPaths) {
                    const items = await loadFileContent(path);
                    combinedData = [...combinedData, ...items];
                }

                if (sorter) {
                    combinedData.sort(sorter);
                }

                setData(combinedData);
                setLoadedFilePaths(initialPaths);
                setNextFileIndex(countToLoad);
                setHasMore(countToLoad < paths.length);
            } else {
                setData([]);
                setLoadedFilePaths([]);
                setHasMore(false);
            }
        } catch (error) {
            console.error('Failed to fetch local data:', error);
        } finally {
            setLoading(false);
        }
    }, [initialLoadCount, loadFileContent, sorter]);

    // 2. Manual Refresh (UI Triggered)
    const handleRefresh = useCallback(async () => {
        setRefreshing(true);
        try {
            // For manual refresh, we DO wait for sync to complete
            await flashNoteService.syncAll();
            // Then re-fetch data
            await fetchLocalData();
        } catch (error) {
            console.error('Manual refresh failed:', error);
        } finally {
            setRefreshing(false);
        }
    }, [fetchLocalData]);

    // 3. Load More
    const handleLoadMore = async () => {
        if (loading || !hasMore || nextFileIndex >= allFilePaths.length) return;

        setLoading(true);
        try {
            const nextPath = allFilePaths[nextFileIndex];
            const newItems = await loadFileContent(nextPath);

            setData(prev => {
                const combined = [...prev, ...newItems];
                if (sorter) combined.sort(sorter);
                return combined;
            });

            setLoadedFilePaths(prev => [...prev, nextPath]);
            setNextFileIndex(prev => prev + 1);
            setHasMore(nextFileIndex + 1 < allFilePaths.length);
        } catch (error) {
            console.error('Failed to load more:', error);
        } finally {
            setLoading(false);
        }
    };

    // 3. Refresh loaded data (without changing pagination depth)
    const refreshLoadedData = useCallback(async () => {
        if (loadedFilePaths.length === 0) return;

        try {
            let combinedData: T[] = [];
            for (const path of loadedFilePaths) {
                const items = await loadFileContent(path);
                combinedData = [...combinedData, ...items];
            }
            if (sorter) combinedData.sort(sorter);
            setData(combinedData);
        } catch (error) {
            console.error('Failed to refresh data:', error);
        }
    }, [loadedFilePaths, loadFileContent, sorter]);

    // Listeners
    useEffect(() => {
        const updateSub = DeviceEventEmitter.addListener(FLASH_NOTES_UPDATED_EVENT, refreshLoadedData);

        // Listen for Batch Sync Status
        const statusSub = DeviceEventEmitter.addListener(BATCH_SYNC_STATUS_CHANGED_EVENT, (payload: any) => {
            // Payload might be string (old) or object (new) - handle both during transition
            if (typeof payload === 'string') {
                setSyncStatus(payload as SyncStatus);
                setIsSyncing(payload === 'checking');
            } else {
                const { status, conflicts, uploadErrors } = payload;
                setSyncStatus(status);
                setIsSyncing(status === 'checking');
                setConflictedFiles(conflicts || []);
                setUploadErrorFiles(uploadErrors || []);
            }
        });

        const initSub = DeviceEventEmitter.addListener(CLOUD_INIT_COMPLETED_EVENT, () => {
            // performAutoSync(); -> Replace with syncAll
            flashNoteService.syncAll();
        });

        const uploadSub = DeviceEventEmitter.addListener(UPLOAD_COMPLETED_EVENT, (eventData: { filePath: string; success?: boolean }) => {
            if (eventData.success && loadedFilePaths.includes(eventData.filePath)) {
                refreshLoadedData();
            }
        });

        return () => {
            updateSub.remove();
            initSub.remove();
            uploadSub.remove();
            statusSub.remove();
        };
    }, [refreshLoadedData, loadedFilePaths]);

    // Initial load on mount
    useEffect(() => {
        // 1. Show local data immediately
        fetchLocalData();

        // 2. Trigger background sync (silent)
        // We don't await this, so UI doesn't block or show refreshing state
        flashNoteService.syncAll();

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return {
        data,
        loading,
        refreshing,
        hasMore,
        handleLoadMore,
        handleRefresh, // Now uses the new manual refresh logic
        refreshLoadedData,
        // Sync state
        syncStatus,
        conflictType,
        isSyncing,
        checkSync,
        resolveConflict,
        conflictedFiles,
        uploadErrorFiles
    };
}
