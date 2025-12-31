import * as FileSystem from 'expo-file-system/legacy';
import { ICloudProvider, CloudFileItem } from './CloudService';
import { fsService } from './FileSystemService';
import { generateCosAuthorization, buildCosUrl } from '../utils/cosSignature';

export class TencentCOSProvider implements ICloudProvider {
    private secretId: string;
    private secretKey: string;
    private bucket: string;
    private region: string;

    constructor(secretId: string, secretKey: string, bucket: string, region: string) {
        this.secretId = secretId;
        this.secretKey = secretKey;
        this.bucket = bucket;
        this.region = region;
    }

    /**
     * Send COS API Request
     */
    private async cosRequest(options: {
        method: string;
        pathname: string;
        query?: Record<string, string>;
        headers?: Record<string, string>;
        body?: string | Uint8Array;
    }): Promise<Response> {
        const { method, pathname, query = {}, headers = {}, body } = options;

        // Generate Signature
        const authorization = generateCosAuthorization({
            method,
            pathname,
            query,
            headers,
            secretId: this.secretId,
            secretKey: this.secretKey,
        });

        // Build URL
        const url = buildCosUrl(this.bucket, this.region, pathname, query);

        // Build Headers
        const requestHeaders: Record<string, string> = {
            ...headers,
            Authorization: authorization,
            Host: `${this.bucket}.cos.${this.region}.myqcloud.com`,
        };

        // Send Request
        const response = await fetch(url, {
            method,
            headers: requestHeaders,
            body: body as any, // fetch supports string or blob/buffer, casting for TS
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`COS Request Failed: ${response.status} ${response.statusText} - ${errorText}`);
        }

        return response;
    }

    async uploadFile(key: string, filePath: string, expectedEtag?: string): Promise<{ etag: string; lastModified: string } | void> {
        const content = await fsService.readFile(filePath);

        // Encode content to verify length if needed, but for text files fetch handles it.
        // Important: COS requires Content-Length for PUT.
        // String length in JS is UTF-16 code units, but network sends UTF-8 bytes.
        // We need accurate byte length.
        const encoder = new TextEncoder();
        const contentLength = encoder.encode(content).length;

        const headers: Record<string, string> = {
            'Content-Type': 'text/markdown', // Assuming markdown based on app context
            'Content-Length': contentLength.toString(),
        };

        if (expectedEtag) {
            let etag = expectedEtag;
            // Legacy Compatibility: Check if we have a legacy stripped hash (32 hex chars without quotes)
            // COS *requires* quotes for If-Match. If legacy data is stripped, we must re-quote it.
            const isLegacyStripped = !etag.startsWith('"') && /^[a-fA-F0-9]{32}$/.test(etag);

            if (isLegacyStripped) {
                etag = `"${etag}"`;
                // console.log(`[TencentCOS] Legacy stripped hash detected, adding quotes for If-Match: ${etag}`);
            }

            headers['If-Match'] = etag;
        }

        try {
            await this.cosRequest({
                method: 'PUT',
                pathname: `/${key}`,
                headers,
                // Pass the string content. fetch will encode it as UTF-8. 
                // We set Content-Length manually above to match the UTF-8 size.
                body: content,
            });

            // Fetch metadata to return
            const metadata = await this.headFile(key);
            if (metadata) {
                return metadata;
            }
        } catch (error: any) {
            if (error.message && error.message.includes('412')) {
                const e: any = new Error('Precondition Failed');
                e.code = 'PreconditionFailed';
                throw e;
            }
            throw error;
        }
    }

    async downloadFile(key: string, downloadPath: string): Promise<{ etag: string; lastModified: string }> {
        // Create parent directory
        const dir = downloadPath.substring(0, downloadPath.lastIndexOf('/'));
        if (dir) {
            await fsService.createDirectory(dir);
        }

        const destPath = fsService.getAbsolutePath(downloadPath);

        // Generate Pre-signed URL for downloading via FileSystem.downloadAsync
        const authorization = generateCosAuthorization({
            method: 'GET',
            pathname: `/${key}`,
            secretId: this.secretId,
            secretKey: this.secretKey,
        });

        const url = buildCosUrl(this.bucket, this.region, `/${key}`);

        // We can pass headers to downloadAsync
        const downloadResult = await FileSystem.downloadAsync(url, destPath, {
            headers: {
                Authorization: authorization,
                Host: `${this.bucket}.cos.${this.region}.myqcloud.com`,
            }
        });

        if (downloadResult.status !== 200) {
            throw new Error(`Download failed with status ${downloadResult.status}`);
        }

        const metadata = await this.headFile(key);
        if (!metadata) {
            return { etag: '', lastModified: new Date().toISOString() };
        }
        return metadata;
    }

    async getCloudFileContent(key: string): Promise<string> {
        const response = await this.cosRequest({
            method: 'GET',
            pathname: `/${key}`,
        });
        return await response.text();
    }

    async listFiles(prefix: string = ''): Promise<CloudFileItem[]> {
        const response = await this.cosRequest({
            method: 'GET',
            pathname: '/',
            query: {
                prefix,
                'delimiter': '/', // Folders
                'max-keys': '1000'
            }
        });

        const xmlText = await response.text();
        return this.parseListBucketResult(xmlText, prefix);
    }

    async deleteFile(key: string): Promise<void> {
        try {
            await this.cosRequest({
                method: 'DELETE',
                pathname: `/${key}`,
            });
        } catch (error: any) {
            // 204 No Content is success, but cosRequest throws on !ok.
            // Wait, 204 IS ok (in 200-299 range).
            // Verify if cosRequest throws for 204.
            // response.ok is true for 200-299.
            // So if it failed, it's a real error.
            throw error;
        }
    }

    async headFile(key: string): Promise<{ etag: string; lastModified: string } | null> {
        try {
            const response = await this.cosRequest({
                method: 'HEAD',
                pathname: `/${key}`,
            });

            return {
                etag: (response.headers.get('ETag') || ''),
                lastModified: response.headers.get('Last-Modified') || '',
            };
        } catch (error: any) {
            // If 404, return null
            if (error.message && error.message.includes('404')) {
                return null;
            }
            throw error;
        }
    }

    /**
     * XML Parser for ListBucketResult
     */
    private parseListBucketResult(xml: string, prefix: string): CloudFileItem[] {
        const files: CloudFileItem[] = [];

        // Extract Contents (Files)
        const contentsRegex = /<Contents>([\s\S]*?)<\/Contents>/g;
        let match;
        while ((match = contentsRegex.exec(xml)) !== null) {
            const content = match[1];
            const keyMatch = content.match(/<Key>(.*?)<\/Key>/);
            const sizeMatch = content.match(/<Size>(.*?)<\/Size>/);
            const lastModifiedMatch = content.match(/<LastModified>(.*?)<\/LastModified>/);
            const etagMatch = content.match(/<ETag>(.*?)<\/ETag>/);

            if (keyMatch) {
                const key = keyMatch[1];
                if (key !== prefix) { // Filter out the directory itself if listed
                    files.push({
                        key: key,
                        size: sizeMatch ? parseInt(sizeMatch[1], 10) : 0,
                        lastModified: lastModifiedMatch ? lastModifiedMatch[1] : '',
                        etag: etagMatch ? etagMatch[1] : '',
                        isDirectory: false
                    });
                }
            }
        }

        // Extract CommonPrefixes (Folders)
        const commonPrefixesRegex = /<CommonPrefixes>([\s\S]*?)<\/CommonPrefixes>/g;
        while ((match = commonPrefixesRegex.exec(xml)) !== null) {
            const content = match[1];
            const prefixMatch = content.match(/<Prefix>(.*?)<\/Prefix>/);
            if (prefixMatch) {
                files.push({
                    key: prefixMatch[1],
                    size: 0,
                    lastModified: new Date().toISOString(),
                    etag: '',
                    isDirectory: true
                });
            }
        }

        return files;
    }
}