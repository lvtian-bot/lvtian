import { Paths, File, Directory } from 'expo-file-system';

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
        // Strip file:// prefix from rootPath for comparison
        // Note: rootDir.uri usually starts with file://
        const rootDirUri = this.rootDir.uri.replace(/^file:\/+/, '/');

        // Normalize userPath: strip file:// prefix
        let pathToCheck = userPath.replace(/^file:\/+/, '/');

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

        return fullPath;
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
                return {
                    name: item.name,
                    path: item.uri,
                    size: item.size || 0,
                    isDirectory,
                    mtime: item.modificationTime ? new Date(item.modificationTime) : new Date(),
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
                    // Calculate relative path for recursion
                    // item.path is absolute uri. Need to convert to relative or just pass absolute?
                    // listFiles expects relative or absolute.
                    // But listFiles output item.path is absolute URI.
                    // To recurse, we can pass item.path directly as it will be sanitized.
                    // However, we need to be careful about infinite loops if symlinks existed (unlikely here).

                    // Sanitize path converts absolute URI back correctly.
                    // But let's be cleaner and use relative paths if possible, or just trust sanitizePath.
                    // Let's use item.path (URI) which sanitizePath handles.

                    // We need the relative path for listFiles to work relative to root? 
                    // No, listFiles handles absolute paths via sanitizePath checking if it starts with rootUri.

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

            file.write(content);
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

            // Note: .move() on File/Directory instance takes a DESTINATION (Directory or File).
            // If passed a Directory, it moves INTO that directory? Or renames TO that directory path?
            // "move(destination: Directory | File): void;"
            // "Updated the uri property that now points to the new location."
            // If I want to rename/move to a specific full path 'destPath', I should create a File/Directory instance for that dest path.

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

            if (info.isDirectory) {
                isDirectory = true;
                const dir = new Directory(fullPath);
                size = dir.size || 0;
                if (dir.modificationTime) mtime = new Date(dir.modificationTime);
                name = dir.name;
                uri = dir.uri;
            } else {
                const file = new File(fullPath);
                size = file.size || 0;
                if (file.modificationTime) mtime = new Date(file.modificationTime);
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
}

export const fsService = new FileSystemService();
