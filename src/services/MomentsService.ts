import { fetch } from 'expo/fetch';
import { AssistantClient } from './AssistantClient';

export interface Moment {
    id: string;
    title: string;
    clippedAt: number;
    summary: string;
    revision: string;
}

export interface MomentsPage {
    items: Moment[];
    nextCursor: string | null;
    canEditSummary: boolean;
}

export type SummaryAction = 'regenerate' | 'delete';
export interface MomentsConnection {
    serverUrl: string;
    serverToken: string;
}

function isMoment(value: unknown): value is Moment {
    return !!value && typeof value === 'object' && 'id' in value && typeof value.id === 'string'
        && 'title' in value && typeof value.title === 'string' && 'summary' in value && typeof value.summary === 'string'
        && 'clippedAt' in value && typeof value.clippedAt === 'number' && Number.isFinite(value.clippedAt)
        && 'revision' in value && typeof value.revision === 'string';
}

async function request(connection: MomentsConnection, endpoint: string, signal: AbortSignal, body?: object): Promise<unknown> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal.aborted) abort();
    signal.addEventListener('abort', abort);
    // 摘要需要等待生成及上传。读取目录使用较短的超时。
    const timeout = setTimeout(abort, body ? 190_000 : 15_000);
    try {
        const response = await fetch(`${AssistantClient.toHttpUrl(connection.serverUrl)}/api/moments${endpoint}`, {
            method: body ? 'POST' : 'GET', redirect: 'error', signal: controller.signal,
            headers: { Authorization: `Bearer ${connection.serverToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
            body: body ? JSON.stringify(body) : undefined,
        });
        if (!response.ok || response.redirected) throw new Error('moments_request_failed');
        return await response.json();
    } finally {
        signal.removeEventListener('abort', abort);
        clearTimeout(timeout);
    }
}

export const momentsService = {
    async list(connection: MomentsConnection, cursor: string | null, signal: AbortSignal): Promise<MomentsPage> {
        const data = await request(connection, cursor ? `?cursor=${encodeURIComponent(cursor)}` : '', signal);
        if (!data || typeof data !== 'object' || !('items' in data) || !Array.isArray(data.items) || !data.items.every(isMoment)
            || !('nextCursor' in data) || (data.nextCursor !== null && typeof data.nextCursor !== 'string')
            || !('canEditSummary' in data) || typeof data.canEditSummary !== 'boolean') throw new Error('moments_invalid_response');
        return { items: data.items, nextCursor: data.nextCursor, canEditSummary: data.canEditSummary };
    },

    async updateSummary(connection: MomentsConnection, item: Moment, action: SummaryAction, signal: AbortSignal): Promise<{
        item: Moment; status: 'uploaded' | 'upload_failed';
    }> {
        const data = await request(connection, '/summary', signal, { id: item.id, revision: item.revision, action });
        if (!data || typeof data !== 'object' || !('item' in data) || !isMoment(data.item) || data.item.id !== item.id
            || !('status' in data) || (data.status !== 'uploaded' && data.status !== 'upload_failed')) throw new Error('moments_invalid_response');
        return { item: data.item, status: data.status };
    },
};
