import AsyncStorage from '@react-native-async-storage/async-storage';
import { stableHash } from '../utils/identityHash';
import type { ChatAttachment } from '../types/assistantProtocol';

export interface PendingChatMessage {
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
        attachments: item.attachments?.map(({ type, name, mimeType, size, uri }) => ({ type, name, mimeType, size, uri })),
    }));
    await AsyncStorage.setItem(key, JSON.stringify({ pendingSendQueue, pendingCancelQueue: outbox.pendingCancelQueue }));
}
