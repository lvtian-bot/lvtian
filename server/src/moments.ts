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
const dayMs = 86_400_000;

export type SummaryAction = 'regenerate' | 'delete';
export type UploadResult = 'uploaded' | 'upload_failed';
export interface Moment {
    id: string;
    title: string;
    clippedAt: number;
    summary: string;
    revision: string;
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
        const page = () => {
            const hasMore = items.length > pageSize;
            const visible = items.slice(0, pageSize);
            const last = visible.at(-1);
            return { items: visible, nextCursor: hasMore && last ? Buffer.from(JSON.stringify({
                id: last.id, clippedAt: last.clippedAt,
            })).toString('base64url') : null };
        };
        for (const year of await directories(this.root, yearPattern)) {
            const yearDir = path.join(this.root, year);
            for (const month of await directories(yearDir, monthPattern)) {
                const folder = `${year}/${month}`;
                // Web Clipper 用 created 的日历年月归档。跨月时允许最多一天的时区偏移。
                const monthStart = new Date(`${year}-${month}-01T00:00:00Z`);
                if (cursor && cursor.clippedAt < monthStart.getTime() - dayMs) continue;
                const monthEnd = monthStart.setUTCMonth(monthStart.getUTCMonth() + 1);
                if (items.length > pageSize && items[pageSize].clippedAt > monthEnd + dayMs) return page();
                const monthDir = path.join(yearDir, month);
                if (await realpath(monthDir).catch(error => { if (isMissing(error)) return null; throw error; }) !== monthDir) continue;
                const ids = (await readdir(monthDir, { withFileTypes: true }).catch(error => {
                    if (isMissing(error)) return [];
                    throw error;
                })).filter(entry => entry.isFile()).map(entry => `${folder}/${entry.name}`).filter(isMomentId);
                const clips: Moment[] = [];
                for (let start = 0; start < ids.length; start += 8) {
                    for (const clip of await Promise.all(ids.slice(start, start + 8).map(id => this.read(id)))) {
                        if (clip && (!cursor || compare(clip, cursor) > 0)) clips.push(clip);
                    }
                }
                items = items.concat(clips).sort(compare).slice(0, pageSize + 1);
            }
        }
        return page();
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
            this.url = new URL('/api/moments/summary', origin);
        } catch { /* 没有有效配对配置时仍可浏览归档。 */ }
    }

    get configured(): boolean { return this.url !== undefined; }

    async update(id: string, revision: string, action: SummaryAction): Promise<UploadResult | null> {
        if (!this.url) return null;
        const response = await fetch(this.url, {
            method: 'POST', redirect: 'error', signal: AbortSignal.timeout(180_000),
            headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, revision, action }),
        });
        if (!response.ok) {
            await response.body?.cancel();
            return null;
        }
        const body: unknown = await response.json();
        if (body && typeof body === 'object' && 'status' in body
            && (body.status === 'uploaded' || body.status === 'upload_failed')) return body.status;
        return null;
    }
}
