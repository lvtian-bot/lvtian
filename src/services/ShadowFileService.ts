import RNFS from 'react-native-fs';
import { normalizePath } from '../utils/pathUtils';

class ShadowFileService {
    private getShadowPath(filePath: string): string {
        const normalized = normalizePath(filePath);
        // Store shadows in a hidden directory in the app's private storage, outside of mdnote_docs
        // e.g., /data/user/0/com.mdnote/files/.shadows/hash_filename.md

        const filename = normalized.split('/').pop() || 'unknown';
        // Simple hash of the full path to avoid collisions for files with same name in different dirs
        let hash = 0;
        for (let i = 0; i < normalized.length; i++) {
            const char = normalized.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32bit integer
        }
        const safeHash = Math.abs(hash).toString(16);

        return `${RNFS.DocumentDirectoryPath}/.shadows/${safeHash}_${filename}`;
    }

    async init(): Promise<void> {
        const shadowDir = `${RNFS.DocumentDirectoryPath}/.shadows`;
        if (!(await RNFS.exists(shadowDir))) {
            await RNFS.mkdir(shadowDir);
        }
    }

    async saveShadow(filePath: string, content: string): Promise<void> {
        await this.init();
        const shadowPath = this.getShadowPath(filePath);
        await RNFS.writeFile(shadowPath, content, 'utf8');
    }

    async getShadow(filePath: string): Promise<string | null> {
        const shadowPath = this.getShadowPath(filePath);
        if (await RNFS.exists(shadowPath)) {
            return await RNFS.readFile(shadowPath, 'utf8');
        }
        return null;
    }

    async hasShadow(filePath: string): Promise<boolean> {
        const shadowPath = this.getShadowPath(filePath);
        return await RNFS.exists(shadowPath);
    }

    async deleteShadow(filePath: string): Promise<void> {
        const shadowPath = this.getShadowPath(filePath);
        if (await RNFS.exists(shadowPath)) {
            await RNFS.unlink(shadowPath);
        }
    }
}

export const shadowFileService = new ShadowFileService();
