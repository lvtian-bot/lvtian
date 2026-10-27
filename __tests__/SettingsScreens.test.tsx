import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { Text, TouchableOpacity } from 'react-native';
import i18n from '../src/i18n';
import { MeScreen } from '../src/screens/MeScreen';
import { AppSettingsScreen } from '../src/screens/AppSettingsScreen';
import { useSettingsStore } from '../src/store/useSettingsStore';
import { useAssistantStore } from '../src/store/useAssistantStore';

const mockNavigate = jest.fn();

jest.mock('@react-navigation/native', () => {
    const actual = jest.requireActual('@react-navigation/native');
    return {
        ...actual,
        useNavigation: () => ({
            navigate: mockNavigate,
            goBack: jest.fn(),
            setOptions: jest.fn(),
        }),
    };
});

describe('MeScreen 与 AppSettingsScreen', () => {
    let currentRenderer: ReactTestRenderer.ReactTestRenderer | undefined;

    beforeEach(async () => {
        jest.clearAllMocks();
        currentRenderer = undefined;
        await i18n.changeLanguage('zh');
        await ReactTestRenderer.act(async () => {
            useSettingsStore.setState({
                fontSize: 'standard',
                markdownTheme: 'default',
                cloudProvider: 'none',
                webDavConfig: { server: '', username: '' },
            });
            useAssistantStore.setState({
                serverUrl: 'http://192.168.1.100:3000',
                connectionState: 'connected',
                permissionMode: 'workspace-write',
            });
        });
    });

    afterEach(async () => {
        if (currentRenderer) {
            await ReactTestRenderer.act(async () => {
                currentRenderer?.unmount();
            });
            currentRenderer = undefined;
        }
    });

    it('MeScreen 渲染绿天助理形象卡片、AI 智能体配置与 APP 设置，不渲染缓存管理', async () => {
        await ReactTestRenderer.act(async () => {
            currentRenderer = ReactTestRenderer.create(<MeScreen />);
        });

        const root = currentRenderer!.root;
        const allTexts = root.findAllByType(Text).map((node) => node.props.children).flat();

        // 验证主页面核心结构
        expect(allTexts).toContain('绿天');
        expect(allTexts).toContain('AI 智能体');
        expect(allTexts).toContain('App 设置');
        expect(allTexts).toContain('云端同步');

        // 验证缓存管理已被彻底移除
        expect(allTexts).not.toContain('本地缓存管理');
        expect(allTexts).not.toContain('缓存管理');
    });

    it('MeScreen 点击各选项能正确导航至对应二级页面', async () => {
        await ReactTestRenderer.act(async () => {
            currentRenderer = ReactTestRenderer.create(<MeScreen />);
        });

        const root = currentRenderer!.root;
        const pressables = root.findAll((node) => typeof node.props.onPress === 'function');

        // 点击 App 设置条目
        const appSettingsItem = pressables.find((p) => {
            const texts = p.findAllByType(Text).flatMap((n) => n.props.children);
            return texts.some((t) => typeof t === 'string' && t.includes('App 设置'));
        });
        expect(appSettingsItem).toBeDefined();

        await ReactTestRenderer.act(async () => {
            appSettingsItem!.props.onPress();
        });
        expect(mockNavigate).toHaveBeenCalledWith('AppSettings');

        // 点击 AI 智能体条目
        const agentConfigItem = pressables.find((p) => {
            const texts = p.findAllByType(Text).flatMap((n) => n.props.children);
            return texts.some((t) => typeof t === 'string' && t.includes('AI 智能体'));
        });
        expect(agentConfigItem).toBeDefined();

        await ReactTestRenderer.act(async () => {
            agentConfigItem!.props.onPress();
        });
        expect(mockNavigate).toHaveBeenCalledWith('AgentConfig');

        // 点击绿天服务端配置区域
        const serverConfigItem = pressables.find((p) => {
            const texts = p.findAllByType(Text).flatMap((n) => n.props.children);
            return texts.some((t) => typeof t === 'string' && t.includes('绿天'));
        });
        expect(serverConfigItem).toBeDefined();

        await ReactTestRenderer.act(async () => {
            serverConfigItem!.props.onPress();
        });
        expect(mockNavigate).toHaveBeenCalledWith('AssistantConfig');
    });

    it('AppSettingsScreen 提供小/默认/大三档调节并联动 store', async () => {
        await ReactTestRenderer.act(async () => {
            currentRenderer = ReactTestRenderer.create(<AppSettingsScreen />);
        });

        const root = currentRenderer!.root;
        const allTexts = root.findAllByType(Text).map((node) => node.props.children).flat();

        expect(allTexts).toContain('阅读与显示');
        expect(allTexts).toContain('字体大小');
        expect(allTexts).toContain('Markdown样式');

        // 点击「字体大小」行打开底部选择弹层
        const fontRow = root
            .findAll((node) => typeof node.props.onPress === 'function')
            .find((p) => {
                const texts = p.findAllByType(Text).flatMap((n) => n.props.children);
                return texts.some((t) => typeof t === 'string' && t.includes('字体大小'));
            });
        expect(fontRow).toBeDefined();

        await ReactTestRenderer.act(async () => {
            fontRow!.props.onPress();
        });

        // 弹层内点击「大」字号选项（遮罩层同样包含选项文本，须以首文本精确匹配）
        const touchables = root.findAllByType(TouchableOpacity);
        const largeButton = touchables.find((t) => {
            const texts = t.findAllByType(Text).map((n) => n.props.children);
            return texts[0] === '大';
        });
        expect(largeButton).toBeDefined();

        await ReactTestRenderer.act(async () => {
            largeButton!.props.onPress();
        });
        expect(useSettingsStore.getState().fontSize).toBe('large');
    });
});
