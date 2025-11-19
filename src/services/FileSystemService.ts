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

    async listFiles(path: string = ''): Promise<FileItem[]> {
        const fullPath = `${this.rootPath}${path ? '/' + path : ''}`;
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
        const fullPath = `${this.rootPath}/${path}`;
        try {
            return await RNFS.readFile(fullPath, 'utf8');
        } catch (error) {
            console.error('Error reading file:', error);
            throw error;
        }
    }

    async writeFile(path: string, content: string): Promise<void> {
        const fullPath = `${this.rootPath}/${path}`;
        try {
            await RNFS.writeFile(fullPath, content, 'utf8');
        } catch (error) {
            console.error('Error writing file:', error);
            throw error;
        }
    }

    async createDirectory(path: string): Promise<void> {
        const fullPath = `${this.rootPath}/${path}`;
        try {
            await RNFS.mkdir(fullPath);
        } catch (error) {
            console.error('Error creating directory:', error);
            throw error;
        }
    }

    async deleteFile(path: string): Promise<void> {
        const fullPath = `${this.rootPath}/${path}`;
        try {
            await RNFS.unlink(fullPath);
        } catch (error) {
            console.error('Error deleting file:', error);
            throw error;
        }
    }

    async moveFile(srcPath: string, destPath: string): Promise<void> {
        const fullSrcPath = `${this.rootPath}/${srcPath}`;
        const fullDestPath = `${this.rootPath}/${destPath}`;
        try {
            await RNFS.moveFile(fullSrcPath, fullDestPath);
        } catch (error) {
            console.error('Error moving file:', error);
            throw error;
        }
    }

    async exists(path: string): Promise<boolean> {
        const fullPath = `${this.rootPath}/${path}`;
        return await RNFS.exists(fullPath);
    }

    getRootPath(): string {
        return this.rootPath;
    }
}

export const fsService = new FileSystemService();
