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
    allowedRoot: string;
    separator: string;
    platform: string;
}

export class FileManagerError extends Error {
    public code: string;
    public statusCode: number;

    constructor(message: string, code: string, statusCode: number = 400) {
        super(message);
        this.name = 'FileManagerError';
        this.code = code;
        this.statusCode = statusCode;
    }
}

export class FileManager {
    private workspaceDir: string;
    private allowedRoot: string;

    constructor(workspaceDir?: string, allowedRoot?: string) {
        this.workspaceDir = workspaceDir ? path.resolve(workspaceDir) : path.join(os.homedir(), 'workspace');
        this.allowedRoot = allowedRoot ? path.resolve(allowedRoot) : os.homedir();
    }

    /**
     * 获取系统与路径环境信息
     */
    public getSystemInfo(): FileSystemInfo {
        return {
            homeDir: os.homedir(),
            workspaceDir: this.workspaceDir,
            allowedRoot: this.allowedRoot,
            separator: path.sep,
            platform: process.platform,
        };
    }

    /**
     * 规范化并解析路径，同时强制校验访问边界（防目录穿越与符号链接逃逸）
     */
    public async resolveAndValidatePath(inputPath?: string, checkSymlinkRealpath: boolean = true): Promise<string> {
        let resolved: string;
        if (!inputPath || inputPath.trim() === '') {
            resolved = this.allowedRoot;
        } else if (inputPath.startsWith('~/') || inputPath === '~') {
            resolved = path.join(os.homedir(), inputPath.slice(1));
        } else {
            // 保留文件名首尾合法空格，不破坏具体文件名
            resolved = path.resolve(inputPath);
        }

        const isWindows = process.platform === 'win32';
        const normTarget = isWindows ? resolved.toLowerCase() : resolved;
        const normRoot = isWindows ? this.allowedRoot.toLowerCase() : this.allowedRoot;

        const isAllowed = normTarget === normRoot || normTarget.startsWith(normRoot + (normRoot.endsWith(path.sep) ? '' : path.sep));
        if (!isAllowed) {
            throw new FileManagerError(`无权限访问该路径: 超出允许的访问根目录 (${this.allowedRoot})`, 'OUT_OF_BOUNDS', 403);
        }

        // 针对已存在的实体做符号链接逃逸检查
        if (checkSymlinkRealpath) {
            try {
                if (fs.existsSync(resolved)) {
                    const real = await fs.promises.realpath(resolved);
                    const normReal = isWindows ? real.toLowerCase() : real;
                    const isRealAllowed = normReal === normRoot || normReal.startsWith(normRoot + (normRoot.endsWith(path.sep) ? '' : path.sep));
                    if (!isRealAllowed) {
                        throw new FileManagerError('禁止通过符号链接访问根目录外部目标', 'SYMLINK_ESCAPE', 403);
                    }
                }
            } catch (err: unknown) {
                if (err instanceof FileManagerError) throw err;
            }
        }

        return resolved;
    }

    /**
     * 同步快速路径解析（用于向后兼容）
     */
    public resolvePath(inputPath?: string): string {
        let resolved: string;
        if (!inputPath || inputPath.trim() === '') {
            resolved = this.allowedRoot;
        } else if (inputPath.startsWith('~/') || inputPath === '~') {
            resolved = path.join(os.homedir(), inputPath.slice(1));
        } else {
            resolved = path.resolve(inputPath);
        }

        const isWindows = process.platform === 'win32';
        const normTarget = isWindows ? resolved.toLowerCase() : resolved;
        const normRoot = isWindows ? this.allowedRoot.toLowerCase() : this.allowedRoot;

        const isAllowed = normTarget === normRoot || normTarget.startsWith(normRoot + (normRoot.endsWith(path.sep) ? '' : path.sep));
        if (!isAllowed) {
            throw new FileManagerError(`无权限访问该路径: 超出允许的访问根目录 (${this.allowedRoot})`, 'OUT_OF_BOUNDS', 403);
        }

        return resolved;
    }

    /**
     * 列出目录内容（采用分批并发，加速大目录读取）
     */
    public async listDirectory(targetPath?: string): Promise<ServerDirectoryListing> {
        const resolvedPath = await this.resolveAndValidatePath(targetPath);

        let stats: fs.Stats;
        try {
            stats = await fs.promises.stat(resolvedPath);
        } catch (err: unknown) {
            const nodeErr = err as NodeJS.ErrnoException;
            if (nodeErr.code === 'ENOENT') {
                throw new FileManagerError(`目录不存在: ${resolvedPath}`, 'ENOENT', 404);
            }
            if (nodeErr.code === 'EACCES' || nodeErr.code === 'EPERM') {
                throw new FileManagerError(`无权限访问该目录: ${resolvedPath}`, 'EACCES', 403);
            }
            throw new FileManagerError(`读取目录信息失败: ${nodeErr.message}`, 'FS_ERROR', 500);
        }

        if (!stats.isDirectory()) {
            throw new FileManagerError(`指定的路径不是目录: ${resolvedPath}`, 'NOT_DIRECTORY', 400);
        }

        let dirEntries: fs.Dirent[];
        try {
            dirEntries = await fs.promises.readdir(resolvedPath, { withFileTypes: true });
        } catch (err: unknown) {
            const nodeErr = err as NodeJS.ErrnoException;
            if (nodeErr.code === 'EACCES' || nodeErr.code === 'EPERM') {
                throw new FileManagerError(`无权限读取目录内容: ${resolvedPath}`, 'EACCES', 403);
            }
            throw new FileManagerError(`读取目录列表失败: ${nodeErr.message}`, 'FS_ERROR', 500);
        }

        // 分批并发处理条目 stat，提速大文件夹
        const concurrency = 20;
        const items: ServerFileItem[] = [];
        const validEntries = dirEntries.filter((entry) => entry.name !== '.' && entry.name !== '..');

        for (let i = 0; i < validEntries.length; i += concurrency) {
            const batch = validEntries.slice(i, i + concurrency);
            const batchResults = await Promise.all(
                batch.map(async (entry) => {
                    const itemFullPath = path.join(resolvedPath, entry.name);
                    let itemStats: fs.Stats | null = null;
                    let isDir = entry.isDirectory();

                    try {
                        itemStats = await fs.promises.stat(itemFullPath);
                        isDir = itemStats.isDirectory();
                    } catch {
                        // 降级以 dirent 判定
                    }

                    const ext = isDir ? '' : path.extname(entry.name).toLowerCase();
                    return {
                        name: entry.name,
                        path: itemFullPath,
                        isDirectory: isDir,
                        size: itemStats ? itemStats.size : 0,
                        mtime: itemStats ? itemStats.mtimeMs : 0,
                        extension: ext,
                    };
                })
            );
            items.push(...batchResults);
        }

        // 排序：文件夹排在前，文件在后；同类按名称字母排序
        items.sort((a, b) => {
            if (a.isDirectory && !b.isDirectory) return -1;
            if (!a.isDirectory && b.isDirectory) return 1;
            return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
        });

        const parsed = path.parse(resolvedPath);
        const isRootOrBoundary = resolvedPath === this.allowedRoot || resolvedPath === parsed.root;
        const parentPath = isRootOrBoundary ? null : path.dirname(resolvedPath);

        return {
            currentPath: resolvedPath,
            parentPath,
            items,
        };
    }

    /**
     * 读取文件内容（支持轻度查看与文本编辑）
     */
    public async readFileContent(
        targetPath: string,
        maxBytes: number = 5 * 1024 * 1024
    ): Promise<{ content: string; mtime: number; size: number }> {
        const resolvedPath = await this.resolveAndValidatePath(targetPath);

        let stats: fs.Stats;
        try {
            stats = await fs.promises.stat(resolvedPath);
        } catch (err: unknown) {
            const nodeErr = err as NodeJS.ErrnoException;
            if (nodeErr.code === 'ENOENT') {
                throw new FileManagerError(`文件不存在: ${resolvedPath}`, 'ENOENT', 404);
            }
            if (nodeErr.code === 'EACCES' || nodeErr.code === 'EPERM') {
                throw new FileManagerError(`无权限读取该文件: ${resolvedPath}`, 'EACCES', 403);
            }
            throw new FileManagerError(`读取文件失败: ${nodeErr.message}`, 'FS_ERROR', 500);
        }

        if (stats.isDirectory()) {
            throw new FileManagerError(`指定路径是目录而非文件: ${resolvedPath}`, 'IS_DIRECTORY', 400);
        }

        if (stats.size > maxBytes) {
            throw new FileManagerError(
                `文件过大（${(stats.size / 1024 / 1024).toFixed(1)}MB），超出最大支持大小（${(maxBytes / 1024 / 1024).toFixed(1)}MB）`,
                'LIMIT_EXCEEDED',
                400
            );
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
            throw new FileManagerError(`读取文件内容失败: ${nodeErr.message}`, 'FS_ERROR', 500);
        }
    }

    /**
     * 保存文件内容（支持 expectedMtime 乐观锁防并发覆盖、保持文件原有权限与大小统一对齐）
     */
    public async saveFileContent(
        targetPath: string,
        content: string,
        expectedMtime?: number,
        maxBytes: number = 5 * 1024 * 1024
    ): Promise<{ success: boolean; mtime: number; size: number }> {
        const contentBytes = Buffer.byteLength(content, 'utf8');
        if (contentBytes > maxBytes) {
            throw new FileManagerError(
                `保存内容过大（${(contentBytes / 1024 / 1024).toFixed(1)}MB），超出最大允许限制（${(maxBytes / 1024 / 1024).toFixed(1)}MB）`,
                'LIMIT_EXCEEDED',
                400
            );
        }

        const resolvedPath = await this.resolveAndValidatePath(targetPath, false);
        const parentDir = path.dirname(resolvedPath);

        try {
            await fs.promises.mkdir(parentDir, { recursive: true });
        } catch (err: unknown) {
            const nodeErr = err as NodeJS.ErrnoException;
            throw new FileManagerError(`创建父级目录失败: ${nodeErr.message}`, 'FS_ERROR', 500);
        }

        // 校验现有文件的 expectedMtime 与权限 mode
        let existingMode: number | null = null;
        try {
            const existingStats = await fs.promises.stat(resolvedPath);
            existingMode = existingStats.mode;

            if (expectedMtime !== undefined && expectedMtime > 0) {
                // 允许 100ms 误差容限
                if (Math.abs(existingStats.mtimeMs - expectedMtime) > 100) {
                    throw new FileManagerError('服务端文件已被外部修改，保存已被阻止 (409 Conflict)', 'PRECONDITION_FAILED', 409);
                }
            }
        } catch (err: unknown) {
            if (err instanceof FileManagerError) throw err;
            // 文件不存在属于新建，继续
        }

        const defaultMode = existingMode !== null ? existingMode : 0o644;
        const tmpFile = `${resolvedPath}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`;

        try {
            await fs.promises.writeFile(tmpFile, content, { encoding: 'utf8', mode: defaultMode });
            if (existingMode !== null) {
                await fs.promises.chmod(tmpFile, existingMode);
            }
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
                // ignore
            }
            if (err instanceof FileManagerError) throw err;
            const nodeErr = err as NodeJS.ErrnoException;
            throw new FileManagerError(`保存文件失败: ${nodeErr.message}`, 'FS_ERROR', 500);
        }
    }

    /**
     * 获取供下载的文件信息
     */
    public async getFileDownloadInfo(targetPath: string): Promise<{ resolvedPath: string; fileName: string; size: number }> {
        const resolvedPath = await this.resolveAndValidatePath(targetPath);

        let stats: fs.Stats;
        try {
            stats = await fs.promises.stat(resolvedPath);
        } catch (err: unknown) {
            const nodeErr = err as NodeJS.ErrnoException;
            if (nodeErr.code === 'ENOENT') {
                throw new FileManagerError(`文件不存在: ${resolvedPath}`, 'ENOENT', 404);
            }
            throw new FileManagerError(`获取文件信息失败: ${nodeErr.message}`, 'FS_ERROR', 500);
        }

        if (stats.isDirectory()) {
            throw new FileManagerError(`无法下载目录: ${resolvedPath}`, 'IS_DIRECTORY', 400);
        }

        return {
            resolvedPath,
            fileName: path.basename(resolvedPath),
            size: stats.size,
        };
    }
}
