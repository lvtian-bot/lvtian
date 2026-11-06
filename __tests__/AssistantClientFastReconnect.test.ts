import { AppState, type AppStateStatus } from 'react-native';
import * as Network from 'expo-network';
import { AssistantClient } from '../src/services/AssistantClient';
import { fsService } from '../src/services/FileSystemService';
import { useAssistantStore } from '../src/store/useAssistantStore';
import { ServerMessage } from '../src/types/assistantProtocol';

jest.mock('expo-network', () => ({ addNetworkStateListener: jest.fn() }));

class TestSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
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
    receive(message: ServerMessage) { this.onmessage?.({ data: JSON.stringify(message) }); }
}

const sync: ServerMessage = {
    type: 'sync_result', sessionId: 'main', messages: [], taskState: 'idle', currentSeq: 0,
};
const wifi: Network.NetworkState = {
    type: 'WIFI' as Network.NetworkStateType,
    isConnected: true, isInternetReachable: true,
};
const cellular: Network.NetworkState = { ...wifi, type: 'CELLULAR' as Network.NetworkStateType };
const offline: Network.NetworkState = { type: 'NONE' as Network.NetworkStateType, isConnected: false };
const originalWebSocket = global.WebSocket;

// Exercise the actual socket callbacks, lifecycle events and deadlines together.
describe('AssistantClient connection recovery', () => {
    let client: AssistantClient;
    let appChange: (state: AppStateStatus) => void;
    let networkChange: (state: Network.NetworkState) => void;

    beforeAll(() => {
        Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
        jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => {
            appChange = listener;
            return { remove: jest.fn() };
        });
        jest.mocked(Network.addNetworkStateListener).mockImplementation(listener => {
            networkChange = listener;
            return { remove: jest.fn() };
        });
        global.WebSocket = TestSocket as unknown as typeof WebSocket;
        client = AssistantClient.getInstance();
    });

    beforeEach(() => {
        jest.useFakeTimers();
        client.disconnect();
        networkChange(wifi);
        appChange('background');
        appChange('active');
        TestSocket.instances = [];
        jest.spyOn(console, 'info').mockImplementation(() => {});
        jest.spyOn(client, 'fetchSkills').mockResolvedValue([]);
        useAssistantStore.setState({
            serverUrl: 'https://server.test', serverToken: 'private-token',
            credentialsStatus: 'ready', credentialsError: null, outboxStatus: 'ready',
            connectionState: 'disconnected', isServerUpgrading: false,
            messages: [], pendingSendQueue: [], pendingCancelQueue: [], currentSeq: 0, clearedSeq: 0,
        });
    });

    afterEach(() => {
        client.disconnect();
        expect(jest.getTimerCount()).toBe(0);
        jest.restoreAllMocks();
        jest.useRealTimers();
    });

    afterAll(() => { global.WebSocket = originalWebSocket; });

    async function ready() {
        await client.connect();
        const ws = TestSocket.instances[0];
        ws.open();
        ws.receive({ type: 'auth_result', success: true });
        ws.receive(sync);
        return ws;
    }

    it('uses settled in-memory credentials without another storage read', async () => {
        const load = jest.spyOn(useAssistantStore.getState(), 'loadSavedCredentials');
        await client.connect();
        expect(load).not.toHaveBeenCalled();
        expect(TestSocket.instances).toHaveLength(1);
    });

    it.each(['handshake', 'authentication', 'sync'] as const)('retries a stalled %s phase within its deadline', async phase => {
        await client.connect();
        const ws = TestSocket.instances[0];
        if (phase !== 'handshake') ws.open();
        if (phase === 'sync') ws.receive({ type: 'auth_result', success: true });
        const timeout = phase === 'sync' ? 20000 : 8000;
        jest.advanceTimersByTime(timeout - 1);
        expect(ws.close).not.toHaveBeenCalled();
        jest.advanceTimersByTime(1);
        expect(ws.close).toHaveBeenCalledTimes(1);
        expect(useAssistantStore.getState().connectionState).toBe('reconnecting');
        jest.advanceTimersByTime(50);
        expect(TestSocket.instances).toHaveLength(2);
    });

    it('replaces a stale handshake immediately on foreground resume', async () => {
        await client.connect();
        const ws = TestSocket.instances[0];
        appChange('background');
        jest.advanceTimersByTime(5000);
        appChange('active');
        expect(ws.close).toHaveBeenCalledTimes(1);
        expect(TestSocket.instances).toHaveLength(2);
    });

    it('keeps a recently started handshake across a short background visit', async () => {
        await client.connect();
        appChange('background');
        jest.advanceTimersByTime(1000);
        appChange('active');
        expect(TestSocket.instances).toHaveLength(1);
        expect(TestSocket.instances[0].close).not.toHaveBeenCalled();
    });

    it('replaces a stale authentication wait when returning to the foreground', async () => {
        await client.connect();
        const ws = TestSocket.instances[0];
        ws.open();
        appChange('background');
        jest.advanceTimersByTime(4000);
        appChange('active');
        expect(ws.close).toHaveBeenCalledTimes(1);
        expect(TestSocket.instances).toHaveLength(2);
    });

    it('rebuilds a ready socket after a longer background stay', async () => {
        const ws = await ready();
        appChange('background');
        jest.advanceTimersByTime(5000);
        appChange('active');
        expect(ws.close).toHaveBeenCalledTimes(1);
        expect(TestSocket.instances).toHaveLength(2);
    });

    it('queues messages until reconciliation completes and retains them until ack', async () => {
        await client.connect();
        const ws = TestSocket.instances[0];
        ws.open();
        const id = client.sendMessage('private-message');
        ws.receive({ type: 'auth_result', success: true });
        expect(useAssistantStore.getState().connectionState).toBe('connecting');
        expect(ws.send.mock.calls.some(([raw]) => JSON.parse(raw as string).type === 'chat')).toBe(false);
        ws.receive(sync);
        expect(useAssistantStore.getState().connectionState).toBe('connected');
        expect(ws.send).toHaveBeenCalledWith(JSON.stringify({
            type: 'chat', sessionId: 'main', messageId: id, content: 'private-message',
        }));
        expect(useAssistantStore.getState().pendingSendQueue.map(item => item.messageId)).toEqual([id]);
        ws.receive({ type: 'message_ack', messageId: id, seq: 1, status: 'sent', role: 'user' });
        expect(useAssistantStore.getState().pendingSendQueue).toEqual([]);
        const logs = JSON.stringify(jest.mocked(console.info).mock.calls);
        expect(logs).toContain('sync_applied');
        expect(logs).not.toMatch(/server\.test|private-token|private-message/);
    });

    it('keeps an attachment queued if its file read finishes during reconnection', async () => {
        await ready();
        let finish!: (value: { content: string; size: number }) => void;
        jest.spyOn(fsService, 'readAttachment').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
        useAssistantStore.getState().addToPendingSendQueue({
            sessionId: 'main', messageId: 'file', content: 'document',
            attachments: [{ type: 'file', name: 'test.txt', uri: 'file:///test.txt' }],
        });
        const pending = client.flushPendingSendQueue();
        await client.connect(true);
        const replacement = TestSocket.instances[1];
        replacement.open();
        finish({ content: 'body', size: 4 });
        await pending;
        expect(replacement.send.mock.calls.some(([raw]) => JSON.parse(raw as string).type === 'chat')).toBe(false);
        expect(useAssistantStore.getState().pendingSendQueue[0].messageId).toBe('file');
    });

    it('ignores late open, message, error and close callbacks from an old socket', async () => {
        await client.connect();
        const old = TestSocket.instances[0];
        const callbacks = { open: old.onopen, message: old.onmessage, error: old.onerror, close: old.onclose };
        await client.connect(true);
        const current = TestSocket.instances[1];
        callbacks.open?.();
        callbacks.message?.({ data: JSON.stringify({ type: 'auth_result', success: false }) });
        callbacks.error?.();
        callbacks.close?.();
        expect(current.send).not.toHaveBeenCalled();
        expect(current.close).not.toHaveBeenCalled();
        current.open();
        current.receive({ type: 'auth_result', success: true });
        current.receive(sync);
        expect(useAssistantStore.getState().connectionState).toBe('connected');
        jest.advanceTimersByTime(8000);
        expect(TestSocket.instances).toHaveLength(2);
    });

    it('stops attempts while offline and reconnects once when the interface returns', async () => {
        await client.connect();
        networkChange(offline);
        expect(TestSocket.instances[0].close).toHaveBeenCalledTimes(1);
        await client.connect();
        jest.advanceTimersByTime(60000);
        expect(TestSocket.instances).toHaveLength(1);
        networkChange(wifi);
        networkChange(wifi);
        jest.advanceTimersByTime(250);
        expect(TestSocket.instances).toHaveLength(2);
    });

    it('coalesces network switching events and resumes immediately on foreground', async () => {
        const ws = await ready();
        networkChange(cellular);
        networkChange(cellular);
        client.handleAppForeground();
        expect(ws.close).toHaveBeenCalledTimes(1);
        expect(TestSocket.instances).toHaveLength(2);
        jest.advanceTimersByTime(250);
        expect(TestSocket.instances).toHaveLength(2);
    });

    it('reconnects on a switch from Wi-Fi to mobile data without waiting for heartbeat', async () => {
        const ws = await ready();
        networkChange(cellular);
        expect(ws.close).toHaveBeenCalledTimes(1);
        jest.advanceTimersByTime(250);
        expect(TestSocket.instances).toHaveLength(2);
    });

    it('does not block LAN servers merely because public Internet validation fails', async () => {
        networkChange({ ...wifi, isInternetReachable: false });
        await client.connect();
        expect(TestSocket.instances).toHaveLength(1);
        TestSocket.instances[0].open();
        TestSocket.instances[0].receive({ type: 'auth_result', success: true });
        TestSocket.instances[0].receive(sync);
        networkChange(wifi);
        expect(TestSocket.instances[0].close).not.toHaveBeenCalled();
    });

    it('respects explicit disconnect and invalid credentials across lifecycle and network changes', async () => {
        await client.connect();
        TestSocket.instances[0].open();
        TestSocket.instances[0].receive({ type: 'auth_result', success: false, error: 'invalid' });
        appChange('background');
        jest.advanceTimersByTime(5000);
        appChange('active');
        networkChange(offline);
        networkChange(wifi);
        jest.advanceTimersByTime(60000);
        expect(TestSocket.instances).toHaveLength(1);
        expect(useAssistantStore.getState().connectionState).toBe('error');
        await client.connect();
        expect(TestSocket.instances).toHaveLength(2);
    });

    it('reuses a healthy socket after a short background stay and clears the probe on any data', async () => {
        const ws = await ready();
        appChange('background');
        jest.advanceTimersByTime(1000);
        appChange('active');
        expect(ws.send).toHaveBeenLastCalledWith(JSON.stringify({ type: 'ping' }));
        ws.receive({ type: 'pong' });
        jest.advanceTimersByTime(3500);
        expect(ws.close).not.toHaveBeenCalled();
    });

    it('repeated foreground probes do not postpone an unresponsive heartbeat deadline', async () => {
        const ws = await ready();
        client.handleAppForeground();
        jest.advanceTimersByTime(3000);
        client.handleAppForeground();
        jest.advanceTimersByTime(500);
        expect(ws.close).toHaveBeenCalledTimes(1);
        jest.advanceTimersByTime(50);
        expect(TestSocket.instances).toHaveLength(2);
    });

    it('retries an error immediately without depending on a later close callback', async () => {
        await client.connect();
        TestSocket.instances[0].onerror?.();
        jest.advanceTimersByTime(50);
        expect(TestSocket.instances).toHaveLength(2);
    });

    it('cancels a credential read that settles after an explicit disconnect', async () => {
        let finish!: () => void;
        jest.spyOn(useAssistantStore.getState(), 'loadSavedCredentials').mockImplementation(() =>
            new Promise<{ url: string; token: string }>(resolve => {
                finish = () => resolve({ url: 'https://server.test', token: 'private-token' });
            }));
        useAssistantStore.setState({ credentialsStatus: 'loading' });
        const pending = client.connect();
        client.disconnect();
        finish();
        await pending;
        expect(TestSocket.instances).toHaveLength(0);
    });
});
