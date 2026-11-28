import AsyncStorage from '@react-native-async-storage/async-storage';
import type { NotificationResponse } from 'expo-notifications';
import { AppState, Linking } from 'react-native';
import i18n from '../i18n';
import { useAssistantStore } from '../store/useAssistantStore';
import { useSettingsStore } from '../store/useSettingsStore';
import type { AssistantMessage } from '../types/assistantProtocol';
import type { ChatNotificationTarget } from '../types/navigation';
import { AssistantClient } from './AssistantClient';
import { stableHash } from '../utils/identityHash';
import { pushModules } from './chatPushModules';

const CHANNEL = 'chat-messages';
const TYPE = 'lvtian_chat_reply';
const TASK_TYPE = 'lvtian_task_report';
const HISTORY_LENGTH = 256;
let isViewingChat = () => false;
let delivery = Promise.resolve();

export const chatNotificationsAvailable = Boolean(pushModules);

export function chatServerIdentity(url: string, token: string): string {
    return stableHash(JSON.stringify([url, token]));
}

function currentChatIdentity(): string | undefined {
    const { credentialsStatus, serverUrl, serverToken } = useAssistantStore.getState();
    if (credentialsStatus === 'ready' && serverUrl && serverToken) return chatServerIdentity(serverUrl, serverToken);
}

function isReadingChat(): boolean {
    return AppState.currentState === 'active' && isViewingChat();
}

function isCompletedReply(message: AssistantMessage): boolean {
    return message.role === 'assistant' && message.status === 'done' && Boolean(message.content.trim());
}

export function pushedReplyIds(value: unknown): string[] {
    if (typeof value !== 'string' || value.length > 3500) return [];
    try {
        const ids: unknown = JSON.parse(value);
        return Array.isArray(ids) ? ids.slice(0, 20).filter((id): id is string =>
            typeof id === 'string' && id.length > 0 && id.length <= 180) : [];
    } catch {
        return [];
    }
}

export const ensureChatNotificationChannel = () => pushModules?.notifications.setNotificationChannelAsync(CHANNEL, {
    name: i18n.t('chatNotifications.enabled'),
    importance: pushModules.notifications.AndroidImportance.HIGH,
    lockscreenVisibility: pushModules.notifications.AndroidNotificationVisibility.PRIVATE,
});

const taskRouteKey = (routeId: string) => 'lvtian-task-notification-route:' + routeId;
const taskEnrollmentKey = (identity: string) => 'lvtian-task-notification-enrolled:' + identity;

export async function getTaskNotificationRoute(identity: string): Promise<string> {
    const key = 'lvtian-task-notification-device:' + identity;
    const existing = await AsyncStorage.getItem(key);
    if (existing) return existing;
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const routeId = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    // The push provider gets a random routing ID, never a value derived from connection credentials.
    await AsyncStorage.multiSet([[key, routeId], [taskRouteKey(routeId), identity]]);
    return routeId;
}

export async function setTaskNotificationEnrollment(identity: string, enabled: boolean): Promise<void> {
    if (enabled) await AsyncStorage.setItem(taskEnrollmentKey(identity), '1');
    else await AsyncStorage.removeItem(taskEnrollmentKey(identity));
}

export async function setChatNotificationPermission(enabled: boolean): Promise<void> {
    const { setChatNotificationsEnabled } = useSettingsStore.getState();
    if (!enabled) {
        setChatNotificationsEnabled(false);
        return;
    }
    const notifications = pushModules?.notifications;
    if (!notifications) return;
    await ensureChatNotificationChannel();
    const permission = await notifications.getPermissionsAsync();
    if (permission.granted) {
        setChatNotificationsEnabled(true);
    } else if (!permission.canAskAgain) {
        await Linking.openSettings();
    } else {
        setChatNotificationsEnabled((await notifications.requestPermissionsAsync()).granted);
    }
}

function waitForSettings(): Promise<void> {
    if (useSettingsStore.getState().hasHydrated) return Promise.resolve();
    return new Promise(resolve => {
        const finish = () => { unsubscribe(); clearTimeout(timeout); resolve(); };
        const unsubscribe = useSettingsStore.subscribe(state => { if (state.hasHydrated) finish(); });
        const timeout = setTimeout(finish, 2500);
    });
}

function previewText(content: string): string {
    const plainText = content.trim().replace(/^#{1,6}\s+/gm, '').replace(/\s+/g, ' ');
    const characters = Array.from(plainText);
    return characters.length > 110 ? characters.slice(0, 110).join('') + '…' : plainText;
}

export function notifyChatReplies(messages: AssistantMessage[]): Promise<void> {
    const notifications = pushModules?.notifications;
    const serverIdentity = currentChatIdentity();
    const replies = messages.filter(isCompletedReply);
    if (!notifications || !serverIdentity || !replies.length) return Promise.resolve();

    const readingWhenReceived = isReadingChat();
    delivery = delivery.then(async () => {
        await waitForSettings();
        if (!useSettingsStore.getState().chatNotificationsEnabled || serverIdentity !== currentChatIdentity()) return;
        const key = 'lvtian-chat-notifications-v1:' + serverIdentity;
        const raw: unknown = JSON.parse(await AsyncStorage.getItem(key) ?? '[]');
        const seen = new Set<string>(Array.isArray(raw) ? raw.filter(id => typeof id === 'string') : []);
        const systemNotifiesTasks = replies.some(message => message.source === 'native_task_report')
            && await AsyncStorage.getItem(taskEnrollmentKey(serverIdentity)) === '1';
        const unseen = replies.filter(message => !seen.has(message.id)
            && !(systemNotifiesTasks && message.source === 'native_task_report'));
        if (!unseen.length) return;
        if (!readingWhenReceived && !isReadingChat()) {
            if (!(await notifications.getPermissionsAsync()).granted) return;
            await ensureChatNotificationChannel();
        }
        for (const message of unseen) {
            const settings = useSettingsStore.getState();
            if (!settings.chatNotificationsEnabled || serverIdentity !== currentChatIdentity()) break;
            if (!readingWhenReceived && !isReadingChat()) {
                const preview = settings.chatNotificationPreview && previewText(message.content);
                try {
                    await notifications.scheduleNotificationAsync({
                        identifier: TYPE + ':' + serverIdentity + ':' + message.id,
                        content: {
                            title: i18n.t('chatNotifications.title'),
                            body: preview || i18n.t('chatNotifications.newMessage'),
                            data: { type: TYPE, messageId: message.id, serverIdentity },
                        },
                        trigger: { channelId: CHANNEL },
                    });
                } catch { continue; }
            }
            seen.add(message.id);
        }
        await AsyncStorage.setItem(key, JSON.stringify(Array.from(seen).slice(-HISTORY_LENGTH)));
    }).catch(() => undefined);
    return delivery;
}

export async function readNotificationReply(target: ChatNotificationTarget, signal: AbortSignal): Promise<AssistantMessage | undefined> {
    const { serverUrl, serverToken, clearedSeq } = useAssistantStore.getState();
    if (currentChatIdentity() !== target.serverIdentity) return;
    const timeout = new AbortController();
    const abort = () => timeout.abort();
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 8000);
    try {
        if (signal.aborted) return;
        const url = AssistantClient.toHttpUrl(serverUrl);
        const response = await fetch(`${url}/api/chat/reply?id=${encodeURIComponent(target.messageId)}`, {
            headers: { Authorization: `Bearer ${serverToken}` },
            signal: timeout.signal,
        });
        if (!response.ok) return;
        const reply = await response.json() as AssistantMessage;
        if (!timeout.signal.aborted && currentChatIdentity() === target.serverIdentity
            && reply?.id === target.messageId && typeof reply.content === 'string'
            && Number.isFinite(reply.timestamp) && Number.isSafeInteger(reply.seq)
            && reply.seq > Math.max(clearedSeq, useAssistantStore.getState().clearedSeq)
            && isCompletedReply(reply)) return reply;
    } catch {
        return undefined;
    } finally {
        signal.removeEventListener('abort', abort);
        clearTimeout(timer);
    }
}

export async function notifyPushedChatReplies(ids: string[]): Promise<void> {
    if (!ids.length) return;
    await waitForSettings();
    const serverIdentity = currentChatIdentity();
    if (!serverIdentity || !useSettingsStore.getState().chatNotificationsEnabled) return;
    const { messages } = useAssistantStore.getState();
    const byId = new Map(messages.map(message => [message.id, message]));
    const signal = new AbortController().signal;
    const replies = await Promise.all(Array.from(new Set(ids), async messageId => {
        const cached = byId.get(messageId);
        if (cached && isCompletedReply(cached)) return cached;
        if (isReadingChat()) return;
        return readNotificationReply({ messageId, serverIdentity }, signal);
    }));
    if (serverIdentity === currentChatIdentity()) {
        await notifyChatReplies(replies.filter((reply): reply is AssistantMessage => reply !== undefined));
    }
}

async function notificationIdentity(data: Record<string, unknown> | undefined): Promise<string | undefined> {
    if (data?.type === TYPE && typeof data.serverIdentity === 'string') return data.serverIdentity;
    if (data?.type === TASK_TYPE && typeof data.routeId === 'string' && /^[a-f0-9]{32}$/.test(data.routeId)) {
        return await AsyncStorage.getItem(taskRouteKey(data.routeId)) ?? undefined;
    }
}

async function handleNotification(response: NotificationResponse, openReply: (target: ChatNotificationTarget) => void): Promise<void> {
    const notifications = pushModules?.notifications;
    const { data } = response.notification.request.content;
    if (!notifications || response.actionIdentifier !== notifications.DEFAULT_ACTION_IDENTIFIER
        || typeof data?.messageId !== 'string') return;
    const serverIdentity = await notificationIdentity(data);
    if (!serverIdentity) return;
    notifications.clearLastNotificationResponse();
    openReply({ messageId: data.messageId, serverIdentity });
}

export function startChatNotifications(isChatVisible: () => boolean, openReply: (target: ChatNotificationTarget) => void) {
    const notifications = pushModules?.notifications;
    if (!notifications) return;
    isViewingChat = isChatVisible;
    notifications.setNotificationHandler({
        handleNotification: async notification => {
            const serverIdentity = await notificationIdentity(notification.request.content.data);
            const show = Boolean(serverIdentity && serverIdentity === currentChatIdentity() && !isReadingChat()
                && useSettingsStore.getState().chatNotificationsEnabled);
            return { shouldShowBanner: show, shouldShowList: show, shouldPlaySound: show, shouldSetBadge: false };
        },
    });

    const onResponse = (event: NotificationResponse) => {
        handleNotification(event, openReply).catch(() => undefined);
    };
    const response = notifications.addNotificationResponseReceivedListener(onResponse);
    const last = notifications.getLastNotificationResponse();
    if (last) onResponse(last);

    const unsubscribe = useAssistantStore.subscribe((state, before) => {
        if (state.messages === before.messages || state.serverUrl !== before.serverUrl
            || state.serverToken !== before.serverToken || !useSettingsStore.getState().chatNotificationsEnabled) return;
        const live = state.connectionState === 'connected' && before.connectionState === 'connected';
        const cursor = before.chatSyncCursor;
        const caughtUp = cursor && state.chatSyncCursor !== cursor && state.chatSyncCursor?.epoch === cursor.epoch;
        if (!live && !caughtUp) return;
        const lastSeq = Math.max(before.currentSeq, cursor?.seq ?? 0);
        const oldById = new Map(before.messages.map(message => [message.id, message]));
        const completed = state.messages.filter(message => {
            if (!isCompletedReply(message)) return false;
            const old = oldById.get(message.id);
            return old ? old.status === 'processing' : message.seq > lastSeq;
        });
        notifyChatReplies(completed).catch(() => undefined);
    });
    return () => {
        isViewingChat = () => false;
        notifications.setNotificationHandler(null);
        response.remove();
        unsubscribe();
    };
}
