import { fetch } from 'expo/fetch';
import { AssistantClient } from './AssistantClient';
import { recordOperation } from './operationDiagnostics';

class ConnectorRequestError extends Error {
    constructor(message: string, readonly httpStatus?: number) {
        super(message);
    }
}

const CONNECTOR_PATH = '/api/connectors/google-calendar';
const REQUEST_TIMEOUT_MS = 10000;

type ConnectorStatus = 'unavailable' | 'disconnected' | 'authorizing' | 'connected' | 'needs_reauth' | 'verification_unavailable';
export interface GoogleCalendarStatus {
    status: ConnectorStatus;
    account?: string;
}

export interface ConnectorConnection {
    serverUrl: string;
    serverToken: string;
}

function parseStatus(data: unknown): GoogleCalendarStatus {
    if (!data || typeof data !== 'object' || !('status' in data)) {
        recordOperation('connector', 'invalid_status');
        throw new Error('invalid_status');
    }
    const status = data.status;
    if (status !== 'unavailable' && status !== 'disconnected' && status !== 'authorizing'
        && status !== 'connected' && status !== 'needs_reauth' && status !== 'verification_unavailable') {
        recordOperation('connector', 'invalid_status');
        throw new Error('invalid_status');
    }
    const account = 'account' in data ? data.account : undefined;
    if (account !== undefined && typeof account !== 'string') {
        recordOperation('connector', 'invalid_status');
        throw new Error('invalid_status');
    }
    return { status, account };
}

async function request(connection: ConnectorConnection, action: '' | '/connect' | '/disconnect', signal: AbortSignal): Promise<unknown> {
    const server = new URL(AssistantClient.toHttpUrl(connection.serverUrl));
    const token = connection.serverToken.trim();
    if (server.protocol !== 'https:' || server.username || server.password || server.search || server.hash
        || !token || /[\r\n\0]/.test(token)) {
        recordOperation('connector', 'invalid_connection');
        throw new Error('invalid_connection');
    }
    if (signal.aborted) throw new Error('request_aborted');

    const controller = new AbortController();
    let abort = () => {};
    let timedOut = () => {};
    const cancelled = new Promise<never>((_, reject) => {
        abort = () => {
            controller.abort();
            reject(new Error('request_cancelled'));
        };
        timedOut = () => {
            controller.abort();
            reject(new ConnectorRequestError('request_timeout'));
        };
    });
    signal.addEventListener('abort', abort);
    const timeout = setTimeout(timedOut, REQUEST_TIMEOUT_MS);
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
            if (response.redirected) throw new ConnectorRequestError('redirect_blocked');
            // A previous Lvtian server may not implement the status route at all.
            if (!action && response.status === 404) return { status: 'unsupported' };
            if (!response.ok) throw new ConnectorRequestError('connector_request_failed', response.status);
            return response.json();
        })()]);
    } catch (error: unknown) {
        if (error instanceof ConnectorRequestError) {
            const outcome = error.message === 'redirect_blocked'
                ? 'redirect_blocked'
                : error.message === 'request_timeout'
                    ? 'timeout'
                    : 'request_failed';
            recordOperation('connector', outcome, { httpStatus: error.httpStatus });
            throw error;
        }
        const message = error instanceof Error ? error.message : '';
        if (message !== 'request_aborted' && message !== 'request_cancelled') {
            recordOperation('connector', 'network');
        }
        throw error;
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
            recordOperation('connector', 'invalid_authorization_url');
            throw new Error('invalid_authorization_url');
        }
        return data.authorizationUrl;
    },
    async disconnect(connection: ConnectorConnection, signal: AbortSignal): Promise<GoogleCalendarStatus> {
        return parseStatus(await request(connection, '/disconnect', signal));
    },
};
