import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { NotificationResponse } from 'expo-notifications';
import {
    CHAT_NOTIFICATION_CHANNEL, chatServerIdentity, clearVisibleChatNotifications, getSystemNotificationRoute,
    notifyChatReplies, notifyPushedChatReplies, pushedReplyIds, removeLegacyChatNotificationChannel,
    setChatNotificationPermission, setSystemNotificationEnrollment, startChatNotifications,
} from '../src/services/chatNotifications';
import { useAssistantStore } from '../src/store/useAssistantStore';
import { useSettingsStore } from '../src/store/useSettingsStore';
import type { AssistantMessage } from '../src/types/assistantProtocol';
import i18n from '../src/i18n';

const mockSchedule = jest.fn();
const mockGetPermissions = jest.fn();
const mockRequestPermissions = jest.fn();
const mockSetChannel = jest.fn();
const mockDeleteChannel = jest.fn();
const mockDismissAll = jest.fn();
const mockClearResponse = jest.fn();
const mockListenResponse = jest.fn();
const mockSetHandler = jest.fn();

jest.mock('../src/services/chatPushModules', () => ({
    pushModules: {
        notifications: {
            DEFAULT_ACTION_IDENTIFIER: 'default',
            AndroidImportance: { HIGH: 4 },
            setNotificationChannelAsync: (...args: unknown[]) => mockSetChannel(...args),
            deleteNotificationChannelAsync: (...args: unknown[]) => mockDeleteChannel(...args),
            dismissAllNotificationsAsync: () => mockDismissAll(),
            getPermissionsAsync: () => mockGetPermissions(),
            requestPermissionsAsync: () => mockRequestPermissions(),
            scheduleNotificationAsync: (...args: unknown[]) => mockSchedule(...args),
            setNotificationHandler: (...args: unknown[]) => mockSetHandler(...args),
            addNotificationResponseReceivedListener: (...args: unknown[]) => mockListenResponse(...args),
            getLastNotificationResponse: () => null,
            clearLastNotificationResponse: () => mockClearResponse(),
        },
    },
}));

const reply = (id: string): AssistantMessage => ({
    id, status: 'done', role: 'assistant', content: '# 本周汇报\n\n已经整理完毕。', timestamp: 1, seq: 4,
});

let testAccount = 0;
let stop: (() => void) | undefined;

beforeEach(async () => {
    jest.clearAllMocks();
    await Promise.resolve();
    Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
    useAssistantStore.setState({ credentialsStatus: 'ready', serverUrl: 'https://server.test',
        serverToken: 'test-' + ++testAccount, connectionState: 'connected', messages: [], currentSeq: 0 });
    useSettingsStore.setState({ hasHydrated: true, chatNotificationsEnabled: true, chatNotificationPreview: true });
    mockGetPermissions.mockResolvedValue({ granted: true });
    mockDeleteChannel.mockResolvedValue(undefined);
    mockSetChannel.mockResolvedValue(undefined);
    mockDismissAll.mockResolvedValue(undefined);
    mockListenResponse.mockReturnValue({ remove: jest.fn() });
});
afterEach(() => { stop?.(); stop = undefined; });

it('requests system permission before enabling notifications without changing previews', async () => {
    useSettingsStore.setState({ chatNotificationsEnabled: false });
    mockGetPermissions.mockResolvedValue({ granted: false, canAskAgain: true });
    mockRequestPermissions.mockResolvedValueOnce({ granted: false }).mockResolvedValueOnce({ granted: true });
    await setChatNotificationPermission(true);
    expect(useSettingsStore.getState().chatNotificationsEnabled).toBe(false);
    await setChatNotificationPermission(true);
    expect(useSettingsStore.getState().chatNotificationsEnabled).toBe(true);
    expect(useSettingsStore.getState().chatNotificationPreview).toBe(true);
});

it('displays one preview when push and live synchronization deliver the same finished reply', async () => {
    const open = jest.fn();
    stop = startChatNotifications(() => false, open);
    const message = reply('one');
    useAssistantStore.setState({ messages: [{ ...message, status: 'processing' }] });
    useAssistantStore.setState({ messages: [message] });
    await notifyChatReplies([message]);

    expect(mockSchedule).toHaveBeenCalledTimes(1);
    const request = mockSchedule.mock.calls[0][0];
    expect(request.content.body).toBe('本周汇报 已经整理完毕。');
    expect(request.content.title).toBe(i18n.t('chatNotifications.title'));
    expect(request.trigger).toEqual({ channelId: CHAT_NOTIFICATION_CHANNEL });
    expect(mockDeleteChannel).not.toHaveBeenCalled();
    expect(mockSetChannel).toHaveBeenCalledWith(CHAT_NOTIFICATION_CHANNEL, {
        name: i18n.t('chatNotifications.enabled'),
        importance: 4,
        enableVibrate: true,
        showBadge: true,
    });
    await removeLegacyChatNotificationChannel();
    expect(mockDeleteChannel).toHaveBeenCalledWith('chat-messages');
    const onResponse = mockListenResponse.mock.calls[0][0] as (response: NotificationResponse) => void;
    onResponse({ actionIdentifier: 'default', notification: { date: Date.now(), request } });
    await Promise.resolve();
    expect(mockClearResponse).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith({ messageId: 'one',
        serverIdentity: chatServerIdentity('https://server.test', 'test-' + testAccount) });
});

it('uses the system notification for enrolled task reports and opens the correct reply on a tap', async () => {
    const open = jest.fn();
    let viewingChat = false;
    stop = startChatNotifications(() => viewingChat, open);
    const identity = chatServerIdentity('https://server.test', 'test-' + testAccount);
    const routeId = 'ab'.repeat(16);
    await AsyncStorage.setItem('lvtian-task-notification-device:' + identity, routeId);
    await AsyncStorage.setItem('lvtian-task-notification-route:' + routeId, identity);
    expect(await getSystemNotificationRoute(identity)).toBe(routeId);
    const report: AssistantMessage = { ...reply('report'), source: 'native_task_report' };
    await setSystemNotificationEnrollment(identity, '1');
    await notifyChatReplies([report, reply('regular')]);
    expect(mockSchedule).toHaveBeenCalledTimes(1);
    expect(mockSchedule.mock.calls[0][0].content.data.messageId).toBe('regular');

    const notification = {
        date: Date.now(),
        request: {
            identifier: 'native-notice',
            trigger: null,
            content: { title: '绿天', body: '你有一条新消息', data: { type: 'lvtian_task_report', messageId: report.id, routeId } },
        },
    };
    const handler = mockSetHandler.mock.calls[0][0];
    await expect(handler.handleNotification(notification)).resolves.toMatchObject({ shouldShowBanner: true });
    viewingChat = true;
    await expect(handler.handleNotification(notification)).resolves.toMatchObject({ shouldShowBanner: false });
    const onResponse = mockListenResponse.mock.calls[0][0];
    onResponse({ actionIdentifier: 'default', notification });
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
    expect(open).toHaveBeenCalledWith({ messageId: report.id, serverIdentity: identity });

    viewingChat = false;
    await setSystemNotificationEnrollment(identity, undefined);
    await notifyChatReplies([report]);
    expect(mockSchedule).toHaveBeenCalledTimes(2);
});

it('lets the system own all completed replies while foreground notifications can show a cached preview', async () => {
    const open = jest.fn();
    let viewingChat = false;
    stop = startChatNotifications(() => viewingChat, open);
    const identity = chatServerIdentity('https://server.test', 'test-' + testAccount);
    const routeId = 'cd'.repeat(16);
    await AsyncStorage.setItem('lvtian-task-notification-route:' + routeId, identity);
    await setSystemNotificationEnrollment(identity, '2');
    const regular = reply('regular-system');
    const report: AssistantMessage = { ...reply('task-system'), source: 'native_task_report' };
    const job: AssistantMessage = { ...reply('job-system'), source: 'autonomous_job_reply' };
    await notifyChatReplies([regular, report, job]);
    const getReply = jest.spyOn(global, 'fetch');
    try {
        await notifyPushedChatReplies([regular.id, report.id, job.id]);
        expect(getReply).not.toHaveBeenCalled();
    } finally {
        getReply.mockRestore();
    }
    expect(mockSchedule).not.toHaveBeenCalled();

    const notification = {
        date: Date.now(),
        request: {
            identifier: 'system-reply',
            trigger: null,
            content: { title: '绿天', body: '你有一条新消息', data: { type: 'lvtian_system_chat_reply', messageId: regular.id, routeId } },
        },
    };
    const handler = mockSetHandler.mock.calls[0][0];
    await expect(handler.handleNotification(notification)).resolves.toMatchObject({ shouldShowBanner: true });
    useAssistantStore.setState({ messages: [regular] });
    viewingChat = true;
    await expect(handler.handleNotification(notification)).resolves.toMatchObject({ shouldShowBanner: false });
    expect(mockSchedule).not.toHaveBeenCalled();
    viewingChat = false;
    await expect(handler.handleNotification(notification)).resolves.toMatchObject({ shouldShowBanner: false });
    expect(mockSchedule).toHaveBeenCalledTimes(1);
    expect(mockSchedule.mock.calls[0][0].content.body).toBe('本周汇报 已经整理完毕。');

    const previewNotice = {
        date: Date.now(),
        request: {
            identifier: 'system-reply-preview',
            trigger: null,
            content: {
                title: '绿天',
                body: '本周汇报 已经整理完毕。',
                data: { type: 'lvtian_system_chat_reply', messageId: regular.id, routeId },
            },
        },
    };
    await expect(handler.handleNotification(previewNotice)).resolves.toMatchObject({ shouldShowBanner: true });
    expect(mockSchedule).toHaveBeenCalledTimes(1);

    useSettingsStore.setState({ chatNotificationPreview: false });
    await expect(handler.handleNotification(previewNotice)).resolves.toMatchObject({ shouldShowBanner: false });
    expect(mockSchedule).toHaveBeenCalledTimes(2);
    expect(mockSchedule.mock.calls[1][0].content.body).toBe(i18n.t('chatNotifications.newMessage'));
    useSettingsStore.setState({ chatNotificationPreview: true });

    const onResponse = mockListenResponse.mock.calls[0][0];
    onResponse({ actionIdentifier: 'default', notification });
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
    expect(open).toHaveBeenCalledWith({ messageId: regular.id, serverIdentity: identity });
});

it('dismisses tray notifications only when the app is active on main chat', async () => {
    let viewingChat = true;
    const listeners: Array<(state: string) => void> = [];
    const addListener = jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, handler) => {
        listeners.push(handler as (state: string) => void);
        return { remove: jest.fn() } as unknown as ReturnType<typeof AppState.addEventListener>;
    });
    try {
        stop = startChatNotifications(() => viewingChat, jest.fn());
        expect(mockDismissAll).toHaveBeenCalledTimes(1);

        Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'background' });
        await clearVisibleChatNotifications();
        expect(mockDismissAll).toHaveBeenCalledTimes(1);

        Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
        viewingChat = false;
        await clearVisibleChatNotifications();
        expect(mockDismissAll).toHaveBeenCalledTimes(1);

        viewingChat = true;
        listeners.forEach(listener => listener('active'));
        await Promise.resolve();
        expect(mockDismissAll).toHaveBeenCalledTimes(2);
    } finally {
        addListener.mockRestore();
    }
});

it('suppresses replies read in open chat and hides text when previews are off', async () => {
    let viewingChat = true;
    stop = startChatNotifications(() => viewingChat, jest.fn());
    await notifyChatReplies([reply('read')]);
    viewingChat = false;
    await notifyChatReplies([reply('read')]);
    expect(mockSchedule).not.toHaveBeenCalled();

    useSettingsStore.setState({ chatNotificationPreview: false });
    await notifyChatReplies([reply('new')]);
    expect(mockSchedule).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.objectContaining({ body: i18n.t('chatNotifications.newMessage') }),
    }));
});

it('parses only bounded message IDs from the data-only push', () => {
    expect(pushedReplyIds('["reply",42,null,""]')).toEqual(['reply']);
    expect(pushedReplyIds('bad-json')).toEqual([]);
});

it('provides notification copy in both supported UI languages', () => {
    const zh = i18n.getFixedT('zh');
    const en = i18n.getFixedT('en');
    expect(zh('chatNotifications.title')).toBe('绿天');
    expect(zh('chatNotifications.newMessage')).toBe('你有一条新消息');
    expect(en('chatNotifications.title')).toBe('Lvtian');
    expect(en('chatNotifications.newMessage')).toBe('You have a new message');
});
