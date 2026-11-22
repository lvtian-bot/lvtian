import AsyncStorage from '@react-native-async-storage/async-storage';
import { fetch } from 'expo/fetch';
import { googleCalendarConnector } from './GoogleCalendarConnectorService';
import { readOperationReports, resetOperationDiagnosticsState } from './operationDiagnostics';

jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
jest.mock('./AssistantClient', () => ({ AssistantClient: { toHttpUrl: (url: string) => url.replace(/^wss:/, 'https:') } }));

const mockFetch = jest.mocked(fetch);
const connection = { serverUrl: 'wss://example.com', serverToken: 'test-only' };
const signal = () => new AbortController().signal;

beforeEach(async () => {
    mockFetch.mockReset();
    await AsyncStorage.clear();
    await resetOperationDiagnosticsState();
});

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

test('records timeout diagnostics when request exceeds 10s but ignores caller abort', async () => {
    jest.useFakeTimers();
    try {
        mockFetch.mockReturnValueOnce(new Promise(() => undefined));
        const timeoutPromise = googleCalendarConnector.getStatus(connection, signal()).catch((error: unknown) => error);
        await jest.advanceTimersByTimeAsync(10000);
        const timeoutError = await timeoutPromise;
        expect(timeoutError).toBeInstanceOf(Error);
        expect((timeoutError as Error).message).toBe('request_timeout');

        let reports = (await readOperationReports()).map(line => JSON.parse(line));
        expect(reports).toEqual([
            expect.objectContaining({ operation: 'connector', outcome: 'timeout' }),
        ]);

        await AsyncStorage.clear();
        await resetOperationDiagnosticsState();

        const controller = new AbortController();
        mockFetch.mockReturnValueOnce(new Promise(() => undefined));
        const abortedPromise = googleCalendarConnector.getStatus(connection, controller.signal).catch((error: unknown) => error);
        controller.abort();
        const abortError = await abortedPromise;
        expect(abortError).toBeInstanceOf(Error);
        expect((abortError as Error).message).toBe('request_cancelled');

        reports = (await readOperationReports()).map(line => JSON.parse(line));
        expect(reports).toEqual([]);
    } finally {
        jest.useRealTimers();
    }
});
