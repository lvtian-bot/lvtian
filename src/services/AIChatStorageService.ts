import { fsService } from './FileSystemService';
import { cloudService } from './CloudService';
import { syncService } from './SyncService';
import { ChatSession } from '../store/useAIStore';

const AI_CHAT_DIR = 'ai-chats';

export class AIChatStorageService {

    /**
     * Get the expected relative file path for a session (Constructed)
     */
    private static getConstructedFilePath(sessionId: string, title?: string): string {
        // Sanitize title for filename
        const safeTitle = (title || 'Untitled').replace(/[\s\\/:*?"<>|]/g, '_');
        return `${AI_CHAT_DIR}/${sessionId}_${safeTitle}.json`;
    }

    /**
     * Find the actual file path for a session ID by scanning the directory
     * This is necessary because the title (and thus filename) might change
     */
    private static async findSessionFilePath(sessionId: string): Promise<string | null> {
        try {
            await this.ensureDirectory();
            const files = await fsService.listFiles(AI_CHAT_DIR);
            // Look for file starting with ID
            const file = files.find(f => f.name.startsWith(sessionId + '_') || f.name === sessionId + '.json');
            if (file) {
                // Encode filename to ensure valid URI (handling spaces etc.)
                return `${AI_CHAT_DIR}/${encodeURIComponent(file.name)}`;
            }
        } catch (e) {
            console.warn('[AIChatStorage] Find file failed:', e);
        }
        return null;
    }

    /**
     * Ensure the ai-chats directory exists
     */
    private static async ensureDirectory(): Promise<void> {
        const exists = await fsService.exists(AI_CHAT_DIR);
        if (!exists) {
            await fsService.createDirectory(AI_CHAT_DIR);
        }
    }

    /**
     * Save session to file and trigger upload
     * @param session The chat session to save
     */
    static async saveSession(session: ChatSession): Promise<void> {
        try {
            await this.ensureDirectory();

            // To be safe and simple: Find existing -> Overwrite. 
            // If not found -> Create new with Title.

            let filePath = await this.findSessionFilePath(session.id);
            if (!filePath) {
                filePath = this.getConstructedFilePath(session.id, session.title);
            }

            const content = JSON.stringify(session, null, 2);

            // Write to local file
            await fsService.writeFile(filePath, content);
            console.log(`[AIChatStorage] Saved session ${session.id} to ${filePath}`);

            // Trigger cloud upload via SyncService (Robust Write-Through)
            syncService.uploadFile(filePath).then(success => {
                if (success) {
                    console.log(`[AIChatStorage] Successfully uploaded session ${session.id}`);
                } else {
                    console.warn(`[AIChatStorage] Upload failed or skipped for ${session.id}`);
                }
            });

        } catch (error) {
            console.error(`[AIChatStorage] Failed to save session ${session.id}:`, error);
        }
    }

    /**
     * Load a session from file
     * @param sessionId The session ID
     */
    static async loadSession(sessionId: string): Promise<ChatSession | null> {
        try {
            const filePath = await this.findSessionFilePath(sessionId);
            if (!filePath || !await fsService.exists(filePath)) {
                return null;
            }

            const content = await fsService.readFile(filePath);
            const session = JSON.parse(content) as ChatSession;
            return session;
        } catch (error) {
            console.error(`[AIChatStorage] Failed to load session ${sessionId}:`, error);
            return null;
        }
    }

    /**
     * Delete a session file locally and on cloud
     * @param sessionId The session ID
     */
    static async deleteSession(sessionId: string): Promise<void> {
        try {
            const filePath = await this.findSessionFilePath(sessionId);
            if (!filePath) return;

            // Delete local
            if (await fsService.exists(filePath)) {
                await fsService.deleteFile(filePath);
                console.log(`[AIChatStorage] Deleted local session file ${filePath}`);
            }

            // Delete remote
            if (cloudService.isConfigured()) {
                cloudService.deleteFile(filePath)
                    .catch(err => console.warn(`[AIChatStorage] Remote delete failed for ${sessionId}:`, err));
            }
        } catch (error) {
            console.error(`[AIChatStorage] Failed to delete session ${sessionId}:`, error);
            throw error;
        }
    }

    /**
     * Rename a session (Move file + Sync)
     */
    static async renameSession(sessionId: string, newTitle: string): Promise<void> {
        try {
            const oldPath = await this.findSessionFilePath(sessionId);
            if (!oldPath) {
                console.warn('[AIChatStorage] Cannot rename, file not found');
                return;
            }

            const newPath = this.getConstructedFilePath(sessionId, newTitle);
            if (oldPath === newPath) return;

            console.log(`[AIChatStorage] Renaming ${oldPath} -> ${newPath}`);

            // 1. Move Local
            await fsService.moveFile(oldPath, newPath);

            // 2. Upload New
            await syncService.uploadFile(newPath);

            // 3. Delete Old Cloud
            if (cloudService.isConfigured()) {
                await cloudService.deleteFile(oldPath);
            }

        } catch (error) {
            console.error(`[AIChatStorage] Failed to rename session ${sessionId}:`, error);
            throw error;
        }
    }

    /**
     * List all available sessions from local file system
     */
    static async listLocalSessions(): Promise<ChatSession[]> {
        try {
            await this.ensureDirectory();
            const files = await fsService.listFiles(AI_CHAT_DIR);
            const sessions: ChatSession[] = [];

            for (const file of files) {
                if (file.name.endsWith('.json')) {
                    try {
                        const content = await fsService.readFile(`${AI_CHAT_DIR}/${encodeURIComponent(file.name)}`);
                        const session = JSON.parse(content) as ChatSession;
                        if (session.id && Array.isArray(session.messages)) {
                            sessions.push(session);
                        }
                    } catch (e) {
                        console.warn(`[AIChatStorage] Failed to parse ${file.name}`, e);
                    }
                }
            }

            // Sort by updatedAt desc
            return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
        } catch (error) {
            console.error('[AIChatStorage] Failed to list sessions:', error);
            return [];
        }
    }

    /**
     * Sync Session List (Metadata Only)
     */
    static async syncSessionList(localSessions: ChatSession[]): Promise<ChatSession[]> {
        if (!cloudService.isConfigured()) return [];

        try {
            await this.ensureCloudDirectory();
            const cloudFiles = await cloudService.listFiles(AI_CHAT_DIR + '/');
            const newPlaceholders: ChatSession[] = [];
            const localMap = new Map(localSessions.map(s => [s.id, s]));
            const cloudIds = new Set<string>();

            for (const cloudFile of cloudFiles) {
                if (!cloudFile.key.endsWith('.json')) continue;

                const filename = cloudFile.key.split('/').pop() || '';
                const simpleName = filename.replace('.json', '');

                // Parse ID and Title
                let id = simpleName;
                let title = `Cloud Chat ${new Date(cloudFile.lastModified).toLocaleDateString()}`;

                const idMatch = simpleName.match(/^(\d{8}_\d{6})/);
                if (idMatch) {
                    id = idMatch[1];
                    if (simpleName.length > id.length + 1) {
                        title = simpleName.substring(id.length + 1).replace(/_/g, ' ');
                    }
                } else {
                    const parts = simpleName.split('_');
                    if (parts.length > 1 && !simpleName.match(/^\d{8}_\d{6}$/)) {
                        id = parts[0];
                        title = parts.slice(1).join('_');
                    }
                }

                cloudIds.add(id);

                if (!localMap.has(id)) {
                    newPlaceholders.push({
                        id,
                        title: title || 'Untitled',
                        messages: [],
                        createdAt: new Date(cloudFile.lastModified).getTime(),
                        updatedAt: new Date(cloudFile.lastModified).getTime(),
                        isPlaceholder: true
                    });
                }
            }

            // Identify Local Only -> Upload using SyncService
            for (const session of localSessions) {
                if (!cloudIds.has(session.id)) {
                    console.log(`[AIChatStorage] Uploading local-only session ${session.id}`);
                    const filePath = this.getConstructedFilePath(session.id, session.title);
                    await syncService.uploadFile(filePath);
                }
            }

            return newPlaceholders;
        } catch (error: any) {
            if (error.message && error.message.includes('404')) {
                console.log('[AIChatStorage] Cloud empty 404, uploading all locals');
                for (const session of localSessions) {
                    const filePath = this.getConstructedFilePath(session.id, session.title);
                    await syncService.uploadFile(filePath);
                }
                return [];
            }
            console.error('[AIChatStorage] Sync list failed:', error);
            return [];
        }
    }

    /**
     * Download specific session content
     */
    static async downloadSession(sessionId: string): Promise<ChatSession | null> {
        let relativePath = await this.findSessionFilePath(sessionId);

        if (!relativePath) {
            try {
                const files = await cloudService.listFiles(AI_CHAT_DIR + '/');
                const target = files.find(f => f.key.includes(sessionId));
                if (target) {
                    // Cloud key might have spaces, encode full relative path (but preserve slashes)
                    relativePath = target.key.split('/').map(encodeURIComponent).join('/');
                }
            } catch (e) {
                console.warn('[AIChatStorage] Failed to resolve cloud path for download', e);
            }
        }

        if (relativePath) {
            const success = await syncService.performDownload(relativePath);
            if (success) {
                return await this.loadSession(sessionId);
            }
        }
        return null;
    }

    /**
     * Sync a specific session (e.g. Current Session)
     */
    static async syncCurrentSession(sessionId: string): Promise<ChatSession | null> {
        const relativePath = await this.findSessionFilePath(sessionId);
        if (!relativePath) return null;

        const status = await syncService.syncFile(relativePath);

        if (status === 'synced') {
            return await this.loadSession(sessionId);
        }

        return null;
    }

    /**
     * Pull updates from cloud (Manual trigger?)
     * Retaining for compatibility, but logic is improved.
     */
    static async pullFromCloud(): Promise<void> {
        if (!cloudService.isConfigured()) return;
        try {
            await this.ensureCloudDirectory();
            const cloudFiles = await cloudService.listFiles(AI_CHAT_DIR + '/');

            for (const cloudFile of cloudFiles) {
                if (!cloudFile.key.endsWith('.json')) continue;

                // Always download? Or check local?
                // For laziness, we don't pull everything automatically anymore. 
                // We rely on syncSessionList + placeholders.
                // But if this is explicitly called, maybe we SHOULD download everything?
                // Let's just download if missing locally?
                // Actually this method is called by 'syncWithCloud' in initial implementation.
                // But now we use 'syncSessionList'. 
                // Keep minimal or deprecated.
            }
        } catch (error) {
            console.error('[AIChatStorage] Pull failed:', error);
        }
    }

    private static async ensureCloudDirectory(): Promise<void> {
        if (!cloudService.isConfigured()) return;
        try {
            await cloudService.createDirectory(AI_CHAT_DIR);
        } catch (error) {
            console.warn('[AIChatStorage] Failed to ensure cloud directory:', error);
        }
    }
}
