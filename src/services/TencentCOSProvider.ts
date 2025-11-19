import COS from 'cos-js-sdk-v5';
import { ICloudProvider, CloudFileItem } from './CloudService';
import { fsService } from './FileSystemService';

export class TencentCOSProvider implements ICloudProvider {
    private cos: COS;
    private bucket: string;
    private region: string;

    constructor(secretId: string, secretKey: string, bucket: string, region: string) {
        this.cos = new COS({
            SecretId: secretId,
            SecretKey: secretKey,
        });
        this.bucket = bucket;
        this.region = region;
    }

    async uploadFile(key: string, filePath: string): Promise<{ etag: string; lastModified: string } | void> {
        const content = await fsService.readFile(filePath);
        const result = await this.cos.putObject({
            Bucket: this.bucket,
            Region: this.region,
            Key: key,
            Body: content,
        });
        // COS putObject returns ETag in headers usually, but let's check what the SDK returns.
        // If not available, we might need to HEAD it, but let's try to extract from result if possible.
        // The type definition for putObject result might not expose headers easily in all SDK versions.
        // For now, let's try to return what we can or void if not easy, but the plan says we should update metadata.
        // Let's try to HEAD it immediately to be safe and get accurate LastModified.
        return this.headFile(key) as Promise<{ etag: string; lastModified: string }>;
    }

    async downloadFile(key: string, downloadPath: string): Promise<{ etag: string; lastModified: string }> {
        const data = await this.cos.getObject({
            Bucket: this.bucket,
            Region: this.region,
            Key: key,
        });
        if (data.Body) {
            const content = data.Body.toString();
            await fsService.writeFile(downloadPath, content);
            const headers = data as any;
            return {
                etag: data.ETag || headers.headers?.etag || '',
                lastModified: headers.LastModified || headers.headers?.['last-modified'] || new Date().toISOString(),
            };
        } else {
            throw new Error('No body in response');
        }
    }

    async getCloudFileContent(key: string): Promise<string> {
        const data = await this.cos.getObject({
            Bucket: this.bucket,
            Region: this.region,
            Key: key,
        });
        if (data.Body) {
            return data.Body.toString();
        } else {
            throw new Error('No body in response for key: ' + key);
        }
    }

    async listFiles(prefix: string = ''): Promise<CloudFileItem[]> {
        const data = await this.cos.getBucket({
            Bucket: this.bucket,
            Region: this.region,
            Prefix: prefix,
            Delimiter: '/', // Use '/' to distinguish files from folders
        });

        // Map files from Contents
        const files: CloudFileItem[] = (data.Contents || [])
            // When listing a prefix, the prefix itself can be returned as a 0-size file. Filter it out.
            .filter(item => item.Key !== prefix)
            .map((item: any) => ({
                key: item.Key,
                size: parseInt(item.Size),
                lastModified: item.LastModified,
            }));

        // Map directories from CommonPrefixes
        const directories: CloudFileItem[] = (data.CommonPrefixes || []).map(
            (item: any) => ({
                key: item.Prefix, // e.g., "notes/"
                size: 0, // Directories have no size
                lastModified: new Date().toISOString(), // No date from API, use current
            })
        );

        return [...directories, ...files];
    }

    async deleteFile(key: string): Promise<void> {
        await this.cos.deleteObject({
            Bucket: this.bucket,
            Region: this.region,
            Key: key,
        });
    }

    async headFile(key: string): Promise<{ etag: string; lastModified: string } | null> {
        try {
            const data = await this.cos.headObject({
                Bucket: this.bucket,
                Region: this.region,
                Key: key,
            });
            // Cast to any because types might be incomplete for headers
            const headers = data as any;
            return {
                etag: data.ETag || headers.headers?.etag || '',
                lastModified: headers.LastModified || headers.headers?.['last-modified'] || '',
            };
        } catch (error) {
            console.log('Error heading file:', error);
            return null;
        }
    }
}