import COS from 'cos-js-sdk-v5';
import RNFS from 'react-native-fs';
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

    async uploadFile(key: string, filePath: string, expectedEtag?: string): Promise<{ etag: string; lastModified: string } | void> {
        const content = await fsService.readFile(filePath);
        const params: any = {
            Bucket: this.bucket,
            Region: this.region,
            Key: key,
            Body: content,
        };

        if (expectedEtag) {
            // Add If-Match header for optimistic locking
            // Note: ETag in If-Match must be quoted
            params.Headers = {
                'If-Match': `"${expectedEtag}"`
            };
        }

        try {
            await this.cos.putObject(params);
            // COS putObject returns ETag in headers usually, but let's check what the SDK returns.
            // If not available, we might need to HEAD it, but let's try to extract from result if possible.
            // The type definition for putObject result might not expose headers easily in all SDK versions.
            // For now, let's try to return what we can or void if not easy, but the plan says we should update metadata.
            // Let's try to HEAD it immediately to be safe and get accurate LastModified.
            return this.headFile(key) as Promise<{ etag: string; lastModified: string }>;
        } catch (error: any) {
            // Handle Precondition Failed (Optimistic Lock Failure)
            if (error.statusCode === 412) {
                const e: any = new Error('Precondition Failed');
                e.code = 'PreconditionFailed';
                throw e;
            }
            throw error;
        }
    }

    async downloadFile(key: string, downloadPath: string): Promise<{ etag: string; lastModified: string }> {
        // Get signed URL first to bypass SDK's internal response parsing (which fails in RN for XML/binary)
        const url = await new Promise<string>((resolve, reject) => {
            this.cos.getObjectUrl({
                Bucket: this.bucket,
                Region: this.region,
                Key: key,
                Sign: true,
                Expires: 300,
            }, (err, data) => {
                if (err) return reject(err);
                resolve(data.Url);
            });
        });

        // Ensure parent directory exists
        const dir = downloadPath.substring(0, downloadPath.lastIndexOf('/'));
        if (dir) {
            await fsService.createDirectory(dir);
        }

        // Get absolute path for RNFS
        const destPath = fsService.getAbsolutePath(downloadPath);

        // Download using native module
        const downloadResult = RNFS.downloadFile({
            fromUrl: url,
            toFile: destPath,
        });

        const res = await downloadResult.promise;

        if (res.statusCode >= 400) {
            throw new Error(`Download failed with status ${res.statusCode}`);
        }

        // Fetch metadata separately since downloadFile doesn't return headers
        const metadata = await this.headFile(key);
        if (!metadata) {
            // Fallback if headFile fails but download succeeded (unlikely)
            return { etag: '', lastModified: new Date().toISOString() };
        }
        return metadata;
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
                size: parseInt(item.Size, 10),
                lastModified: item.LastModified,
                etag: (item.ETag || '').replace(/"/g, ''),
            }));

        // Map directories from CommonPrefixes
        const directories: CloudFileItem[] = (data.CommonPrefixes || []).map(
            (item: any) => ({
                key: item.Prefix, // e.g., "notes/"
                size: 0, // Directories have no size
                lastModified: new Date().toISOString(), // No date from API, use current
                etag: '', // Directories don't have etags
            })
        );

        return [...directories, ...files];
    }

    async deleteFile(key: string): Promise<void> {
        console.log('=== DELETE FILE DEBUG ===');
        console.log('Key:', key);
        console.log('Bucket:', this.bucket);
        console.log('Region:', this.region);

        // Workaround: cos-js-sdk-v5 has CORS issues with DELETE in React Native
        // Use SDK to generate signed URL, then use native fetch to send DELETE request
        return new Promise((resolve, reject) => {
            try {
                // Get signed URL from SDK
                this.cos.getObjectUrl({
                    Bucket: this.bucket,
                    Region: this.region,
                    Key: key,
                    Method: 'DELETE',
                    Sign: true,
                    Expires: 60, // URL valid for 60 seconds
                }, (err: any, data: any) => {
                    if (err) {
                        console.error('Failed to generate signed URL:', err);
                        reject(err);
                        return;
                    }

                    console.log('Signed URL generated:', data.Url);

                    // Use native fetch to send DELETE request (works better in React Native)
                    fetch(data.Url, {
                        method: 'DELETE',
                        headers: {
                            'Accept': '*/*',
                        }
                    })
                        .then(response => {
                            console.log('Delete response status:', response.status);
                            if (response.ok || response.status === 204) {
                                console.log('Delete successful via fetch');
                                resolve();
                            } else {
                                response.text().then(text => {
                                    console.error('Delete failed:', response.status, text);
                                    reject(new Error(`Delete failed with status ${response.status}: ${text}`));
                                });
                            }
                        })
                        .catch(fetchError => {
                            console.error('Fetch error:', fetchError);
                            reject(fetchError);
                        });
                });
            } catch (error) {
                console.error('Exception in deleteFile:', error);
                reject(error);
            }
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
                etag: (data.ETag || headers.headers?.etag || '').replace(/"/g, ''),
                lastModified: headers.LastModified || headers.headers?.['last-modified'] || '',
            };
        } catch (error: any) {
            // Only return null if file not found (404)
            if (error && error.statusCode === 404) {
                return null;
            }
            // For other errors (network, 403, etc), rethrow so caller can handle it
            console.log('Error heading file:', error);
            throw error;
        }
    }
}