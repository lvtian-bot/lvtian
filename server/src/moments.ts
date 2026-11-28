import { createHash } from 'node:crypto';
import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import { FileManager, FileManagerError } from './fileManager.js';

const yearPattern = /^\d{4}$/;
const monthPattern = /^(0[1-9]|1[0-2])$/;
// eslint-disable-next-line no-control-regex -- Windows 路径和控制字符不属于归档文件名。
const filePattern = /^[^/\\:\u0000-\u001f\u007f]+\.md$/;
const pageSize = 20;

type UploadResult = 'uploaded' | 'upload_failed';
type DeleteResult = 'deleted' | 'delete_failed';
export interface Moment {
    id: string;
    title: string;
    sourceUrl?: string;
    clippedAt: number;
    summary: string;
    revision: string;
}

function publicSource(source: string): string | undefined {
    try {
        const url = new URL(source);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
        // 与 Web Clipper 发往 Telegram 的原文链接一致。
        url.search = '';
        url.hash = '';
        return url.href;
    } catch { /* 无效的旧来源仍可展示摘要。 */ }
}

export function isMomentId(value: unknown): value is string {
    if (typeof value !== 'string') return false;
    const [year, month, file, ...rest] = value.split('/');
    return rest.length === 0 && yearPattern.test(year) && monthPattern.test(month)
        && filePattern.test(file);
}

function captureTime(created: unknown, fallback: number): number {
    if (typeof created !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:$|T)/.test(created)) return fallback;
    const calendarDate = Date.parse(created.slice(0, 10));
    const clippedAt = Date.parse(created.length === 10 ? created + 'T00:00:00' : created);
    return Number.isFinite(clippedAt) && Number.isFinite(calendarDate)
        && new Date(calendarDate).toISOString().slice(0, 10) === created.slice(0, 10) ? clippedAt : fallback;
}

function parseMoment(id: string, content: string, fallback: number): Moment | null {
    const header = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n(?:[ \t]*\r?\n)*#[ \t]+总结提炼[ \t]*\r?\n/.exec(content);
    if (!header) return null;
    const section = content.slice(header[0].length);
    // 模板在分隔线之前留两空行、之后留一空行，区分摘要中的普通分隔线。
    const separator = /(?:^|\r?\n)(?:[ \t]*\r?\n){2}---[ \t]*\r?\n[ \t]*\r?\n/.exec(section);
    if (!separator) return null;
    let metadata: unknown;
    try { metadata = parse(header[1]); } catch { return null; }
    if (!metadata || typeof metadata !== 'object' || !('note_type' in metadata)
        || metadata.note_type !== '文献笔记' || !('source' in metadata) || typeof metadata.source !== 'string') return null;
    return {
        id,
        // 剪藏的 YAML 没有标题字段，转换器已将文章标题用于文件名。
        title: path.posix.basename(id, '.md'),
        sourceUrl: publicSource(metadata.source),
        clippedAt: captureTime('created' in metadata ? metadata.created : undefined, fallback),
        summary: section.slice(0, separator.index).trim(),
        revision: createHash('sha256').update(content).digest('hex'),
    };
}

function isMissing(error: unknown): boolean {
    return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

async function directories(parent: string, pattern: RegExp): Promise<string[]> {
    try {
        return (await readdir(parent, { withFileTypes: true }))
            .filter(entry => entry.isDirectory() && pattern.test(entry.name))
            .map(entry => entry.name).sort().reverse();
    } catch (error) {
        if (isMissing(error)) return [];
        throw error;
    }
}

function compare(left: Pick<Moment, 'id' | 'clippedAt'>, right: Pick<Moment, 'id' | 'clippedAt'>): number {
    return right.clippedAt - left.clippedAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

interface Cursor { id: string; clippedAt: number }
function decodeCursor(encoded: string): Cursor | null {
    if (!/^[A-Za-z0-9_-]{1,2048}$/.test(encoded)) return null;
    try {
        const value: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
        if (value && typeof value === 'object' && 'id' in value && isMomentId(value.id)
            && 'clippedAt' in value && typeof value.clippedAt === 'number' && Number.isFinite(value.clippedAt)) {
            return { id: value.id, clippedAt: value.clippedAt };
        }
    } catch { /* 无效游标由 HTTP 层处理。 */ }
    return null;
}

export class MomentsArchive {
    private readonly files: FileManager;
    private readonly root: string;

    constructor(workspace: string) {
        this.files = new FileManager(workspace, workspace);
        this.root = path.join(this.files.getSystemInfo().workspaceDir, 'moments');
    }

    async read(id: string): Promise<Moment | null> {
        if (!isMomentId(id)) return null;
        const filename = path.join(this.root, ...id.split('/'));
        try {
            const stats = await lstat(filename);
            if (!stats.isFile() || await realpath(filename) !== filename) return null;
            const { content } = await this.files.readFileContent(filename);
            return parseMoment(id, content, stats.birthtimeMs || stats.mtimeMs);
        } catch (error) {
            if (isMissing(error) || (error instanceof FileManagerError && ['ENOENT', 'LIMIT_EXCEEDED'].includes(error.code))) return null;
            throw error;
        }
    }

    async list(encoded: string | null) {
        const cursor = encoded === null ? null : decodeCursor(encoded);
        if (encoded !== null && !cursor) return null;
        try {
            if (!(await lstat(this.root)).isDirectory() || await realpath(this.root) !== this.root) return { items: [], nextCursor: null };
        } catch (error) {
            if (isMissing(error)) return { items: [], nextCursor: null };
            throw error;
        }
        let items: Moment[] = [];
        for (const year of await directories(this.root, yearPattern)) {
            const yearDir = path.join(this.root, year);
            for (const month of await directories(yearDir, monthPattern)) {
                const folder = `${year}/${month}`;
                const monthDir = path.join(yearDir, month);
                if (await realpath(monthDir).catch(error => { if (isMissing(error)) return null; throw error; }) !== monthDir) continue;
                const ids = (await readdir(monthDir, { withFileTypes: true }).catch(error => {
                    if (isMissing(error)) return [];
                    throw error;
                })).filter(entry => entry.isFile()).map(entry => `${folder}/${entry.name}`).filter(isMomentId);
                // 缺少 created 的文件可能在归档月份之外创建。逐批比较真实排序键，
                // 保留当前页和下一条，避免按目录剪枝造成漏项。
                for (let start = 0; start < ids.length; start += 8) {
                    for (const clip of await Promise.all(ids.slice(start, start + 8).map(id => this.read(id)))) {
                        if (clip && (!cursor || compare(clip, cursor) > 0)) items.push(clip);
                    }
                    items = items.sort(compare).slice(0, pageSize + 1);
                }
            }
        }
        const hasMore = items.length > pageSize;
        if (hasMore) items.pop();
        const last = items.at(-1);
        const nextCursor = hasMore && last ? Buffer.from(JSON.stringify({
            id: last.id, clippedAt: last.clippedAt,
        })).toString('base64url') : null;
        return { items, nextCursor };
    }
}

export class ClipperMomentsClient {
    private readonly url: URL | undefined;
    private readonly token: string;

    constructor(rawOrigin: string | undefined, token: string | undefined) {
        this.token = token?.trim() ?? '';
        if (!rawOrigin || !this.token || /[\r\n\0]/.test(this.token)) return;
        try {
            const origin = new URL(rawOrigin);
            if (!['http:', 'https:'].includes(origin.protocol)
                || !['127.0.0.1', '[::1]'].includes(origin.hostname)
                || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') return;
            this.url = origin;
        } catch { /* 没有有效配对配置时仍可浏览归档。 */ }
    }

    get configured(): boolean { return this.url !== undefined; }

    private async request(endpoint: string, body: object): Promise<unknown> {
        if (!this.url) return null;
        const response = await fetch(new URL(endpoint, this.url), {
            method: 'POST', redirect: 'error', signal: AbortSignal.timeout(180_000),
            headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!response.ok) {
            await response.body?.cancel();
            return null;
        }
        const result: unknown = await response.json();
        return result && typeof result === 'object' && 'status' in result ? result.status : null;
    }

    async rewrite(id: string, revision: string): Promise<UploadResult | null> {
        const status = await this.request('/api/moments/summary', { id, revision, action: 'regenerate' });
        return status === 'uploaded' || status === 'upload_failed' ? status : null;
    }

    async delete(id: string, revision: string): Promise<DeleteResult | null> {
        const status = await this.request('/api/moments/delete', { id, revision });
        return status === 'deleted' || status === 'delete_failed' ? status : null;
    }
}
