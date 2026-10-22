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
    /** 目录条目过多时仅返回前面的部分条目（按目录读取顺序），为 true 表示已截断 */
    truncated: boolean;
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
    /** 家目录的物理真实路径：与 allowedRoot 同一命名空间，`~` 展开与系统信息广播保持一致 */
    private homeDirReal: string;
    /** 按目标路径串行化保存操作：乐观锁检查与临时文件替换必须独占执行，防止并发保存互相覆盖 */
    private saveQueues = new Map<string, Promise<unknown>>();

    constructor(workspaceDir?: string, allowedRoot?: string) {
        // 根目录自身可能包含符号链接段（如 /home -> /var/home）：
        // 统一规范化为物理真实路径，后续 realpath 边界比较才不会把界内文件误判为逃逸
        this.homeDirReal = this.canonicalizeRoot(os.homedir());
        this.workspaceDir = this.canonicalizeRoot(workspaceDir ? path.resolve(workspaceDir) : path.join(os.homedir(), 'workspace'));
        this.allowedRoot = this.canonicalizeRoot(allowedRoot ? path.resolve(allowedRoot) : os.homedir());
    }

    private canonicalizeRoot(root: string): string {
        try {
            return fs.realpathSync(root);
        } catch {
            return root; // 目录尚不存在时保留词法路径，后续创建后由祖先真实路径校验兜底
        }
    }

    /**
     * 获取系统与路径环境信息
     */
    public getSystemInfo(): FileSystemInfo {
        return {
            homeDir: this.homeDirReal,
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
            resolved = path.join(this.homeDirReal, inputPath.slice(1));
        } else {
            // 保留文件名首尾合法空格，不破坏具体文件名
            resolved = path.resolve(inputPath);
        }
        // 统一拉入物理命名空间（最近存在祖先物理化 + 剩余段拼接），
        // 与物理 allowedRoot 前缀比较才不会因输入路径含符号链接段而误判
        resolved = this.canonicalizePath(resolved);

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
            resolved = path.join(this.homeDirReal, inputPath.slice(1));
        } else {
            resolved = path.resolve(inputPath);
        }
        resolved = this.canonicalizePath(resolved);

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

        // 分批并发处理条目 stat，提速大文件夹；条目数超过上限时截断，避免超大目录扫描耗时超出客户端超时
        const concurrency = 20;
        const maxEntries = 1000;
        let truncated = false;
        const items: ServerFileItem[] = [];
        const validEntries = dirEntries.filter((entry) => entry.name !== '.' && entry.name !== '..');

        outer: for (let i = 0; i < validEntries.length; i += concurrency) {
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
            if (items.length >= maxEntries) {
                truncated = true;
                break outer;
            }
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
            truncated,
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
            // 循环读取直到文件尾或超限：缓冲长度不依赖打开前的 stat，
            // 文件在 stat 与 open 之间增长也不会把截断内容当作完整结果返回
            const handle = await fs.promises.open(resolvedPath, 'r');
            try {
                const chunkSize = 1024 * 1024;
                const chunks: Buffer[] = [];
                let totalBytes = 0;
                while (totalBytes <= maxBytes) {
                    const buf = Buffer.alloc(Math.min(chunkSize, maxBytes + 1 - totalBytes));
                    const { bytesRead } = await handle.read(buf, 0, buf.length, null);
                    if (bytesRead === 0) break;
                    totalBytes += bytesRead;
                    if (totalBytes > maxBytes) {
                        throw new FileManagerError(
                            `文件过大，超出最大支持大小（${(maxBytes / 1024 / 1024).toFixed(1)}MB）`,
                            'LIMIT_EXCEEDED',
                            400
                        );
                    }
                    chunks.push(Buffer.from(buf.subarray(0, bytesRead)));
                }
                return {
                    content: Buffer.concat(chunks).toString('utf8'),
                    mtime: stats.mtimeMs,
                    size: totalBytes,
                };
            } finally {
                await handle.close();
            }
        } catch (err: unknown) {
            if (err instanceof FileManagerError) throw err;
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

        // 同一目标文件的保存请求串行执行：乐观锁检查（mtime 比对）与临时文件替换必须在同一独占段内完成，
        // 防止并发保存双双通过检查后，后一次 rename 静默覆盖前一次的修改。
        // 锁键基于最近已存在祖先的物理真实路径规范化，使根内符号链接别名（如 /allowed/link/a.md
        // 与 /allowed/real/a.md 指向同一文件）进入同一队列串行
        const lockKey = this.canonicalizePath(resolvedPath);
        const previous = this.saveQueues.get(lockKey) ?? Promise.resolve();
        let releaseSaveLock!: () => void;
        const gate = new Promise<void>((resolve) => { releaseSaveLock = resolve; });
        const tail = previous.then(() => gate);
        this.saveQueues.set(lockKey, tail);
        // 链尾自清理，避免长期运行后 Map 无限增长
        tail.catch(() => {}).then(() => {
            if (this.saveQueues.get(lockKey) === tail) {
                this.saveQueues.delete(lockKey);
            }
        });

        await previous;
        try {
            return await this.performSave(resolvedPath, content, expectedMtime);
        } finally {
            releaseSaveLock();
        }
    }

    private async performSave(resolvedPath: string, content: string, expectedMtime?: number): Promise<{ success: boolean; mtime: number; size: number }> {
        const parentDir = path.dirname(resolvedPath);

        // 在创建任何目录之前，先校验最近已存在祖先的物理真实路径，
        // 防止经符号链接在外部目录下实际创建出新目录之后才拒绝保存
        const existingAncestor = this.findExistingAncestor(parentDir);
        try {
            const realAncestor = await fs.promises.realpath(existingAncestor);
            if (!this.isPathWithinAllowedRoot(realAncestor)) {
                throw new FileManagerError(`目标目录超出允许的访问范围: ${realAncestor}`, 'OUT_OF_BOUNDS', 403);
            }
        } catch (err: unknown) {
            if (err instanceof FileManagerError) throw err;
            const nodeErr = err as NodeJS.ErrnoException;
            throw new FileManagerError(`校验目标目录失败: ${nodeErr.message}`, 'FS_ERROR', 500);
        }

        try {
            await fs.promises.mkdir(parentDir, { recursive: true });
            // mkdir 后复核最终父目录物理真实路径仍在边界内（竞态兜底）
            const realParent = await fs.promises.realpath(parentDir);
            if (!this.isPathWithinAllowedRoot(realParent)) {
                throw new FileManagerError(`目标目录超出允许的访问范围: ${realParent}`, 'OUT_OF_BOUNDS', 403);
            }
        } catch (err: unknown) {
            if (err instanceof FileManagerError) throw err;
            const nodeErr = err as NodeJS.ErrnoException;
            throw new FileManagerError(`创建或校验父级目录失败: ${nodeErr.message}`, 'FS_ERROR', 500);
        }

        // 校验现有文件的 expectedMtime 与权限 mode
        let existingMode: number | null = null;
        // 保存必须落到目标真实文件：目标是根内符号链接时，rename 到词法路径会顶替链接本身
        // 而真实文件内容不变（界面报成功但实际未保存），因此先解析到物理目标并校验边界
        let finalPath = resolvedPath;
        try {
            try {
                const realTarget = await fs.promises.realpath(resolvedPath);
                if (!this.isPathWithinAllowedRoot(realTarget)) {
                    throw new FileManagerError('禁止通过符号链接访问根目录外部目标', 'SYMLINK_ESCAPE', 403);
                }
                finalPath = realTarget;
            } catch (err: unknown) {
                if (err instanceof FileManagerError) throw err;
                const rnErr = err as NodeJS.ErrnoException;
                if (rnErr.code !== 'ENOENT') throw err;
                // 目标不存在（新建文件），使用原路径
            }

            const existingStats = await fs.promises.stat(finalPath);
            existingMode = existingStats.mode;

            if (expectedMtime !== undefined && expectedMtime > 0) {
                // 严格相等比对：mtime 经 JSON 传输无损，任何不一致都视为外部修改，阻止覆盖
                if (existingStats.mtimeMs !== expectedMtime) {
                    throw new FileManagerError('服务端文件已被外部修改，保存已被阻止 (409 Conflict)', 'PRECONDITION_FAILED', 409);
                }
            }
        } catch (err: unknown) {
            if (err instanceof FileManagerError) throw err;
            const nodeErr = err as NodeJS.ErrnoException;
            if (nodeErr.code === 'ENOENT') {
                if (expectedMtime !== undefined && expectedMtime > 0) {
                    throw new FileManagerError('服务端文件已被外部删除或移动，保存已被阻止 (409 Conflict)', 'PRECONDITION_FAILED', 409);
                }
                // 预期为新文件（无 expectedMtime），正常继续新建
            } else {
                throw new FileManagerError(`检查目标文件状态失败: ${nodeErr.message}`, 'FS_ERROR', 500);
            }
        }

        const defaultMode = existingMode !== null ? existingMode : 0o644;
        const tmpFile = `${finalPath}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`;

        try {
            await fs.promises.writeFile(tmpFile, content, { encoding: 'utf8', mode: defaultMode });
            if (existingMode !== null) {
                await fs.promises.chmod(tmpFile, existingMode);
            }
            await fs.promises.rename(tmpFile, finalPath);
            const stats = await fs.promises.stat(finalPath);
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
     * 判断物理路径是否位于允许根目录边界内（Windows 下大小写不敏感）
     */
    private isPathWithinAllowedRoot(target: string): boolean {
        const isWindows = process.platform === 'win32';
        const normTarget = isWindows ? target.toLowerCase() : target;
        const normRoot = isWindows ? this.allowedRoot.toLowerCase() : this.allowedRoot;
        return normTarget === normRoot || normTarget.startsWith(normRoot + (normRoot.endsWith(path.sep) ? '' : path.sep));
    }

    /**
     * 从给定目录逐级向上找到第一个实际存在的祖先目录（符号链接本身视为存在）
     */
    private findExistingAncestor(startDir: string): string {
        let current = path.resolve(startDir);
        const root = path.parse(current).root;
        while (!fs.existsSync(current) && current !== root) {
            const parent = path.dirname(current);
            if (parent === current) break;
            current = parent;
        }
        return current;
    }

    /**
     * 统一路径命名空间：以最近已存在祖先的物理真实路径为锚点拼接剩余路径段。
     * 用于路径边界校验（词法输入与物理 allowedRoot 可比）与保存锁键
     * （经根内符号链接访问的同一物理文件共享同一把锁）
     */
    private canonicalizePath(resolvedPath: string): string {
        const anchor = this.findExistingAncestor(resolvedPath);
        try {
            const realAnchor = fs.realpathSync(anchor);
            return path.join(realAnchor, path.relative(anchor, resolvedPath));
        } catch {
            return resolvedPath;
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
