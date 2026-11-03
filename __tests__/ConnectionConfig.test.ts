import type { useAssistantStore as Store } from '../src/store/useAssistantStore';

jest.mock('@react-native-async-storage/async-storage', () => ({
    __esModule: true, default: { getItem: jest.fn(), setItem: jest.fn(), removeItem: jest.fn() },
}));
jest.mock('expo-secure-store', () => ({
    getItemAsync: jest.fn(), setItemAsync: jest.fn(), deleteItemAsync: jest.fn(),
}));

const CONFIG = 'lvtian-connection-config-v1';
const CACHE = 'lvtian-chat-cache-v2';
const URL = 'https://saved.example';
const TOKEN = 'saved-token';
const message = { id: 'saved', role: 'assistant', content: 'Saved', timestamp: 1, seq: 1, status: 'done' };
const item = { sessionId: 'main', messageId: 'pending', content: 'Waiting' };
const flush = async () => { for (let i = 0; i < 80; i += 1) await Promise.resolve(); };
const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
};

function setup(entries: Record<string, string> = {}) {
    jest.resetModules();
    const storage = (require('@react-native-async-storage/async-storage') as {
        default: { getItem: jest.Mock; setItem: jest.Mock; removeItem: jest.Mock };
    }).default;
    const secure = require('expo-secure-store') as {
        getItemAsync: jest.Mock; setItemAsync: jest.Mock; deleteItemAsync: jest.Mock;
    };
    const data = new Map(Object.entries(entries));
    storage.getItem.mockReset().mockImplementation(async (key: string) => data.get(key) ?? null);
    storage.setItem.mockReset().mockImplementation(async (key: string, value: string) => { data.set(key, value); });
    storage.removeItem.mockReset().mockImplementation(async (key: string) => { data.delete(key); });
    secure.getItemAsync.mockReset().mockResolvedValue(TOKEN);
    secure.setItemAsync.mockReset().mockResolvedValue(undefined);
    secure.deleteItemAsync.mockReset().mockResolvedValue(undefined);
    const { outboxKey } = require('../src/services/chatOutbox') as typeof import('../src/services/chatOutbox');
    const key = outboxKey(URL, TOKEN);
    const start = () => (require('../src/store/useAssistantStore') as { useAssistantStore: typeof Store }).useAssistantStore;
    return { storage, secure, data, key, start };
}

const config = JSON.stringify({ url: URL });
const queued = JSON.stringify({ pendingSendQueue: [item], pendingCancelQueue: [] });

describe('independent credentials, disposable chat cache, and durable outbox', () => {
    it('does not migrate legacy chat or outbox records', async () => {
        const { start, storage, data } = setup({ 'lvtian-assistant-storage': '{old' });
        const store = start();
        await flush();
        expect(store.getState()).toMatchObject({ credentialsStatus: 'ready', serverUrl: '' });
        expect(storage.getItem).not.toHaveBeenCalledWith('lvtian-assistant-storage');
        expect(data.has('lvtian-assistant-storage')).toBe(false);
    });

    it('loads credentials even if the chat cache read never completes', async () => {
        const { start, storage } = setup({ [CONFIG]: config });
        const cache = deferred<string | null>();
        storage.getItem.mockImplementation((key: string) => key === CACHE ? cache.promise : Promise.resolve(null));
        storage.getItem.mockImplementation((key: string) => key === CACHE ? cache.promise : Promise.resolve(key === CONFIG ? config : null));
        const store = start();
        await flush();
        expect(store.getState()).toMatchObject({ credentialsStatus: 'ready', serverUrl: URL, outboxStatus: 'ready' });
        expect(store.persist.hasHydrated()).toBe(false);
    });

    it('ignores a cache that arrives after the server snapshot', async () => {
        const { start, storage, key } = setup({ [CONFIG]: config });
        const cache = deferred<string | null>();
        storage.getItem.mockImplementation((name: string) => name === CACHE ? cache.promise : Promise.resolve(name === CONFIG ? config : null));
        const store = start();
        await flush();
        store.getState().markChatAuthoritative();
        store.getState().setMessages([{ ...message, id: 'server', role: 'assistant', status: 'done' }]);
        cache.resolve(JSON.stringify({ state: { identity: key, messages: [message] }, version: 0 }));
        await flush();
        expect(store.getState().messages.map(m => m.id)).toEqual(['server']);
    });

    it('limits cached chat size and does not store connection or outbox fields', async () => {
        const { start, data } = setup({ [CONFIG]: config });
        const store = start();
        await flush();
        store.getState().setMessages([
            { ...message, role: 'assistant', status: 'done', id: 'large', content: 'x'.repeat(140000) },
            { ...message, role: 'assistant', status: 'done', id: 'recent' },
        ]);
        await flush();
        const raw = data.get(CACHE)!;
        const cached = JSON.parse(raw).state;
        expect(cached.messages.map((entry: { id: string }) => entry.id)).toEqual(['recent']);
        expect(cached).not.toHaveProperty('pendingSendQueue');
        expect(cached).not.toHaveProperty('serverToken');
        expect(cached).not.toHaveProperty('currentSeq');
        expect(raw.length).toBeLessThan(128 * 1024);
    });

    it('discards corrupt chat cache independently of the saved outbox', async () => {
        const { start, data, storage, key } = setup({ [CONFIG]: config, [CACHE]: '{bad' });
        data.set(key, queued);
        const store = start();
        await flush();
        expect(storage.removeItem).toHaveBeenCalledWith(CACHE);
        expect(storage.removeItem).not.toHaveBeenCalledWith(key);
        expect(store.getState()).toMatchObject({ credentialsStatus: 'ready', outboxStatus: 'ready', pendingSendQueue: [item] });
        expect(store.getState().messages.some(m => m.id === item.messageId)).toBe(true);
    });

    it('merges newly queued messages with a slow independent outbox read', async () => {
        const { start, data, storage, key } = setup({ [CONFIG]: config });
        const pendingRead = deferred<string | null>();
        storage.getItem.mockImplementation((name: string) => name === key ? pendingRead.promise : Promise.resolve(data.get(name) ?? null));
        const store = start();
        await flush();
        store.getState().addToPendingSendQueue({ ...item, messageId: 'new' });
        expect(storage.setItem.mock.calls.some(([name]) => name === key)).toBe(false);
        pendingRead.resolve(queued);
        await flush();
        expect(store.getState().pendingSendQueue.map(m => m.messageId)).toEqual(['pending', 'new']);
        expect(JSON.parse(data.get(key)!).pendingSendQueue).toHaveLength(2);
    });

    it('discards an unreadable outbox without blocking credentials', async () => {
        const { start, data, storage, key } = setup({ [CONFIG]: config });
        data.set(key, '{bad');
        const store = start();
        await flush();
        expect(store.getState()).toMatchObject({ credentialsStatus: 'ready', outboxStatus: 'ready', pendingSendQueue: [] });
        expect(JSON.parse(data.get(key)!)).toEqual({ pendingSendQueue: [], pendingCancelQueue: [] });
        expect(storage.removeItem).not.toHaveBeenCalledWith(key);
    });

    it('abandons an outbox read that never finishes and saves new messages', async () => {
        jest.useFakeTimers();
        try {
            const { start, data, storage, key } = setup({ [CONFIG]: config });
            const pendingRead = deferred<string | null>();
            storage.getItem.mockImplementation((name: string) => name === key ? pendingRead.promise : Promise.resolve(data.get(name) ?? null));
            const store = start();
            await flush();
            store.getState().addToPendingSendQueue(item);
            jest.advanceTimersByTime(3000);
            await flush();
            expect(store.getState()).toMatchObject({ credentialsStatus: 'ready', outboxStatus: 'ready', pendingSendQueue: [item] });
            expect(JSON.parse(data.get(key)!).pendingSendQueue).toEqual([item]);
            pendingRead.resolve(JSON.stringify({ pendingSendQueue: [{ ...item, messageId: 'late-old' }], pendingCancelQueue: [] }));
            await flush();
            expect(store.getState().pendingSendQueue).toEqual([item]);
        } finally { jest.useRealTimers(); }
    });

    it('removes a confirmed message from the separately stored queue', async () => {
        const { start, data, key } = setup({ [CONFIG]: config });
        data.set(key, queued);
        const store = start();
        await flush();
        store.getState().removeFromPendingSendQueue(item.messageId);
        await flush();
        expect(JSON.parse(data.get(key)!).pendingSendQueue).toEqual([]);
    });

    it('stores the outbox separately from chat and omits attachment payloads', async () => {
        const { start, data, key } = setup({ [CONFIG]: config });
        const store = start();
        await flush();
        store.getState().addToPendingSendQueue({ ...item, attachments: [{
            type: 'image', name: 'photo.jpg', uri: 'file:///photo.jpg', data: 'large-data',
        }] });
        await flush();
        const saved = JSON.parse(data.get(key)!).pendingSendQueue[0];
        expect(saved.attachments[0]).toEqual({ type: 'image', name: 'photo.jpg', uri: 'file:///photo.jpg' });
        expect(key).not.toContain(TOKEN);
        expect(data.get(key)).not.toContain(TOKEN);
        expect(JSON.parse(data.get(CACHE)!).state).not.toHaveProperty('pendingSendQueue');
    });

    it('keeps the in-memory message available when outbox writes fail', async () => {
        const { start, data, storage, key } = setup({ [CONFIG]: config });
        const store = start();
        await flush();
        storage.setItem.mockImplementation(async (name: string, value: string) => {
            if (name === key) throw new Error('write failed');
            data.set(name, value);
        });
        store.getState().addToPendingSendQueue(item);
        await flush();
        expect(store.getState()).toMatchObject({ outboxStatus: 'ready', pendingSendQueue: [item], credentialsStatus: 'ready' });
        storage.setItem.mockImplementation(async (name: string, value: string) => { data.set(name, value); });
        store.getState().addToPendingSendQueue({ ...item, messageId: 'next' });
        await flush();
        expect(store.getState().outboxStatus).toBe('ready');
        expect(JSON.parse(data.get(key)!).pendingSendQueue.map((entry: { messageId: string }) => entry.messageId)).toEqual(['pending', 'next']);
    });

    it('does not restore pending messages already present in a newer server snapshot', async () => {
        const { start, data, storage, key } = setup({ [CONFIG]: config });
        const pendingRead = deferred<string | null>();
        storage.getItem.mockImplementation((name: string) => name === key ? pendingRead.promise : Promise.resolve(data.get(name) ?? null));
        const store = start();
        await flush();
        store.getState().markChatAuthoritative();
        store.getState().setMessages([{ ...message, id: item.messageId, role: 'user', status: 'sent' }]);
        pendingRead.resolve(queued);
        await flush();
        expect(store.getState().pendingSendQueue).toEqual([]);
        expect(store.getState().messages).toHaveLength(1);
    });

    it('does not restore another server identity’s queue', async () => {
        const { start, data, key } = setup({ [CONFIG]: config });
        data.set(key, queued);
        const store = start();
        await flush();
        await store.getState().setServerConfig('https://another.example', 'another-token');
        await flush();
        expect(store.getState().pendingSendQueue).toEqual([]);
        expect(data.get(key)).toBe(queued);
    });

    it('ignores a late queue read after switching servers', async () => {
        const { start, data, storage, key } = setup({ [CONFIG]: config });
        const oldRead = deferred<string | null>();
        storage.getItem.mockImplementation((name: string) => name === key ? oldRead.promise : Promise.resolve(data.get(name) ?? null));
        const store = start();
        await flush();
        await store.getState().setServerConfig('https://another.example', 'another-token');
        await flush();
        oldRead.resolve(queued);
        await flush();
        expect(store.getState()).toMatchObject({ serverUrl: 'https://another.example', pendingSendQueue: [] });
    });

    it('does not accept malformed connection configuration', async () => {
        const { start } = setup({ [CONFIG]: '{broken' });
        const store = start();
        await flush();
        expect(store.getState().credentialsError).toBe('connection_config_invalid');
    });

    it('preserves in-memory credentials when secure storage cannot be read', async () => {
        const { start, secure } = setup({ [CONFIG]: config });
        const store = start();
        await flush();
        store.setState({ serverUrl: 'https://memory.example', serverToken: 'memory-token' });
        secure.getItemAsync.mockRejectedValue(new Error('unavailable'));
        await expect(store.getState().loadSavedCredentials()).rejects.toMatchObject({ code: 'credentials_read_failed' });
        expect(store.getState()).toMatchObject({ serverUrl: 'https://memory.example', serverToken: 'memory-token' });
    });

    it('serializes a pending credential read and an explicit save', async () => {
        const { start, secure } = setup({ [CONFIG]: config });
        const token = deferred<string | null>();
        secure.getItemAsync.mockReturnValueOnce(token.promise);
        const store = start();
        await flush();
        const saving = store.getState().setServerConfig('https://new.example', 'new-token');
        token.resolve(TOKEN);
        await saving;
        expect(store.getState()).toMatchObject({ serverUrl: 'https://new.example', serverToken: 'new-token', credentialsStatus: 'ready' });
    });

    it('rolls token back if saving the connection URL fails', async () => {
        const { start, storage, secure } = setup({ [CONFIG]: config });
        const store = start();
        await flush();
        storage.setItem.mockImplementation(async (key: string) => {
            if (key === CONFIG) throw new Error('disk full');
        });
        await expect(store.getState().setServerConfig('https://new.example', 'new-token')).rejects.toMatchObject({ code: 'connection_config_write_failed' });
        expect(secure.setItemAsync.mock.calls).toEqual([
            ['lvtian_assistant_token', 'new-token'], ['lvtian_assistant_token', TOKEN],
        ]);
    });

    it('reports a failure to roll back the access token', async () => {
        const { start, storage, secure } = setup({ [CONFIG]: config });
        const store = start();
        await flush();
        storage.setItem.mockImplementation(async (key: string) => { if (key === CONFIG) throw new Error('write failed'); });
        secure.setItemAsync.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('rollback failed'));
        await expect(store.getState().setServerConfig('https://new.example', 'new-token')).rejects.toMatchObject({ code: 'credentials_rollback_failed' });
    });
});
