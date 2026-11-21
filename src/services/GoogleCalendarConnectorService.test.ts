import { fetch } from 'expo/fetch';
import { googleCalendarConnector } from './GoogleCalendarConnectorService';

jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
jest.mock('./AssistantClient', () => ({ AssistantClient: { toHttpUrl: (url: string) => url.replace(/^wss:/, 'https:') } }));

const mockFetch = jest.mocked(fetch);
const connection = { serverUrl: 'wss://example.com', serverToken: 'test-only' };
const signal = () => new AbortController().signal;

beforeEach(() => mockFetch.mockReset());

function reply(payload: unknown) {
    mockFetch.mockResolvedValue({ ok: true, redirected: false, json: async () => payload } as Awaited<ReturnType<typeof fetch>>);
}

test('reads authoritative connector status with the server bearer and no redirects', async () => {
    reply({ status: 'connected', account: 'calendar@example.com' });
    await expect(googleCalendarConnector.getStatus(connection, signal())).resolves.toEqual({ status: 'connected', account: 'calendar@example.com' });
    expect(mockFetch).toHaveBeenCalledWith('https://example.com/api/connectors/google-calendar', expect.objectContaining({
        method: 'GET', redirect: 'error', headers: { Authorization: 'Bearer test-only' },
    }));
});

test('allows only the expected Google authorization URL', async () => {
    const good = 'https://accounts.google.com/o/oauth2/auth?state=test';
    reply({ authorizationUrl: good });
    await expect(googleCalendarConnector.connect(connection, signal())).resolves.toBe(good);
    reply({ authorizationUrl: 'https://accounts.google.com.invalid/o/oauth2/auth?state=test' });
    await expect(googleCalendarConnector.connect(connection, signal())).rejects.toThrow('invalid_authorization_url');
});

test('never sends the server bearer via plain HTTP', async () => {
    await expect(googleCalendarConnector.getStatus({ ...connection, serverUrl: 'http://example.com' }, signal())).rejects.toThrow('invalid_connection');
    expect(mockFetch).not.toHaveBeenCalled();
});
