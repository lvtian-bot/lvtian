export interface ICloudProvider {
    uploadFile(key: string, filePath: string, expectedEtag?: string): Promise<{ etag: string; lastModified: string } | void>;
    uploadContent?(key: string, content: string): Promise<void>;
    downloadFile(key: string, downloadPath: string): Promise<{ etag: string; lastModified: string }>;
    getCloudFileContent(key: string): Promise<string>;
    listFiles(prefix?: string): Promise<CloudFileItem[]>;
    deleteFile(key: string): Promise<void>;
    headFile(key: string): Promise<{ etag: string; lastModified: string } | null>;
    signIn?(): Promise<void>;
    signOut?(): Promise<void>;
    createDirectory?(key: string): Promise<void>;
}

export interface CloudFileItem {
    key: string;
    size: number;
    lastModified: string;
    etag: string;
    isDirectory?: boolean;
}

import { WebDavProvider } from './WebDavProvider';
import * as SecureStore from 'expo-secure-store';
import { useSettingsStore } from '../store/useSettingsStore';
import { UPLOAD_COMPLETED_EVENT, CLOUD_INIT_COMPLETED_EVENT } from '../constants/events';

// Re-export events for backward compatibility
export { UPLOAD_COMPLETED_EVENT, CLOUD_INIT_COMPLETED_EVENT };

class CloudService {
    private provider: ICloudProvider | null = null;
    private _isInitialized: boolean = false;

    setProvider(provider: ICloudProvider | null) {
        this.provider = provider;
    }

    markInitialized() {
        this._isInitialized = true;
        const { DeviceEventEmitter } = require('react-native');
        DeviceEventEmitter.emit(CLOUD_INIT_COMPLETED_EVENT);
    }

    async initProvider() {
        try {
            const store = useSettingsStore.getState();
            const type = store.cloudProvider;

            console.log('[CloudService] Initializing provider:', type);

            if (type === 'webdav') {
                const password = await SecureStore.getItemAsync('WEBDAV_PASSWORD');
                const { server, username } = store.webDavConfig;

                if (server && username && password) {
                    this.setProvider(new WebDavProvider({ server, username, password }));
                } else {
                    console.warn('[CloudService] WebDAV config missing');
                    this.setProvider(null);
                }
            } else {
                this.setProvider(null);
            }

            this.markInitialized();
        } catch (e) {
            console.error('[CloudService] Failed to init provider:', e);
            this.setProvider(null);
            this.markInitialized(); // Mark as init even if failed, so app knows check is done
        }
    }

    isInitialized(): boolean {
        return this._isInitialized;
    }

    isConfigured(): boolean {
        return this.provider !== null;
    }

    async uploadFile(key: string, filePath: string, expectedEtag?: string): Promise<{ etag: string; lastModified: string } | void> {
        if (!this.provider) throw new Error('Cloud provider not configured');
        return this.provider.uploadFile(key, filePath, expectedEtag);
    }

    async uploadContent(key: string, content: string): Promise<void> {
        if (!this.provider) throw new Error('Cloud provider not configured');
        if (this.provider.uploadContent) {
            return this.provider.uploadContent(key, content);
        }
        throw new Error('当前云服务不支持直接上传内容');
    }

    async downloadFile(key: string, downloadPath: string): Promise<{ etag: string; lastModified: string }> {
        if (!this.provider) throw new Error('Cloud provider not configured');
        return this.provider.downloadFile(key, downloadPath);
    }

    async getCloudFileContent(key: string): Promise<string> {
        if (!this.provider) throw new Error('Cloud provider not configured');
        return this.provider.getCloudFileContent(key);
    }

    async listFiles(prefix?: string): Promise<CloudFileItem[]> {
        if (!this.provider) throw new Error('Cloud provider not configured');
        return this.provider.listFiles(prefix);
    }

    async deleteFile(key: string): Promise<void> {
        if (!this.provider) throw new Error('Cloud provider not configured');
        return this.provider.deleteFile(key);
    }

    async headFile(key: string): Promise<{ etag: string; lastModified: string } | null> {
        if (!this.provider) throw new Error('Cloud provider not configured');
        return this.provider.headFile(key);
    }

    async createDirectory(key: string): Promise<void> {
        if (!this.provider) throw new Error('Cloud provider not configured');
        if (this.provider.createDirectory) {
            return this.provider.createDirectory(key);
        }
    }
}

export const cloudService = new CloudService();
