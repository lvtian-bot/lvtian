import fs from 'node:fs';
import path from 'node:path';
import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging, type Messaging } from 'firebase-admin/messaging';

const DEVICE_TTL_MS = 60 * 24 * 60 * 60 * 1000;
const MAX_DEVICES = 32;
const INVALID_TOKEN = new Set(['messaging/registration-token-not-registered', 'messaging/invalid-registration-token']);

export function isChatPushToken(value: unknown): value is string {
    return typeof value === 'string' && /^[A-Za-z0-9_:\-]{20,4096}$/.test(value);
}

export class ChatSyncPush {
    private devices = new Map<string, number>();
    private delivering = false;
    private pending = new Set<string>();
    private readonly filename: string;

    constructor(dataDir: string, private readonly sender: Pick<Messaging, 'sendEachForMulticast'>) {
        this.filename = path.join(dataDir, 'chat-sync-devices.json');
        try {
            const raw: unknown = JSON.parse(fs.readFileSync(this.filename, 'utf8'));
            if (!Array.isArray(raw)) return;
            for (const row of raw.slice(-MAX_DEVICES)) {
                if (Array.isArray(row) && isChatPushToken(row[0])
                    && typeof row[1] === 'number' && row[1] > Date.now() - DEVICE_TTL_MS) {
                    this.devices.set(row[0], row[1]);
                }
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                console.warn('[ChatSyncPush] Could not load registrations');
            }
        }
    }

    register(token: string): void {
        const now = Date.now();
        const recent = Array.from(this.devices).filter(([saved, at]) => saved !== token && at > now - DEVICE_TTL_MS);
        this.save(new Map([...recent.slice(-(MAX_DEVICES - 1)), [token, now]]));
    }

    unregister(token: string): void {
        if (!this.devices.has(token)) return;
        const devices = new Map(this.devices);
        devices.delete(token);
        this.save(devices);
    }

    wakeDevices(messageId: string): void {
        this.pending.add(messageId);
        if (this.delivering) return;
        this.delivering = true;
        void this.drain().finally(() => {
            this.delivering = false;
            const next = this.pending.values().next();
            if (!next.done) this.wakeDevices(next.value);
        });
    }

    private async drain(): Promise<void> {
        while (this.pending.size > 0) {
            // Keep the FCM payload small even when several replies arrive during a send.
            const messageIds = Array.from(this.pending).slice(0, 20);
            for (const id of messageIds) this.pending.delete(id);
            await this.deliver(messageIds);
        }
    }

    private async deliver(messageIds: string[]): Promise<void> {
        const registrations = Array.from(this.devices).filter(([, at]) => at > Date.now() - DEVICE_TTL_MS);
        if (registrations.length === 0) return;
        try {
            const result = await this.sender.sendEachForMulticast({
                tokens: registrations.map(([token]) => token),
                data: { type: 'lvtian_chat_sync', messageIds: JSON.stringify(messageIds) },
                android: { priority: 'normal', ttl: 15 * 60 * 1000 },
            });
            const devices = new Map(this.devices);
            result.responses.forEach(({ error }, index) => {
                const [token, registeredAt] = registrations[index];
                if (error && INVALID_TOKEN.has(error.code) && devices.get(token) === registeredAt) devices.delete(token);
            });
            if (devices.size !== this.devices.size) this.save(devices);
            if (result.failureCount > 0) console.info('[ChatSyncPush] FCM failures:', result.failureCount);
        } catch {
            console.warn('[ChatSyncPush] FCM delivery failed');
        }
    }

    private save(devices: Map<string, number>): void {
        const temporary = this.filename + '.tmp';
        fs.writeFileSync(temporary, JSON.stringify(Array.from(devices)), { mode: 0o600 });
        fs.renameSync(temporary, this.filename);
        this.devices = devices;
    }
}

export function createChatSyncPush(dataDir: string, projectId = process.env.LVTIAN_CHAT_SYNC_FIREBASE_PROJECT): ChatSyncPush | undefined {
    const project = projectId?.trim();
    if (!project) return;
    const name = 'lvtian-chat-sync-' + project;
    try {
        const firebase = getApps().find(app => app.name === name)
            ?? initializeApp({ credential: applicationDefault(), projectId: project }, name);
        return new ChatSyncPush(dataDir, getMessaging(firebase));
    } catch {
        console.warn('[ChatSyncPush] Firebase configuration failed');
        return undefined;
    }
}
