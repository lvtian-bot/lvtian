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

    async uploadFile(key: string, filePath: string): Promise<void> {
        const content = await fsService.readFile(filePath);
        await this.cos.putObject({
            Bucket: this.bucket,
            Region: this.region,
            Key: key,
            Body: content,
        });
    }

    async downloadFile(key: string, downloadPath: string): Promise<void> {
        const data = await this.cos.getObject({
            Bucket: this.bucket,
            Region: this.region,
            Key: key,
        });
        if (data.Body) {
            const content = data.Body.toString();
            await fsService.writeFile(downloadPath, content);
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
}