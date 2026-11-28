import type { NotificationTaskPayload } from 'expo-notifications';
import { AppState } from 'react-native';
import i18n from '../i18n';
import { useAssistantStore } from '../store/useAssistantStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { AssistantClient } from './AssistantClient';
import { pushModules } from './chatPushModules';
import {
    chatServerIdentity, ensureChatNotificationChannel, getSystemNotificationRoute,
    notifyPushedChatReplies, pushedReplyIds, setSystemNotificationEnrollment,
} from './chatNotifications';

const TASK = 'lvtian-chat-background-sync';
const SYSTEM_NOTIFICATION_HEADER = 'X-Lvtian-Task-Notification';

if (pushModules) {
    const { notifications, taskManager } = pushModules;
    taskManager.defineTask<NotificationTaskPayload>(TASK, async ({ data, error }) => {
        if (error || !data || !('data' in data) || data.data?.type !== 'lvtian_chat_sync') {
            return notifications.BackgroundNotificationTaskResult.NoData;
        }
        const updated = await AssistantClient.getInstance().syncInBackground();
        await notifyPushedChatReplies(pushedReplyIds(data.data.messageIds));
        return updated ? notifications.BackgroundNotificationTaskResult.NewData : notifications.BackgroundNotificationTaskResult.NoData;
    });
}

interface Registration {
    url: string;
    auth: string;
    token: string;
    taskNotification?: { routeId: string; language: 'zh' | 'en'; scope: 'chat' };
}

async function updateDevice(registration: Registration, remove = false): Promise<Response | undefined> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
        const { token, taskNotification } = registration;
        const res = await fetch(`${AssistantClient.toHttpUrl(registration.url)}/api/chat/sync-device`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${registration.auth}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, remove, taskNotification: remove ? undefined : taskNotification }),
            signal: controller.signal,
        });
        return res.ok ? res : undefined;
    } catch {
        return undefined;
    } finally {
        clearTimeout(timeout);
    }
}

export function startChatBackgroundPush(): (() => void) | undefined {
    if (!pushModules) return;
    const { notifications, taskManager } = pushModules;
    let active = true;
    let registration: Registration | undefined;
    let systemNotificationsAccepted = false;
    let registeredAt = 0;
    let operation = Promise.resolve();
    let backgroundSetup: Promise<void> | undefined;

    function ensureBackgroundTask(): void {
        if (backgroundSetup) return;
        backgroundSetup = taskManager.isTaskRegisteredAsync(TASK).then(async registered => {
            if (active && !registered) await notifications.registerTaskAsync(TASK);
        }).catch(() => { backgroundSetup = undefined; });
    }

    function refresh(token?: string): void {
        operation = operation.then(async () => {
            if (!active) return;
            const { credentialsStatus, serverUrl, serverToken } = useAssistantStore.getState();
            const settings = useSettingsStore.getState();
            if (credentialsStatus !== 'ready' || !settings.hasHydrated) return;
            const previous = registration;
            const sameServer = previous?.url === serverUrl && previous.auth === serverToken;
            if (previous && !sameServer) {
                registration = undefined;
                updateDevice(previous, true).catch(() => undefined);
            }
            if (!serverUrl || !serverToken) return;
            const identity = chatServerIdentity(serverUrl, serverToken);
            const enabled = settings.chatNotificationsEnabled && (await notifications.getPermissionsAsync()).granted;
            const language = i18n.language?.split('-')[0] === 'zh' ? 'zh' : 'en';
            if (sameServer && (!token || previous.token === token)
                && (enabled ? systemNotificationsAccepted && previous.taskNotification?.language === language
                    : !previous.taskNotification)
                && Date.now() - registeredAt < 24 * 60 * 60 * 1000) {
                ensureBackgroundTask();
                return;
            }

            const deviceToken = token ?? (await notifications.getDevicePushTokenAsync()).data;
            if (!active || typeof deviceToken !== 'string') return;
            ensureBackgroundTask();
            let taskNotification: Registration['taskNotification'];
            if (enabled) {
                await ensureChatNotificationChannel();
                taskNotification = { routeId: await getSystemNotificationRoute(identity), language, scope: 'chat' };
            }
            if (!active) return;
            const next = { url: serverUrl, auth: serverToken, token: deviceToken, taskNotification };
            const response = await updateDevice(next);
            if (response) {
                const scope = taskNotification && response.headers.get(SYSTEM_NOTIFICATION_HEADER);
                systemNotificationsAccepted = scope === '2';
                await setSystemNotificationEnrollment(identity, scope === '2' || scope === '1' ? scope : undefined);
                registration = next;
                registeredAt = Date.now();
                if (previous && sameServer && previous.token !== deviceToken) updateDevice(previous, true).catch(() => undefined);
            }
        }).catch(() => undefined);
    }

    const removeStoreListener = useAssistantStore.subscribe((state, before) => {
        if (state.credentialsStatus === 'ready' && (before.credentialsStatus !== 'ready'
            || before.serverUrl !== state.serverUrl || before.serverToken !== state.serverToken
            || (state.connectionState === 'connected' && before.connectionState !== 'connected'))) refresh();
    });
    const appState = AppState.addEventListener('change', state => { if (state === 'active') refresh(); });
    const removeSettingsListener = useSettingsStore.subscribe((state, before) => {
        if (state.hasHydrated && (!before.hasHydrated || state.chatNotificationsEnabled !== before.chatNotificationsEnabled)) refresh();
    });
    const onLanguageChanged = () => refresh();
    i18n.on('languageChanged', onLanguageChanged);
    const tokenChanges = notifications.addPushTokenListener(token => {
        if (token.type === 'android' && typeof token.data === 'string') refresh(token.data);
    });
    refresh();

    return () => {
        active = false;
        removeStoreListener();
        removeSettingsListener();
        i18n.off('languageChanged', onLanguageChanged);
        appState.remove();
        tokenChanges.remove();
    };
}
