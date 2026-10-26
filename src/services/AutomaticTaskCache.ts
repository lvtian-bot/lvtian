import AsyncStorage from '@react-native-async-storage/async-storage';
import SHA256 from 'crypto-js/sha256';
import Utf8 from 'crypto-js/enc-utf8';
import type { AutomaticTask } from '../types/automaticTasks';
import { isAutomaticTask } from './AutomaticTaskService';

export const TASK_CACHE_TTL_MS = 60_000;
export const TASK_CACHE_MAX_BYTES = 256 * 1024;
const STORAGE_KEY = 'automatic-task-catalog-v1';

export interface TaskCatalogSnapshot {
    tasks: AutomaticTask[];
    fetchedAt: number;
}

function byteLength(text: string): number {
    return Utf8.parse(text).sigBytes;
}

/** One bounded, replaceable display snapshot; never a scheduling or credential store. */
export class AutomaticTaskCache {
    private writes: Promise<void> = Promise.resolve();

    private identity(url: string, token: string): string {
        return SHA256(JSON.stringify([url.trim().replace(/\/+$/, ''), token.trim()])).toString();
    }

    async read(url: string, token: string): Promise<TaskCatalogSnapshot | undefined> {
        if (!url.trim() || !token.trim()) return undefined;
        try {
            const identity = await this.identity(url, token);
            await this.writes;
            const raw = await AsyncStorage.getItem(STORAGE_KEY);
            if (!raw || byteLength(raw) > TASK_CACHE_MAX_BYTES) return undefined;
            const value: unknown = JSON.parse(raw);
            if (!value || typeof value !== 'object') return undefined;
            const entry = value as Record<string, unknown>;
            if (entry.identity !== identity || typeof entry.fetchedAt !== 'number'
                || !Number.isFinite(entry.fetchedAt) || entry.fetchedAt < 0 || entry.fetchedAt > Date.now()
                || !Array.isArray(entry.tasks) || !entry.tasks.every(isAutomaticTask)) return undefined;
            return { tasks: entry.tasks.filter(task => task.status === 'active'), fetchedAt: entry.fetchedAt };
        } catch {
            // Cache corruption, storage errors or unavailable crypto must not block server reads.
            return undefined;
        }
    }

    write(url: string, token: string, snapshot: TaskCatalogSnapshot): Promise<void> {
        this.writes = this.writes.then(async () => {
            if (!url.trim() || !token.trim()) return;
            const identity = await this.identity(url, token);
            const raw = JSON.stringify({ identity, tasks: snapshot.tasks, fetchedAt: snapshot.fetchedAt });
            if (byteLength(raw) > TASK_CACHE_MAX_BYTES) {
                // Do not truncate instructions or leave an older disk snapshot behind.
                await AsyncStorage.removeItem(STORAGE_KEY);
            } else {
                await AsyncStorage.setItem(STORAGE_KEY, raw);
            }
        }).catch(() => { /* A replaceable cache never turns a successful HTTP read into a failure. */ });
        return this.writes;
    }
}

export const automaticTaskCache = new AutomaticTaskCache();
