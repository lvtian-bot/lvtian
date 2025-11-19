import RNFS from 'react-native-fs';

export interface FileItem {
    name: string;
    path: string;
    size: number;
    isDirectory: boolean;
    mtime: Date;
}

class FileSystemService {
    private rootPath: string;

    constructor() {
        this.rootPath = RNFS.DocumentDirectoryPath; // Use DocumentDirectory for persistent storage
    }

    /**
     * Sanitizes and validates a user-provided path to prevent path traversal attacks
     * @param userPath - The user-provided path
     * @returns The safe, full absolute path
     * @throws Error if path is invalid or attempts to escape root directory
     */
    private sanitizePath(userPath: string): string {
        // Remove leading slashes
        let normalized = userPath.replace(/^\/+/, '');

        // Check for dangerous patterns
        if (normalized.includes('..') || normalized.includes('~')) {
            throw new Error('Invalid path: path traversal detected');
        }

        // Build full path
        const fullPath = normalized ? `${this.rootPath}/${normalized}` : this.rootPath;

        // Ensure the resulting path is within rootPath
        // Normalize by removing duplicate slashes and resolving segments
        const normalizedFull = fullPath.replace(/\/+/g, '/');

        if (!normalizedFull.startsWith(this.rootPath)) {
            throw new Error('Invalid path: outside root directory');
        }

        return normalizedFull;
    }

    /**
     * Recursively creates directories
     * @param dirPath - The full directory path to create
     */
    private async createDirectoryRecursive(dirPath: string): Promise<void> {
        // Check if directory already exists
        const exists = await RNFS.exists(dirPath);
        if (exists) {
            return;
        }

        // Get parent directory
        const parentDir = dirPath.substring(0, dirPath.lastIndexOf('/'));

        // If parent doesn't exist, create it first (recursion)
        if (parentDir && parentDir !== this.rootPath) {
            const parentExists = await RNFS.exists(parentDir);
            if (!parentExists) {
                await this.createDirectoryRecursive(parentDir);
            }
        }

        // Create current directory
        await RNFS.mkdir(dirPath);
    }

    async listFiles(path: string = ''): Promise<FileItem[]> {
        const fullPath = this.sanitizePath(path);
        try {
            const result = await RNFS.readDir(fullPath);
            return result.map((item) => ({
                name: item.name,
                path: item.path,
                size: Number(item.size),
                isDirectory: item.isDirectory(),
                mtime: item.mtime || new Date(),
            }));
        } catch (error) {
            console.error('Error listing files:', error);
            return [];
        }
    }

    async readFile(path: string): Promise<string> {
        const fullPath = this.sanitizePath(path);
        try {
            return await RNFS.readFile(fullPath, 'utf8');
        } catch (error) {
            console.error('Error reading file:', error);
            throw error;
        }
    }

    async writeFile(path: string, content: string): Promise<void> {
        const fullPath = this.sanitizePath(path);
        try {
            const dirPath = fullPath.substring(0, fullPath.lastIndexOf('/'));

            // Check if directory exists
            const dirExists = await RNFS.exists(dirPath);

            if (!dirExists) {
                console.log(`Directory ${dirPath} does not exist. Creating recursively...`);
                try {
                    // Recursively create all parent directories
                    await this.createDirectoryRecursive(dirPath);
                    console.log(`Directory ${dirPath} created successfully.`);
                } catch (mkdirError) {
                    console.error(`Failed to create directory ${dirPath}:`, mkdirError);
                    throw mkdirError; // Re-throw the specific mkdir error
                }
            }

            await RNFS.writeFile(fullPath, content, 'utf8');
        } catch (error) {
            console.error('Error writing file:', error);
            throw error;
        }
    }

    async createDirectory(path: string): Promise<void> {
        const fullPath = this.sanitizePath(path);
        try {
            await RNFS.mkdir(fullPath);
        } catch (error) {
            console.error('Error creating directory:', error);
            throw error;
        }
    }

    async deleteFile(path: string): Promise<void> {
        const fullPath = this.sanitizePath(path);
        try {
            await RNFS.unlink(fullPath);
        } catch (error) {
            console.error('Error deleting file:', error);
            throw error;
        }
    }

    async moveFile(srcPath: string, destPath: string): Promise<void> {
        const fullSrcPath = this.sanitizePath(srcPath);
        const fullDestPath = this.sanitizePath(destPath);
        try {
            await RNFS.moveFile(fullSrcPath, fullDestPath);
        } catch (error) {
            console.error('Error moving file:', error);
            throw error;
        }
    }

    async exists(path: string): Promise<boolean> {
        const fullPath = this.sanitizePath(path);
        return await RNFS.exists(fullPath);
    }

    async stat(path: string): Promise<FileItem | null> {
        const fullPath = this.sanitizePath(path);
        try {
            const statResult = await RNFS.stat(fullPath);
            return {
                name: path.split('/').pop() || '',
                path: statResult.path,
                size: Number(statResult.size),
                isDirectory: statResult.isDirectory(),
                mtime: statResult.mtime ? new Date(statResult.mtime) : new Date(),
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
