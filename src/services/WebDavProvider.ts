import { ICloudProvider, CloudFileItem } from './CloudService';
import { fsService } from './FileSystemService';
import { Platform } from 'react-native';
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
        return `${this.server}/${encodeURI(cleanKey)}`;
    }

    private async request(method: string, key: string, headers: Record<string, string> = {}, body?: string | Blob | ArrayBuffer): Promise<Response> {
        const url = this.getUrl(key);
        // console.log(`[WebDav] ${method} ${url}`);

        try {
            const response = await fetch(url, {
                method,
                headers: {
                    'Authorization': this.authHeader,
                    ...headers
                },
                body: body as any
            });

            // 404 is valid result for some checks (like head), caller should handle
            // But generally, throw for error codes implies failure
            // We'll leave specific error handling to methods
            return response;
        } catch (error: any) {
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
            headers['If-Match'] = `"${expectedEtag}"`;
        }

        const response = await this.request('PUT', key, headers, content);

        if (!response.ok) {
            if (response.status === 412) {
                const e: any = new Error('Precondition Failed');
                e.code = 'PreconditionFailed';
                throw e;
            }
            throw new Error(`WebDav Upload Failed: ${response.status} ${response.statusText}`);
        }

        // Fetch verification metadata
        const metadata = await this.headFile(key);
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

    async deleteFile(key: string): Promise<void> {
        const response = await this.request('DELETE', key);
        if (!response.ok && response.status !== 404) {
            throw new Error(`WebDav Delete Failed: ${response.status}`);
        }
    }

    async headFile(key: string): Promise<{ etag: string; lastModified: string } | null> {
        const response = await this.request('HEAD', key);

        if (response.status === 404) {
            return null;
        }

        if (!response.ok) {
            throw new Error(`WebDav Head Failed: ${response.status}`);
        }

        const etag = (response.headers.get('ETag') || '').replace(/"/g, ''); // Nutstore returns quoted ETag
        const lastModified = response.headers.get('Last-Modified') || new Date().toISOString();

        return { etag, lastModified };
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
        return this.parsePropFindResponse(xmlText, prefix);
    }

    private parsePropFindResponse(xml: string, prefix: string): CloudFileItem[] {
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
                const match = this.server.match(/^https?:\/\/[^\/]+(\/.*)?$/);
                if (match && match[1]) {
                    serverPath = match[1];
                }
                if (serverPath.endsWith('/')) serverPath = serverPath.slice(0, -1);
            } catch (e) {
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

            if (normalizedKey === normalizedPrefix) {
                continue;
            }

            // Skip directories if the app doesn't handle them recursively yet in the list (CloudService returns flat list? Or SyncService expects files?)
            // SyncService expects CloudFileItem. 
            // CosProvider listFiles: returns files and explicit folders (size 0).
            // Let's include them.

            const etag = gettagMatch ? gettagMatch[1].replace(/"/g, '') : '';
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
