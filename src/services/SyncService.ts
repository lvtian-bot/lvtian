import { cloudService } from './CloudService';
import { fsService } from './FileSystemService';
import { useSyncStore } from '../store/useSyncStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { Alert } from 'react-native';

class SyncService {
    private isSyncing = false;

    async init() {
        // Initialize cloud provider with settings
        const { cosConfig } = useSettingsStore.getState();
        if (cosConfig.secretId && cosConfig.secretKey) {
            const { TencentCOSProvider } = require('./TencentCOSProvider');
            const provider = new TencentCOSProvider(
                cosConfig.secretId,
                cosConfig.secretKey,
                cosConfig.bucket,
                cosConfig.region
            );
            cloudService.setProvider(provider);
        }
        this.processQueue();
    }

    async syncFile(filePath: string) {
        const fileName = filePath.split('/').pop() || 'untitled.md';
        // Add to queue
        useSyncStore.getState().addToQueue(filePath, fileName);
        // Trigger processing
        this.processQueue();
    }

    async processQueue() {
        if (this.isSyncing) return;
        this.isSyncing = true;

        const { uploadQueue, updateItemStatus, removeFromQueue, incrementRetry } = useSyncStore.getState();
        const pendingItems = uploadQueue.filter(item => item.status === 'pending' || item.status === 'failed');

        for (const item of pendingItems) {
            if (item.retryCount > 3) {
                updateItemStatus(item.id, 'failed');
                continue;
            }

            updateItemStatus(item.id, 'uploading');
            try {
                // Check for conflict before upload (simplified for V1: just upload, or check HEAD)
                // PRD says: "Write: Copy on Write. Save -> Local -> Queue -> Upload"
                // Conflict resolution is mostly on READ or if upload fails due to version mismatch (if we had versions).
                // Here we just upload.

                await cloudService.uploadFile(item.key, item.filePath);
                removeFromQueue(item.id);
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
        // Rename local file
        const fileName = filePath.split('/').pop() || '';
        const dir = filePath.replace(fileName, '');
        const timestamp = new Date().getTime();
        const newName = `${fileName.replace('.md', '')}_old_${timestamp}.md`;
        const newPath = `${dir}${newName}`;

        await fsService.moveFile(filePath, newPath);

        // Download new version
        await cloudService.downloadFile(fileName, filePath);

        // Upload the backup
        this.syncFile(newPath);

        return newPath;
    }
}

export const syncService = new SyncService();
