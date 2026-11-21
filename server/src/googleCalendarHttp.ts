import type http from 'node:http';
import { GOOGLE_CALENDAR_CALLBACK } from './googleCalendarConfig.js';
import { GoogleCalendarConnector, GoogleCalendarError } from './googleCalendarConnector.js';
import { calendarCallbackLocale } from './googleCalendarLocale.js';

const BASE = '/api/connectors/google-calendar';
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const GOOGLE_RESPONSE_PARAMS = new Set(['state', 'code', 'scope', 'authuser', 'prompt', 'hd', 'iss', 'error', 'error_description', 'error_uri']);

export function isGoogleCalendarApiPath(path: string): boolean {
    return path === BASE || path === `${BASE}/connect` || path === `${BASE}/disconnect`;
}

/** Called only after the normal /api bearer gate. No caller-provided operation arguments. */
export async function handleGoogleCalendarApi(req: http.IncomingMessage, res: http.ServerResponse,
    url: URL, connector: GoogleCalendarConnector, draining: boolean): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    const method = url.pathname === BASE ? 'GET' : 'POST';
    const send = (status: number, payload: unknown) => { res.writeHead(status); res.end(JSON.stringify(payload)); };
    if (req.method !== method) {
        res.setHeader('Allow', method);
        send(405, { error: 'method_not_allowed' });
        return;
    }
    if (url.search) {
        send(400, { error: 'invalid_request' });
        return;
    }
    if (draining) {
        send(503, { error: 'connector_unavailable' });
        return;
    }
    try {
        if (url.pathname === BASE) send(200, await connector.status());
        else if (url.pathname === `${BASE}/connect`) send(200, await connector.connect());
        else send(200, await connector.disconnect());
    } catch (err: unknown) {
        if (err instanceof GoogleCalendarError && err.code === 'connector_unavailable') {
            send(503, { error: 'connector_unavailable' });
        } else {
            send(502, { error: 'connector_operation_failed' });
        }
    }
}

/** Only a loopback HTTPS ingress may assert the configured public origin. It must overwrite forwarded proto. */
export async function handleGoogleCalendarCallback(req: http.IncomingMessage, res: http.ServerResponse,
    connector: GoogleCalendarConnector, draining: boolean): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const end = (status: number) => { res.writeHead(status); res.end(); };
    const redirect = connector.redirectUri;
    if (!redirect || draining) return end(404);
    try {
        const expected = new URL(redirect);
        if (!LOOPBACK.has(req.socket.remoteAddress ?? '') || req.headers['x-forwarded-proto'] !== 'https'
            || req.headers.host !== expected.host) return end(404);
        if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return end(405); }
        const target = req.url ?? '';
        if (target === GOOGLE_CALENDAR_CALLBACK) {
            // The browser has left the Google callback URL; no code, account or result is rendered.
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            const { language, text } = calendarCallbackLocale(req.headers['accept-language']);
            res.setHeader('Content-Language', language);
            res.setHeader('Vary', 'Accept-Language');
            res.writeHead(200);
            res.end(text);
            return;
        }
        if (!target.startsWith(`${GOOGLE_CALENDAR_CALLBACK}?`) || target.length > 8_192 || target.includes('#')) return end(400);
        const params = new URLSearchParams(target.slice(GOOGLE_CALENDAR_CALLBACK.length + 1));
        for (const key of params.keys()) {
            if (!GOOGLE_RESPONSE_PARAMS.has(key) || params.getAll(key).length !== 1) return end(400);
        }
        const state = params.get('state');
        const code = params.get('code');
        const error = params.get('error');
        const issuer = params.get('iss');
        if (!state || ((code !== null) === (error !== null))
            || (code !== null && !/^[!-~]{1,2048}$/.test(code))
            || (error !== null && !/^[a-z_]{1,64}$/.test(error))
            || (issuer !== null && issuer !== 'https://accounts.google.com')) return end(400);
        if (!await connector.callback(state, code ?? undefined)) return end(400);
        // Replace the address bar with the trusted fixed URI (no code/state, client-supplied destination, or link to the app).
        res.setHeader('Location', redirect);
        return end(303);
    } catch {
        return end(400);
    }
}
