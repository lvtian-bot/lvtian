import { fsService } from './FileSystemService';
import { syncService } from './SyncService';
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

class FlashNoteService {
    private getFlashNotePath(): string {
        const { flashNoteConfig } = useSettingsStore.getState();
        const path = flashNoteConfig.path ? `${flashNoteConfig.path}/${flashNoteConfig.filename}` : flashNoteConfig.filename;
        return normalizePath(path);
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

        await fsService.writeFile(filePath, newContent);

        // Set temporary metadata to indicate uploading state (only if cloud is configured)
        const { cloudService } = require('./CloudService');
        if (cloudService.isConfigured()) {
            const { setMetadata } = useFileMetadataStore.getState();
            setMetadata(filePath, 'uploading', new Date().toISOString());
            await syncService.syncFile(filePath);
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
            await fsService.writeFile(filePath, newContent);

            // Set temporary metadata to indicate uploading state (only if cloud is configured)
            const { cloudService } = require('./CloudService');
            if (cloudService.isConfigured()) {
                const { setMetadata } = useFileMetadataStore.getState();
                setMetadata(filePath, 'uploading', new Date().toISOString());
                await syncService.syncFile(filePath);
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
        await fsService.writeFile(filePath, newContent);

        // Set temporary metadata to indicate uploading state (only if cloud is configured)
        const { cloudService } = require('./CloudService');
        if (cloudService.isConfigured()) {
            const { setMetadata } = useFileMetadataStore.getState();
            setMetadata(filePath, 'uploading', new Date().toISOString());
            await syncService.syncFile(filePath);
        }

        DeviceEventEmitter.emit(FLASH_NOTES_UPDATED_EVENT);
    }
}

export const flashNoteService = new FlashNoteService();
