import { fsService } from './FileSystemService';
import { cloudService } from './CloudService';
import { syncService } from './SyncService';
import { ChatSession } from '../store/useAIStore';
import { useFileMetadataStore } from '../store/useFileMetadataStore';
import { normalizePath } from '../utils/pathUtils';

const AI_CHAT_DIR = 'ai-chats';

export class AIChatStorageService {

    /**
     * Get the expected relative file path for a session (Constructed)
     */
    private static getConstructedFilePath(sessionId: string, title?: string): string {
        // Sanitize title for filename: replace unsafe chars but keep non-ASCII (中文等)
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
                // Keep filename as-is - already matches what we downloaded
                // We stopped double-encoding in downloadSession, so no need to decode
                return `${AI_CHAT_DIR}/${file.name}`;
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
            } else {
                // 安全检查：确保目录中只有一个该SessionID的文件
                const files = await fsService.listFiles(AI_CHAT_DIR);
                const duplicateFiles = files.filter(f =>
                    f.name.startsWith(session.id + '_') || f.name === session.id + '.json'
                );

                // 删除重复文件，只保留找到的第一个
                duplicateFiles.forEach(async (dupe, index) => {
                    if (index > 0) {
                        const dupePath = `${AI_CHAT_DIR}/${dupe.name}`;
                        console.log(`[AIChatStorage] Removing duplicate session file: ${dupePath}`);
                        await fsService.deleteFile(dupePath);
                    }
                });
            }

            // 不在JSON内容中保存标题，标题将从文件名解析
            const { title, ...sessionWithoutTitle } = session;
            const content = JSON.stringify(sessionWithoutTitle, null, 2);

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
            let sessionWithoutTitle = JSON.parse(content) as Omit<ChatSession, 'title'>;

            // 从文件名解析标题
            const fileName = filePath.split('/').pop() || '';
            const fileNameWithoutExt = fileName.replace('.json', '');
            // 找到sessionId后面的第一个下划线位置 (sessionId格式: YYYYMMDDHHmmss，共14个字符)
            const sessionIdEndIndex = fileNameWithoutExt.indexOf('_', 14); // YYYYMMDD_HHmmss完整长度为15，从第15个字符后开始找下划线

            if (sessionIdEndIndex !== -1) {
                let title = fileNameWithoutExt.substring(sessionIdEndIndex + 1);
                // 将下划线替换为空格
                title = title.replace(/_/g, ' ');

                // 重建完整的session对象
                const session: ChatSession = {
                    ...sessionWithoutTitle,
                    title: title || 'Untitled'
                };

                return session;
            }

            return null;
        } catch (error) {
            console.error(`[AIChatStorage] Failed to load session ${sessionId}:`, error);
            return null;
        }
    }

    /**
     * Delete a session file locally and on cloud
     * @param sessionId The session ID
     */
    /**
     * Delete a session file locally and on cloud (Cloud-First)
     * @param sessionId The session ID
     * @param title The session title (to construct cloud path without searching)
     */
    static async deleteSession(sessionId: string, title?: string): Promise<void> {
        try {
            // 1. Construct Cloud Key (O(1)) and Delete Cloud First
            if (cloudService.isConfigured() && title) {
                const cloudKey = this.getConstructedFilePath(sessionId, title);
                try {
                    console.log(`[AIChatStorage] Deleting cloud session: ${cloudKey}`);
                    await cloudService.deleteFile(cloudKey);
                } catch (err: any) {
                    // Ignore 404 (already deleted)
                    if (err?.message?.includes('404')) {
                        console.log(`[AIChatStorage] Cloud file ${cloudKey} already missing (404)`);
                    } else {
                        console.warn(`[AIChatStorage] Cloud delete failed for ${cloudKey}:`, err);
                    }
                }
            }

            // 2. Delete Local (Best Effort)
            // Try to find file first (handle legacy names), fallback to constructed
            let filePath = await this.findSessionFilePath(sessionId);
            if (!filePath && title) {
                filePath = this.getConstructedFilePath(sessionId, title);
            }

            if (filePath && await fsService.exists(filePath)) {
                await fsService.deleteFile(filePath);
                console.log(`[AIChatStorage] Deleted local session file ${filePath}`);
            }

        } catch (error) {
            console.error(`[AIChatStorage] Failed to delete session ${sessionId}:`, error);
            throw error;
        }
    }

    /**
     * Rename a session (Move file + Sync)
     */
    /**
     * Rename a session (Cloud-First: Upload New -> Delete Old)
     */
    static async renameSession(sessionId: string, newTitle: string, oldTitle?: string): Promise<void> {
        try {
            const oldPath = await this.findSessionFilePath(sessionId);
            const newPath = this.getConstructedFilePath(sessionId, newTitle);

            // 1. Local exists: Rename Local -> Sync (legacy flow optimized)
            if (oldPath && await fsService.exists(oldPath)) {
                if (oldPath !== newPath) {
                    console.log(`[AIChatStorage] Renaming local ${oldPath} -> ${newPath}`);
                    await fsService.moveFile(oldPath, newPath);

                    // Upload new file immediately
                    await syncService.uploadFile(newPath);

                    // Delete old cloud file
                    if (cloudService.isConfigured() && oldTitle) {
                        // Use constructed old path for deletion to ensure we hit the right key
                        // even if local file name was slightly off (though findSessionFilePath usually matches)
                        const cloudOldKey = this.getConstructedFilePath(sessionId, oldTitle);
                        // Prevent deleting the *new* file if keys happen to be same (unlikely here)
                        if (cloudOldKey !== newPath) {
                            await cloudService.deleteFile(cloudOldKey).catch(e => console.warn('Old cloud file delete failed', e));
                        }
                    } else if (cloudService.isConfigured() && oldPath) {
                        // Fallback to oldPath if title not provided
                        await cloudService.deleteFile(oldPath).catch(e => console.warn('Old cloud file delete failed', e));
                    }
                }
                return;
            }

            // 2. Local missing (Placeholder): Cloud Loopback (Download -> Upload New -> Delete Old)
            if (cloudService.isConfigured() && oldTitle) {
                const cloudOldKey = this.getConstructedFilePath(sessionId, oldTitle);

                if (cloudOldKey === newPath) return; // Name didn't change effectively

                console.log(`[AIChatStorage] Renaming Cloud-Only ${cloudOldKey} -> ${newPath}`);

                try {
                    // A. Download Old Content directly to memory (bypass file system for speed if pos? CloudService returns string)
                    // CloudService.getCloudFileContent returns string
                    const content = await cloudService.getCloudFileContent(cloudOldKey);

                    if (content) {
                        let sessionData = JSON.parse(content);
                        // Do NOT update title in JSON (we don't store title in JSON anymore) - but good to be safe
                        // sessionData.title = newTitle; 

                        // B. Write to Local New Path (to make it available locally + uploadable)
                        // Actually, we can just write local file and let syncService upload it?
                        // Or upload directly?
                        // Writing locally is better so the user sees the content immediately if they click it.
                        await fsService.writeFile(newPath, JSON.stringify(sessionData, null, 2));

                        // C. Upload New
                        await syncService.uploadFile(newPath);

                        // D. Delete Old
                        await cloudService.deleteFile(cloudOldKey);
                        console.log(`[AIChatStorage] Cloud rename complete.`);
                    }
                } catch (e) {
                    console.error('[AIChatStorage] Cloud-only rename failed:', e);
                    // If 404, maybe file is already gone or named differently?
                }
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
                        const content = await fsService.readFile(`${AI_CHAT_DIR}/${file.name}`);
                        let session = JSON.parse(content) as Omit<ChatSession, 'title'>;

                        // 从文件名解析标题
                        const fileNameWithoutExt = file.name.replace('.json', '');
                        // 找到sessionId后面的第一个下划线位置 (sessionId格式: YYYYMMDDHHmmss，共14个字符)
                        const sessionIdEndIndex = fileNameWithoutExt.indexOf('_', 14); // YYYYMMDD_HHmmss完整长度为15，从第15个字符后开始找下划线
                        if (sessionIdEndIndex !== -1) {
                            let title = fileNameWithoutExt.substring(sessionIdEndIndex + 1);
                            // 将下划线替换为空格
                            title = title.replace(/_/g, ' ');

                            // 重建完整的session对象
                            const fullSession: ChatSession = {
                                ...session,
                                title: title || 'Untitled'
                            };

                            if (fullSession.id && Array.isArray(fullSession.messages)) {
                                sessions.push(fullSession);
                            }
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
                const decodedFilename = decodeURIComponent(filename);
                const simpleName = decodedFilename.replace('.json', '');

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

            // Identify Local Only Sessions
            for (const session of localSessions) {
                if (!cloudIds.has(session.id)) {
                    let filePath = await this.findSessionFilePath(session.id);
                    if (!filePath) {
                        filePath = this.getConstructedFilePath(session.id, session.title);
                    }

                    // Normalize path to ensure metadata key match (handling leading slashes etc)
                    filePath = normalizePath(filePath);

                    // Check if this file has ever been synced to cloud (has syncedHash)
                    const metadata = useFileMetadataStore.getState().getMetadata(filePath);

                    if (metadata?.syncedHash) {
                        // Check if file is not in uploading or failed state
                        if (metadata.uploadState !== 'uploading' && metadata.uploadState !== 'failed' && metadata.uploadState !== 'conflict-failed') {
                            // File was once synced to cloud but now missing on cloud - delete local copy
                            console.log(`[AIChatStorage] Deleting locally retained session ${session.id} that was deleted from cloud`);
                            await this.deleteSession(session.id); // This will delete local file and try to delete cloud (though already gone)
                        } else {
                            // File is in uploading/failed state - skip deletion
                            console.log(`[AIChatStorage] Skipping deletion of session ${session.id} with upload state: ${metadata.uploadState}`);
                        }
                    } else {
                        // File is new and never synced - upload it
                        console.log(`[AIChatStorage] Uploading local-only session ${session.id}`);
                        await syncService.uploadFile(filePath);
                    }
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
                    // Decode keys and NORMALIZE to remove potential leading slashes from WebDAV
                    relativePath = normalizePath(decodeURIComponent(target.key));
                }
            } catch (e) {
                console.warn('[AIChatStorage] Failed to resolve cloud path for download', e);
            }
        }

        if (relativePath) {
            // Ensure consistency
            relativePath = normalizePath(relativePath);
            const success = await syncService.performDownload(relativePath);
            // ...
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
        if (!relativePath || !await fsService.exists(relativePath)) {
            // 会话文件不存在（还未发送消息），直接返回
            console.log(`[AIChatStorage] Session file ${relativePath} not found, skipping sync`);
            return null;
        }

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
