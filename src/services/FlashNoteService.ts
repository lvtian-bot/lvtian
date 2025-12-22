import { fsService } from './FileSystemService';
import { cloudService } from './CloudService';
import { useSettingsStore } from '../store/useSettingsStore';
import { useFileMetadataStore } from '../store/useFileMetadataStore';
import { DeviceEventEmitter } from 'react-native';
import { normalizePath } from '../utils/pathUtils';
import { syncService } from './SyncService';
import { shadowFileService } from './ShadowFileService';
import { mergeUtils } from '../utils/mergeUtils';
import { TodoItem, TodoStatus } from '../types/todo';
import { TodoParser } from '../utils/TodoParser';
import NetInfo from "@react-native-community/netinfo";

export interface FlashNote {
    id: string;
    timestamp: string;
    content: string;
    filePath: string; // Added source file path
}

// TodoStatus and TodoItem are now imported from ../types/todo
export type { TodoItem, TodoStatus };

const HEADER_REGEX = /^(#{1,2})\s+(20\d{2}[-/]\d{1,2}[-/]\d{1,2}.*)/;
// TODO_REGEX is now handled by TodoParser

export const FLASH_NOTES_UPDATED_EVENT = 'FLASH_NOTES_UPDATED';
export const SHARE_RECEIVED_EVENT = 'SHARE_RECEIVED_EVENT';

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

        const historyPattern = flashNoteConfig.historyPattern || 'none';

        if (historyPattern === 'none') {
            return [normalizedMainPath];
        }

        const namePart = mainFilename.replace(/\.md$/i, '');
        let regex: RegExp | null = null;

        if (historyPattern === 'dash-yyyymm') {
            const escapedName = namePart.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            regex = new RegExp(`^${escapedName}-(\\d{6})\\.md$`, 'i');
        } else if (historyPattern === 'underscore-yyyymm') {
            const escapedName = namePart.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            regex = new RegExp(`^${escapedName}_(\\d{6})\\.md$`, 'i');
        } else if (historyPattern === 'dash-yyyy') {
            const escapedName = namePart.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            regex = new RegExp(`^${escapedName}-(\\d{4})\\.md$`, 'i');
        } else if (historyPattern === 'chinese-yyyymm') {
            const escapedName = namePart.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            // Match -YYYY年M月 or -YYYY年MM月
            regex = new RegExp(`^${escapedName}-(\\d{4})年(\\d{1,2})月\\.md$`, 'i');
        }

        if (!regex) {
            return [normalizedMainPath];
        }

        try {
            const scanDirPath = flashNoteConfig.historyFolderPath || dirPath; // Use historyFolderPath if set, else main path

            // Check if directory exists before listing
            if (!scanDirPath || !(await fsService.exists(scanDirPath))) {
                return [normalizedMainPath];
            }

            const files = await fsService.listFiles(scanDirPath);
            const historyFiles: string[] = [];

            files.forEach(file => {
                if (file.isDirectory) return;
                // Important: If mainFilename is found in history folder, it means it's a copy
                // We should still treat it as a history file if it matches pattern.
                // The main path itself is always returned first, so we don't need to filter it out here
                // unless we want to avoid duplicate entries if main file itself matches history pattern
                // Let's filter if it's the exact main file path to avoid duplicates if main is in history folder
                if (normalizePath(scanDirPath ? `${scanDirPath}/${file.name}` : file.name) === normalizedMainPath) return;

                const match = file.name.match(regex!);
                if (match) {
                    const relativePath = scanDirPath ? `${scanDirPath}/${file.name}` : file.name;
                    historyFiles.push(normalizePath(relativePath));
                }
            });

            // Custom sort for Chinese date format to ensure correct order (e.g., 10月 > 2月)
            if (historyPattern === 'chinese-yyyymm') {
                historyFiles.sort((a, b) => {
                    const getYearMonth = (path: string) => {
                        const filename = path.split('/').pop() || '';
                        const match = filename.match(regex!);
                        if (match) {
                            const year = parseInt(match[1], 10);
                            const month = parseInt(match[2], 10);
                            return year * 100 + month;
                        }
                        return 0;
                    };
                    return getYearMonth(b) - getYearMonth(a); // Descending order
                });
            } else {
                historyFiles.sort((a, b) => b.localeCompare(a));
            }

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

    private getFormattedTimestamp(): string {
        const now = new Date();
        const pad = (n: number) => n.toString().padStart(2, '0');
        return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    }

    private getDateString(): string {
        const now = new Date();
        const pad = (n: number) => n.toString().padStart(2, '0');
        return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    }

    parseNotes(content: string, filePath: string = ''): FlashNote[] {
        const { flashNoteConfig } = useSettingsStore.getState();
        const suffix = flashNoteConfig.suffix || '';

        // Create regex to match suffix followed by only whitespace at end
        // If suffix is empty, just trim trailing whitespace
        const suffixRegex = suffix ? new RegExp(suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$') : /\s*$/;

        const lines = content.split('\n');
        const parsedNotes: FlashNote[] = [];
        let currentNote: Partial<FlashNote> = {};

        lines.forEach(line => {
            const match = line.match(HEADER_REGEX);
            if (match) {
                if (currentNote.id) {
                    currentNote.content = currentNote.content!.replace(suffixRegex, '');
                    parsedNotes.push(currentNote as FlashNote);
                }
                const timestamp = match[2].trim();
                currentNote = { id: timestamp, timestamp: timestamp, content: '', filePath: filePath };
            } else {
                if (currentNote.id) {
                    // 过滤掉只包含 > 和空白字符的行
                    if (/^\s*>\s*$/.test(line)) {
                        return;
                    }
                    currentNote.content += line + '\n';
                }
            }
        });
        if (currentNote.id) {
            currentNote.content = currentNote.content!.replace(suffixRegex, '');
            parsedNotes.push(currentNote as FlashNote);
        }

        // console.log(`Parsed ${parsedNotes.length} notes from ${filePath}. Latest: ${parsedNotes[0]?.timestamp}`);
        parsedNotes.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
        return parsedNotes;
    }

    extractTodos(notes: FlashNote[]): TodoItem[] {
        const todos: TodoItem[] = [];

        notes.forEach(note => {
            const lines = note.content.split('\n');
            lines.forEach((line, index) => {
                const todoItem = TodoParser.parse(line, note.id, note.filePath, index);
                if (todoItem) {
                    todos.push(todoItem);
                }
            });
        });

        return todos;
    }

    async addNote(content: string): Promise<void> {
        const trimmedInput = content.trim();
        if (!trimmedInput) return;

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
        const newEntry = `\n## ${timestamp}\n${trimmedInput}${suffix}`;

        const newContent = currentContent + newEntry;

        // Ensure directory exists before writing
        await this.ensureDirectoryExists(filePath);
        await fsService.writeFile(filePath, newContent);
        useFileMetadataStore.getState().markFileAsModified(filePath);

        // Upload to cloud if configured (async, don't wait)
        syncService.uploadFile(filePath, { useShadow: true }).catch(error => {
            console.error('FlashNoteService addNote upload failed:', error);
        });

        DeviceEventEmitter.emit(FLASH_NOTES_UPDATED_EVENT);
    }

    async updateNote(id: string, newText: string): Promise<void> {
        const filePath = this.getFlashNotePath();
        const currentContent = await fsService.readFile(filePath);
        const { flashNoteConfig } = useSettingsStore.getState();
        const suffix = flashNoteConfig.suffix || '';

        const noteBlocks = currentContent.split(/(?=^##\s)/m).filter(b => b.trim());
        let noteFound = false;

        const newBlocks = noteBlocks.map(block => {
            if (block.trim().startsWith(`## ${id}`)) {
                noteFound = true;
                return `## ${id}\n${newText.trim()}${suffix}\n`;
            }
            return block;
        });

        if (noteFound) {
            const newContent = newBlocks.join('');
            await this.ensureDirectoryExists(filePath);
            await fsService.writeFile(filePath, newContent);
            useFileMetadataStore.getState().markFileAsModified(filePath);

            // Upload to cloud if configured (async, don't wait)
            syncService.uploadFile(filePath, { useShadow: true }).catch(error => {
                console.error('FlashNoteService updateNote upload failed:', error);
            });

            DeviceEventEmitter.emit(FLASH_NOTES_UPDATED_EVENT);
        } else {
            throw new Error('Note not found');
        }
    }

    async updateTodoStatus(noteId: string, rawLine: string, newStatus: TodoStatus, filePath?: string): Promise<void> {
        const targetPath = filePath || this.getFlashNotePath();
        const currentContent = await fsService.readFile(targetPath);

        // Find the note block
        const noteBlocks = currentContent.split(/(?=^##\s)/m).filter(b => b.trim());
        let noteFound = false;

        const newBlocks = noteBlocks.map(block => {
            if (block.trim().startsWith(`## ${noteId}`)) {
                noteFound = true;

                const lines = block.split('\n');
                let replaced = false;
                const newLines = lines.map((line, index) => {
                    // Try exact match or trimmed match
                    if (!replaced && (line === rawLine || line.trim() === rawLine.trim())) {
                        const todoItem = TodoParser.parse(line, noteId, targetPath, index);
                        if (todoItem) {
                            replaced = true;
                            todoItem.status = newStatus;

                            const today = this.getDateString();

                            if (newStatus === 'done') {
                                todoItem.completedAt = today;
                                todoItem.canceledAt = undefined;
                            } else if (newStatus === 'canceled') {
                                todoItem.canceledAt = today;
                                todoItem.completedAt = undefined;
                            } else {
                                // Reset dates if moving back to todo/in-progress
                                todoItem.completedAt = undefined;
                                todoItem.canceledAt = undefined;
                            }

                            return TodoParser.serialize(todoItem);
                        }
                    }
                    return line;
                });

                if (replaced) {
                    return newLines.join('\n');
                }
            }
            return block;
        });

        if (noteFound) {
            const newContent = newBlocks.join('');
            await this.ensureDirectoryExists(targetPath);
            await fsService.writeFile(targetPath, newContent);
            useFileMetadataStore.getState().markFileAsModified(targetPath);

            // Upload to cloud logic
            syncService.uploadFile(targetPath, { useShadow: true }).catch(error => {
                console.error('FlashNoteService updateTodoStatus upload failed:', error);
            });

            DeviceEventEmitter.emit(FLASH_NOTES_UPDATED_EVENT);
        }
    }

    async updateTodoContent(noteId: string, rawLine: string, newContentText: string, filePath?: string): Promise<void> {
        const targetPath = filePath || this.getFlashNotePath();
        const currentContent = await fsService.readFile(targetPath);

        const noteBlocks = currentContent.split(/(?=^##\s)/m).filter(b => b.trim());
        let noteFound = false;

        const newBlocks = noteBlocks.map(block => {
            if (block.trim().startsWith(`## ${noteId}`)) {
                noteFound = true;

                const lines = block.split('\n');
                let replaced = false;
                const newLines = lines.map((line, index) => {
                    if (!replaced && (line === rawLine || line.trim() === rawLine.trim())) {
                        const todoItem = TodoParser.parse(line, noteId, targetPath, index);
                        if (todoItem) {
                            replaced = true;

                            // Split input which might contain multiple lines (from multiline edit)
                            const inputLines = newContentText.split('\n');

                            const resultLines = inputLines.map((lineContent, idx) => {
                                // Create a dummy line to parse tags from the input text (which includes suffix tags)
                                const dummyLine = `- [ ] ${lineContent}`;
                                const parsedNew = TodoParser.parse(dummyLine, '', '', 0);

                                if (idx === 0) {
                                    // First line updates the EXISTING item
                                    if (parsedNew) {
                                        todoItem.content = parsedNew.content;
                                        todoItem.priority = parsedNew.priority;
                                        todoItem.dueAt = parsedNew.dueAt;
                                        // Preserve completedAt/canceledAt unless needed (omitted here as typically content edit doesn't change status)
                                    } else {
                                        todoItem.content = lineContent;
                                    }
                                    return TodoParser.serialize(todoItem);
                                } else {
                                    // Subsequent lines become NEW independent todos
                                    // They start as 'todo' status (from dummy string '- [ ]')
                                    if (parsedNew) {
                                        return TodoParser.serialize(parsedNew);
                                    }
                                    return dummyLine;
                                }
                            });

                            return resultLines.join('\n');


                        }
                    }
                    return line;
                });
                return newLines.join('\n');
            }
            return block;
        });

        if (noteFound) {
            const newContent = newBlocks.join('');
            await this.ensureDirectoryExists(targetPath);
            await fsService.writeFile(targetPath, newContent);
            useFileMetadataStore.getState().markFileAsModified(targetPath);

            syncService.uploadFile(targetPath, { useShadow: true }).catch(error => {
                console.error('FlashNoteService updateTodoContent upload failed:', error);
            });

            DeviceEventEmitter.emit(FLASH_NOTES_UPDATED_EVENT);
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

        const newContent = newLines.join('\n');
        await this.ensureDirectoryExists(filePath);
        await fsService.writeFile(filePath, newContent);
        useFileMetadataStore.getState().markFileAsModified(filePath);

        // Upload to cloud if configured
        syncService.uploadFile(filePath, { useShadow: true }).catch(error => {
            console.error('Upload failed:', error);
        });

        DeviceEventEmitter.emit(FLASH_NOTES_UPDATED_EVENT);
    }

    async syncMainFile(): Promise<void> {
        const filePath = this.getFlashNotePath();

        if (!cloudService.isConfigured()) {
            console.log('Cloud not configured, skipping main file sync');
            return;
        }

        try {
            // Use SyncService to handle basic sync (CloudNewer -> Download, LocalNewer -> Upload)
            // Enable shadow file updates
            const syncResult = await syncService.syncFile(filePath, { useShadow: true });

            if (syncResult === 'synced') {
                DeviceEventEmitter.emit(FLASH_NOTES_UPDATED_EVENT);
                return;
            }

            if (syncResult === 'conflict') {
                // Handle Bidirectional Conflict with 3-Way Merge
                console.log('Bidirectional conflict detected in main file. Attempting 3-way merge...');

                // 1. Get Base (Shadow)
                const baseContent = await shadowFileService.getShadow(filePath);
                if (baseContent === null) {
                    console.warn('No shadow file found for 3-way merge. Falling back to cloud overwrite (safe default) or manual resolution.');
                    // Without base, we can't do 3-way. 
                    // Option A: Union Merge (diff-match-patch without base) - risky?
                    // Option B: Let user decide (keep current conflict state).
                    // For now, let's just return and let the UI show conflict.
                    return;
                }

                // 2. Get Local
                const localContent = await fsService.readFile(filePath);

                // 3. Get Cloud (Download to temp)
                // We don't have a direct "download to string" method exposed in cloudService yet, 
                // but we can download to a temp file.
                const tempPath = `${filePath}.cloud.tmp`;
                await cloudService.downloadFile(filePath, tempPath);
                const cloudContent = await fsService.readFile(tempPath);
                await fsService.deleteFile(tempPath);

                // 4. Merge
                const mergeResult = mergeUtils.threeWayMerge(baseContent, localContent, cloudContent);

                // 5. Apply Merge
                await fsService.writeFile(filePath, mergeResult.mergedContent);
                useFileMetadataStore.getState().markFileAsModified(filePath);

                // 6. Upload Merged Content (and update shadow)
                console.log('Merge successful. Uploading merged content...');
                await syncService.uploadFile(filePath, { useShadow: true });

                DeviceEventEmitter.emit(FLASH_NOTES_UPDATED_EVENT);
            }

        } catch (error) {
            console.error('Failed to sync main file:', error);
            // Don't throw, just log. UI will show error state via hooks.
        }
    }

    async syncHistoryFiles(): Promise<void> {
        const { flashNoteConfig } = useSettingsStore.getState();

        // 1. Network Check (Service Layer Protection)
        const netState = await NetInfo.fetch();
        if (!netState.isConnected) {
            console.log('[FlashNoteService] Offline, skipping history sync.');
            return;
        }

        if (!cloudService.isConfigured()) {
            return;
        }

        if (flashNoteConfig.historyPattern === 'none') {
            return;
        }

        const mainFilename = flashNoteConfig.filename;
        const dirPath = flashNoteConfig.path || '';
        const scanDirPath = flashNoteConfig.historyFolderPath || dirPath;

        // Ensure local directory exists
        if (scanDirPath && !(await fsService.exists(scanDirPath))) {
            await fsService.createDirectory(scanDirPath);
        }

        // Construct regex for matching
        const namePart = mainFilename.replace(/\.md$/i, '');
        let regex: RegExp | null = null;

        if (flashNoteConfig.historyPattern === 'dash-yyyymm') {
            const escapedName = namePart.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            regex = new RegExp(`^${escapedName}-(\\d{6})\\.md$`, 'i');
        } else if (flashNoteConfig.historyPattern === 'underscore-yyyymm') {
            const escapedName = namePart.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            regex = new RegExp(`^${escapedName}_(\\d{6})\\.md$`, 'i');
        } else if (flashNoteConfig.historyPattern === 'dash-yyyy') {
            const escapedName = namePart.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            regex = new RegExp(`^${escapedName}-(\\d{4})\\.md$`, 'i');
        } else if (flashNoteConfig.historyPattern === 'chinese-yyyymm') {
            const escapedName = namePart.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            regex = new RegExp(`^${escapedName}-(\\d{4})年(\\d{1,2})月\\.md$`, 'i');
        }

        if (!regex) return;

        const allFilesSet = new Set<string>();

        // 1. Scan Local Files
        try {
            if (await fsService.exists(scanDirPath)) {
                const localFiles = await fsService.listFiles(scanDirPath);
                localFiles.forEach(file => {
                    if (file.isDirectory) return;
                    // Skip main file if it's in the same directory
                    if (normalizePath(scanDirPath ? `${scanDirPath}/${file.name}` : file.name) === normalizePath(dirPath ? `${dirPath}/${mainFilename}` : mainFilename)) return;

                    if (regex!.test(file.name)) {
                        allFilesSet.add(normalizePath(scanDirPath ? `${scanDirPath}/${file.name}` : file.name));
                    }
                });
            }
        } catch (e) {
            console.error('Error scanning local history:', e);
        }

        // 2. Scan Cloud Files
        try {
            let prefix = scanDirPath;
            if (prefix && !prefix.endsWith('/')) prefix += '/';

            console.log(`Scanning cloud files with prefix: ${prefix}`);
            const cloudFiles = await cloudService.listFiles(prefix);

            cloudFiles.forEach(file => {
                const filename = file.key.split('/').pop();
                if (!filename) return;
                if (filename === mainFilename) return;

                if (regex!.test(filename)) {
                    allFilesSet.add(normalizePath(file.key));
                }
            });
        } catch (error: any) {
            if (error?.message === 'Network request failed' || error?.message?.includes('Network request failed')) {
                console.log('[FlashNoteService] History scan aborted due to network error.');
                return; // Abort the rest of the sync process
            } else {
                console.warn('Failed to scan cloud history files:', error);
            }
        }

        // 3. Sync All Found Files
        console.log(`Found ${allFilesSet.size} history files to sync.`);

        // Process sequentially to avoid overwhelming network/CPU
        for (const filePath of allFilesSet) {
            try {
                await syncService.syncFile(filePath, { useShadow: true });
            } catch (e) {
                console.error(`Failed to sync history file ${filePath}`, e);
            }
        }

        DeviceEventEmitter.emit(FLASH_NOTES_UPDATED_EVENT);
    }
}

export const flashNoteService = new FlashNoteService();
