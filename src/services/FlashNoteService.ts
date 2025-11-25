import { fsService } from './FileSystemService';
import { cloudService, UPLOAD_COMPLETED_EVENT } from './CloudService';
import { useSettingsStore } from '../store/useSettingsStore';
import { useFileMetadataStore } from '../store/useFileMetadataStore';
import { DeviceEventEmitter } from 'react-native';
import { normalizePath } from '../utils/pathUtils';

export interface FlashNote {
    id: string;
    timestamp: string;
    content: string;
}

const SUFFIX_REGEX = /\n>\s*$/;
const HEADER_REGEX = /^(#{1,2})\s+(20\d{2}[-/]\d{1,2}[-/]\d{1,2}.*)/;

export const FLASH_NOTES_UPDATED_EVENT = 'FLASH_NOTES_UPDATED';
export const SHARE_RECEIVED_EVENT = 'SHARE_RECEIVED_EVENT';

class FlashNoteService {
    private getFlashNotePath(): string {
        const { flashNoteConfig } = useSettingsStore.getState();
        const path = flashNoteConfig.path ? `${flashNoteConfig.path}/${flashNoteConfig.filename}` : flashNoteConfig.filename;
        return normalizePath(path);
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

    parseNotes(content: string): FlashNote[] {
        const lines = content.split('\n');
        const parsedNotes: FlashNote[] = [];
        let currentNote: Partial<FlashNote> = {};

        lines.forEach(line => {
            const match = line.match(HEADER_REGEX);
            if (match) {
                if (currentNote.id) {
                    currentNote.content = currentNote.content!.replace(SUFFIX_REGEX, '');
                    parsedNotes.push(currentNote as FlashNote);
                }
                const timestamp = match[2].trim();
                currentNote = { id: timestamp, timestamp: timestamp, content: '' };
            } else {
                if (currentNote.id) {
                    currentNote.content += line + '\n';
                }
            }
        });
        if (currentNote.id) {
            currentNote.content = currentNote.content!.replace(SUFFIX_REGEX, '');
            parsedNotes.push(currentNote as FlashNote);
        }

        console.log(`Parsed ${parsedNotes.length} notes. Latest: ${parsedNotes[0]?.timestamp}`);
        parsedNotes.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
        return parsedNotes;
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
        } catch (e) {
            // Ignore error if file doesn't exist, start fresh
        }

        const timestamp = this.getFormattedTimestamp();
        const suffix = '\n> ';
        const newEntry = `\n\n## ${timestamp}\n${trimmedInput}${suffix}`;

        const newContent = currentContent.trim() ? currentContent.trim() + newEntry : `## ${timestamp}\n${trimmedInput}${suffix}`;

        // Ensure directory exists before writing
        await this.ensureDirectoryExists(filePath);
        await fsService.writeFile(filePath, newContent);

        // Upload to cloud if configured (async, don't wait)
        if (cloudService.isConfigured()) {
            const { setMetadata, setUploadState } = useFileMetadataStore.getState();
            setUploadState(filePath, 'uploading');

            // Start upload in background
            cloudService.uploadFile(filePath, filePath).then(result => {
                if (result) {
                    setMetadata(filePath, result.etag, result.lastModified);
                }
                // Notify UI that upload completed
                DeviceEventEmitter.emit(UPLOAD_COMPLETED_EVENT, { filePath });
            }).catch(error => {
                console.error('Upload failed:', error);
                setUploadState(filePath, 'failed');
                // Notify UI that upload failed
                DeviceEventEmitter.emit(UPLOAD_COMPLETED_EVENT, { filePath });
            });
        }

        DeviceEventEmitter.emit(FLASH_NOTES_UPDATED_EVENT);
    }

    async updateNote(id: string, newText: string): Promise<void> {
        const filePath = this.getFlashNotePath();
        const currentContent = await fsService.readFile(filePath);
        const suffix = '\n> ';

        const noteBlocks = currentContent.split(/(?=^##\s)/m);
        let noteFound = false;

        const newBlocks = noteBlocks.map(block => {
            if (block.trim().startsWith(`## ${id}`)) {
                noteFound = true;
                return `## ${id}\n${newText.trim()}${suffix}`;
            }
            return block;
        });

        if (noteFound) {
            const newContent = newBlocks.join('');
            await this.ensureDirectoryExists(filePath);
            await fsService.writeFile(filePath, newContent);

            // Upload to cloud if configured (async, don't wait)
            if (cloudService.isConfigured()) {
                const { setMetadata, setUploadState } = useFileMetadataStore.getState();
                setUploadState(filePath, 'uploading');

                // Start upload in background
                cloudService.uploadFile(filePath, filePath).then(result => {
                    if (result) {
                        setMetadata(filePath, result.etag, result.lastModified);
                    }
                    DeviceEventEmitter.emit(UPLOAD_COMPLETED_EVENT, { filePath });
                }).catch(error => {
                    console.error('Upload failed:', error);
                    setUploadState(filePath, 'failed');
                    DeviceEventEmitter.emit(UPLOAD_COMPLETED_EVENT, { filePath });
                });
            }

            DeviceEventEmitter.emit(FLASH_NOTES_UPDATED_EVENT);
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

        const newContent = newLines.join('\n');
        await this.ensureDirectoryExists(filePath);
        await fsService.writeFile(filePath, newContent);

        // Upload to cloud if configured
        if (cloudService.isConfigured()) {
            try {
                const result = await cloudService.uploadFile(filePath, filePath);
                if (result) {
                    const { setMetadata } = useFileMetadataStore.getState();
                    setMetadata(filePath, result.etag, result.lastModified);
                }
            } catch (error) {
                console.error('Upload failed:', error);
                // TODO: Add to retry queue
            }
        }

        DeviceEventEmitter.emit(FLASH_NOTES_UPDATED_EVENT);
    }
}

export const flashNoteService = new FlashNoteService();
