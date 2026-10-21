import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface ServerFileItem {
    name: string;
    path: string;
    isDirectory: boolean;
    size: number;
    mtime: number;
    extension: string;
}

export interface ServerDirectoryListing {
    currentPath: string;
    parentPath: string | null;
    items: ServerFileItem[];
}

export interface FileSystemInfo {
    homeDir: string;
    workspaceDir: string;
    separator: string;
    platform: string;
}

export class FileManager {
    private workspaceDir: string;

    constructor(workspaceDir?: string) {
        this.workspaceDir = workspaceDir || path.join(os.homedir(), 'workspace');
    }

    /**
     * 获取系统与路径环境信息
     */
    public getSystemInfo(): FileSystemInfo {
        return {
            homeDir: os.homedir(),
            workspaceDir: this.workspaceDir,
            separator: path.sep,
            platform: process.platform,
        };
    }

    /**
     * 规范化并解析路径
     */
    public resolvePath(inputPath?: string): string {
        if (!inputPath || !inputPath.trim()) {
            return os.homedir();
        }
        const trimmed = inputPath.trim();
        if (trimmed.startsWith('~/') || trimmed === '~') {
            return path.join(os.homedir(), trimmed.slice(1));
        }
        return path.resolve(trimmed);
    }

    /**
     * 列出目录内容
     */
    public async listDirectory(targetPath?: string): Promise<ServerDirectoryListing> {
        const resolvedPath = this.resolvePath(targetPath);

        let stats: fs.Stats;
        try {
            stats = await fs.promises.stat(resolvedPath);
        } catch (err: unknown) {
            const nodeErr = err as NodeJS.ErrnoException;
            if (nodeErr.code === 'ENOENT') {
                throw new Error(`目录不存在: ${resolvedPath}`);
            }
            if (nodeErr.code === 'EACCES' || nodeErr.code === 'EPERM') {
                throw new Error(`无权限访问该目录: ${resolvedPath}`);
            }
            throw new Error(`读取目录信息失败: ${nodeErr.message}`);
        }

        if (!stats.isDirectory()) {
            throw new Error(`指定的路径不是目录: ${resolvedPath}`);
        }

        let dirEntries: fs.Dirent[];
        try {
            dirEntries = await fs.promises.readdir(resolvedPath, { withFileTypes: true });
        } catch (err: unknown) {
            const nodeErr = err as NodeJS.ErrnoException;
            if (nodeErr.code === 'EACCES' || nodeErr.code === 'EPERM') {
                throw new Error(`无权限读取目录内容: ${resolvedPath}`);
            }
            throw new Error(`读取目录列表失败: ${nodeErr.message}`);
        }

        const items: ServerFileItem[] = [];

        for (const entry of dirEntries) {
            // 忽略 '.' 和 '..'
            if (entry.name === '.' || entry.name === '..') {
                continue;
            }

            const itemFullPath = path.join(resolvedPath, entry.name);
            let itemStats: fs.Stats | null = null;
            let isDir = entry.isDirectory();

            try {
                itemStats = await fs.promises.stat(itemFullPath);
                isDir = itemStats.isDirectory();
            } catch {
                // 如果 stat 失败（如损坏的软链接或无权限的特定子项），以 dirent 为准降级记录
            }

            const ext = isDir ? '' : path.extname(entry.name).toLowerCase();

            items.push({
                name: entry.name,
                path: itemFullPath,
                isDirectory: isDir,
                size: itemStats ? itemStats.size : 0,
                mtime: itemStats ? itemStats.mtimeMs : 0,
                extension: ext,
            });
        }

        // 排序：文件夹排在前，文件在后；同类按名称字母排序
        items.sort((a, b) => {
            if (a.isDirectory && !b.isDirectory) return -1;
            if (!a.isDirectory && b.isDirectory) return 1;
            return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
        });

        const parsed = path.parse(resolvedPath);
        // 如果当前路径等于其 root，说明已到达根目录，没有 parentPath
        const isRoot = resolvedPath === parsed.root;
        const parentPath = isRoot ? null : path.dirname(resolvedPath);

        return {
            currentPath: resolvedPath,
            parentPath,
            items,
        };
    }

    /**
     * 读取文件内容（支持轻度查看与文本编辑）
     */
    public async readFileContent(targetPath: string, maxBytes: number = 5 * 1024 * 1024): Promise<{ content: string; mtime: number; size: number }> {
        const resolvedPath = this.resolvePath(targetPath);

        let stats: fs.Stats;
        try {
            stats = await fs.promises.stat(resolvedPath);
        } catch (err: unknown) {
            const nodeErr = err as NodeJS.ErrnoException;
            if (nodeErr.code === 'ENOENT') {
                throw new Error(`文件不存在: ${resolvedPath}`);
            }
            if (nodeErr.code === 'EACCES' || nodeErr.code === 'EPERM') {
                throw new Error(`无权限读取该文件: ${resolvedPath}`);
            }
            throw new Error(`读取文件失败: ${nodeErr.message}`);
        }

        if (stats.isDirectory()) {
            throw new Error(`指定路径是目录而非文件: ${resolvedPath}`);
        }

        if (stats.size > maxBytes) {
            throw new Error(`文件过大（${(stats.size / 1024 / 1024).toFixed(1)}MB），超出最大支持大小（${(maxBytes / 1024 / 1024).toFixed(1)}MB）`);
        }

        try {
            const content = await fs.promises.readFile(resolvedPath, 'utf8');
            return {
                content,
                mtime: stats.mtimeMs,
                size: stats.size,
            };
        } catch (err: unknown) {
            const nodeErr = err as NodeJS.ErrnoException;
            throw new Error(`读取文件内容失败: ${nodeErr.message}`);
        }
    }

    /**
     * 保存文件内容（支持轻度编辑保存）
     */
    public async saveFileContent(targetPath: string, content: string): Promise<{ success: boolean; mtime: number; size: number }> {
        const resolvedPath = this.resolvePath(targetPath);
        const parentDir = path.dirname(resolvedPath);

        try {
            await fs.promises.mkdir(parentDir, { recursive: true });
        } catch (err: unknown) {
            const nodeErr = err as NodeJS.ErrnoException;
            throw new Error(`创建父级目录失败: ${nodeErr.message}`);
        }

        // 使用临时文件写入后原子重命名，防止并发截断或落盘崩溃
        const tmpFile = `${resolvedPath}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`;
        try {
            await fs.promises.writeFile(tmpFile, content, { encoding: 'utf8', mode: 0o644 });
            await fs.promises.rename(tmpFile, resolvedPath);
            const stats = await fs.promises.stat(resolvedPath);
            return {
                success: true,
                mtime: stats.mtimeMs,
                size: stats.size,
            };
        } catch (err: unknown) {
            try {
                if (fs.existsSync(tmpFile)) {
                    await fs.promises.unlink(tmpFile);
                }
            } catch {
                // 忽略清理临时文件时的异常
            }
            const nodeErr = err as NodeJS.ErrnoException;
            throw new Error(`保存文件失败: ${nodeErr.message}`);
        }
    }

    /**
     * 获取供下载的文件信息
     */
    public async getFileDownloadInfo(targetPath: string): Promise<{ resolvedPath: string; fileName: string; size: number }> {
        const resolvedPath = this.resolvePath(targetPath);

        let stats: fs.Stats;
        try {
            stats = await fs.promises.stat(resolvedPath);
        } catch (err: unknown) {
            const nodeErr = err as NodeJS.ErrnoException;
            if (nodeErr.code === 'ENOENT') {
                throw new Error(`文件不存在: ${resolvedPath}`);
            }
            throw new Error(`获取文件信息失败: ${nodeErr.message}`);
        }

        if (stats.isDirectory()) {
            throw new Error(`无法下载目录: ${resolvedPath}`);
        }

        return {
            resolvedPath,
            fileName: path.basename(resolvedPath),
            size: stats.size,
        };
    }
}
