import { fsService } from './FileSystemService';
import { normalizePath } from '../utils/pathUtils';

class ShadowFileService {
    private getShadowPath(filePath: string): string {
        const normalized = normalizePath(filePath);
        // Store shadows in a hidden directory in the app's private storage
        // e.g., /data/user/0/com.mdnote/files/shadows/path/to/file.md
        // We can just prepend 'shadows/' to the relative path if we treat the root as the app's document dir.
        // Assuming fsService works with absolute paths or paths relative to DocumentDirectory.
        // Let's assume we create a 'shadows' folder in the root of DocumentDirectory.

        // To avoid path traversal issues or complex directory structures, 
        // we can hash the original path to create a flat shadow filename, 
        // OR mirror the directory structure inside 'shadows'.
        // Mirroring is safer for debugging.

        // If filePath is absolute (e.g. /data/.../files/notes/foo.md), 
        // we need to be careful. 
        // Let's assume we store shadows in `${fsService.DocumentDirectoryPath}/.shadows/${filename_hash}` 
        // to keep it simple and avoid deep directory creation issues.

        // Actually, let's use a simple naming convention in a specific folder.
        const filename = normalized.split('/').pop() || 'unknown';
        // Simple hash of the full path to avoid collisions for files with same name in different dirs
        let hash = 0;
        for (let i = 0; i < normalized.length; i++) {
            const char = normalized.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32bit integer
        }
        const safeHash = Math.abs(hash).toString(16);

        return `${fsService.DocumentDirectoryPath}/.shadows/${safeHash}_${filename}`;
    }

    async init(): Promise<void> {
        const shadowDir = `${fsService.DocumentDirectoryPath}/.shadows`;
        if (!(await fsService.exists(shadowDir))) {
            await fsService.createDirectory(shadowDir);
        }
    }

    async saveShadow(filePath: string, content: string): Promise<void> {
        await this.init();
        const shadowPath = this.getShadowPath(filePath);
        await fsService.writeFile(shadowPath, content);
    }

    async getShadow(filePath: string): Promise<string | null> {
        const shadowPath = this.getShadowPath(filePath);
        if (await fsService.exists(shadowPath)) {
            return await fsService.readFile(shadowPath);
        }
        return null;
    }

    async hasShadow(filePath: string): Promise<boolean> {
        const shadowPath = this.getShadowPath(filePath);
        return await fsService.exists(shadowPath);
    }

    async deleteShadow(filePath: string): Promise<void> {
        const shadowPath = this.getShadowPath(filePath);
        if (await fsService.exists(shadowPath)) {
            await fsService.deleteFile(shadowPath);
        }
    }
}

export const shadowFileService = new ShadowFileService();
