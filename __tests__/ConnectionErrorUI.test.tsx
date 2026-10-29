import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { ActivityIndicator, Alert, Text, TextInput, TouchableOpacity } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { ConnectionConfigError } from '../src/services/connectionConfig';
import { ChatScreen } from '../src/screens/ChatScreen';
import { AssistantConfigScreen } from '../src/screens/AssistantConfigScreen';
import { AssistantClient } from '../src/services/AssistantClient';
import { useAssistantStore } from '../src/store/useAssistantStore';
import { connectionErrorKey } from '../src/utils/connectionErrorPresentation';
import i18n from '../src/i18n';

jest.mock('expo-secure-store', () => ({ getItemAsync: jest.fn(), setItemAsync: jest.fn(), deleteItemAsync: jest.fn() }));
const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
    ...jest.requireActual('@react-navigation/native'),
    useNavigation: () => ({ setOptions: jest.fn(), navigate: mockNavigate }),
}));

const realLoad = useAssistantStore.getState().loadSavedCredentials;
const realSave = useAssistantStore.getState().setServerConfig;
const connectionMessage = '读取连接配置失败，请重试；已保存的配置未被清除。';
const tokenMessage = '读取访问令牌失败，请重试；已保存的令牌未被清除。';
const chatMessage = '读取聊天缓存失败，请重试。';

describe('connection storage failure presentation', () => {
    let renderer: ReactTestRenderer.ReactTestRenderer | undefined;
    let connect: jest.SpyInstance;
    const texts = () => renderer!.root.findAllByType(Text).map(node => node.props.children);
    const press = async (label: string) => {
        const button = renderer!.root.findAllByType(TouchableOpacity).find(node =>
            node.findAllByType(Text).some(text => text.props.children === label));
        expect(button).toBeDefined();
        await act(async () => { await button!.props.onPress(); });
    };
    beforeEach(async () => {
        jest.clearAllMocks();
        await i18n.changeLanguage('zh');
        // Let the independent module-level initialization settle before each fixture.
        await Promise.resolve(); await Promise.resolve();
        connect = jest.spyOn(AssistantClient.getInstance(), 'connect').mockResolvedValue(undefined);
        useAssistantStore.setState({ serverUrl: '', serverToken: '', credentialsStatus: 'ready', credentialsError: null,
            hasHydrated: true, chatHydrationError: null, chatCacheError: null, messages: [], pendingApprovals: [],
            connectionState: 'disconnected', connectionError: null, taskState: 'idle', loadSavedCredentials: realLoad });
    });
    afterEach(async () => {
        if (renderer) await act(async () => { renderer!.unmount(); });
        renderer = undefined;
        jest.restoreAllMocks();
        useAssistantStore.setState({ loadSavedCredentials: realLoad, setServerConfig: realSave });
    });

    it.each([
        ['connection_config_read_failed', connectionMessage],
        ['credentials_read_failed', tokenMessage],
    ] as const)('shows %s distinctly from unconfigured and retries without exposing errors', async (code, message) => {
        const load = jest.fn(async () => {
            useAssistantStore.setState({ credentialsStatus: 'ready', credentialsError: null,
                serverUrl: 'https://saved.test', serverToken: 'saved' });
            return { url: 'https://saved.test', token: 'saved' };
        });
        useAssistantStore.setState({ credentialsStatus: 'error', credentialsError: code, loadSavedCredentials: load });
        await act(async () => { renderer = ReactTestRenderer.create(<ChatScreen />); });
        expect(texts()).toContain(message);
        expect(texts()).not.toContain('尚未连接绿天助理服务');
        expect(renderer!.root.findAllByType(TextInput)).toHaveLength(0);
        expect(connect).not.toHaveBeenCalled();
        await press('重试');
        expect(load).toHaveBeenCalledTimes(1);
        expect(connect).toHaveBeenCalled();
        expect(texts()).not.toContain(message);
    });

    it('credential loading shows a spinner, not an empty configuration guide', async () => {
        useAssistantStore.setState({ credentialsStatus: 'loading' });
        await act(async () => { renderer = ReactTestRenderer.create(<ChatScreen />); });
        expect(renderer!.root.findAllByType(ActivityIndicator)).toHaveLength(1);
        expect(renderer!.root.findAllByType(TextInput)).toHaveLength(0);
        expect(texts()).not.toContain('尚未连接绿天助理服务');
        expect(connect).not.toHaveBeenCalled();
    });

    it('successful loading with genuinely absent settings shows the configuration guide', async () => {
        await act(async () => { renderer = ReactTestRenderer.create(<ChatScreen />); });
        expect(texts()).toContain('尚未连接绿天助理服务');
        expect(texts()).toContain('前往配置服务');
        expect(texts()).not.toContain(connectionMessage);
        expect(renderer!.root.findAllByType(ActivityIndicator)).toHaveLength(0);
        expect(connect).not.toHaveBeenCalled();
    });

    it('failed credential retry remains an explicit error without an automatic retry loop', async () => {
        const load = jest.fn(async () => {
            useAssistantStore.setState({ credentialsStatus: 'error', credentialsError: 'credentials_read_failed' });
            throw new ConnectionConfigError('credentials_read_failed');
        });
        useAssistantStore.setState({ credentialsStatus: 'error', credentialsError: 'credentials_read_failed', loadSavedCredentials: load });
        await act(async () => { renderer = ReactTestRenderer.create(<ChatScreen />); });
        expect(load).not.toHaveBeenCalled();
        await press('重试');
        expect(load).toHaveBeenCalledTimes(1);
        expect(texts()).toContain(tokenMessage);
        expect(renderer!.root.findAllByType(TextInput)).toHaveLength(0);
        expect(connect).not.toHaveBeenCalled();
    });

    it('pending chat read does not expose a composer that late hydration could overwrite', async () => {
        useAssistantStore.setState({ serverUrl: 'https://saved.test', hasHydrated: false });
        await act(async () => { renderer = ReactTestRenderer.create(<ChatScreen />); });
        expect(renderer!.root.findAllByType(TextInput)).toHaveLength(0);
        expect(renderer!.root.findAllByType(ActivityIndicator)).toHaveLength(1);
        expect(texts()).not.toContain('尚未连接绿天助理服务');
        expect(connect).not.toHaveBeenCalled();
        await act(async () => { useAssistantStore.setState({ hasHydrated: true }); });
        expect(renderer!.root.findAllByType(TextInput)).toHaveLength(1);
        expect(connect).toHaveBeenCalled();
    });

    it('failed cache read blocks the composer and retries before connecting', async () => {
        useAssistantStore.setState({ serverUrl: 'https://saved.test', serverToken: 'saved', chatHydrationError: 'chat_hydration_failed' });
        const rehydrate = jest.spyOn(useAssistantStore.persist, 'rehydrate').mockImplementation(async () => {
            expect(connect).not.toHaveBeenCalled();
            useAssistantStore.setState({ chatHydrationError: null });
        });
        await act(async () => { renderer = ReactTestRenderer.create(<ChatScreen />); });
        expect(texts()).toContain(chatMessage);
        expect(renderer!.root.findAllByType(TextInput)).toHaveLength(0);
        expect(connect).not.toHaveBeenCalled();
        await press('重试');
        expect(rehydrate).toHaveBeenCalledTimes(1);
        expect(connect).toHaveBeenCalled();
        expect(texts()).not.toContain(chatMessage);
        expect(renderer!.root.findAllByType(TextInput)).toHaveLength(1);
    });

    it('a failed cache retry stays an error and never opens a connection', async () => {
        useAssistantStore.setState({ serverUrl: 'https://saved.test', chatHydrationError: 'chat_hydration_failed' });
        jest.spyOn(useAssistantStore.persist, 'rehydrate').mockResolvedValue(undefined);
        await act(async () => { renderer = ReactTestRenderer.create(<ChatScreen />); });
        await press('重试');
        expect(texts()).toContain(chatMessage);
        expect(renderer!.root.findAllByType(TextInput)).toHaveLength(0);
        expect(connect).not.toHaveBeenCalled();
    });

    it('cache write failure is not mislabeled as a read failure', async () => {
        useAssistantStore.setState({ serverUrl: 'https://saved.test', serverToken: 'saved', chatCacheError: 'chat_cache_write_failed' });
        await act(async () => { renderer = ReactTestRenderer.create(<ChatScreen />); });
        expect(texts()).toContain('保存失败');
        expect(texts()).not.toContain(chatMessage);
        await press('重试');
        expect(useAssistantStore.getState().chatCacheError).toBeNull();
    });

    it.each([
        ['connection_config_read_failed', connectionMessage],
        ['credentials_read_failed', tokenMessage],
    ] as const)('settings shows %s and does not claim the configuration is absent', async (code, message) => {
        const load = jest.fn(async () => {
            useAssistantStore.setState({ credentialsStatus: 'ready', credentialsError: null,
                serverUrl: 'https://saved.test', serverToken: 'saved' });
            return { url: 'https://saved.test', token: 'saved' };
        });
        useAssistantStore.setState({ credentialsStatus: 'error', credentialsError: code, loadSavedCredentials: load });
        await act(async () => { renderer = ReactTestRenderer.create(<AssistantConfigScreen />); });
        expect(texts()).toContain(message);
        expect(texts()).not.toContain('未配置服务地址');
        await press('重试');
        expect(load).toHaveBeenCalledTimes(1);
        expect(texts()).not.toContain(message);
    });

    it('valid clipboard input with a storage write failure reports save failure, not clipboard failure', async () => {
        const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
        jest.spyOn(Clipboard, 'getStringAsync').mockResolvedValue('https://saved.test?token=test-token');
        const save = jest.fn().mockRejectedValue(new ConnectionConfigError('credentials_write_failed'));
        useAssistantStore.setState({ setServerConfig: save });
        await act(async () => { renderer = ReactTestRenderer.create(<ChatScreen />); });
        await press('一键粘贴完整配置链接');
        expect(save).toHaveBeenCalledWith('https://saved.test', 'test-token');
        expect(alert).toHaveBeenCalledWith('错误', '保存配置失败');
        expect(alert.mock.calls.some(call => call[1] === '读取剪贴板失败')).toBe(false);
        expect(alert.mock.calls.some(call => call[1] === '已成功解析并应用配置')).toBe(false);
        expect(connect).not.toHaveBeenCalled();
    });

    it('does not mislabel failed writes or rollback as read failures', () => {
        expect(connectionErrorKey('credentials_rollback_failed')).toBe('assistant.saveFailed');
        expect(connectionErrorKey('connection_config_write_failed')).toBe('assistant.saveFailed');
        expect(connectionErrorKey('credentials_write_failed')).toBe('assistant.saveFailed');
    });
});
