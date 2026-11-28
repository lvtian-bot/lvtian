import React from 'react';
import Renderer, { act } from 'react-test-renderer';
import { Alert, FlatList } from 'react-native';
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
            renderScene({ route: navigationState.routes[navigationState.index] }));
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
    summary: '摘要第一段\n\n**完整摘要末尾**', revision: 'first',
};
const second = { ...first, id: '2026/10/previous.md', title: '历史剪藏', summary: '', revision: 'second' };
const page = { items: [first], nextCursor: 'next-page', canEditSummary: true };
const response = (data: object) => ({ ok: true, redirected: false, json: async () => data }) as Awaited<ReturnType<typeof fetch>>;
const i18n = createInstance();
const mockFetch = jest.mocked(fetch);

const metrics = { frame: { x: 0, y: 0, width: 400, height: 800 }, insets: { top: 0, bottom: 0, left: 0, right: 0 } };

describe('从绿天底栏进入动态', () => {
    let renderer: Renderer.ReactTestRenderer;
    const texts = () => renderer.root.findAll(node => String(node.type) === 'Text').map(node => node.props.children);
    const enter = async () => {
        const tab = renderer.root.findAllByProps({ testID: 'tab-Moments' }).find(node => typeof node.props.onPress === 'function');
        if (!tab) throw new Error('缺少动态标签');
        await act(async () => { tab.props.onPress(); });
    };
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

    it('标签和页标题一致，显示完整摘要、翻页并在删除后保留卡片', async () => {
        mockFetch.mockResolvedValueOnce(response(page))
            .mockResolvedValueOnce(response({ ...page, items: [second], nextCursor: null }))
            .mockResolvedValueOnce(response({ item: { ...first, summary: '', revision: 'removed' }, status: 'uploaded' }))
            .mockResolvedValueOnce(response({ item: { ...first, summary: '重新生成后的摘要', revision: 'updated' }, status: 'upload_failed' }));
        const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
        await mount();
        expect(mockFetch).not.toHaveBeenCalled();
        await enter();
        expect(renderer.root.findAllByProps({ testID: 'stack-header' }).some(node => node.props.children === '动态')).toBe(true);
        expect(texts()).toContain('最近剪藏');
        expect(texts()).toContain('完整摘要末尾');

        await act(async () => { renderer.root.findByType(FlatList).props.onEndReached(); });
        expect(mockFetch.mock.calls[1][0]).toBe('https://lvtian.example/api/moments?cursor=next-page');
        expect(texts()).toContain('历史剪藏');

        await press('删除摘要');
        expect(texts()).toContain('最近剪藏');
        expect(texts()).not.toContain('完整摘要末尾');
        expect(JSON.parse(String(mockFetch.mock.calls[2][1]?.body))).toEqual({ id: first.id, revision: 'first', action: 'delete' });

        await press('重新生成摘要');
        expect(JSON.parse(String(mockFetch.mock.calls[3][1]?.body))).toEqual({ id: first.id, revision: 'removed', action: 'regenerate' });
        expect(texts()).toContain('重新生成后的摘要');
        expect(alert).toHaveBeenCalledWith('上传失败', '已成功保存');
        await act(async () => { await i18n.changeLanguage('en'); });
        expect(renderer.root.findAllByProps({ testID: 'stack-header' }).some(node => node.props.children === 'Moments')).toBe(true);
        expect(texts().filter(value => value === 'Moments').length).toBeGreaterThanOrEqual(2);
    });

    it('未接入摘要接口时仍可从动态浏览已归档的摘要', async () => {
        mockFetch.mockResolvedValueOnce(response({ ...page, nextCursor: null, canEditSummary: false }));
        await mount();
        await enter();
        expect(texts()).toContain('最近剪藏');
        expect(renderer.root.findAllByProps({ accessibilityLabel: '重新生成摘要' }).some(node => node.props.disabled)).toBe(true);
    });
});
