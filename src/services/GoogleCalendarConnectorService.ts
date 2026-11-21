import { fetch } from 'expo/fetch';
import { AssistantClient } from './AssistantClient';

const CONNECTOR_PATH = '/api/connectors/google-calendar';
const REQUEST_TIMEOUT_MS = 10000;

type ConnectorStatus = 'unavailable' | 'disconnected' | 'authorizing' | 'connected' | 'needs_reauth';
export interface GoogleCalendarStatus {
    status: ConnectorStatus;
    account?: string;
}

export interface ConnectorConnection {
    serverUrl: string;
    serverToken: string;
}

function parseStatus(data: unknown): GoogleCalendarStatus {
    if (!data || typeof data !== 'object' || !('status' in data)) throw new Error('invalid_status');
    const status = data.status;
    if (status !== 'unavailable' && status !== 'disconnected' && status !== 'authorizing'
        && status !== 'connected' && status !== 'needs_reauth') throw new Error('invalid_status');
    const account = 'account' in data ? data.account : undefined;
    if (account !== undefined && typeof account !== 'string') throw new Error('invalid_account');
    return { status, account };
}

async function request(connection: ConnectorConnection, action: '' | '/connect' | '/disconnect', signal: AbortSignal): Promise<unknown> {
    const server = new URL(AssistantClient.toHttpUrl(connection.serverUrl));
    const token = connection.serverToken.trim();
    if (server.protocol !== 'https:' || server.username || server.password || server.search || server.hash
        || !token || /[\r\n\0]/.test(token)) throw new Error('invalid_connection');
    if (signal.aborted) throw new Error('request_aborted');

    const controller = new AbortController();
    let abort = () => {};
    const cancelled = new Promise<never>((_, reject) => {
        abort = () => {
            controller.abort();
            reject(new Error('request_cancelled'));
        };
    });
    signal.addEventListener('abort', abort);
    const timeout = setTimeout(abort, REQUEST_TIMEOUT_MS);
    try {
        // Unlike RN's legacy global fetch, Expo's native transport blocks redirects
        // before forwarding the Bearer credential to another endpoint.
        return await Promise.race([cancelled, (async () => {
            const response = await fetch(`${server.toString().replace(/\/+$/, '')}${CONNECTOR_PATH}${action}`, {
                method: action ? 'POST' : 'GET',
                headers: { Authorization: `Bearer ${token}` },
                redirect: 'error',
                signal: controller.signal,
            });
            if (response.redirected) throw new Error('redirect_blocked');
            // A previous Lvtian server may not implement the status route at all.
            if (!action && response.status === 404) return { status: 'unsupported' };
            if (!response.ok) throw new Error('connector_request_failed');
            return response.json();
        })()]);
    } finally {
        clearTimeout(timeout);
        signal.removeEventListener('abort', abort);
    }
}

export const googleCalendarConnector = {
    async getStatus(connection: ConnectorConnection, signal: AbortSignal): Promise<GoogleCalendarStatus | { status: 'unsupported'; account?: never }> {
        const data = await request(connection, '', signal);
        if (data && typeof data === 'object' && 'status' in data && data.status === 'unsupported') return { status: 'unsupported' };
        return parseStatus(data);
    },
    async connect(connection: ConnectorConnection, signal: AbortSignal): Promise<string> {
        const data = await request(connection, '/connect', signal);
        if (!data || typeof data !== 'object' || !('authorizationUrl' in data)
            || typeof data.authorizationUrl !== 'string'
            || !/^https:\/\/accounts\.google\.com\/o\/oauth2\/auth\?[^\s#\\]+$/.test(data.authorizationUrl)
            || !/^[!-~]+$/.test(data.authorizationUrl)) {
            throw new Error('invalid_authorization_url');
        }
        return data.authorizationUrl;
    },
    async disconnect(connection: ConnectorConnection, signal: AbortSignal): Promise<GoogleCalendarStatus> {
        return parseStatus(await request(connection, '/disconnect', signal));
    },
};
