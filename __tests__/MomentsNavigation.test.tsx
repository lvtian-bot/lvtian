import React from 'react';
import Renderer, { act } from 'react-test-renderer';
import { Alert, AppState, FlatList, Linking, type AppStateStatus } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { NavigationContainer } from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { fetch } from 'expo/fetch';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';

import { TabNavigator } from '../src/navigation/TabNavigator';
import { useAssistantStore } from '../src/store/useAssistantStore';

jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
jest.mock('../src/screens/ChatScreen', () => ({ ChatScreen: () => null }));
jest.mock('../src/screens/FlashScreen', () => ({ FlashScreen: () => null }));
jest.mock('../src/screens/TodoScreen', () => ({ TodoScreen: () => null }));
jest.mock('../src/screens/MeScreen', () => ({ MeScreen: () => null }));
jest.mock('../src/screens/WorkRecordsScreen', () => ({ WorkRecordsScreen: () => null }));

// Only the native pager/stack hosts are unavailable in Jest. The material tab
// navigator, focus effects, summary screen and service use their real code.
jest.mock('react-native-tab-view', () => ({
    TabView: ({ navigationState, renderTabBar, renderScene, onIndexChange }: {
        navigationState: { index: number; routes: { key: string; name: string }[] };
        renderTabBar: (props: object) => React.ReactNode;
        renderScene: (props: { route: object }) => React.ReactNode;
        onIndexChange: (index: number) => void;
    }) => {
        const ReactModule = require('react');
        const { View: Box } = require('react-native');
        const tabProps = { navigationState, jumpTo: (key: string) => onIndexChange(
            navigationState.routes.findIndex(route => route.key === key),
        ) };
        return ReactModule.createElement(Box, null, renderTabBar(tabProps),
            navigationState.routes.map(route => ReactModule.createElement(Box, { key: route.key }, renderScene({ route }))));
    },
    TabBar: ({ navigationState, options, onTabPress, jumpTo }: {
        navigationState: { routes: { key: string; name: string }[] };
        options: Record<string, { labelText: string }>;
        onTabPress: (event: { route: { key: string }; preventDefault: () => void }) => void;
        jumpTo: (key: string) => void;
    }) => {
        const ReactModule = require('react');
        const { Pressable: Button, Text: Label, View: Box } = require('react-native');
        return ReactModule.createElement(Box, null, navigationState.routes.map(route => ReactModule.createElement(Button, {
            key: route.key, testID: `tab-${route.name}`,
            onPress: () => {
                let prevented = false;
                onTabPress({ route, preventDefault: () => { prevented = true; } });
                if (!prevented) jumpTo(route.key);
            },
        }, ReactModule.createElement(Label, null, options[route.key].labelText))));
    },
}));

jest.mock('@react-navigation/native-stack', () => {
    const ReactModule = require('react');
    const { createNavigatorFactory, useNavigationBuilder, StackRouter } = jest.requireActual('@react-navigation/native');
    const { Text: Label } = require('react-native');
    function NativeStack(props: object) {
        const { state, descriptors, NavigationContent } = useNavigationBuilder(StackRouter, props);
        const descriptor = descriptors[state.routes[state.index].key];
        return ReactModule.createElement(NavigationContent, null,
            ReactModule.createElement(Label, { testID: 'stack-header' }, descriptor.options.title),
            descriptor.render(),
        );
    }
    return { createNativeStackNavigator: createNavigatorFactory(NativeStack) };
});

const first = {
    id: '2026/11/latest.md', title: '最近剪藏', clippedAt: Date.parse('2026-11-28T09:00:00Z'),
    sourceUrl: 'https://example.com/article',
    summary: '## 摘要标题\n\n发布时间：2025-10-01\n\n**完整摘要末尾**', revision: 'first',
};
const second = {
    ...first, id: '2026/10/previous.md', title: '历史剪藏原名',
    clippedAt: first.clippedAt - 3 * 60 * 60_000, summary: '历史摘要标题', revision: 'second',
};
const page = { items: [first], nextCursor: 'next-page', canEditSummary: true };
const response = (data: object) => ({ ok: true, redirected: false, json: async () => data }) as Awaited<ReturnType<typeof fetch>>;
const i18n = createInstance();
const mockFetch = jest.mocked(fetch);

const metrics = { frame: { x: 0, y: 0, width: 400, height: 800 }, insets: { top: 0, bottom: 0, left: 0, right: 0 } };

describe('从绿天底栏进入动态', () => {
    let renderer: Renderer.ReactTestRenderer;
    const texts = () => renderer.root.findAll(node => String(node.type) === 'Text').map(node => node.props.children);
    const tapTab = async (name = 'Moments') => {
        const tab = renderer.root.findAllByProps({ testID: `tab-${name}` }).find(node => typeof node.props.onPress === 'function');
        if (!tab) throw new Error(`缺少标签：${name}`);
        await act(async () => { tab.props.onPress(); });
    };
    const feed = () => renderer.root.findByType(FlatList);
    const onPull = async () => { await act(async () => { feed().props.onRefresh(); }); };
    const press = async (label: string) => {
        const button = renderer.root.findAllByProps({ accessibilityLabel: label }).find(node => typeof node.props.onPress === 'function');
        if (!button || button.props.disabled) throw new Error(`按钮不可点击：${label}`);
        await act(async () => { button.props.onPress(); });
    };
    beforeAll(async () => {
        await i18n.init({ lng: 'zh', fallbackLng: 'zh', resources: {
            zh: { translation: require('../src/locales/zh.json') }, en: { translation: require('../src/locales/en.json') },
        } });
    });
    beforeEach(async () => {
        await i18n.changeLanguage('zh');
        mockFetch.mockReset();
        await AsyncStorage.clear();
        AppState.currentState = 'active';
        jest.spyOn(Date, 'now').mockReturnValue(first.clippedAt);
        useAssistantStore.setState({ serverUrl: 'https://lvtian.example', serverToken: 'token', credentialsStatus: 'ready' });
    });
    afterEach(async () => {
        if (renderer) await act(async () => renderer.unmount());
        jest.restoreAllMocks();
    });

    const mount = async () => {
        await act(async () => {
            renderer = Renderer.create(<I18nextProvider i18n={i18n}><SafeAreaProvider initialMetrics={metrics}>
                <NavigationContainer><TabNavigator /></NavigationContainer>
            </SafeAreaProvider></I18nextProvider>);
        });
    };

    it('从底栏进入后只显示可点的摘要标题，翻页、重写及确认整篇删除', async () => {
        mockFetch.mockResolvedValueOnce(response(page))
            .mockResolvedValueOnce(response({ ...page, items: [second], nextCursor: null }))
            .mockResolvedValueOnce(response({ item: { ...first, summary: '# 重写后的摘要标题\n\n新正文', revision: 'updated' }, status: 'upload_failed' }))
            .mockResolvedValueOnce(response({ status: 'delete_failed' }));
        const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
        const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
        await mount();
        expect(mockFetch).not.toHaveBeenCalled();
        await tapTab();
        expect(renderer.root.findAllByProps({ testID: 'stack-header' }).some(node => node.props.children === '动态')).toBe(true);
        expect(texts().filter(value => value === '摘要标题')).toHaveLength(1);
        expect(texts()).not.toContain('最近剪藏');
        expect(texts()).toEqual(expect.arrayContaining(['发布时间：2025-10-01', '完整摘要末尾', '刚刚']));
        const title = renderer.root.findAllByProps({ accessibilityRole: 'link' }).find(node => node.props.children === '摘要标题');
        expect(title).toBeDefined();
        await act(async () => { title?.props.onPress(); });
        expect(open).toHaveBeenCalledWith(first.sourceUrl);

        await act(async () => { feed().props.onEndReached(); });
        expect(mockFetch.mock.calls[1][0]).toBe('https://lvtian.example/api/moments?cursor=next-page');
        expect(texts()).toEqual(expect.arrayContaining(['历史摘要标题', '3 小时前']));

        await press('重写');
        expect(mockFetch.mock.calls[2][0]).toBe('https://lvtian.example/api/moments/summary');
        expect(JSON.parse(String(mockFetch.mock.calls[2][1]?.body))).toEqual({ id: first.id, revision: 'first', action: 'regenerate' });
        expect(texts()).toContain('重写后的摘要标题');
        expect(texts()).not.toContain('摘要标题');
        expect(alert).toHaveBeenCalledWith('上传失败', '已成功保存');

        await press('删除');
        expect(mockFetch).toHaveBeenCalledTimes(3);
        expect(alert.mock.lastCall?.[2]?.map(button => button.text)).toEqual(['取消', '删除']);
        await act(async () => { alert.mock.lastCall?.[2]?.[1].onPress?.(); });
        expect(mockFetch.mock.calls[3][0]).toBe('https://lvtian.example/api/moments/delete');
        expect(JSON.parse(String(mockFetch.mock.calls[3][1]?.body))).toEqual({ id: first.id, revision: 'updated' });
        expect(texts()).not.toContain('重写后的摘要标题');
        expect(texts()).toContain('历史摘要标题');
        expect(alert).toHaveBeenCalledWith('错误', '工作区文件已删除，坚果云文件删除失败。');
        await act(async () => { await i18n.changeLanguage('en'); });
        expect(renderer.root.findAllByProps({ testID: 'stack-header' }).some(node => node.props.children === 'Moments')).toBe(true);
        await act(async () => renderer.unmount());
        await mount();
        await tapTab();
        expect(mockFetch).toHaveBeenCalledTimes(4);
        expect(feed().props.data).toEqual([]);
    });

    it('重开先显示缓存，满五分钟仅在前台进入时刷新，加载失败保留缓存', async () => {
        const currentTime = jest.mocked(Date.now);
        let onAppStateChange: ((state: AppStateStatus) => void) | undefined;
        jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, handler) => {
            onAppStateChange = handler;
            return { remove: () => { onAppStateChange = undefined; } };
        });
        const changeAppState = async (state: AppStateStatus) => {
            await act(async () => {
                AppState.currentState = state;
                onAppStateChange?.(state);
            });
        };
        mockFetch.mockResolvedValueOnce(response({ ...page, nextCursor: null }));
        await mount();
        await tapTab();
        expect(mockFetch).toHaveBeenCalledTimes(1);
        await act(async () => renderer.unmount());

        currentTime.mockReturnValue(first.clippedAt + 299_999);
        await mount();
        await tapTab();
        expect(texts()).toContain('摘要标题');
        expect(mockFetch).toHaveBeenCalledTimes(1);

        await tapTab('Chat');
        await changeAppState('background');
        currentTime.mockReturnValue(first.clippedAt + 300_000);
        await tapTab();
        expect(mockFetch).toHaveBeenCalledTimes(1);

        let failRefresh: (reason: Error) => void = () => undefined;
        mockFetch.mockImplementationOnce(() => new Promise((_resolve, reject) => { failRefresh = reject; }));
        await changeAppState('active');
        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(texts()).toContain('摘要标题');
        expect(renderer.root.findAllByProps({ testID: 'moments-refresh' })).not.toHaveLength(0);
        await act(async () => { failRefresh(new Error('offline')); });
        expect(texts()).toContain('摘要标题');
        expect(renderer.root.findAllByProps({ testID: 'moments-refresh' })).toHaveLength(0);

        mockFetch.mockResolvedValueOnce(response({ ...page, items: [second], nextCursor: null }));
        await onPull();
        expect(mockFetch).toHaveBeenCalledTimes(3);
        expect(texts()).toContain('历史摘要标题');
        mockFetch.mockResolvedValueOnce(response({ ...page, nextCursor: null }));
        await onPull();
        expect(mockFetch).toHaveBeenCalledTimes(4);
        expect(texts()).toContain('摘要标题');
    });

    it('已在动态时重按底栏只滚回顶部，切出去再进入才检查刷新期限', async () => {
        const scroll = jest.spyOn(FlatList.prototype, 'scrollToOffset').mockImplementation(() => {});
        mockFetch.mockResolvedValue(response({ ...page, nextCursor: null }));
        await mount();
        await tapTab();
        await act(async () => { await new Promise(requestAnimationFrame); });
        expect(scroll).not.toHaveBeenCalled();
        jest.mocked(Date.now).mockReturnValue(first.clippedAt + 300_000);

        await tapTab();
        await act(async () => { await new Promise(requestAnimationFrame); });
        expect(scroll).toHaveBeenCalledWith({ offset: 0, animated: true });
        expect(mockFetch).toHaveBeenCalledTimes(1);

        await tapTab('Chat');
        await tapTab();
        expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('更换配对凭据后不展示旧缓存，未接入摘要接口仍可浏览', async () => {
        mockFetch.mockResolvedValueOnce(response({ ...page, nextCursor: null }));
        await mount();
        await tapTab();
        expect(texts()).toContain('摘要标题');
        mockFetch.mockResolvedValueOnce(response({ ...page, items: [second], nextCursor: null, canEditSummary: false }));
        await act(async () => { useAssistantStore.setState({ serverToken: 'different-test-token' }); });
        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(texts()).not.toContain('摘要标题');
        expect(texts()).toContain('历史摘要标题');
        expect(renderer.root.findAllByProps({ accessibilityLabel: '重写' }).some(node => node.props.disabled)).toBe(true);
    });
});
