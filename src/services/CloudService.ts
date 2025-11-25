export interface ICloudProvider {
    uploadFile(key: string, filePath: string): Promise<{ etag: string; lastModified: string } | void>;
    downloadFile(key: string, downloadPath: string): Promise<{ etag: string; lastModified: string }>;
    getCloudFileContent(key: string): Promise<string>;
    listFiles(prefix?: string): Promise<CloudFileItem[]>;
    deleteFile(key: string): Promise<void>;
    headFile(key: string): Promise<{ etag: string; lastModified: string } | null>;
}

export interface CloudFileItem {
    key: string;
    size: number;
    lastModified: string;
    etag: string;
}

export const UPLOAD_COMPLETED_EVENT = 'UPLOAD_COMPLETED';

class CloudService {
    private provider: ICloudProvider | null = null;

    setProvider(provider: ICloudProvider | null) {
        this.provider = provider;
    }

    isConfigured(): boolean {
        return this.provider !== null;
    }

    async uploadFile(key: string, filePath: string): Promise<{ etag: string; lastModified: string } | void> {
        if (!this.provider) throw new Error('Cloud provider not configured');
        return this.provider.uploadFile(key, filePath);
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
}

export const cloudService = new CloudService();

