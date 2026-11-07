import { File } from 'expo-file-system';

export class DownloadTimeoutError extends Error {
    constructor() {
        super('Download timed out');
        this.name = 'DownloadTimeoutError';
    }
}

let downloadSequence = 0;
const destinationLocks = new Map<string, Promise<void>>();

async function withDestinationLock<T>(uri: string, operation: () => Promise<T>): Promise<T> {
    const previous = destinationLocks.get(uri);
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    destinationLocks.set(uri, current);
    if (previous) await previous;
    try {
        return await operation();
    } finally {
        release();
        if (destinationLocks.get(uri) === current) destinationLocks.delete(uri);
    }
}

/** Download to a separate file so a failed transfer cannot damage the destination. */
export async function downloadToFile(
    url: string,
    destinationUri: string,
    headers: Record<string, string>,
    options: { timeoutMs: number; timeoutMode: 'total' | 'idle' },
): Promise<string> {
    const destination = new File(destinationUri);
    const parent = destination.parentDirectory;
    if (!parent.exists) parent.create({ intermediates: true, idempotent: true });
    const temp = new File(parent, `.download-${Date.now()}-${++downloadSequence}-${Math.random().toString(36).slice(2)}.tmp`);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let finished = false;
    let preserveTemp = false;
    let rejectTimeout: (error: DownloadTimeoutError) => void = () => undefined;
    const timeoutPromise = new Promise<never>((_, reject) => { rejectTimeout = reject; });
    const timeoutError = new DownloadTimeoutError();
    let task: ReturnType<typeof File.createDownloadTask>;
    const armTimeout = () => {
        if (timeout) clearTimeout(timeout);
        timeout = setTimeout(() => {
            timedOut = true;
            task.cancel();
            rejectTimeout(timeoutError);
        }, options.timeoutMs);
    };
    task = File.createDownloadTask(url, temp, {
        headers,
        onProgress: () => { if (!timedOut && !finished && options.timeoutMode === 'idle') armTimeout(); },
    });
    const operation = task.downloadAsync();
    armTimeout();
    try {
        const downloaded = await Promise.race([operation, timeoutPromise]);
        finished = true;
        if (timeout) clearTimeout(timeout);
        if (!downloaded) throw new Error('Download stopped before completion');
        await withDestinationLock(destination.uri, async () => {
            // Expo's overwrite move can delete the existing destination before moving.
            // Keep a backup until replacement succeeds, so a failed move can be recovered.
            const backup = new File(parent, `.backup-${Date.now()}-${++downloadSequence}-${Math.random().toString(36).slice(2)}.tmp`);
            let backedUp = false;
            if (destination.exists) {
                try {
                    await destination.copy(backup);
                    backedUp = true;
                } catch (error: unknown) {
                    try { if (backup.exists) backup.delete(); } catch { /* preserve original error */ }
                    throw error;
                }
            }
            try {
                await downloaded.move(destination, { overwrite: true });
            } catch (error: unknown) {
                if (backedUp) {
                    try {
                        await backup.copy(destination, { overwrite: true });
                    } catch (restoreError: unknown) {
                        preserveTemp = true;
                        console.error('[NativeDownloadService] Failed to restore download destination; backup retained:', backup.uri, restoreError);
                    }
                }
                if (!preserveTemp && backup.exists) backup.delete();
                throw error;
            }
            try { if (backup.exists) backup.delete(); }
            catch (cleanupError) { console.warn('[NativeDownloadService] Failed to remove backup:', cleanupError); }
        });
        task.release();
        return destination.uri;
    } catch (error: unknown) {
        task.cancel();
        // A cancelled native transfer may settle later. Only remove its temporary file
        // after it has actually stopped, and never touch the existing destination.
        operation.then(() => undefined, () => undefined).then(() => {
            try { if (!preserveTemp && temp.exists) temp.delete(); }
            catch (cleanupError) { console.warn('[NativeDownloadService] Failed to clean up download:', cleanupError); }
            task.release();
        }).catch(cleanupError => console.warn('[NativeDownloadService] Failed to release download:', cleanupError));
        throw timedOut ? timeoutError : error;
    } finally {
        finished = true;
        if (timeout) clearTimeout(timeout);
    }
}
