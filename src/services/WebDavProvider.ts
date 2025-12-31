import { ICloudProvider, CloudFileItem } from './CloudService';
import { fsService } from './FileSystemService';
import * as FileSystem from 'expo-file-system/legacy';
import CryptoJS from 'crypto-js';

export interface WebDavConfig {
    server: string; // e.g., https://dav.jianguoyun.com/dav/
    username: string;
    password: string; // Application password
}

export class WebDavProvider implements ICloudProvider {
    private server: string;
    private authHeader: string;

    constructor(config: WebDavConfig) {
        this.server = config.server.replace(/\/+$/, ''); // Remove trailing slash
        const encodedAuth = CryptoJS.enc.Base64.stringify(CryptoJS.enc.Utf8.parse(`${config.username}:${config.password}`));
        this.authHeader = `Basic ${encodedAuth}`;
    }

    private getUrl(key: string): string {
        // Ensure key doesn't start with slash if server already has it (handled by replace above)
        // But key usually comes from relative path, e.g., 'folder/file.md'
        // If key starts with /, strip it
        const cleanKey = key.startsWith('/') ? key.substring(1) : key;
        // If key is empty string, return server root
        if (!cleanKey) return this.server + '/';

        // Fix: Use encodeURIComponent on each segment to handle special chars like '#' or '?'
        // encodeURI does not encode #, which breaks the URL
        const encodedKey = cleanKey.split('/').map(encodeURIComponent).join('/');

        return `${this.server}/${encodedKey}`;
    }

    private limiter = new ConcurrencyLimiter(3); // Limit to 3 concurrent requests

    private async request(method: string, key: string, headers: Record<string, string> = {}, body?: string | Blob | ArrayBuffer): Promise<Response> {
        return this.limiter.add(() => this.requestWithRetry(method, key, headers, body));
    }

    private async requestWithRetry(method: string, key: string, headers: Record<string, string> = {}, body?: string | Blob | ArrayBuffer, retries = 3): Promise<Response> {
        const url = this.getUrl(key);

        try {
            const response = await fetch(url, {
                method,
                headers: {
                    'Authorization': this.authHeader,
                    'Cache-Control': 'no-cache',
                    'Pragma': 'no-cache',
                    ...headers
                },
                body: body as any
            });

            // Handle Rate Limiting (429) and Service Unavailable (503)
            if (!response.ok && (response.status === 429 || response.status === 503)) {
                if (retries > 0) {
                    const delay = 1000 * (4 - retries) + Math.random() * 500; // 1s, 2s, 3s + jitter
                    console.log(`[WebDav] Rate limited (${response.status}), retrying in ${delay.toFixed(0)}ms...`);
                    await new Promise(resolve => setTimeout(() => resolve(undefined), delay));
                    return this.requestWithRetry(method, key, headers, body, retries - 1);
                }
            }

            return response;
        } catch (error: any) {
            // Retry on network errors
            if (retries > 0 && (error?.message === 'Network request failed' || error?.message?.includes('Network request failed'))) {
                const delay = 1000 * (4 - retries) + Math.random() * 500;
                console.log(`[WebDav] Network error, retrying in ${delay.toFixed(0)}ms...`);
                await new Promise(resolve => setTimeout(() => resolve(undefined), delay));
                return this.requestWithRetry(method, key, headers, body, retries - 1);
            }

            if (error?.message === 'Network request failed' || error?.message?.includes('Network request failed')) {
                console.log(`[WebDav] Network request failed: ${method} ${url}`);
            } else {
                console.error(`[WebDav] Request failed: ${method} ${url}`, error);
            }
            throw error;
        }
    }


    async uploadFile(key: string, filePath: string, expectedEtag?: string): Promise<{ etag: string; lastModified: string } | void> {
        const content = await fsService.readFile(filePath);

        const headers: Record<string, string> = {
            'Content-Type': 'text/markdown', // Or detect mime type
        };

        if (expectedEtag) {
            headers['If-Match'] = expectedEtag;
        }

        const response = await this.request('PUT', key, headers, content);

        if (!response.ok) {
            if (response.status === 412) {
                // 立即查询云端的实际 ETag
                const actualMetadata = await this.headFile(key);
                const actualEtag = actualMetadata?.etag || 'UNKNOWN';
                console.log('[WebDav Upload] 412 Precondition Failed for:', key);
                console.log('[WebDav Upload] Expected ETag:', expectedEtag);
                console.log('[WebDav Upload] Actual cloud ETag:', actualEtag);
                const e: any = new Error('Precondition Failed');
                e.code = 'PreconditionFailed';
                throw e;
            }
            throw new Error(`WebDav Upload Failed: ${response.status} ${response.statusText}`);
        }

        // Fetch verification metadata
        const metadata = await this.headFile(key);
        console.log('[WebDav Upload] Upload successful, new ETag:', metadata?.etag, 'for file:', key);
        if (metadata) {
            return metadata;
        }
    }

    async downloadFile(key: string, downloadPath: string): Promise<{ etag: string; lastModified: string }> {
        // Create parent directory
        const dir = downloadPath.substring(0, downloadPath.lastIndexOf('/'));
        if (dir) {
            await fsService.createDirectory(dir);
        }

        const destPath = fsService.getAbsolutePath(downloadPath);
        const url = this.getUrl(key);

        const downloadResult = await FileSystem.downloadAsync(url, destPath, {
            headers: {
                'Authorization': this.authHeader
            }
        });

        if (downloadResult.status !== 200) {
            throw new Error(`WebDav Download failed: ${downloadResult.status}`);
        }

        const metadata = await this.headFile(key);
        if (!metadata) {
            return { etag: '', lastModified: new Date().toISOString() };
        }
        return metadata;
    }

    async getCloudFileContent(key: string): Promise<string> {
        const response = await this.request('GET', key);
        if (!response.ok) {
            throw new Error(`WebDav Get Content Failed: ${response.status}`);
        }
        return await response.text();
    }

    async createDirectory(key: string): Promise<void> {
        const response = await this.request('MKCOL', key);
        if (!response.ok && response.status !== 405) {
            if (response.status === 409) {
                const parent = key.substring(0, key.lastIndexOf('/'));
                if (parent) {
                    await this.createDirectory(parent);
                    await this.request('MKCOL', key);
                    return;
                }
            }
            if (response.status !== 405) {
                throw new Error(`WebDav Create Directory Failed: ${response.status}`);
            }
        }
    }




    async deleteFile(key: string): Promise<void> {
        const response = await this.request('DELETE', key);
        if (!response.ok && response.status !== 404) {
            throw new Error(`WebDav Delete Failed: ${response.status}`);
        }
    }

    async headFile(key: string): Promise<{ etag: string; lastModified: string } | null> {
        // Use PROPFIND with Depth 0 to get file properties
        // WebDAV servers (like Nutstore) often don't return ETag in HEAD requests
        const headers: Record<string, string> = {
            'Depth': '0'
        };

        const response = await this.request('PROPFIND', key, headers);

        if (response.status === 404) {
            return null;
        }

        if (!response.ok) {
            throw new Error(`WebDav Head (PROPFIND) Failed: ${response.status}`);
        }

        const xmlText = await response.text();
        // Parse the single file response
        const items = this.parsePropFindResponse(xmlText, key, true);

        if (items.length === 0) {
            return null;
        }

        const item = items[0];
        // console.log(`[WebDav] Head ${key} -> ETag: ${item.etag}, LastMod: ${item.lastModified}`);

        return {
            etag: item.etag,
            lastModified: item.lastModified
        };
    }

    async listFiles(prefix: string = ''): Promise<CloudFileItem[]> {
        // WebDAV PROPFIND for directory listing
        // specific depth to 1 to get direct children
        const headers = {
            'Depth': '1',
            // 'Content-Type': 'application/xml' // Optional request body for properties
        };

        const response = await this.request('PROPFIND', prefix, headers);

        if (!response.ok) {
            throw new Error(`WebDav List Failed: ${response.status}`);
        }

        const xmlText = await response.text();
        return this.parsePropFindResponse(xmlText, prefix, false);
    }

    private parsePropFindResponse(xml: string, prefix: string, includeSelf: boolean = false): CloudFileItem[] {
        const files: CloudFileItem[] = [];

        // Simple XML regex parsing (Robust enough for standard WebDAV responses)
        // Note: XML namespaces can vary (d:response, D:response), regex should be flexible.

        // Split into response blocks
        const responseBlocks = xml.split(/<\D+:response/i).slice(1); // Skip preamble

        for (const block of responseBlocks) {
            // Extract href
            const hrefMatch = block.match(/<\D+:href>([^<]+)<\/\D+:href>/i);
            const href = hrefMatch ? decodeURI(hrefMatch[1]) : '';

            // Extract properties
            const gettagMatch = block.match(/<\D+:getetag>([^<]+)<\/\D+:getetag>/i);
            const getlastmodifiedMatch = block.match(/<\D+:getlastmodified>([^<]+)<\/\D+:getlastmodified>/i);
            const getcontentlengthMatch = block.match(/<\D+:getcontentlength>([^<]+)<\/\D+:getcontentlength>/i);
            const resourcetypeMatch = block.match(/<\D+:resourcetype>([\s\S]*?)<\/\D+:resourcetype>/i); // Can contain self-closing tags

            if (!href) continue;

            // Determine if directory
            // <d:resourcetype><d:collection/></d:resourcetype>
            const isDirectory = resourcetypeMatch ? resourcetypeMatch[1].includes('collection') : false;

            // Nutstore returns full path in href (e.g., /dav/folder/file.md)
            // We need to extract the relative key.
            // Be careful with server root path.
            // Assumption: href ends with the key path.

            // Simplest way: extract basename? No, we need relative path from "prefix".
            // But standard sync logic expects files with keys relative to root?
            // Let's rely on standard logic: Key should be usable for subsequent requests.
            // If we access https://dav.jianguoyun.com/dav/ , list returns /dav/

            // We need to normalize key to be relative to the 'mount point' (prefix? or just relative to root?)
            // The SyncService usually expects 'filename.md' or 'folder/filename.md'.

            // Let's strip the server path component if possible.
            // But we don't easily know the full server path structure from config without parsing URL.
            // Config.server: https://dav.jianguoyun.com/dav/
            // Href: /dav/test.md

            // Let's store the `serverPath` from config used in constructor

            let serverPath = '';
            try {
                // Simple parser for server path
                const match = this.server.match(new RegExp('^https?://[^/]+(/.*)?$'));
                if (match && match[1]) {
                    serverPath = match[1];
                }
                if (serverPath.endsWith('/')) serverPath = serverPath.slice(0, -1);
            } catch {
                // Fallback
            }

            // Remove server path prefix from href
            let relativeKey = href;
            // Decode URI component just in case

            // Handle case where href starts with the path part of server URL
            if (serverPath && relativeKey.startsWith(serverPath)) {
                relativeKey = relativeKey.substring(serverPath.length);
            }

            // Remove leading slash
            if (relativeKey.startsWith('/')) {
                relativeKey = relativeKey.substring(1);
            }

            // Filter out the directory itself (which usually matches the prefix or empty string)
            // The PROPFIND responses usually include the requested folder itself.
            // If prefix matches relativeKey (modulo slashes), skip it if we want children only?
            // Usually listFiles expects children.

            // Normalize slashes for comparison
            const normalizedPrefix = prefix.replace(/\/+$/, '').replace(/^\/+/, '');
            const normalizedKey = relativeKey.replace(/\/+$/, '').replace(/^\/+/, '');

            if (!includeSelf && normalizedKey === normalizedPrefix) {
                continue;
            }

            // Skip directories if the app doesn't handle them recursively yet in the list (CloudService returns flat list? Or SyncService expects files?)
            // SyncService expects CloudFileItem. 
            // CosProvider listFiles: returns files and explicit folders (size 0).
            // Let's include them.

            const etag = gettagMatch ? gettagMatch[1] : '';
            const lastModified = getlastmodifiedMatch ? getlastmodifiedMatch[1] : new Date().toISOString(); // Default for folders
            const size = getcontentlengthMatch ? parseInt(getcontentlengthMatch[1], 10) : 0;

            files.push({
                key: relativeKey, // Keep path structure
                size,
                lastModified,
                etag,
                isDirectory
            });
        }

        return files;
    }
}

class ConcurrencyLimiter {
    private queue: (() => void)[] = [];
    private activeCount = 0;
    private maxConcurrency: number;

    constructor(maxConcurrency: number) {
        this.maxConcurrency = maxConcurrency;
    }

    async add<T>(fn: () => Promise<T>): Promise<T> {
        if (this.activeCount >= this.maxConcurrency) {
            await new Promise<void>(resolve => this.queue.push(() => resolve()));
        }

        this.activeCount++;
        try {
            return await fn();
        } finally {
            this.activeCount--;
            if (this.queue.length > 0) {
                const next = this.queue.shift();
                next?.();
            }
        }
    }
}
