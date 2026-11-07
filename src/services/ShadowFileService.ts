/* eslint-disable no-bitwise */
import { Directory, File, Paths } from 'expo-file-system';
import { normalizePath } from '../utils/pathUtils';

class ShadowFileService {
    private getShadowPath(filePath: string): string {
        const normalized = normalizePath(filePath);
        // Store shadows in a hidden directory in the app's private storage, outside of lvtian_docs
        // e.g., /data/user/0/com.lvtian/files/.shadows/hash_filename.md

        const filename = normalized.split('/').pop() || 'unknown';
        // Simple hash of the full path to avoid collisions for files with same name in different dirs
        let hash = 0;
        for (let i = 0; i < normalized.length; i++) {
            const char = normalized.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32bit integer
        }
        const safeHash = Math.abs(hash).toString(16);

        const docDir = Paths.document.uri.replace(/\/+$/, '');
        return `${docDir}/.shadows/${safeHash}_${filename}`;
    }

    async init(): Promise<void> {
        const docDir = Paths.document.uri.replace(/\/+$/, '');
        const shadowDir = `${docDir}/.shadows`;
        const directory = new Directory(shadowDir);
        if (!directory.exists) {
            directory.create({ intermediates: true, idempotent: true });
        }
    }

    async saveShadow(filePath: string, content: string): Promise<void> {
        await this.init();
        const shadowPath = this.getShadowPath(filePath);
        await new File(shadowPath).write(content);
    }

    async getShadow(filePath: string): Promise<string | null> {
        const shadowPath = this.getShadowPath(filePath);
        const file = new File(shadowPath);
        if (file.exists) {
            return await file.text();
        }
        return null;
    }

    async hasShadow(filePath: string): Promise<boolean> {
        const shadowPath = this.getShadowPath(filePath);
        return new File(shadowPath).exists;
    }

    async deleteShadow(filePath: string): Promise<void> {
        const shadowPath = this.getShadowPath(filePath);
        const file = new File(shadowPath);
        if (file.exists) {
            file.delete();
        }
    }
}

export const shadowFileService = new ShadowFileService();
