import * as FileSystem from 'expo-file-system/legacy';

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
        // Expo documentDirectory ends with a slash usually, but let's be safe
        const docDir = FileSystem.documentDirectory?.replace(/\/+$/, '') || '';
        this.rootPath = `${docDir}/mdnote_docs`;
        // Ensure the root directory exists
        this.createDirectoryRecursive(this.rootPath).catch(err => {
            console.error('Failed to create root directory:', err);
        });
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
     * @param userPath - The user-provided path
     * @returns The safe, full absolute path
     * @throws Error if path is invalid or attempts to escape root directory
     */
    /**
     * Sanitizes and validates a user-provided path to prevent path traversal attacks
     * @param userPath - The user-provided path (can be relative or absolute)
     * @returns The safe, full absolute path
     * @throws Error if path is invalid or attempts to escape root directory
     */
    private sanitizePath(userPath: string): string {
        // Strip file:// prefix from rootPath for comparison
        const rootDir = this.rootPath.replace(/^file:\/+/, '/');

        // Normalize userPath: strip file:// prefix
        let pathToCheck = userPath.replace(/^file:\/+/, '/');

        // Check if userPath already contains the root path (is absolute)
        let fullPath = '';
        if (pathToCheck.startsWith(rootDir)) {
            // It is already absolute
            fullPath = pathToCheck;
        } else {
            // It is relative, append to root
            // Remove leading slashes from relative path
            const cleanRelative = pathToCheck.replace(/^\/+/, '');
            fullPath = cleanRelative ? `${rootDir}/${cleanRelative}` : rootDir;
        }

        // Normalize slashes (remove duplicates)
        fullPath = fullPath.replace(/\/+/g, '/');

        // Security Check: Ensure the resulting path is still within rootPath
        if (!fullPath.startsWith(rootDir)) {
            console.error(`[FileSystemService] Invalid path detected: userPath="${userPath}", resolved="${fullPath}", root="${rootDir}"`);
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
        // Expo supports intermediates
        const info = await FileSystem.getInfoAsync(dirPath);
        if (info.exists) {
            return;
        }
        await FileSystem.makeDirectoryAsync(dirPath, { intermediates: true });
    }

    async listFiles(path: string = ''): Promise<FileItem[]> {
        const fullPath = this.sanitizePath(path);
        try {
            const fileNames = await FileSystem.readDirectoryAsync(fullPath);
            const items = await Promise.all(fileNames.map(async (name) => {
                const itemPath = fullPath.endsWith('/') ? fullPath + name : fullPath + '/' + name;
                const info = await FileSystem.getInfoAsync(itemPath);
                if (!info.exists) return null;
                return {
                    name,
                    path: itemPath,
                    size: info.size,
                    isDirectory: info.isDirectory,
                    mtime: info.modificationTime ? new Date(info.modificationTime * 1000) : new Date(),
                };
            }));
            return items.filter((item): item is FileItem => item !== null);
        } catch (error) {
            console.error('Error listing files:', error);
            return [];
        }
    }

    async readFile(path: string): Promise<string> {
        const fullPath = this.sanitizePath(path);
        try {
            return await FileSystem.readAsStringAsync(fullPath, { encoding: FileSystem.EncodingType.UTF8 });
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
            const dirInfo = await FileSystem.getInfoAsync(dirPath);
            const dirExists = dirInfo.exists;

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

            await FileSystem.writeAsStringAsync(fullPath, content, { encoding: FileSystem.EncodingType.UTF8 });
        } catch (error) {
            console.error('Error writing file:', error);
            throw error;
        }
    }

    async createDirectory(path: string): Promise<void> {
        const fullPath = this.sanitizePath(path);
        try {
            await FileSystem.makeDirectoryAsync(fullPath, { intermediates: true });
        } catch (error) {
            console.error('Error creating directory:', error);
            throw error;
        }
    }

    async deleteFile(path: string): Promise<void> {
        const fullPath = this.sanitizePath(path);
        try {
            await FileSystem.deleteAsync(fullPath);
        } catch (error) {
            console.error('Error deleting file:', error);
            throw error;
        }
    }

    async moveFile(srcPath: string, destPath: string): Promise<void> {
        const fullSrcPath = this.sanitizePath(srcPath);
        const fullDestPath = this.sanitizePath(destPath);
        try {
            await FileSystem.moveAsync({ from: fullSrcPath, to: fullDestPath });
        } catch (error) {
            console.error('Error moving file:', error);
            throw error;
        }
    }

    async exists(path: string): Promise<boolean> {
        const fullPath = this.sanitizePath(path);
        const info = await FileSystem.getInfoAsync(fullPath);
        return info.exists;
    }

    async stat(path: string): Promise<FileItem | null> {
        const fullPath = this.sanitizePath(path);
        try {
            const info = await FileSystem.getInfoAsync(fullPath);
            if (!info.exists) return null;
            return {
                name: path.split('/').pop() || '',
                path: info.uri, // Expo uses uri
                size: info.size,
                isDirectory: info.isDirectory,
                mtime: info.modificationTime ? new Date(info.modificationTime * 1000) : new Date(),
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
