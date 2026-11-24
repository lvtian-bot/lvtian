import { AppState } from 'react-native';
import type { NotificationResponse } from 'expo-notifications';
import {
    chatServerIdentity, notifyChatReplies, pushedReplyIds, setChatNotificationPermission,
    startChatNotifications,
} from '../src/services/chatNotifications';
import { useAssistantStore } from '../src/store/useAssistantStore';
import { useSettingsStore } from '../src/store/useSettingsStore';
import type { AssistantMessage } from '../src/types/assistantProtocol';
import i18n from '../src/i18n';

const mockSchedule = jest.fn();
const mockGetPermissions = jest.fn();
const mockRequestPermissions = jest.fn();
const mockSetChannel = jest.fn();
const mockClearResponse = jest.fn();
const mockListenResponse = jest.fn();

jest.mock('../src/services/chatPushModules', () => ({
    pushModules: {
        notifications: {
            DEFAULT_ACTION_IDENTIFIER: 'default',
            AndroidImportance: { HIGH: 4 },
            AndroidNotificationVisibility: { PRIVATE: 0 },
            setNotificationChannelAsync: (...args: unknown[]) => mockSetChannel(...args),
            getPermissionsAsync: () => mockGetPermissions(),
            requestPermissionsAsync: () => mockRequestPermissions(),
            scheduleNotificationAsync: (...args: unknown[]) => mockSchedule(...args),
            setNotificationHandler: jest.fn(),
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
    expect(mockSetChannel).toHaveBeenCalledWith('chat-messages', expect.objectContaining({ lockscreenVisibility: 0 }));
    const onResponse = mockListenResponse.mock.calls[0][0] as (response: NotificationResponse) => void;
    onResponse({ actionIdentifier: 'default', notification: { date: Date.now(), request } });
    expect(mockClearResponse).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith({ messageId: 'one',
        serverIdentity: chatServerIdentity('https://server.test', 'test-' + testAccount) });
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
