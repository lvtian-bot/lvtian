import { cloudService } from './CloudService';
import { fsService } from './FileSystemService';
import { useSyncStore } from '../store/useSyncStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { Alert, DeviceEventEmitter } from 'react-native';
import { normalizePath } from '../utils/pathUtils';

export const SYNC_COMPLETED_EVENT = 'SYNC_COMPLETED';

class SyncService {
    private isSyncing = false;

    // Note: Cloud provider initialization is handled in App.tsx
    // Credentials are stored in react-native-keychain and loaded on app start

    async syncFile(filePath: string) {
        // Normalize path to ensure consistency
        const normalizedPath = normalizePath(filePath);
        // Use normalized path as key to maintain directory structure
        const key = normalizedPath;
        // Add to queue
        useSyncStore.getState().addToQueue(normalizedPath, key);
        // Trigger processing
        this.processQueue();
    }

    async processQueue() {
        if (this.isSyncing) return;
        this.isSyncing = true;

        const { uploadQueue, updateItemStatus, removeFromQueue, incrementRetry } = useSyncStore.getState();
        const { setMetadata } = require('../store/useFileMetadataStore').useFileMetadataStore.getState();
        const pendingItems = uploadQueue.filter(item => item.status === 'pending' || item.status === 'failed');

        for (const item of pendingItems) {
            // Max 3 retries: attempt on retryCount 0, 1, 2. Stop at 3.
            if (item.retryCount >= 3) {
                updateItemStatus(item.id, 'failed');
                continue;
            }

            updateItemStatus(item.id, 'uploading');
            try {
                // Check for conflict before upload (simplified for V1: just upload, or check HEAD)
                // PRD says: "Write: Copy on Write. Save -> Local -> Queue -> Upload"
                // Conflict resolution is mostly on READ or if upload fails due to version mismatch (if we had versions).
                // Here we just upload.

                const result = await cloudService.uploadFile(item.key, item.filePath);
                if (result) {
                    setMetadata(item.filePath, result.etag, result.lastModified);
                }
                removeFromQueue(item.id);
                // Emit event to notify that sync is completed for this file
                DeviceEventEmitter.emit(SYNC_COMPLETED_EVENT, { filePath: item.filePath });
            } catch (error) {
                console.error('Upload failed', error);
                incrementRetry(item.id);
                updateItemStatus(item.id, 'failed');
            }
        }

        this.isSyncing = false;
    }

    async checkForUpdates(fileName: string, localMtime: Date) {
        try {
            const files = await cloudService.listFiles(fileName);
            const cloudFile = files.find(f => f.key === fileName);
            if (cloudFile) {
                const cloudMtime = new Date(cloudFile.lastModified);
                if (cloudMtime > localMtime) {
                    return true; // Update available
                }
            }
        } catch (error) {
            console.error('Check updates failed', error);
        }
        return false;
    }

    async resolveConflict(filePath: string) {
        // Normalize path first
        const normalizedPath = normalizePath(filePath);

        // Rename local file (like "Save As" in Office apps)
        const fileName = normalizedPath.split('/').pop() || '';
        const dir = normalizedPath.replace(fileName, '');
        const timestamp = new Date().getTime();
        const newName = `${fileName.replace('.md', '')}_old_${timestamp}.md`;
        const newPath = normalizePath(`${dir}${newName}`);

        await fsService.moveFile(normalizedPath, newPath);

        // Set temporary metadata to prevent conflict detection before upload completes
        const { setMetadata } = require('../store/useFileMetadataStore').useFileMetadataStore.getState();
        setMetadata(newPath, 'uploading', new Date().toISOString());

        // Upload the renamed file to cloud
        this.syncFile(newPath);

        // Return new path so caller can navigate to the renamed file
        // Note: Cloud version is NOT downloaded. User can manually open it from file list if needed.
        return newPath;
    }
}

export const syncService = new SyncService();
