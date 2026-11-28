import AsyncStorage from '@react-native-async-storage/async-storage';
import Utf8 from 'crypto-js/enc-utf8';
import { stableHash } from '../utils/identityHash';
import { isMomentsPage, type MomentsConnection, type MomentsPage } from './MomentsService';

export const MOMENTS_REFRESH_INTERVAL = 5 * 60_000;
const storageKey = 'lvtian-moments-first-page-v1';
const maxBytes = 1024 * 1024;
let writes = Promise.resolve();

export interface MomentsSnapshot {
    page: MomentsPage;
    refreshedAt: number;
}

export function momentsIdentity({ serverUrl, serverToken }: MomentsConnection): string {
    return stableHash(JSON.stringify([serverUrl, serverToken]));
}

export const momentsCache = {
    async read(identity: string): Promise<MomentsSnapshot | undefined> {
        try {
            await writes;
            const raw = await AsyncStorage.getItem(storageKey);
            if (!raw) return;
            const cached: unknown = JSON.parse(raw);
            if (cached && typeof cached === 'object' && 'identity' in cached && cached.identity === identity
                && 'refreshedAt' in cached && typeof cached.refreshedAt === 'number' && Number.isFinite(cached.refreshedAt)
                && 'page' in cached && isMomentsPage(cached.page)) {
                return { page: cached.page, refreshedAt: cached.refreshedAt };
            }
        } catch { /* 缓存不可读时仍可以从服务端加载。 */ }
    },

    write(identity: string, snapshot: MomentsSnapshot): Promise<void> {
        writes = writes.then(async () => {
            const raw = JSON.stringify({ identity, ...snapshot });
            if (Utf8.parse(raw).sigBytes > maxBytes) {
                await AsyncStorage.removeItem(storageKey);
            } else {
                await AsyncStorage.setItem(storageKey, raw);
            }
        }).catch(() => { /* 存储失败时保留内存中的列表。 */ });
        return writes;
    },
};
