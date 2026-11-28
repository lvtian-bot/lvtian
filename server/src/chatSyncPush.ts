import fs from 'node:fs';
import path from 'node:path';
import { applicationDefault, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging, type Messaging, type MulticastMessage } from 'firebase-admin/messaging';
import { createInstance } from 'i18next';

const DEVICE_TTL_MS = 60 * 24 * 60 * 60 * 1000;
const MAX_DEVICES = 32;
const INVALID_TOKEN = new Set(['messaging/registration-token-not-registered', 'messaging/invalid-registration-token']);
export const CHAT_NOTIFICATION_CHANNEL = 'chat-messages-v2';
const LEGACY_NOTIFICATION_CHANNEL = 'chat-messages';
// Retain the original registration header for already installed clients.
export const SYSTEM_NOTIFICATION_HEADER = 'X-Lvtian-Task-Notification';
export const NOTIFICATION_CHANNEL_HEADER = 'X-Lvtian-Notification-Channel';

function previewText(content: string): string {
    const plainText = content.trim().replace(/^#{1,6}\s+/gm, '').replace(/\s+/g, ' ');
    const characters = Array.from(plainText);
    return characters.length > 110 ? characters.slice(0, 110).join('') + '…' : plainText;
}

const i18n = createInstance();
await i18n.init({
    resources: {
        zh: { translation: { title: '绿天', body: '你有一条新消息' } },
        en: { translation: { title: 'Lvtian', body: 'You have a new message' } },
    },
    fallbackLng: 'en',
    initAsync: false,
});

interface SystemNotification {
    routeId: string;
    language: 'zh' | 'en';
    scope?: 'chat';
    preview?: boolean;
    channelId?: string;
}

interface PushDevice {
    registeredAt: number;
    systemNotification?: SystemNotification;
}

export function isChatPushToken(value: unknown): value is string {
    return typeof value === 'string' && /^[A-Za-z0-9_:\-]{20,4096}$/.test(value);
}

export function readSystemNotification(value: unknown): SystemNotification | undefined {
    if (typeof value !== 'object' || !value) return;
    const { routeId, language, scope, preview, channelId } = value as Partial<Record<keyof SystemNotification, unknown>>;
    if (typeof routeId === 'string' && /^[a-f0-9]{32}$/.test(routeId) && (language === 'zh' || language === 'en')) {
        return {
            routeId,
            language,
            scope: scope === 'chat' ? scope : undefined,
            preview: typeof preview === 'boolean' ? preview : undefined,
            channelId: channelId === CHAT_NOTIFICATION_CHANNEL ? CHAT_NOTIFICATION_CHANNEL : undefined,
        };
    }
}

export class ChatSyncPush {
    private devices = new Map<string, PushDevice>();
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
                    this.devices.set(row[0], { registeredAt: row[1], systemNotification: readSystemNotification(row[2]) });
                }
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                console.warn('[ChatSyncPush] Could not load registrations');
            }
        }
    }

    register(token: string, systemNotification?: SystemNotification): void {
        const now = Date.now();
        const recent = this.activeDevices().filter(([saved]) => saved !== token);
        this.save(new Map([...recent.slice(-(MAX_DEVICES - 1)), [token, { registeredAt: now, systemNotification }]]));
    }

    unregister(token: string): void {
        if (!this.devices.has(token)) return;
        const devices = new Map(this.devices);
        devices.delete(token);
        this.save(devices);
    }

    wakeDevices(messageId: string, notice?: 'chat' | 'task' | { kind: 'chat' | 'task'; content?: string }): void {
        if (notice) {
            const target = typeof notice === 'string' ? { kind: notice } : notice;
            this.notifyReply(messageId, target.kind, target.content);
        }
        this.pending.add(messageId);
        this.drainPending();
    }

    private drainPending(): void {
        if (this.delivering) return;
        this.delivering = true;
        void this.drain().finally(() => {
            this.delivering = false;
            if (this.pending.size) this.drainPending();
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
        await this.send(this.activeDevices(), {
            data: { type: 'lvtian_chat_sync', messageIds: JSON.stringify(messageIds) },
            android: { priority: 'normal', ttl: 15 * 60 * 1000 },
        });
    }

    private activeDevices(): [string, PushDevice][] {
        const cutoff = Date.now() - DEVICE_TTL_MS;
        return Array.from(this.devices).filter(([, device]) => device.registeredAt > cutoff);
    }

    private notifyReply(messageId: string, kind: 'chat' | 'task', content?: string): void {
        for (const registration of this.activeDevices()) {
            const notice = registration[1].systemNotification;
            if (!notice || (notice.scope !== 'chat' && kind !== 'task')) continue;
            const { routeId, language, scope, preview, channelId } = notice;
            const translate = i18n.getFixedT(language);
            const body = (preview === true && content ? previewText(content) : '') || translate('body');
            void this.send([registration], {
                notification: { title: translate('title'), body },
                data: { type: scope === 'chat' ? 'lvtian_system_chat_reply' : 'lvtian_task_report', messageId, routeId },
                android: {
                    priority: 'high',
                    ttl: 6 * 60 * 60 * 1000,
                    notification: { channelId: channelId ?? LEGACY_NOTIFICATION_CHANNEL, tag: messageId },
                },
            });
        }
    }

    private async send(registrations: [string, PushDevice][], message: Omit<MulticastMessage, 'tokens'>): Promise<void> {
        if (registrations.length === 0) return;
        try {
            const result = await this.sender.sendEachForMulticast({
                ...message,
                tokens: registrations.map(([token]) => token),
            });
            const devices = new Map(this.devices);
            result.responses.forEach(({ error }, index) => {
                const [token, device] = registrations[index];
                if (error && INVALID_TOKEN.has(error.code) && devices.get(token) === device) devices.delete(token);
            });
            if (devices.size !== this.devices.size) this.save(devices);
            if (result.failureCount > 0) console.info('[ChatSyncPush] FCM failures:', result.failureCount);
        } catch {
            console.warn('[ChatSyncPush] FCM delivery failed');
        }
    }

    private save(devices: Map<string, PushDevice>): void {
        const temporary = this.filename + '.tmp';
        const rows = Array.from(devices, ([token, device]) => [token, device.registeredAt, device.systemNotification ?? null]);
        fs.writeFileSync(temporary, JSON.stringify(rows), { mode: 0o600 });
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
