import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import { AppState, Platform } from 'react-native';
import { useAssistantStore } from '../store/useAssistantStore';
import { AssistantClient } from './AssistantClient';

const TASK = 'lvtian-chat-background-sync';
const ENABLED = Platform.OS === 'android' && Constants.expoConfig?.extra?.chatBackgroundSync === true;

if (ENABLED) {
    TaskManager.defineTask<Notifications.NotificationTaskPayload>(TASK, async ({ data, error }) => {
        if (error || !data || !('data' in data) || data.data?.type !== 'lvtian_chat_sync') {
            return Notifications.BackgroundNotificationTaskResult.NoData;
        }
        const updated = await AssistantClient.getInstance().syncInBackground();
        return updated ? Notifications.BackgroundNotificationTaskResult.NewData : Notifications.BackgroundNotificationTaskResult.NoData;
    });
}

interface Registration {
    url: string;
    auth: string;
    token: string;
}

async function updateDevice(registration: Registration, remove = false): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
        const res = await fetch(`${AssistantClient.toHttpUrl(registration.url)}/api/chat/sync-device`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${registration.auth}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: registration.token, remove }),
            signal: controller.signal,
        });
        return res.ok;
    } catch {
        return false;
    } finally {
        clearTimeout(timeout);
    }
}

export function startChatBackgroundPush(): (() => void) | undefined {
    if (!ENABLED) return;
    let active = true;
    let registration: Registration | undefined;
    let registeredAt = 0;
    let operation = Promise.resolve();

    function refresh(token?: string): void {
        operation = operation.then(async () => {
            if (!active) return;
            const { credentialsStatus, serverUrl, serverToken } = useAssistantStore.getState();
            if (credentialsStatus !== 'ready') return;
            const previous = registration;
            const sameServer = previous?.url === serverUrl && previous.auth === serverToken;
            if (sameServer && (!token || previous.token === token) && Date.now() - registeredAt < 24 * 60 * 60 * 1000) return;
            if (previous && !sameServer) {
                registration = undefined;
                updateDevice(previous, true).catch(() => undefined);
            }
            if (!serverUrl || !serverToken) return;

            if (!await TaskManager.isTaskRegisteredAsync(TASK)) await Notifications.registerTaskAsync(TASK);
            const deviceToken = token ?? (await Notifications.getDevicePushTokenAsync()).data;
            if (!active || typeof deviceToken !== 'string') return;
            const next = { url: serverUrl, auth: serverToken, token: deviceToken };
            if (await updateDevice(next)) {
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
    const tokenChanges = Notifications.addPushTokenListener(token => {
        if (token.type === 'android' && typeof token.data === 'string') refresh(token.data);
    });
    refresh();

    return () => {
        active = false;
        removeStoreListener();
        appState.remove();
        tokenChanges.remove();
    };
}
