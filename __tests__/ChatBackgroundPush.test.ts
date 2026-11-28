import type { NotificationTaskPayload } from 'expo-notifications';

const TASK = 'lvtian-chat-background-sync';

jest.mock('expo', () => ({ requireOptionalNativeModule: jest.fn() }));
jest.mock('expo-localization', () => ({ getLocales: () => [{ languageCode: 'zh' }] }));
jest.mock('expo-notifications', () => ({
    getDevicePushTokenAsync: jest.fn(),
    getPermissionsAsync: jest.fn().mockResolvedValue({ granted: true }),
    registerTaskAsync: jest.fn(),
    addPushTokenListener: () => ({ remove: jest.fn() }),
    BackgroundNotificationTaskResult: { NewData: 0, NoData: 1 },
}));
jest.mock('expo-task-manager', () => ({
    defineTask: jest.fn(),
    isTaskRegisteredAsync: jest.fn().mockResolvedValue(false),
}));
jest.mock('../src/services/chatNotifications', () => ({
    pushedReplyIds: jest.fn(() => []),
    notifyPushedChatReplies: jest.fn(),
    chatServerIdentity: jest.fn(() => 'test-server'),
    ensureChatNotificationChannel: jest.fn(),
    getTaskNotificationRoute: jest.fn().mockResolvedValue('ab'.repeat(16)),
    setTaskNotificationEnrollment: jest.fn(),
}));
jest.mock('../src/services/AssistantClient', () => ({
    AssistantClient: { getInstance: jest.fn(), toHttpUrl: (url: string) => url },
}));
jest.mock('../src/store/useAssistantStore', () => ({
    useAssistantStore: {
        getState: () => ({
            credentialsStatus: 'ready', serverUrl: 'https://server.test', serverToken: 'test-token',
        }),
        subscribe: () => jest.fn(),
    },
}));

function mockAndroid(hasModules: boolean) {
    jest.resetModules();
    const { Platform } = require('react-native') as typeof import('react-native');
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
    const expo = jest.requireMock<{ requireOptionalNativeModule: jest.Mock }>('expo');
    expo.requireOptionalNativeModule.mockReturnValue(hasModules ? {} : null);
    const notifications = jest.requireMock<{
        getDevicePushTokenAsync: jest.Mock;
        registerTaskAsync: jest.Mock;
    }>('expo-notifications');
    const tasks = jest.requireMock<{
        defineTask: jest.Mock;
    }>('expo-task-manager');
    const client = jest.requireMock<{ AssistantClient: { getInstance: jest.Mock } }>('../src/services/AssistantClient');
    const notificationsService = jest.requireMock<{ setTaskNotificationEnrollment: jest.Mock }>('../src/services/chatNotifications');
    const { useSettingsStore } = require('../src/store/useSettingsStore') as typeof import('../src/store/useSettingsStore');
    useSettingsStore.setState({ hasHydrated: true, chatNotificationsEnabled: false });
    const { startChatBackgroundPush } = require('../src/services/chatBackgroundPush') as
        typeof import('../src/services/chatBackgroundPush');
    return { startChatBackgroundPush, tasks, notifications, client, notificationsService, useSettingsStore };
}

const flush = async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

describe('Android chat background synchronization', () => {
    afterEach(() => jest.restoreAllMocks());

    it('keeps using the installed Firebase setup with no capability flag in the update', async () => {
        const { startChatBackgroundPush, notifications, tasks, client } = mockAndroid(true);
        const syncInBackground = jest.fn().mockResolvedValue(true);
        client.AssistantClient.getInstance.mockReturnValue({ syncInBackground });
        notifications.getDevicePushTokenAsync.mockResolvedValue({ type: 'android', data: 'test-device-token' });
        const fetch = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true } as Response);
        const stop = startChatBackgroundPush();

        await flush();
        expect(notifications.registerTaskAsync).toHaveBeenCalledWith(TASK);
        expect(fetch).toHaveBeenCalledWith('https://server.test/api/chat/sync-device', expect.objectContaining({
            body: JSON.stringify({ token: 'test-device-token', remove: false }),
        }));
        expect(tasks.defineTask).toHaveBeenCalledWith(TASK, expect.any(Function));
        const [, runTask] = tasks.defineTask.mock.calls[0] as [string, (event: {
            data: NotificationTaskPayload;
        }) => Promise<number>];
        await expect(runTask({ data: { notification: null, data: { type: 'lvtian_chat_sync' } } })).resolves.toBe(0);
        expect(syncInBackground).toHaveBeenCalledTimes(1);
        stop?.();
    });

    it('registers system task notifications when enabled and removes that option without stopping silent sync', async () => {
        const { startChatBackgroundPush, notifications, notificationsService, useSettingsStore } = mockAndroid(true);
        notifications.getDevicePushTokenAsync.mockResolvedValue({ type: 'android', data: 'test-device-token' });
        notifications.registerTaskAsync.mockRejectedValueOnce(new Error('Background task registration failed'));
        useSettingsStore.setState({ chatNotificationsEnabled: true });
        const fetch = jest.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
            const { taskNotification } = JSON.parse(String(init?.body));
            return { ok: true, headers: { get: () => taskNotification ? '1' : null } } as unknown as Response;
        });
        const stop = startChatBackgroundPush();
        try {
            await flush();
            const initial = JSON.parse(String(fetch.mock.calls[0][1]?.body));
            expect(initial.taskNotification).toEqual({ routeId: 'ab'.repeat(16), language: 'zh' });
            expect(notificationsService.setTaskNotificationEnrollment).toHaveBeenCalledWith('test-server', true);
            useSettingsStore.setState({ chatNotificationsEnabled: false });
            await flush();
            const disabled = JSON.parse(String(fetch.mock.calls[1][1]?.body));
            expect(disabled).toEqual({ token: 'test-device-token', remove: false });
            expect(notificationsService.setTaskNotificationEnrollment).toHaveBeenLastCalledWith('test-server', false);
            expect(notifications.registerTaskAsync).toHaveBeenCalledTimes(2);
        } finally {
            stop?.();
        }
    });

    it('can load on an APK without the native push modules', () => {
        const { startChatBackgroundPush, tasks, notifications } = mockAndroid(false);
        expect(startChatBackgroundPush()).toBeUndefined();
        expect(tasks.defineTask).not.toHaveBeenCalled();
        expect(notifications.getDevicePushTokenAsync).not.toHaveBeenCalled();
    });

    it('leaves an APK without Firebase registration on foreground synchronization', async () => {
        const { startChatBackgroundPush, notifications } = mockAndroid(true);
        notifications.getDevicePushTokenAsync.mockRejectedValue(new Error('Firebase is not initialized'));
        const fetch = jest.spyOn(global, 'fetch');
        const stop = startChatBackgroundPush();
        await flush();
        expect(notifications.registerTaskAsync).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
        stop?.();
    });
});
