import { fsService } from './FileSystemService';
import { cloudService } from './CloudService';
import { useSettingsStore } from '../store/useSettingsStore';
import { useFileMetadataStore } from '../store/useFileMetadataStore';
import { DeviceEventEmitter } from 'react-native';
import { normalizePath } from '../utils/pathUtils';
import { syncService } from './SyncService';
import * as Network from 'expo-network';
import {
    FLASH_NOTES_UPDATED_EVENT,
    SHARE_RECEIVED_EVENT,
    BATCH_SYNC_STATUS_CHANGED_EVENT
} from '../constants/events';

export interface FlashNote {
    id: string;
    timestamp: string;
    content: string;
    filePath: string; // Added source file path
}

const HEADER_REGEX = /^(#{1,2})\s+(20\d{2}[-/]\d{1,2}[-/]\d{1,2}.*)/;

// Re-export events for backward compatibility
export { FLASH_NOTES_UPDATED_EVENT, SHARE_RECEIVED_EVENT, BATCH_SYNC_STATUS_CHANGED_EVENT };

// Updated event payload type
export interface BatchSyncStatusPayload {
    status: 'checking' | 'synced' | 'conflict' | 'offline' | 'error' | 'not-configured';
    conflicts: string[];
    uploadErrors: string[];
}

class FlashNoteService {
    private getFlashNotePath(): string {
        const { flashNoteConfig } = useSettingsStore.getState();
        const path = flashNoteConfig.path ? `${flashNoteConfig.path}/${flashNoteConfig.filename}` : flashNoteConfig.filename;
        return normalizePath(path);
    }

    async getSortedFilePaths(): Promise<string[]> {
        const { flashNoteConfig } = useSettingsStore.getState();
        const mainFilename = flashNoteConfig.filename;
        const dirPath = flashNoteConfig.path || '';
        const fullMainPath = dirPath ? `${dirPath}/${mainFilename}` : mainFilename;
        const normalizedMainPath = normalizePath(fullMainPath);

        const historyFolderPath = flashNoteConfig.historyFolderPath;

        if (!historyFolderPath || !(await fsService.exists(historyFolderPath))) {
            return [normalizedMainPath];
        }

        try {
            const files = await fsService.listFiles(historyFolderPath);
            const historyFiles: string[] = [];

            files.forEach(file => {
                if (file.isDirectory) return;
                if (!/\.md$/i.test(file.name)) return;
                const filePath = normalizePath(`${historyFolderPath}/${file.name}`);
                if (filePath === normalizedMainPath) return; // main file is handled separately
                historyFiles.push(filePath);
            });

            historyFiles.sort((a, b) => b.localeCompare(a));
            return [normalizedMainPath, ...historyFiles];
        } catch (e) {
            console.error('Failed to scan history files', e);
            return [normalizedMainPath];
        }
    }

    private async ensureDirectoryExists(filePath: string): Promise<void> {
        const lastSlashIndex = filePath.lastIndexOf('/');
        if (lastSlashIndex > 0) {
            const dirPath = filePath.substring(0, lastSlashIndex);
            if (!(await fsService.exists(dirPath))) {
                await fsService.createDirectory(dirPath);
            }
        }
    }

    private async saveAndSync(filePath: string, content: string): Promise<void> {
        await this.ensureDirectoryExists(filePath);
        await fsService.writeFile(filePath, content);
        useFileMetadataStore.getState().markFileAsModified(filePath);
        this.lastSyncTime = Date.now(); // suppress redundant syncAll on focus after write

        syncService.uploadFile(filePath, { useShadow: true, withLock: true }).catch(error => {
            console.error(`[FlashNoteService] Upload failed for ${filePath}:`, error);
        });

        DeviceEventEmitter.emit(FLASH_NOTES_UPDATED_EVENT);
    }

    private getFormattedTimestamp(): string {
        const now = new Date();
        const pad = (n: number) => n.toString().padStart(2, '0');
        return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    }

    parseNotes(content: string, filePath: string = ''): FlashNote[] {
        const lines = content.split('\n');
        const parsedNotes: FlashNote[] = [];
        let currentNote: Partial<FlashNote> = {};

        lines.forEach(line => {
            const match = line.match(HEADER_REGEX);
            if (match) {
                if (currentNote.id) {
                    currentNote.content = currentNote.content!.replace(/\s+$/, '');
                    parsedNotes.push(currentNote as FlashNote);
                }
                const timestamp = match[2].trim();
                currentNote = { id: timestamp, timestamp: timestamp, content: '', filePath: filePath };
            } else {
                if (currentNote.id) {
                    currentNote.content += line + '\n';
                }
            }
        });
        if (currentNote.id) {
            currentNote.content = currentNote.content!.replace(/\s+$/, '');
            parsedNotes.push(currentNote as FlashNote);
        }

        parsedNotes.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
        return parsedNotes;
    }

    async addNote(content: string): Promise<FlashNote | null> {
        const trimmedInput = content.trim();
        if (!trimmedInput) return null;

        const filePath = this.getFlashNotePath();
        let currentContent = '';

        try {
            if (await fsService.exists(filePath)) {
                currentContent = await fsService.readFile(filePath);
            }
        } catch {
            // Ignore error if file doesn't exist, start fresh
        }

        const timestamp = this.getFormattedTimestamp();
        const { flashNoteConfig } = useSettingsStore.getState();
        const suffix = flashNoteConfig.suffix || '';
        const newEntry = `\n\n## ${timestamp}\n${trimmedInput}${suffix}`;

        const newContent = currentContent + newEntry;

        await this.saveAndSync(filePath, newContent);

        return {
            id: timestamp,
            timestamp,
            content: `${trimmedInput}${suffix}`,
            filePath,
        };
    }

    async updateNote(id: string, newText: string): Promise<FlashNote> {
        const filePath = this.getFlashNotePath();
        const currentContent = await fsService.readFile(filePath);

        const noteBlocks = currentContent.split(/(?=^##\s)/m).filter(b => b.trim());
        let noteFound = false;

        const newBlocks = noteBlocks.map(block => {
            if (block.trim().startsWith(`## ${id}`)) {
                noteFound = true;
                return `## ${id}\n${newText.trim()}\n`;
            }
            return block;
        });

        if (noteFound) {
            await this.saveAndSync(filePath, newBlocks.join(''));
            return {
                id,
                timestamp: id,
                content: newText.trim(),
                filePath,
            };
        } else {
            throw new Error('Note not found');
        }
    }

    async deleteNote(noteId: string): Promise<void> {
        const filePath = this.getFlashNotePath();
        const currentContent = await fsService.readFile(filePath);

        const lines = currentContent.split('\n');
        const newLines: string[] = [];
        let skipMode = false;

        lines.forEach(line => {
            const match = line.match(HEADER_REGEX);
            if (match) {
                const timestamp = match[2].trim();
                if (timestamp === noteId) {
                    skipMode = true;
                } else {
                    skipMode = false;
                    newLines.push(line);
                }
            } else {
                if (!skipMode) {
                    newLines.push(line);
                }
            }
        });

        await this.saveAndSync(filePath, newLines.join('\n'));
    }

    /**
     * Stage 2: Retry Local Upload Failures
     * Checks for files with 'failed' or 'conflict-failed' states.
     * Retries upload or attempts smart merge for optimistic lock failures.
     */
    private async retryLocalFailures(allFiles: string[]): Promise<{ uploadErrors: string[], conflicts: string[] }> {
        const { getMetadata } = useFileMetadataStore.getState();
        const uploadErrors: string[] = [];
        const conflicts: string[] = [];

        for (const filePath of allFiles) {
            const metadata = getMetadata(filePath);
            if (!metadata) continue;

            if (metadata.uploadState === 'failed') {
                console.log(`[FlashNoteService] Retrying failed upload for ${filePath}`);
                const success = await syncService.uploadFile(filePath);
                if (!success) {
                    uploadErrors.push(filePath);
                }
            } else if (metadata.uploadState === 'conflict-failed') {
                console.log(`[FlashNoteService] Optimistic lock failure for ${filePath} -> Attempting Smart Merge`);
                const mergeSuccess = await syncService.syncFile(filePath, { smartMerge: true });
                if (mergeSuccess !== 'synced') {
                    console.log(`[FlashNoteService] Smart Merge failed for ${filePath} -> Marking as Conflict`);
                    conflicts.push(filePath);
                } else {
                    console.log(`[FlashNoteService] Smart Merge recovered ${filePath}`);
                }
            }
        }
        return { uploadErrors, conflicts };
    }

    private _isSyncing: boolean = false;
    private lastSyncTime: number = 0;

    async syncAll(): Promise<void> {
        const { flashNoteConfig } = useSettingsStore.getState();
        const scanDirPath = flashNoteConfig.historyFolderPath || '';

        const emitStatus = (payload: BatchSyncStatusPayload) => {
            DeviceEventEmitter.emit(BATCH_SYNC_STATUS_CHANGED_EVENT, payload);
        };

        if (this._isSyncing) {
            console.log('[FlashNoteService] syncAll skipped: Sync already in progress');
            return;
        }

        // 10s cooldown to prevent rapid tab switching triggers
        if (Date.now() - this.lastSyncTime < 10000) {
            console.log('[FlashNoteService] syncAll skipped: cooldown active');
            return;
        }

        this._isSyncing = true;

        // Broadcast checking status
        emitStatus({ status: 'checking', conflicts: [], uploadErrors: [] });

        // 1. Stage 1: Environment Checks
        const netState = await Network.getNetworkStateAsync();
        if (!netState.isConnected) {
            console.log('[FlashNoteService] Offline, skipping sync.');
            emitStatus({ status: 'offline', conflicts: [], uploadErrors: [] });
            this._isSyncing = false;
            return;
        }

        if (!cloudService.isConfigured()) {
            emitStatus({ status: 'not-configured', conflicts: [], uploadErrors: [] });
            this._isSyncing = false;
            return;
        }

        // 2. Prepare Local File List (Main + all .md files in historyFolderPath)
        const localFiles = await this.getSortedFilePaths();
        const mainPath = localFiles[0];

        try {
            // 3. Stage 2: Retry Local Failures
            const { uploadErrors: retryErrors, conflicts: retryConflicts } = await this.retryLocalFailures(localFiles);

            // 4. Stage 3: Full Sync & Conflict Detection
            let prefix = scanDirPath;
            if (prefix && !prefix.endsWith('/')) prefix += '/';

            console.log(`[FlashNoteService] Starting Full Sync. Cloud Prefix: ${prefix || '(none)'}`);

            const [cloudList, mainFileMeta] = await Promise.all([
                prefix
                    ? cloudService.listFiles(prefix).catch(e => {
                        console.warn('[FlashNoteService] Failed to list prefix:', e);
                        return [] as import('./CloudService').CloudFileItem[];
                    })
                    : Promise.resolve([] as import('./CloudService').CloudFileItem[]),
                cloudService.headFile(mainPath).catch(() => null)
            ]);

            const cloudFiles = [...cloudList];
            if (mainFileMeta) {
                const alreadyExists = cloudFiles.some(f => normalizePath(f.key) === mainPath);
                if (!alreadyExists) {
                    cloudFiles.push({
                        key: mainPath,
                        etag: mainFileMeta.etag,
                        lastModified: mainFileMeta.lastModified,
                        size: 0,
                        isDirectory: false
                    });
                }
            }

            // Filter function: main file or any .md in historyFolderPath
            const normalizedScanDir = scanDirPath ? normalizePath(scanDirPath) : '';
            const fileFilter = (key: string) => {
                const normalizedKey = normalizePath(key);
                if (normalizedKey === mainPath) return true;
                if (normalizedScanDir && normalizedKey.startsWith(normalizedScanDir + '/') && normalizedKey.endsWith('.md')) return true;
                return false;
            };

            const batchResults = await syncService.syncBatchFiles(cloudFiles, fileFilter, {
                useShadow: true,
                localFiles: localFiles,
                smartMerge: true
            });

            // Merge Stage 2 results with Stage 3 results
            const conflicts: string[] = [...retryConflicts, ...batchResults.conflictedFiles];
            const uploadErrors: string[] = [...retryErrors, ...batchResults.errorFiles];

            console.log(`[FlashNoteService] Sync Complete. Conflicts: ${conflicts.length}, Errors: ${uploadErrors.length}`);

            if (conflicts.length > 0 || uploadErrors.length > 0) {
                DeviceEventEmitter.emit(FLASH_NOTES_UPDATED_EVENT);
                emitStatus({ status: 'conflict', conflicts, uploadErrors });
            } else {
                DeviceEventEmitter.emit(FLASH_NOTES_UPDATED_EVENT);
                emitStatus({ status: 'synced', conflicts: [], uploadErrors: [] });
            }

        } catch (e) {
            console.error('[FlashNoteService] Batch Sync Failed:', e);
            emitStatus({ status: 'error', conflicts: [], uploadErrors: [] });
        } finally {
            this._isSyncing = false;
            this.lastSyncTime = Date.now();
        }
    }

    async resolveConflictForFile(filePath: string, strategy: 'useCloud' | 'useLocal' | 'saveCopy'): Promise<void> {
        return syncService.resolveConflict(filePath, strategy);
    }
}

export const flashNoteService = new FlashNoteService();
