/* eslint-disable no-bitwise */
import * as FileSystem from 'expo-file-system/legacy';
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

        const docDir = FileSystem.documentDirectory?.replace(/\/+$/, '') || '';
        return `${docDir}/.shadows/${safeHash}_${filename}`;
    }

    async init(): Promise<void> {
        const docDir = FileSystem.documentDirectory?.replace(/\/+$/, '') || '';
        const shadowDir = `${docDir}/.shadows`;
        const info = await FileSystem.getInfoAsync(shadowDir);
        if (!info.exists) {
            await FileSystem.makeDirectoryAsync(shadowDir, { intermediates: true });
        }
    }

    async saveShadow(filePath: string, content: string): Promise<void> {
        await this.init();
        const shadowPath = this.getShadowPath(filePath);
        await FileSystem.writeAsStringAsync(shadowPath, content, { encoding: FileSystem.EncodingType.UTF8 });
    }

    async getShadow(filePath: string): Promise<string | null> {
        const shadowPath = this.getShadowPath(filePath);
        const info = await FileSystem.getInfoAsync(shadowPath);
        if (info.exists) {
            return await FileSystem.readAsStringAsync(shadowPath, { encoding: FileSystem.EncodingType.UTF8 });
        }
        return null;
    }

    async hasShadow(filePath: string): Promise<boolean> {
        const shadowPath = this.getShadowPath(filePath);
        const info = await FileSystem.getInfoAsync(shadowPath);
        return info.exists;
    }

    async deleteShadow(filePath: string): Promise<void> {
        const shadowPath = this.getShadowPath(filePath);
        const info = await FileSystem.getInfoAsync(shadowPath);
        if (info.exists) {
            await FileSystem.deleteAsync(shadowPath);
        }
    }
}

export const shadowFileService = new ShadowFileService();
