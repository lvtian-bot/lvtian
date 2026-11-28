import type http from 'node:http';
import { ClipperMomentsClient, isMomentId, MomentsArchive } from './moments.js';

function json(res: http.ServerResponse, status: number, value: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
}

export async function handleMomentsHttp(
    req: http.IncomingMessage, res: http.ServerResponse, url: URL,
    archive: MomentsArchive, clipper: ClipperMomentsClient, readBody: () => Promise<unknown>, draining: boolean,
): Promise<void> {
    try {
        if (url.pathname === '/api/moments' && req.method === 'GET') {
            const page = await archive.list(url.searchParams.get('cursor'));
            if (!page) { json(res, 400, { code: 'invalid_input' }); return; }
            json(res, 200, { ...page, canEditSummary: clipper.configured });
            return;
        }
        if (url.pathname === '/api/moments/summary' && req.method === 'POST') {
            if (draining || !clipper.configured) { json(res, 503, { code: 'summary_unavailable' }); return; }
            const body = await readBody().catch(() => null);
            if (!body || typeof body !== 'object' || !('id' in body) || !isMomentId(body.id)
                || !('revision' in body) || typeof body.revision !== 'string' || !/^[a-f0-9]{64}$/.test(body.revision)
                || !('action' in body) || (body.action !== 'regenerate' && body.action !== 'delete')) {
                json(res, 400, { code: 'invalid_input' }); return;
            }
            const current = await archive.read(body.id);
            if (!current) { json(res, 404, { code: 'clip_not_found' }); return; }
            if (current.revision !== body.revision) { json(res, 409, { code: 'clip_changed' }); return; }
            const status = await clipper.update(body.id, body.revision, body.action);
            if (!status) { json(res, 502, { code: 'summary_failed' }); return; }
            const item = await archive.read(body.id);
            if (!item) { json(res, 404, { code: 'clip_not_found' }); return; }
            json(res, 200, { item, status });
            return;
        }
        json(res, 405, { code: 'method_not_allowed' });
    } catch {
        json(res, 503, { code: 'moments_unavailable' });
    }
}
