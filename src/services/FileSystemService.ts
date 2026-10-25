import { Paths, File, Directory } from 'expo-file-system';
import * as FileSystem from 'expo-file-system/legacy';
export interface FileItem {
    name: string;
    path: string;
    size: number;
    isDirectory: boolean;
    mtime: Date;
}

class FileSystemService {
    private rootDir: Directory;
    private rootPath: string;

    constructor() {
        // Initialize root directory
        this.rootDir = new Directory(Paths.document, 'mdnote_docs');
        this.rootPath = this.rootDir.uri;

        // Ensure the root directory exists
        if (!this.rootDir.exists) {
            try {
                this.rootDir.create({ intermediates: true });
            } catch (err) {
                console.error('Failed to create root directory:', err);
            }
        }
    }

    /**
     * Returns the full absolute path for a given relative path
     * @param path - The relative path
     */
    getAbsolutePath(path: string): string {
        return this.sanitizePath(path);
    }

    /**
     * Sanitizes and validates a user-provided path to prevent path traversal attacks
     * @param userPath - The user-provided path (can be relative or absolute)
     * @returns The safe, full absolute path
     * @throws Error if path is invalid or attempts to escape root directory
     */
    private sanitizePath(userPath: string): string {
        // Get decoded root path for comparison
        let rootDirUri = this.rootDir.uri.replace(/^file:\/+/, '/');
        try {
            rootDirUri = decodeURI(rootDirUri);
        } catch (e) {
            console.warn('[FileSystemService] Failed to decode root URI:', e);
        }

        // Normalize userPath: strip file:// prefix and decode
        let pathToCheck = userPath.replace(/^file:\/+/, '/');
        try {
            pathToCheck = decodeURI(pathToCheck);
        } catch (_e) {
            // If decoding fails, continue with original string (might not be encoded)
        }

        // Check if userPath already contains the root path (is absolute)
        let fullPath = '';
        if (pathToCheck.startsWith(rootDirUri)) {
            // It is already absolute
            fullPath = pathToCheck;
        } else {
            // It is relative, append to root
            // Remove leading slashes from relative path
            const cleanRelative = pathToCheck.replace(/^\/+/, '');
            fullPath = cleanRelative ? `${rootDirUri}/${cleanRelative}` : rootDirUri;
        }

        // Normalize slashes (remove duplicates)
        fullPath = fullPath.replace(/\/+/g, '/');

        // Security Check: Ensure the resulting path is still within rootPath
        if (!fullPath.startsWith(rootDirUri)) {
            console.error(`[FileSystemService] Invalid path detected: userPath="${userPath}", resolved="${fullPath}", root="${rootDirUri}"`);
            throw new Error('Invalid path: outside root directory');
        }

        // Re-attach protocol if needed (Expo FS expects file://)
        if (!fullPath.startsWith('file://')) {
            // Ensure path starts with / before adding scheme
            if (!fullPath.startsWith('/')) fullPath = '/' + fullPath;
            fullPath = 'file://' + fullPath;
        }

        // Final encoding to ensure special characters (spaces, chinese, etc.) are valid in URI
        return encodeURI(fullPath);
    }

    /**
     * Recursively creates directories
     * @param dirPath - The full directory path to create
     */
    private async createDirectoryRecursive(dirPath: string): Promise<void> {
        const dir = new Directory(dirPath);
        if (!dir.exists) {
            dir.create({ intermediates: true });
        }
    }

    async listFiles(path: string = ''): Promise<FileItem[]> {
        const fullPath = this.sanitizePath(path);
        const dir = new Directory(fullPath);

        try {
            if (!dir.exists) return [];

            const items = dir.list();
            return items.map(item => {
                const isDirectory = item instanceof Directory;
                // 'modificationTime' is not on File/Directory instances in new API.
                // We must use Paths.info(item.uri) to get metadata.
                const info = Paths.info(item.uri);
                // @ts-ignore - PathInfo type might be missing modificationTime in strict mode but it exists at runtime/legacy compat
                const mtimeVal = info.modificationTime;

                return {
                    name: item.name,
                    path: item.uri,
                    size: item.size || 0,
                    isDirectory,
                    mtime: mtimeVal ? new Date(mtimeVal * 1000) : new Date(), // Check if seconds or ms. Usually seconds in Expo.
                };
            });
        } catch (error) {
            console.error('Error listing files:', error);
            return [];
        }
    }

    /**
     * Recursively list all files (not directories) in the given path
     * @param path Relative path to start from
     */
    async listFilesRecursive(path: string = ''): Promise<FileItem[]> {
        const allFiles: FileItem[] = [];
        const processDirectory = async (currentPath: string) => {
            const items = await this.listFiles(currentPath);
            for (const item of items) {
                if (item.isDirectory) {
                    await processDirectory(item.path);
                } else {
                    allFiles.push(item);
                }
            }
        };

        await processDirectory(path);
        return allFiles;
    }

    async readFile(path: string): Promise<string> {
        const fullPath = this.sanitizePath(path);
        try {
            const file = new File(fullPath);
            return await file.text();
        } catch (error) {
            console.error('Error reading file:', error);
            throw error;
        }
    }



    async writeFile(path: string, content: string): Promise<void> {
        const fullPath = this.sanitizePath(path);
        try {
            const file = new File(fullPath);
            const parentDir = file.parentDirectory;

            if (!parentDir.exists) {
                console.log(`Directory ${parentDir.uri} does not exist. Creating recursively...`);
                parentDir.create({ intermediates: true });
            }

            await file.write(content);
        } catch (error) {
            console.error('Error writing file:', error);
            throw error;
        }
    }

    async createDirectory(path: string): Promise<void> {
        const fullPath = this.sanitizePath(path);
        try {
            const dir = new Directory(fullPath);
            if (!dir.exists) {
                dir.create({ intermediates: true });
            }
        } catch (error) {
            console.error('Error creating directory:', error);
            throw error;
        }
    }

    async deleteFile(path: string): Promise<void> {
        const fullPath = this.sanitizePath(path);
        try {
            // Check what provided path points to
            const info = Paths.info(fullPath);
            if (!info.exists) return;

            if (info.isDirectory) {
                new Directory(fullPath).delete();
            } else {
                new File(fullPath).delete();
            }
        } catch (error) {
            console.error('Error deleting file:', error);
            throw error;
        }
    }

    async moveFile(srcPath: string, destPath: string): Promise<void> {
        const fullSrcPath = this.sanitizePath(srcPath);
        const fullDestPath = this.sanitizePath(destPath); // used for validation
        const destDir = new Directory(fullDestPath).parentDirectory;

        // Ensure destination directory exists (move usually requires parent to exist)
        if (!destDir.exists) {
            destDir.create({ intermediates: true });
        }

        try {
            const srcInfo = Paths.info(fullSrcPath);
            if (!srcInfo.exists) throw new Error('Source path does not exist');

            const destInstance = srcInfo.isDirectory ? new Directory(fullDestPath) : new File(fullDestPath);

            if (srcInfo.isDirectory) {
                new Directory(fullSrcPath).move(destInstance);
            } else {
                new File(fullSrcPath).move(destInstance);
            }
        } catch (error) {
            console.error('Error moving file:', error);
            throw error;
        }
    }

    async exists(path: string): Promise<boolean> {
        const fullPath = this.sanitizePath(path);
        return Paths.info(fullPath).exists;
    }

    async stat(path: string): Promise<FileItem | null> {
        const fullPath = this.sanitizePath(path);
        try {
            const info = Paths.info(fullPath);
            if (!info.exists) return null;

            let size = 0;
            let mtime = new Date();
            let isDirectory = false;
            let name = fullPath.split('/').pop() || '';
            let uri = fullPath;

            // @ts-ignore
            if (info.modificationTime) {
                // @ts-ignore
                mtime = new Date(info.modificationTime * 1000);
            }

            if (info.isDirectory) {
                isDirectory = true;
                const dir = new Directory(fullPath);
                size = dir.size || 0;
                name = dir.name;
                uri = dir.uri;
            } else {
                const file = new File(fullPath);
                size = file.size || 0;
                name = file.name;
                uri = file.uri;
            }

            return {
                name,
                path: uri,
                size,
                isDirectory,
                mtime
            };
        } catch (error) {
            console.error('Error getting file stats:', error);
            return null;
        }
    }

    getRootPath(): string {
        return this.rootPath;
    }

    private isTextFile(mimeType?: string, fileName?: string): boolean {
        if (mimeType) {
            const lowerMime = mimeType.toLowerCase();
            if (lowerMime.startsWith('text/')) return true;
            if (
                lowerMime === 'application/json' ||
                lowerMime === 'application/javascript' ||
                lowerMime === 'application/typescript' ||
                lowerMime === 'application/xml' ||
                lowerMime === 'application/x-sh' ||
                lowerMime === 'application/x-yaml'
            ) {
                return true;
            }
        }
        if (fileName) {
            const lowerName = fileName.toLowerCase();
            const textExtensions = [
                '.txt', '.md', '.markdown', '.json', '.js', '.jsx', '.ts', '.tsx',
                '.html', '.htm', '.css', '.scss', '.yaml', '.yml', '.xml', '.csv',
                '.sh', '.bash', '.py', '.java', '.c', '.cpp', '.h', '.rs', '.go',
                '.sql', '.log', '.env', '.ini', '.conf',
            ];
            return textExtensions.some((ext) => lowerName.endsWith(ext));
        }
        return false;
    }

    /**
     * 读取外部/临时附件文件（用于主聊天图片或文档附件上传）
     * 区分纯文本与二进制文档（PDF、Office、压缩包等），避免强行解码为损坏的 UTF-8 文本
     * @param uri 外部/缓存文件路径
     * @param maxSize 附件体积限制（默认 750KB，避免超出 WebSocket 传输安全阈值）
     * @param mimeType 可选 MIME 类型
     * @param fileName 可选文件名
     */
    async readAttachment(
        uri: string,
        maxSize = 750 * 1024,
        mimeType?: string,
        fileName?: string
    ): Promise<{ content?: string; data?: string; size: number }> {
        const info = await FileSystem.getInfoAsync(uri);
        if (!info.exists || info.isDirectory) {
            throw new Error('ATTACHMENT_NOT_FOUND');
        }

        const size = info.size ?? 0;
        if (size > maxSize) {
            throw new Error('ATTACHMENT_TOO_LARGE');
        }

        const isText = this.isTextFile(mimeType, fileName || uri);
        let content: string | undefined;
        let data: string | undefined;

        if (isText) {
            try {
                content = await FileSystem.readAsStringAsync(uri, {
                    encoding: FileSystem.EncodingType.UTF8,
                });
            } catch {
                try {
                    data = await FileSystem.readAsStringAsync(uri, {
                        encoding: FileSystem.EncodingType.Base64,
                    });
                } catch (err) {
                    console.error('[FileSystemService] 读取附件内容失败:', err);
                    throw new Error('ATTACHMENT_READ_FAILED');
                }
            }
        } else {
            try {
                data = await FileSystem.readAsStringAsync(uri, {
                    encoding: FileSystem.EncodingType.Base64,
                });
            } catch (err) {
                console.error('[FileSystemService] 读取二进制附件失败:', err);
                throw new Error('ATTACHMENT_READ_FAILED');
            }
        }

        if (!content && !data) {
            throw new Error('ATTACHMENT_READ_EMPTY');
        }

        return { content, data, size };
    }
}

export const fsService = new FileSystemService();
