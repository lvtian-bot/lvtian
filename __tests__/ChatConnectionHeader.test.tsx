import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { ActivityIndicator, Text, TouchableOpacity } from 'react-native';
import { ChatHeaderTitle } from '../src/components/ChatHeaderTitle';
import { ChatScreen } from '../src/screens/ChatScreen';
import { AssistantClient } from '../src/services/AssistantClient';
import { useAssistantStore } from '../src/store/useAssistantStore';
import {
    CONNECTING_GRACE_MS,
    MIN_STATUS_VISIBLE_MS,
    UNREACHABLE_BANNER_DELAY_MS,
} from '../src/utils/chatConnectionPresentation';
import i18n from '../src/i18n';

const mockNavigate = jest.fn();
const mockSetOptions = jest.fn();

jest.mock('@react-navigation/native', () => {
    const actual = jest.requireActual('@react-navigation/native');
    return {
        ...actual,
        useNavigation: () => ({
            setOptions: mockSetOptions,
            navigate: mockNavigate,
        }),
    };
});

describe('ChatConnectionHeader 与主聊天分级连接提示', () => {
    let headerRenderer: ReactTestRenderer.ReactTestRenderer | undefined;
    let screenRenderer: ReactTestRenderer.ReactTestRenderer | undefined;

    const headerTexts = () =>
        headerRenderer!.root.findAllByType(Text).map((node) => node.props.children);
    const hasHeaderSpinner = () =>
        headerRenderer!.root.findAllByType(ActivityIndicator).length > 0;
    const screenTexts = () =>
        screenRenderer!.root.findAllByType(Text).map((node) => node.props.children);

    beforeEach(async () => {
        jest.useFakeTimers();
        jest.clearAllMocks();
        await i18n.changeLanguage('zh');
        jest.spyOn(AssistantClient.getInstance(), 'connect').mockResolvedValue(undefined);
        await act(async () => {
            useAssistantStore.setState({
                serverUrl: 'https://server.test',
                serverToken: 'token',
                credentialsStatus: 'ready',
                credentialsError: null,
                connectionState: 'disconnected',
                connectionPhase: null,
                connectionError: null,
                connectionErrorKind: null,
                isNetworkOffline: false,
                isServerUpgrading: false,
                messages: [],
                taskState: 'idle',
                pendingApprovals: [],
                pendingSendQueue: [],
            });
        });
    });

    afterEach(async () => {
        if (headerRenderer) {
            await act(async () => {
                headerRenderer?.unmount();
            });
            headerRenderer = undefined;
        }
        if (screenRenderer) {
            await act(async () => {
                screenRenderer?.unmount();
            });
            screenRenderer = undefined;
        }
        jest.restoreAllMocks();
        jest.useRealTimers();
    });

    it('常规建连 2 秒内完成时顶栏静默保持标题，聊天区不弹横幅', async () => {
        await act(async () => {
            useAssistantStore.setState({ connectionState: 'connecting', connectionPhase: 'handshake' });
            headerRenderer = ReactTestRenderer.create(<ChatHeaderTitle />);
            screenRenderer = ReactTestRenderer.create(<ChatScreen />);
        });

        expect(headerTexts()).toEqual(['主聊天']);
        expect(hasHeaderSpinner()).toBe(false);
        expect(screenTexts()).not.toContain('暂时无法连接服务');

        await act(async () => {
            jest.advanceTimersByTime(CONNECTING_GRACE_MS - 1);
        });
        expect(headerTexts()).toEqual(['主聊天']);
        expect(hasHeaderSpinner()).toBe(false);

        await act(async () => {
            useAssistantStore.getState().setConnectionState('connected');
        });
        expect(headerTexts()).toEqual(['主聊天']);
        expect(hasHeaderSpinner()).toBe(false);
        expect(screenRenderer!.root.findAllByProps({ testID: 'chat-unreachable-banner' })).toHaveLength(0);
    });

    it('超过 2 秒未连上时顶栏切换为连接中，进入 sync 阶段切换为更新中，且最短停留 0.6 秒防闪烁', async () => {
        await act(async () => {
            useAssistantStore.setState({ connectionState: 'connecting', connectionPhase: 'handshake' });
            headerRenderer = ReactTestRenderer.create(<ChatHeaderTitle />);
            screenRenderer = ReactTestRenderer.create(<ChatScreen />);
        });

        // 连续状态流转不应重置 2 秒宽限计时器
        await act(async () => {
            jest.advanceTimersByTime(1000);
            useAssistantStore.getState().setConnectionState('reconnecting');
            useAssistantStore.getState().setConnectionPhase('authentication');
        });
        expect(headerTexts()).toEqual(['主聊天']);

        await act(async () => {
            jest.advanceTimersByTime(CONNECTING_GRACE_MS - 1000);
        });
        expect(headerTexts()).toEqual(['连接中…']);
        expect(hasHeaderSpinner()).toBe(true);
        expect(screenRenderer!.root.findAllByProps({ testID: 'chat-unreachable-banner' })).toHaveLength(0);

        await act(async () => {
            useAssistantStore.getState().setConnectionPhase('sync');
        });
        expect(headerTexts()).toEqual(['更新中…']);
        expect(hasHeaderSpinner()).toBe(true);

        // 刚展示 200ms 就连上：仍需保持剩余 400ms 再切回「主聊天」
        await act(async () => {
            jest.advanceTimersByTime(200);
            useAssistantStore.getState().setConnectionState('connected');
        });
        expect(headerTexts()).toEqual(['更新中…']);
        expect(hasHeaderSpinner()).toBe(true);

        await act(async () => {
            jest.advanceTimersByTime(MIN_STATUS_VISIBLE_MS - 200 - 1);
        });
        expect(headerTexts()).toEqual(['更新中…']);

        await act(async () => {
            jest.advanceTimersByTime(1);
        });
        expect(headerTexts()).toEqual(['主聊天']);
        expect(hasHeaderSpinner()).toBe(false);
    });

    it('手机明确无网络时立即在顶栏提示等待网络，不弹横幅', async () => {
        await act(async () => {
            useAssistantStore.setState({ isNetworkOffline: true, connectionState: 'disconnected' });
            headerRenderer = ReactTestRenderer.create(<ChatHeaderTitle />);
            screenRenderer = ReactTestRenderer.create(<ChatScreen />);
        });

        expect(headerTexts()).toEqual(['等待网络…']);
        expect(hasHeaderSpinner()).toBe(true);

        await act(async () => {
            jest.advanceTimersByTime(UNREACHABLE_BANNER_DELAY_MS + 1000);
        });
        expect(screenRenderer!.root.findAllByProps({ testID: 'chat-unreachable-banner' })).toHaveLength(0);
        expect(screenRenderer!.root.findAllByProps({ testID: 'chat-auth-error-banner' })).toHaveLength(0);
    });

    it('有网但持续连不上满 8 秒时展示重连横幅，点击重试收起横幅并保持顶栏连接中', async () => {
        const connectSpy = jest.spyOn(AssistantClient.getInstance(), 'connect').mockResolvedValue(undefined);
        await act(async () => {
            useAssistantStore.setState({ connectionState: 'reconnecting', connectionPhase: 'handshake' });
            headerRenderer = ReactTestRenderer.create(<ChatHeaderTitle />);
            screenRenderer = ReactTestRenderer.create(<ChatScreen />);
        });

        await act(async () => {
            jest.advanceTimersByTime(UNREACHABLE_BANNER_DELAY_MS - 1);
        });
        expect(screenRenderer!.root.findAllByProps({ testID: 'chat-unreachable-banner' })).toHaveLength(0);

        await act(async () => {
            jest.advanceTimersByTime(1);
        });
        expect(headerTexts()).toEqual(['连接中…']);
        expect(screenTexts()).toContain('暂时无法连接服务');
        expect(screenTexts()).toContain('重试');

        const retryBtn = screenRenderer!.root.findAllByType(TouchableOpacity).find((node) =>
            node.findAllByType(Text).some((t) => t.props.children === '重试'));
        expect(retryBtn).toBeDefined();

        await act(async () => {
            retryBtn!.props.onPress();
        });
        expect(connectSpy).toHaveBeenCalledWith(true);
        expect(screenRenderer!.root.findAllByProps({ testID: 'chat-unreachable-banner' })).toHaveLength(0);
        expect(headerTexts()).toEqual(['连接中…']);

        // 若仍连不上，再满 8 秒后重新提示
        await act(async () => {
            jest.advanceTimersByTime(UNREACHABLE_BANNER_DELAY_MS);
        });
        expect(screenTexts()).toContain('暂时无法连接服务');
        expect(screenTexts()).toContain('重试');
    });

    it('认证失败时顶栏保持标题不转圈，立即展示错误横幅并提供去设置跳转', async () => {
        await act(async () => {
            useAssistantStore.setState({
                connectionState: 'error',
                connectionError: null,
                connectionErrorKind: 'auth',
            });
            headerRenderer = ReactTestRenderer.create(<ChatHeaderTitle />);
            screenRenderer = ReactTestRenderer.create(<ChatScreen />);
        });

        expect(headerTexts()).toEqual(['主聊天']);
        expect(hasHeaderSpinner()).toBe(false);
        expect(screenTexts()).toContain('访问令牌已失效，请重新配置');
        expect(screenTexts()).toContain('去设置');

        const settingsBtn = screenRenderer!.root.findAllByType(TouchableOpacity).find((node) =>
            node.findAllByType(Text).some((t) => t.props.children === '去设置'));
        expect(settingsBtn).toBeDefined();

        await act(async () => {
            settingsBtn!.props.onPress();
        });
        expect(mockNavigate).toHaveBeenCalledWith('AssistantConfig');
    });

    it('服务端升级中顶栏保持标题不转圈，聊天区仅显示升级横幅', async () => {
        await act(async () => {
            useAssistantStore.setState({
                connectionState: 'reconnecting',
                isServerUpgrading: true,
            });
            headerRenderer = ReactTestRenderer.create(<ChatHeaderTitle />);
            screenRenderer = ReactTestRenderer.create(<ChatScreen />);
        });

        await act(async () => {
            jest.advanceTimersByTime(UNREACHABLE_BANNER_DELAY_MS);
        });
        expect(headerTexts()).toEqual(['主聊天']);
        expect(hasHeaderSpinner()).toBe(false);
        expect(screenTexts().some((t) => typeof t === 'string' && /服务端正在升级/.test(t))).toBe(true);
        expect(screenRenderer!.root.findAllByProps({ testID: 'chat-unreachable-banner' })).toHaveLength(0);
    });

    it('未配置服务或凭据异常时顶栏保持标题不转圈', async () => {
        await act(async () => {
            useAssistantStore.setState({
                serverUrl: '',
                credentialsStatus: 'ready',
                connectionState: 'disconnected',
                isNetworkOffline: true,
            });
            headerRenderer = ReactTestRenderer.create(<ChatHeaderTitle />);
        });
        expect(headerTexts()).toEqual(['主聊天']);
        expect(hasHeaderSpinner()).toBe(false);

        await act(async () => {
            useAssistantStore.setState({
                serverUrl: 'https://server.test',
                credentialsStatus: 'error',
                credentialsError: 'credentials_read_failed',
            });
            jest.advanceTimersByTime(CONNECTING_GRACE_MS + 1000);
        });
        expect(headerTexts()).toEqual(['主聊天']);
        expect(hasHeaderSpinner()).toBe(false);
    });
});
