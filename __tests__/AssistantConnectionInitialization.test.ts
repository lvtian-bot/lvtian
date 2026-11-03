import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { AssistantClient } from '../src/services/AssistantClient';
import { CONNECTION_CONFIG_KEY } from '../src/services/connectionConfig';
import { useAssistantStore } from '../src/store/useAssistantStore';

jest.mock('expo-secure-store', () => ({ getItemAsync: jest.fn(), setItemAsync: jest.fn(), deleteItemAsync: jest.fn() }));

class TestSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    static instances: TestSocket[] = [];
    readyState = TestSocket.CONNECTING;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    readonly send = jest.fn();
    readonly close = jest.fn(() => { this.readyState = TestSocket.CLOSED; });
    constructor(readonly url: string) { TestSocket.instances.push(this); }
    open() { this.readyState = TestSocket.OPEN; this.onopen?.(); }
}

const originalWebSocket = global.WebSocket;
const loadSavedCredentials = useAssistantStore.getState().loadSavedCredentials;

describe('AssistantClient independent connection initialization', () => {
    let client: AssistantClient;
    let load: jest.MockedFunction<typeof loadSavedCredentials>;

    beforeEach(async () => {
        jest.useFakeTimers();
        await AsyncStorage.clear();
        await AsyncStorage.setItem(CONNECTION_CONFIG_KEY, JSON.stringify({ url: 'https://saved.test' }));
        jest.mocked(SecureStore.getItemAsync).mockReset().mockResolvedValue('saved-token');
        // Drain the store's independent startup initialization before setting each scenario.
        await loadSavedCredentials();
        load = jest.fn(loadSavedCredentials);
        TestSocket.instances = [];
        global.WebSocket = TestSocket as unknown as typeof WebSocket;
        client = AssistantClient.getInstance();
        client.disconnect();
        useAssistantStore.setState({
            serverUrl: 'https://memory.test', serverToken: 'memory-token',
            credentialsStatus: 'ready', credentialsError: null,
            hasHydrated: true, chatHydrationError: null,
            connectionState: 'disconnected', connectionError: null,
            loadSavedCredentials: load, isServerUpgrading: false,
            messages: [], pendingSendQueue: [], pendingCancelQueue: [],
            currentSeq: 12, clearedSeq: 15,
        });
    });

    afterEach(() => {
        try {
            client.disconnect();
            // Opening a connection starts its heartbeat; disconnect must clean it up.
            expect(jest.getTimerCount()).toBe(0);
        } finally {
            global.WebSocket = originalWebSocket;
            useAssistantStore.setState({ loadSavedCredentials });
            jest.restoreAllMocks();
            jest.useRealTimers();
        }
    });

    it.each(['url', 'token'] as const)('handles %s storage failure without a socket or rejected connect, preserving credentials for explicit retry', async failure => {
        if (failure === 'url') jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('private URL and token'));
        else jest.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(new Error('private URL and token'));
        useAssistantStore.setState({ credentialsStatus: 'loading' });

        await expect(client.connect()).resolves.toBeUndefined();

        const code = failure === 'url' ? 'connection_config_read_failed' : 'credentials_read_failed';
        expect(useAssistantStore.getState()).toMatchObject({
            serverUrl: 'https://memory.test', serverToken: 'memory-token',
            credentialsStatus: 'error', credentialsError: code,
            connectionState: 'disconnected', connectionError: code,
        });
        expect(TestSocket.instances).toHaveLength(0);
        expect(load).toHaveBeenCalledTimes(1);
        // No automatic retry was scheduled after a local storage failure.
        expect(jest.getTimerCount()).toBe(0);

        await expect(client.connect()).resolves.toBeUndefined();
        expect(load).toHaveBeenCalledTimes(2);
        expect(TestSocket.instances).toHaveLength(1);
        const socket = TestSocket.instances[0];
        expect(socket.url).toBe('wss://saved.test');
        socket.open();
        expect(useAssistantStore.getState()).toMatchObject({
            credentialsStatus: 'ready', credentialsError: null,
            connectionState: 'connected', connectionError: null,
        });
        expect(socket.send.mock.calls.map(([value]) => JSON.parse(value as string) as unknown)).toEqual([
            { type: 'auth', token: 'saved-token' },
            { type: 'sync', sessionId: 'main', lastSeq: 15 },
        ]);
    });

    it.each([null, 'chat_hydration_failed'] as const)('connects after chat hydration settles, using a fresh sync after failure (%s)', async chatHydrationError => {
        useAssistantStore.setState({ hasHydrated: false });
        await client.connect();
        expect(TestSocket.instances).toHaveLength(0);
        expect(load).not.toHaveBeenCalled();

        useAssistantStore.setState({ hasHydrated: true, chatHydrationError });
        await client.connect();
        expect(TestSocket.instances).toHaveLength(1);
        const socket = TestSocket.instances[0];
        socket.open();
        expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'sync', sessionId: 'main', lastSeq: chatHydrationError ? 0 : 15 }));
        expect(useAssistantStore.getState().connectionState).toBe('connected');
        expect(load).not.toHaveBeenCalled();
    });

    it('loads credentials independently while chat is unsettled, but opens no socket before both settle', async () => {
        let resolveToken!: (token: string) => void;
        const token = new Promise<string>(resolve => { resolveToken = resolve; });
        jest.mocked(SecureStore.getItemAsync).mockReturnValueOnce(token);
        useAssistantStore.setState({ credentialsStatus: 'loading', hasHydrated: false });
        const connecting = client.connect();
        expect(load).toHaveBeenCalledTimes(1);
        expect(TestSocket.instances).toHaveLength(0);
        resolveToken('saved-token');
        await connecting;
        expect(useAssistantStore.getState().credentialsStatus).toBe('ready');
        expect(TestSocket.instances).toHaveLength(0);

        useAssistantStore.setState({ hasHydrated: true });
        await client.connect();
        expect(load).toHaveBeenCalledTimes(1);
        expect(TestSocket.instances).toHaveLength(1);
        expect(TestSocket.instances[0].url).toBe('wss://saved.test');
    });

    it('treats ready with an empty token as settled absence, without reloading or a loading/ready loop', async () => {
        useAssistantStore.setState({ serverToken: '' });
        const statuses: string[] = [];
        const stop = useAssistantStore.subscribe((next, previous) => {
            if (next.credentialsStatus !== previous.credentialsStatus) statuses.push(next.credentialsStatus);
        });
        try {
            await client.connect();
            await client.connect();
            expect(load).not.toHaveBeenCalled();
            expect(statuses).toEqual([]);
            expect(TestSocket.instances).toHaveLength(1);
            const socket = TestSocket.instances[0];
            socket.open();
            expect(socket.send.mock.calls.map(([value]) => JSON.parse(value as string) as unknown)).toEqual([
                { type: 'sync', sessionId: 'main', lastSeq: 15 },
            ]);
        } finally { stop(); }
    });
});
