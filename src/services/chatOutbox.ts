import AsyncStorage from '@react-native-async-storage/async-storage';
import { stableHash } from '../utils/identityHash';
import type { ChatAttachment } from '../types/assistantProtocol';

export interface PendingChatMessage {
    /** Show this message at full opacity from submission if the service was ready. */
    submittedOnline?: boolean;
    /** Missing on older records whose delivery is uncertain. */
    attempted?: boolean;
    /** Automatic retries exhausted or permanent send/attachment failure. */
    failed?: boolean;
    withdrawal?: 'cancel' | 'edit' | 'draft';
    sessionId: string;
    messageId: string;
    content: string;
    attachments?: ChatAttachment[];
}

export interface ChatOutbox {
    pendingSendQueue: PendingChatMessage[];
    pendingCancelQueue: string[];
}

export const outboxKey = (url: string, token: string): string =>
    `lvtian-chat-outbox-v1:${stableHash(JSON.stringify([url, token]))}`;

export async function readOutbox(key: string): Promise<ChatOutbox> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let raw: string | null;
    try {
        raw = await Promise.race([
            AsyncStorage.getItem(key),
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error('outbox_timeout')), 3000);
            }),
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
    if (raw === null) return { pendingSendQueue: [], pendingCancelQueue: [] };
    const value = JSON.parse(raw) as ChatOutbox;
    if (!value || !Array.isArray(value.pendingSendQueue) || !Array.isArray(value.pendingCancelQueue)
        || !value.pendingSendQueue.every(item => item && typeof item.sessionId === 'string'
            && typeof item.messageId === 'string' && typeof item.content === 'string'
            && (item.submittedOnline === undefined || typeof item.submittedOnline === 'boolean')
            && (item.failed === undefined || typeof item.failed === 'boolean')
            && (item.attachments === undefined || (Array.isArray(item.attachments)
                && item.attachments.every(attachment => attachment
                    && (attachment.type === 'image' || attachment.type === 'file')
                    && typeof attachment.name === 'string'))))
        || !value.pendingCancelQueue.every(item => typeof item === 'string')) {
        throw new Error('invalid_outbox');
    }
    return value;
}

export async function writeOutbox(key: string, outbox: ChatOutbox): Promise<void> {
    const pendingSendQueue = outbox.pendingSendQueue.map(item => ({
        ...item,
        // A previous process may have written to the socket after its last disk
        // snapshot. Only a live process can prove that it never attempted this ID.
        attempted: item.attempted || undefined,
        failed: item.failed || undefined,
        attachments: item.attachments?.map(att => att.uri ? { type: att.type, name: att.name, mimeType: att.mimeType, size: att.size, uri: att.uri } : att),
    }));
    await AsyncStorage.setItem(key, JSON.stringify({ pendingSendQueue, pendingCancelQueue: outbox.pendingCancelQueue }));
}
