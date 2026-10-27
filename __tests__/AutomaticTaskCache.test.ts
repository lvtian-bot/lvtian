import AsyncStorage from '@react-native-async-storage/async-storage';
import { AutomaticTaskCache, TASK_CACHE_MAX_BYTES } from '../src/services/AutomaticTaskCache';
import type { AutomaticTask } from '../src/types/automaticTasks';

jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
const task: AutomaticTask = { id: 'a', sessionId: 'session', title: 'Task', prompt: 'Instruction',
    status: 'active', kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai', scheduledAt: '2030-01-01T01:00:00Z' };
const url = 'https://example.test';
const token = 'private-credential';

describe('AutomaticTaskCache bounded identity-scoped display snapshot', () => {
    beforeEach(async () => { await AsyncStorage.clear(); jest.clearAllMocks(); });
    afterEach(() => jest.restoreAllMocks());

    it('persists a complete snapshot across instances without raw credentials or URL in keys or envelope', async () => {
        const snapshot = { tasks: [task], fetchedAt: Date.now() };
        // Caller metadata must never override the hashed identity in the serialized envelope.
        const withMemoryIdentity = { ...snapshot, identity: JSON.stringify([url, token]), otherSecret: token };
        await new AutomaticTaskCache().write(url, token, withMemoryIdentity);
        expect(await new AutomaticTaskCache().read(url + '/', token)).toEqual(snapshot);
        const serializedCalls = JSON.stringify(jest.mocked(AsyncStorage.setItem).mock.calls);
        expect(serializedCalls).not.toContain(token);
        expect(serializedCalls).not.toContain(url);
        expect(await new AutomaticTaskCache().read(url, 'different-token')).toBeUndefined();
        expect(await new AutomaticTaskCache().read('https://other.test', token)).toBeUndefined();
        expect(await new AutomaticTaskCache().read(url, '')).toBeUndefined();
    });

    it('successful empty lists remain valid cache entries and only the most recent identity is stored', async () => {
        const cache = new AutomaticTaskCache();
        const snapshot = { tasks: [], fetchedAt: Date.now() };
        await cache.write(url, token, snapshot);
        expect(await cache.read(url, token)).toEqual(snapshot);
        await cache.write(url, 'other', snapshot);
        expect(await cache.read(url, token)).toBeUndefined();
        expect(await cache.read(url, 'other')).toEqual(snapshot);
        expect((await AsyncStorage.getAllKeys()).filter(key => key.startsWith('automatic-task'))).toHaveLength(1);
    });

    it('oversized UTF-8 snapshots are not truncated and remove the old persistent copy', async () => {
        const cache = new AutomaticTaskCache();
        await cache.write(url, token, { tasks: [task], fetchedAt: Date.now() });
        const oversized = { ...task, prompt: '汉'.repeat(TASK_CACHE_MAX_BYTES / 2) };
        await cache.write(url, token, { tasks: [oversized], fetchedAt: Date.now() });
        expect(await cache.read(url, token)).toBeUndefined();
        expect(oversized.prompt.length).toBe(TASK_CACHE_MAX_BYTES / 2);
    });

    it('corrupt JSON, invalid tasks, future timestamps and oversized records are cache misses', async () => {
        const cache = new AutomaticTaskCache();
        await cache.write(url, token, { tasks: [task], fetchedAt: Date.now() });
        const key = jest.mocked(AsyncStorage.setItem).mock.calls[0][0];
        const raw = JSON.parse((await AsyncStorage.getItem(key))!);
        for (const corrupted of ['{', JSON.stringify({ ...raw, tasks: [{ ...task, timeZone: null }] }),
            JSON.stringify({ ...raw, fetchedAt: Date.now() + 60_000 }), 'x'.repeat(TASK_CACHE_MAX_BYTES + 1)]) {
            await AsyncStorage.setItem(key, corrupted);
            expect(await cache.read(url, token)).toBeUndefined();
        }
    });

    it('read/write failures do not escape and an expired timestamp remains readable as stale data', async () => {
        const cache = new AutomaticTaskCache();
        jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('disk full'));
        await expect(cache.write(url, token, { tasks: [task], fetchedAt: Date.now() })).resolves.toBeUndefined();
        jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('read failed'));
        await expect(cache.read(url, token)).resolves.toBeUndefined();
        await cache.write(url, token, { tasks: [task], fetchedAt: 0 });
        expect(await cache.read(url, token)).toEqual({ tasks: [task], fetchedAt: 0 });
    });
});
