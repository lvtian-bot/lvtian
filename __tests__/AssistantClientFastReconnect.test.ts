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
            messages: [], pendingSendQueue: [], pendingCancelQueue: [], currentSeq: 0, clearedSeq: 0, chatSyncCursor: undefined, chatHistoryBefore: undefined,
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

    it('resumes chat by the last applied sync after reconnecting', async () => {
        const ws = await ready();
        const firstReply = { id: 'first', role: 'assistant' as const, status: 'done' as const,
            content: 'old reply', timestamp: 1, seq: 10 };
        ws.receive({ ...sync, replaceCache: true, syncEpoch: 'epoch', currentSeq: 10, messages: [firstReply] });
        await client.connect(true);

        const next = TestSocket.instances[1];
        next.open();
        expect(next.send).toHaveBeenCalledWith(JSON.stringify({
            type: 'sync', sessionId: 'main', lastSeq: 0, cursor: { epoch: 'epoch', seq: 10 }, historyVersion: 1,
        }));
        next.receive({ ...sync, replaceCache: false, syncEpoch: 'epoch', currentSeq: 12,
            messages: [{ ...firstReply, id: 'second', content: 'new reply', timestamp: 2, seq: 12 }] });
        expect(useAssistantStore.getState().messages.map(m => m.content)).toEqual(['old reply', 'new reply']);
    });

    it('prefetches a completed reply in the background and keeps it through the next reconnect', async () => {
        const ws = await ready();
        ws.receive({ ...sync, replaceCache: true, syncEpoch: 'epoch', currentSeq: 10 });
        appChange('background');
        const reply = { id: 'finished', role: 'assistant' as const, status: 'done' as const,
            content: 'result from the server', timestamp: 2, seq: 11 };
        const fetch = jest.spyOn(global, 'fetch').mockResolvedValue({
            ok: true, json: async () => ({ ...sync, replaceCache: false, syncEpoch: 'epoch', currentSeq: 12, messages: [reply] }),
        } as Response);

        await expect(client.syncInBackground()).resolves.toBe(true);
        expect(fetch).toHaveBeenCalledWith('https://server.test/api/chat/sync?clearedSeq=0&historyVersion=1&epoch=epoch&seq=10',
            expect.objectContaining({ headers: { Authorization: 'Bearer private-token' } }));
        expect(useAssistantStore.getState().messages).toEqual([reply]);
        expect(ws.close).toHaveBeenCalledTimes(1);

        appChange('active');
        await Promise.resolve();
        const next = TestSocket.instances[1];
        next.open();
        expect(next.send).toHaveBeenCalledWith(JSON.stringify({
            type: 'sync', sessionId: 'main', lastSeq: 0, cursor: { epoch: 'epoch', seq: 12 }, historyVersion: 1,
        }));
        next.receive({ ...sync, replaceCache: false, syncEpoch: 'epoch', currentSeq: 12 });
        expect(useAssistantStore.getState().messages).toEqual([reply]);
    });

    it('correlates the authenticated sync with server logs without logging chat data', async () => {
        await client.connect();
        const ws = TestSocket.instances[0];
        ws.open();
        const trace = '00000000-0000-4000-8000-000000000001';
        ws.receive({ type: 'auth_result', success: true, connectionTrace: trace });
        ws.receive({ ...sync, messages: [{
            id: 'reply', role: 'assistant', status: 'done', content: 'private-body', timestamp: 1, seq: 1,
        }] });

        for (const event of ['authenticated', 'sync_frame_arrived', 'sync_received', 'sync_applied']) {
            expect(console.info).toHaveBeenCalledWith('[AssistantClient:connection]', expect.stringMatching(
                new RegExp(`"connectionTrace":"${trace}".*"event":"${event}"`),
            ));
        }
        expect(JSON.stringify(jest.mocked(console.info).mock.calls)).not.toMatch(/private-body|private-token/);
    });

    it('prepends history without rewinding live synchronization and coalesces repeated pulls', async () => {
        const ws = await ready();
        const newest = { id: 'new', role: 'assistant' as const, status: 'done' as const, content: 'new', timestamp: 12, seq: 12 };
        const older = { ...newest, id: 'old', timestamp: 2, seq: 2, content: 'old' };
        ws.receive({ ...sync, messages: [newest], replaceCache: true, syncEpoch: 'epoch', currentSeq: 12,
            historyBefore: { epoch: 'epoch', order: 3, timestamp: newest.timestamp } });
        let finish!: (response: Response) => void;
        const fetch = jest.spyOn(global, 'fetch').mockReturnValue(new Promise(resolve => { finish = resolve; }));

        const request = client.loadEarlierChat();
        expect(client.loadEarlierChat()).toBe(request);
        ws.receive({ type: 'event_chunk', sessionId: 'main', seq: 13, messageId: newest.id, status: 'running_tool' });
        ws.receive({ type: 'message_deleted', sessionId: 'main', messageId: 'deleted' });
        finish({ ok: true, json: async () => ({
            messages: [older, newest, { ...older, id: 'deleted', seq: 4 }], historyBefore: null,
        }) } as Response);
        await expect(request).resolves.toBe(1);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(useAssistantStore.getState().messages).toEqual([older, newest]);
        expect(useAssistantStore.getState().currentSeq).toBe(13);
        expect(useAssistantStore.getState().chatSyncCursor).toEqual({ epoch: 'epoch', seq: 12 });
        expect(useAssistantStore.getState().chatHistoryBefore).toBeNull();
    });

    it('discards a background response if the foreground socket already moved the chat forward', async () => {
        const ws = await ready();
        ws.receive({ ...sync, replaceCache: true, syncEpoch: 'epoch', currentSeq: 10 });
        appChange('background');
        let finish!: (response: Response) => void;
        const request = new Promise<Response>(resolve => { finish = resolve; });
        const fetch = jest.spyOn(global, 'fetch').mockReturnValue(request);
        const pulling = client.syncInBackground();
        await jest.advanceTimersByTimeAsync(0);
        expect(fetch).toHaveBeenCalledTimes(1);

        appChange('active');
        ws.receive({ ...sync, syncEpoch: 'epoch', replaceCache: false, currentSeq: 13 });
        finish({ ok: true, json: async () => ({
            ...sync, syncEpoch: 'epoch', replaceCache: false, currentSeq: 12,
        }) } as Response);
        await expect(pulling).resolves.toBe(false);
        expect(useAssistantStore.getState().chatSyncCursor?.seq).toBe(13);
        expect(ws.close).not.toHaveBeenCalled();
    });

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

    it.each(['handshake', 'authentication', 'sync'] as const)(
        'preserves an in-progress %s on the same network up to its original deadline', async phase => {
            await client.connect();
            const ws = TestSocket.instances[0];
            if (phase !== 'handshake') ws.open();
            if (phase === 'sync') ws.receive({ type: 'auth_result', success: true });
            const deadline = phase === 'sync' ? 20000 : 8000;
            appChange('background');
            jest.advanceTimersByTime(deadline - 500);
            appChange('active');
            jest.advanceTimersByTime(499);
            expect(ws.close).not.toHaveBeenCalled();
            jest.advanceTimersByTime(1);
            expect(ws.close).toHaveBeenCalledTimes(1);
            jest.advanceTimersByTime(50);
            expect(TestSocket.instances).toHaveLength(2);
        }
    );

    it('replaces an expired handshake when background timers were suspended', async () => {
        await client.connect();
        appChange('background');
        jest.setSystemTime(Date.now() + 9000);
        appChange('active');
        await Promise.resolve();
        expect(TestSocket.instances[0].close).toHaveBeenCalledTimes(1);
        expect(TestSocket.instances).toHaveLength(2);
    });

    it('continues chatting immediately when the old socket received data recently', async () => {
        const ws = await ready();
        appChange('background');
        jest.advanceTimersByTime(5000);
        ws.send.mockClear();
        appChange('active');
        expect(ws.send).not.toHaveBeenCalled();
        const id = client.sendMessage('after resume');
        ws.receive({ type: 'message_ack', messageId: id, seq: 1, status: 'sent', role: 'user' });
        jest.advanceTimersByTime(3500);
        expect(useAssistantStore.getState().pendingSendQueue).toEqual([]);
        expect(TestSocket.instances).toHaveLength(1);
        expect(ws.close).not.toHaveBeenCalled();
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

    it.each([true, false])('coalesces a real interface switch and a foreground return (network first %s)', async networkFirst => {
        const ws = await ready();
        ws.send.mockClear();
        appChange('background');
        jest.setSystemTime(Date.now() + 30_000);
        if (networkFirst) networkChange(cellular);
        appChange('active');
        if (!networkFirst) networkChange(cellular);
        await Promise.resolve();
        expect(ws.close).toHaveBeenCalledTimes(1);
        expect(ws.send).not.toHaveBeenCalled();
        expect(TestSocket.instances).toHaveLength(2);
        jest.advanceTimersByTime(250);
        expect(TestSocket.instances).toHaveLength(2);
    });

    it('replaces an in-progress attempt when the network interface is known to have changed', async () => {
        await client.connect();
        const ws = TestSocket.instances[0];
        networkChange(cellular);
        expect(ws.close).toHaveBeenCalledTimes(1);
        jest.advanceTimersByTime(250);
        expect(TestSocket.instances).toHaveLength(2);
    });

    it('keeps the last known interface across an unknown network report', async () => {
        const ws = await ready();
        networkChange({ ...wifi, type: 'UNKNOWN' as Network.NetworkStateType });
        expect(ws.close).not.toHaveBeenCalled();
        networkChange(cellular);
        expect(ws.close).toHaveBeenCalledTimes(1);
        jest.advanceTimersByTime(250);
        expect(TestSocket.instances).toHaveLength(2);
    });

    it('reconnects after a network switch and replays unacknowledged chat', async () => {
        const ws = await ready();
        const id = client.sendMessage('pending');
        await Promise.resolve();
        expect(ws.send).toHaveBeenCalledWith(JSON.stringify({
            type: 'chat', sessionId: 'main', messageId: id, content: 'pending',
        }));
        networkChange(cellular);
        expect(ws.close).toHaveBeenCalledTimes(1);
        jest.advanceTimersByTime(250);
        expect(TestSocket.instances).toHaveLength(2);
        const replacement = TestSocket.instances[1];
        replacement.open();
        replacement.receive({ type: 'auth_result', success: true });
        replacement.receive(sync);
        expect(replacement.send).toHaveBeenCalledWith(JSON.stringify({
            type: 'chat', sessionId: 'main', messageId: id, content: 'pending',
        }));
        replacement.receive({ type: 'message_ack', messageId: id, seq: 1, status: 'sent', role: 'user' });
        expect(useAssistantStore.getState().pendingSendQueue).toEqual([]);
    });

    it('recovers when sending the foreground probe fails synchronously', async () => {
        const ws = await ready();
        ws.send.mockImplementationOnce(() => { throw new Error('socket closed'); });
        appChange('background');
        jest.setSystemTime(Date.now() + 15_000);
        appChange('active');
        expect(ws.close).toHaveBeenCalledTimes(1);
        jest.advanceTimersByTime(50);
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
        expect(useAssistantStore.getState().connectionPhase).toBe('handshake');
        TestSocket.instances[0].open();
        expect(useAssistantStore.getState().connectionPhase).toBe('authentication');
        TestSocket.instances[0].receive({ type: 'auth_result', success: false, error: 'invalid' });
        appChange('background');
        jest.advanceTimersByTime(5000);
        appChange('active');
        networkChange(offline);
        expect(useAssistantStore.getState().isNetworkOffline).toBe(true);
        networkChange(wifi);
        expect(useAssistantStore.getState().isNetworkOffline).toBe(false);
        jest.advanceTimersByTime(60000);
        expect(TestSocket.instances).toHaveLength(1);
        expect(useAssistantStore.getState().connectionState).toBe('error');
        expect(useAssistantStore.getState().connectionErrorKind).toBe('auth');
        expect(useAssistantStore.getState().connectionPhase).toBeNull();
        await client.connect();
        expect(TestSocket.instances).toHaveLength(2);
    });

    it.each([15_000, 29_999])('uses a short probe after %i ms without incoming data and accepts a chat receipt', async age => {
        const ws = await ready();
        appChange('background');
        jest.setSystemTime(Date.now() + age);
        appChange('active');
        expect(ws.send).toHaveBeenLastCalledWith(JSON.stringify({ type: 'ping' }));
        expect(useAssistantStore.getState().connectionState).toBe('connected');
        const id = client.sendMessage('after resume');
        ws.receive({ type: 'message_ack', messageId: id, seq: 1, status: 'sent', role: 'user' });
        jest.advanceTimersByTime(1500);
        expect(ws.close).not.toHaveBeenCalled();
        expect(TestSocket.instances).toHaveLength(1);
    });

    it('immediately replaces the old socket after 30 seconds in the background', async () => {
        const ws = await ready();
        ws.send.mockClear();
        appChange('background');
        jest.setSystemTime(Date.now() + 30_000);
        ws.receive({ type: 'pong' });
        appChange('active');
        await Promise.resolve();
        expect(ws.send).not.toHaveBeenCalled();
        expect(ws.close).toHaveBeenCalledTimes(1);
        expect(TestSocket.instances).toHaveLength(2);
    });

    it('immediately replaces an open socket after 30 seconds without incoming data', async () => {
        const ws = await ready();
        ws.send.mockClear();
        jest.setSystemTime(Date.now() + 29_999);
        appChange('background');
        jest.setSystemTime(Date.now() + 1);
        appChange('active');
        await Promise.resolve();
        expect(ws.send).not.toHaveBeenCalled();
        expect(ws.close).toHaveBeenCalledTimes(1);
        expect(TestSocket.instances).toHaveLength(2);
    });

    it('does not wait for an expired heartbeat timer after Android resumes', async () => {
        const ws = await ready();
        appChange('background');
        jest.advanceTimersByTime(10_000);
        jest.setSystemTime(Date.now() + 3500);
        appChange('active');
        await Promise.resolve();
        expect(ws.close).toHaveBeenCalledTimes(1);
        expect(TestSocket.instances).toHaveLength(2);
    });

    it.each([[0, 1500], [2500, 1000]])(
        'caps an outstanding heartbeat after %i ms at %i additional ms on foreground return', async (elapsed, remaining) => {
            const ws = await ready();
            ws.send.mockClear();
            appChange('background');
            jest.setSystemTime(Date.now() + 6000);
            jest.advanceTimersByTime(10_000 + elapsed);
            appChange('active');
            jest.advanceTimersByTime(remaining - 1);
            client.handleAppForeground();
            expect(ws.close).not.toHaveBeenCalled();
            expect(ws.send.mock.calls).toEqual([[JSON.stringify({ type: 'ping' })]]);
            jest.advanceTimersByTime(1);
            expect(ws.close).toHaveBeenCalledTimes(1);
            jest.advanceTimersByTime(50);
            expect(TestSocket.instances).toHaveLength(2);
        }
    );

    it('does not extend a new foreground probe on repeated foreground events', async () => {
        const ws = await ready();
        ws.send.mockClear();
        jest.setSystemTime(Date.now() + 15_000);
        client.handleAppForeground();
        jest.advanceTimersByTime(1000);
        client.handleAppForeground();
        jest.advanceTimersByTime(499);
        expect(ws.close).not.toHaveBeenCalled();
        expect(ws.send.mock.calls).toEqual([[JSON.stringify({ type: 'ping' })]]);
        jest.advanceTimersByTime(1);
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
