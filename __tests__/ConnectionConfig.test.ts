// These tests exercise the real Zustand persist middleware, not a mocked store.
import type { useAssistantStore as Store } from '../src/store/useAssistantStore';

jest.mock('@react-native-async-storage/async-storage', () => ({
    __esModule: true,
    default: { getItem: jest.fn(), setItem: jest.fn(), removeItem: jest.fn() },
}));
jest.mock('expo-secure-store', () => ({
    getItemAsync: jest.fn(), setItemAsync: jest.fn(), deleteItemAsync: jest.fn(),
}));

const CHAT = 'lvtian-assistant-storage';
const CONFIG = 'lvtian-connection-config-v1';
const message = { id: 'existing', role: 'assistant', content: 'Saved text', timestamp: 1, seq: 4, status: 'done' };
const legacy = (url = 'https://old.example') => JSON.stringify({
    state: { serverUrl: url, messages: [], currentSeq: 0 }, version: 0,
});
const flush = async () => { for (let i = 0; i < 40; i += 1) await Promise.resolve(); };
const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
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
    storage.getItem.mockImplementation(async (key: string) => data.get(key) ?? null);
    storage.setItem.mockImplementation(async (key: string, value: string) => { data.set(key, value); });
    storage.removeItem.mockImplementation(async (key: string) => { data.delete(key); });
    secure.getItemAsync.mockResolvedValue('saved-token');
    secure.setItemAsync.mockResolvedValue(undefined);
    secure.deleteItemAsync.mockResolvedValue(undefined);
    const start = () => (require('../src/store/useAssistantStore') as { useAssistantStore: typeof Store }).useAssistantStore;
    return { storage, secure, data, start };
}

describe('independent connection configuration', () => {
    it('migrates once, strips URL/token from real chat persistence, and never writes a backup', async () => {
        const { start, data, storage } = setup({ [CHAT]: legacy() });
        const store = start();
        await flush();
        expect(store.getState()).toMatchObject({ serverUrl: 'https://old.example', serverToken: 'saved-token', credentialsStatus: 'ready', hasHydrated: true });
        expect(JSON.parse(data.get(CONFIG)!)).toEqual({ url: 'https://old.example' });
        store.getState().setCurrentSeq(8);
        await flush();
        const chat = JSON.parse(data.get(CHAT)!).state;
        expect(chat).not.toHaveProperty('serverUrl');
        expect(chat).not.toHaveProperty('serverToken');
        expect(storage.setItem.mock.calls.filter(([key]) => key === CONFIG)).toHaveLength(1);
        expect(storage.setItem.mock.calls.some(([key]) => key === 'lvtian-connection-url-v1')).toBe(false);
    });

    it('uses canonical URL despite stale legacy URL and failed chat hydration', async () => {
        const { start, storage } = setup({ [CONFIG]: JSON.stringify({ url: 'https://new.example' }), [CHAT]: legacy() });
        storage.getItem.mockImplementation(async (key: string) => {
            if (key === CHAT) throw new Error('native details including secret');
            return JSON.stringify({ url: 'https://new.example' });
        });
        const store = start();
        await flush();
        expect(store.getState()).toMatchObject({ hasHydrated: true, chatHydrationError: 'chat_hydration_failed', credentialsStatus: 'ready', serverUrl: 'https://new.example' });
    });

    it('initializes credentials even while chat hydration is still pending', async () => {
        const { start, storage } = setup();
        const chat = deferred<string | null>();
        storage.getItem.mockImplementation((key: string) => key === CHAT ? chat.promise : Promise.resolve(JSON.stringify({ url: 'https://new.example' })));
        const store = start();
        await flush();
        expect(store.getState()).toMatchObject({ hasHydrated: false, credentialsStatus: 'ready', serverUrl: 'https://new.example' });
        chat.resolve(legacy());
        await flush();
        expect(store.getState().serverUrl).toBe('https://new.example');
    });

    it('does not overwrite unread legacy during status/hydration updates and retries read failure', async () => {
        const { start, storage, data } = setup({ [CHAT]: legacy() });
        let legacyReads = 0;
        storage.getItem.mockImplementation(async (key: string) => {
            if (key === CHAT && ++legacyReads > 1) throw new Error('read denied');
            return data.get(key) ?? null;
        });
        const store = start();
        await flush();
        expect(store.getState().credentialsError).toBe('connection_legacy_read_failed');
        store.getState().setConnectionState('disconnected');
        await flush();
        expect(data.get(CHAT)).toBe(legacy());
        expect(storage.setItem).not.toHaveBeenCalled();
        storage.getItem.mockImplementation(async (key: string) => data.get(key) ?? null);
        await expect(store.getState().loadSavedCredentials()).resolves.toEqual({ url: 'https://old.example', token: 'saved-token' });
    });

    it('retries an interrupted migration write without erasing its source', async () => {
        const { start, storage, data } = setup({ [CHAT]: legacy() });
        storage.setItem.mockRejectedValue(new Error('disk full'));
        const store = start();
        await flush();
        expect(store.getState().credentialsError).toBe('connection_config_write_failed');
        expect(data.get(CHAT)).toBe(legacy());
        storage.setItem.mockImplementation(async (key: string, value: string) => { data.set(key, value); });
        await store.getState().loadSavedCredentials();
        expect(store.getState().serverUrl).toBe('https://old.example');
    });

    it('resumes after URL migration committed but token read was interrupted', async () => {
        const { start, secure, data, storage } = setup({ [CHAT]: legacy() });
        secure.getItemAsync.mockRejectedValue(new Error('temporarily locked'));
        const store = start();
        await flush();
        expect(data.get(CONFIG)).toBe(JSON.stringify({ url: 'https://old.example' }));
        expect(data.get(CHAT)).toBe(legacy());
        secure.getItemAsync.mockResolvedValue('restored-token');
        storage.getItem.mockClear();
        await store.getState().loadSavedCredentials();
        expect(storage.getItem.mock.calls).toEqual([[CONFIG]]);
        expect(store.getState().serverToken).toBe('restored-token');
    });

    it('rejects token read failure even with nonempty memory and preserves both memory fields', async () => {
        const { start, secure } = setup({ [CONFIG]: JSON.stringify({ url: 'https://saved.example' }) });
        const store = start();
        await flush();
        store.setState({ serverUrl: 'https://memory.example', serverToken: 'keep-token' });
        secure.getItemAsync.mockRejectedValue(new Error('secret details'));
        await expect(store.getState().loadSavedCredentials()).rejects.toMatchObject({ code: 'credentials_read_failed', message: 'credentials_read_failed' });
        expect(store.getState()).toMatchObject({ serverUrl: 'https://memory.example', serverToken: 'keep-token', credentialsStatus: 'error', credentialsError: 'credentials_read_failed' });
    });

    it.each([
        [CONFIG, 'broken', 'connection_config_invalid'],
        [CHAT, 'broken', 'connection_legacy_invalid'],
    ])('does not silently treat corrupt %s as missing', async (key, value, code) => {
        const { start, data } = setup({ [key]: value });
        const store = start();
        await flush();
        expect(store.getState().credentialsError).toBe(code);
        expect(data.get(key)).toBe(value);
        await expect(store.getState().loadSavedCredentials()).rejects.toMatchObject({ code });
    });

    it('does not fall back to legacy on canonical read failure', async () => {
        const { start, storage, data } = setup({ [CHAT]: legacy() });
        storage.getItem.mockImplementation(async (key: string) => {
            if (key === CONFIG) throw new Error('unavailable');
            return data.get(key) ?? null;
        });
        const store = start();
        await flush();
        expect(store.getState().credentialsError).toBe('connection_config_read_failed');
        expect(storage.setItem).not.toHaveBeenCalled();
    });

    it('persists explicit empty configuration without resurrecting legacy', async () => {
        const { start, data } = setup({ [CONFIG]: JSON.stringify({ url: '' }), [CHAT]: legacy() });
        const store = start();
        await flush();
        expect(store.getState().serverUrl).toBe('');
        await store.getState().setServerConfig('', '');
        expect(data.get(CONFIG)).toBe(JSON.stringify({ url: '' }));
    });

    it('save writes URL only once and token only to SecureStore', async () => {
        const { start, storage, secure, data } = setup({ [CONFIG]: JSON.stringify({ url: 'https://old.example' }) });
        const store = start();
        await flush();
        storage.setItem.mockClear();
        await store.getState().setServerConfig(' https://new.example/// ', ' new-token ');
        expect(storage.setItem.mock.calls.filter(([key]) => key === CONFIG)).toEqual([[CONFIG, JSON.stringify({ url: 'https://new.example' })]]);
        expect(secure.setItemAsync).toHaveBeenCalledWith('lvtian_assistant_token', 'new-token');
        expect(data.get(CHAT)).not.toContain('new-token');
        expect(JSON.parse(data.get(CHAT)!).state).not.toHaveProperty('serverUrl');
    });

    it('late real hydration cannot restore the previous identity after a save', async () => {
        const { start, storage } = setup();
        const chat = deferred<string | null>();
        storage.getItem.mockImplementation((key: string) => key === CHAT ? chat.promise : Promise.resolve(JSON.stringify({ url: 'https://old.example' })));
        const store = start();
        await flush();
        await store.getState().setServerConfig('https://new.example', 'new-token');
        chat.resolve(JSON.stringify({ state: { serverUrl: 'https://old.example', serverToken: 'old-token', messages: [{ id: 'old' }], currentSeq: 42 }, version: 0 }));
        await flush();
        expect(store.getState()).toMatchObject({ serverUrl: 'https://new.example', serverToken: 'new-token', messages: [], currentSeq: 0, hasHydrated: true });
        await store.persist.rehydrate();
        await flush();
        expect(store.getState().messages).toEqual([]);
    });

    it('saving unchanged identity does not discard pending chat hydration', async () => {
        const { start, storage } = setup();
        const chat = deferred<string | null>();
        storage.getItem.mockImplementation((key: string) => key === CHAT ? chat.promise : Promise.resolve(JSON.stringify({ url: 'https://old.example' })));
        const store = start();
        await flush();
        await store.getState().setServerConfig('https://old.example', 'saved-token');
        chat.resolve(JSON.stringify({ state: { messages: [message], currentSeq: 4 }, version: 0 }));
        await flush();
        expect(store.getState().messages).toEqual([message]);
    });

    it('serializes a pending initial read and save so stale credentials cannot win', async () => {
        const { start, secure } = setup({ [CONFIG]: JSON.stringify({ url: 'https://old.example' }) });
        const token = deferred<string | null>();
        secure.getItemAsync.mockReturnValueOnce(token.promise);
        const store = start();
        await flush();
        const saving = store.getState().setServerConfig('https://new.example', 'new-token');
        token.resolve('old-token');
        await saving;
        expect(store.getState()).toMatchObject({ serverUrl: 'https://new.example', serverToken: 'new-token', credentialsStatus: 'ready' });
    });

    it('corrupt chat JSON does not prevent canonical credentials loading', async () => {
        const { start } = setup({ [CONFIG]: JSON.stringify({ url: 'https://saved.example' }), [CHAT]: '{broken' });
        const store = start();
        await flush();
        expect(store.getState()).toMatchObject({ credentialsStatus: 'ready', serverUrl: 'https://saved.example', hasHydrated: true, chatHydrationError: 'chat_hydration_failed' });
    });

    it.each(['corrupt', 'read-failure'])('clears %s cache and permits rebuilding', async (failure) => {
        const raw = failure === 'corrupt' ? '{broken' : legacy();
        const { start, data, storage } = setup({ [CONFIG]: JSON.stringify({ url: 'https://saved.example' }), [CHAT]: raw });
        if (failure === 'read-failure') {
            storage.getItem.mockImplementation(async (key: string) => {
                if (key === CHAT) throw new Error('unreadable');
                return data.get(key) ?? null;
            });
        }
        const store = start();
        await flush();
        expect(storage.removeItem).toHaveBeenCalledWith(CHAT);
        expect(store.getState()).toMatchObject({ credentialsStatus: 'ready', hasHydrated: true, chatHydrationError: 'chat_hydration_failed' });
        expect(data.get(CHAT)).not.toBe(raw);
        store.getState().setMessages([{ ...message, role: 'assistant', status: 'done' }]);
        await flush();
        expect(JSON.parse(data.get(CHAT)!).state.messages).toEqual([message]);
    });

    it('does not block connection when cache removal fails', async () => {
        const { start, storage } = setup({ [CONFIG]: JSON.stringify({ url: 'https://saved.example' }), [CHAT]: '{broken' });
        storage.removeItem.mockRejectedValue(new Error('unavailable'));
        const store = start();
        await flush();
        expect(store.getState()).toMatchObject({ hasHydrated: true, credentialsStatus: 'ready', chatHydrationError: 'chat_hydration_failed', chatCacheError: 'chat_cache_write_failed' });
    });

    it('bounds cached message size and requests a fresh server snapshot when trimming', async () => {
        const { start, data } = setup({ [CONFIG]: JSON.stringify({ url: 'https://saved.example' }) });
        const store = start();
        await flush();
        store.getState().setMessages([
            { ...message, role: 'assistant', status: 'done', id: 'large', content: 'x'.repeat(140000), seq: 1 },
            { ...message, role: 'assistant', status: 'done', id: 'recent', seq: 2 },
        ]);
        await flush();
        const cache = JSON.parse(data.get(CHAT)!).state;
        expect(cache.messages.map((item: { id: string }) => item.id)).toEqual(['recent']);
        expect(cache.currentSeq).toBe(0);
        expect(data.get(CHAT)!.length).toBeLessThan(128 * 1024);
    });

    it.each([
        { messages: 'bad' },
        { messages: [null] },
        { messages: [{ ...message, content: {} }] },
        { messages: [{ ...message, role: 'invalid' }] },
        { messages: [{ ...message, attachments: {} }] },
        { pendingSendQueue: {} },
        { pendingSendQueue: [null] },
        { pendingCancelQueue: [5] },
        { agentModelOptions: {} },
        { agentModelSelection: { model: 'missing-provider' } },
        { currentSeq: -1 },
        { clearedSeq: '5' },
        { permissionMode: 'invalid' },
    ])('rejects malformed chat shape without poisoning memory: %j', async (state) => {
        const raw = JSON.stringify({ state, version: 0 });
        const { start, data, storage } = setup({ [CONFIG]: JSON.stringify({ url: 'https://saved.example' }), [CHAT]: raw });
        const store = start();
        await flush();
        expect(store.getState()).toMatchObject({
            credentialsStatus: 'ready', serverUrl: 'https://saved.example', hasHydrated: true,
            chatHydrationError: 'chat_hydration_failed', messages: [], pendingSendQueue: [], currentSeq: 0,
        });
        store.getState().setCurrentSeq(5);
        await flush();
        expect(storage.removeItem).toHaveBeenCalledWith(CHAT);
        expect(data.get(CHAT)).not.toBe(raw);
    });

    it.each([CONFIG, CHAT])('explicit save replaces corrupt %s without depending on migration', async (key) => {
        const { start, data } = setup({ [key]: '{broken', [CHAT]: '{broken' });
        const store = start();
        await flush();
        expect(store.getState().credentialsStatus).toBe('error');
        await store.getState().setServerConfig('https://replacement.example', 'replacement-token');
        expect(store.getState()).toMatchObject({ serverUrl: 'https://replacement.example', serverToken: 'replacement-token', credentialsStatus: 'ready', messages: [] });
        expect(data.get(CONFIG)).toBe(JSON.stringify({ url: 'https://replacement.example' }));
        expect(data.get(CHAT)).not.toBe('{broken');
    });

    it('explicit save succeeds when automatic legacy reads fail', async () => {
        const { start, data, storage } = setup({ [CHAT]: legacy() });
        storage.getItem.mockImplementation(async (key: string) => {
            if (key === CHAT) throw new Error('legacy unavailable');
            return data.get(key) ?? null;
        });
        const store = start();
        await flush();
        expect(store.getState().credentialsStatus).toBe('error');
        await store.getState().setServerConfig('https://replacement.example', 'replacement-token');
        expect(store.getState().credentialsStatus).toBe('ready');
        expect(data.get(CHAT)).not.toBe(legacy());
        expect(data.get(CONFIG)).toBe(JSON.stringify({ url: 'https://replacement.example' }));
    });

    it('explicit save can retry after automatic migration write failure', async () => {
        const { start, data, storage } = setup({ [CHAT]: legacy() });
        storage.setItem.mockRejectedValueOnce(new Error('migration write interrupted'));
        const store = start();
        await flush();
        expect(store.getState().credentialsError).toBe('connection_config_write_failed');
        await store.getState().setServerConfig('https://replacement.example', 'replacement-token');
        expect(store.getState()).toMatchObject({ serverUrl: 'https://replacement.example', credentialsStatus: 'ready' });
        expect(data.get(CONFIG)).toBe(JSON.stringify({ url: 'https://replacement.example' }));
    });

    it('rejects a failed token save without changing URL or memory', async () => {
        const { start, secure, data } = setup({ [CONFIG]: JSON.stringify({ url: 'https://old.example' }) });
        const store = start();
        await flush();
        secure.setItemAsync.mockRejectedValue(new Error('private native details'));
        await expect(store.getState().setServerConfig('https://new.example', 'new-token')).rejects.toMatchObject({ code: 'credentials_write_failed' });
        expect(store.getState()).toMatchObject({ serverUrl: 'https://old.example', serverToken: 'saved-token', credentialsStatus: 'error' });
        expect(data.get(CONFIG)).toBe(JSON.stringify({ url: 'https://old.example' }));
    });

    it('rolls token back if URL save fails and preserves memory', async () => {
        const { start, storage, secure } = setup({ [CONFIG]: JSON.stringify({ url: 'https://old.example' }) });
        const store = start();
        await flush();
        storage.setItem.mockImplementation(async (key: string) => {
            if (key === CONFIG) throw new Error('disk full');
        });
        await expect(store.getState().setServerConfig('https://new.example', 'new-token')).rejects.toMatchObject({ code: 'connection_config_write_failed' });
        expect(secure.setItemAsync.mock.calls).toEqual([
            ['lvtian_assistant_token', 'new-token'], ['lvtian_assistant_token', 'saved-token'],
        ]);
        expect(store.getState()).toMatchObject({ serverUrl: 'https://old.example', serverToken: 'saved-token' });
    });

    it('reports rollback failure without leaking native details', async () => {
        const { start, storage, secure } = setup({ [CONFIG]: JSON.stringify({ url: 'https://old.example' }) });
        const store = start();
        await flush();
        storage.setItem.mockRejectedValue(new Error('native details'));
        secure.setItemAsync.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('token details'));
        await expect(store.getState().setServerConfig('https://new.example', 'new-token')).rejects.toMatchObject({ code: 'credentials_rollback_failed', message: 'credentials_rollback_failed' });
    });

    it('surfaces chat write failure separately without rejecting successful credentials or looping', async () => {
        const { start, storage } = setup({ [CONFIG]: JSON.stringify({ url: 'https://old.example' }) });
        const store = start();
        await flush();
        storage.setItem.mockRejectedValue(new Error('write denied'));
        store.getState().setCurrentSeq(3);
        await flush();
        expect(store.getState()).toMatchObject({ credentialsStatus: 'ready', credentialsError: null, chatCacheError: 'chat_cache_write_failed' });
        expect(storage.setItem.mock.calls.length).toBeLessThan(5);
    });
});
