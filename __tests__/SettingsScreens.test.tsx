import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import { Alert, Text, TouchableOpacity } from 'react-native';
import i18n from '../src/i18n';
import * as diagnosticLog from '../src/services/diagnosticLog';
import { SettingsRow, SettingsToast } from '../src/components/settings';
import { AboutScreen } from '../src/screens/AboutScreen';
import { MeScreen } from '../src/screens/MeScreen';
import { AppSettingsScreen } from '../src/screens/AppSettingsScreen';
import { NotificationSettingsScreen } from '../src/screens/NotificationSettingsScreen';
import { setChatNotificationPermission } from '../src/services/chatNotifications';
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

jest.mock('../src/services/chatNotifications', () => ({
    chatNotificationsAvailable: true,
    setChatNotificationPermission: jest.fn(),
}));

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
        jest.restoreAllMocks();
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

    it('groups both notification preferences under one entry on the Me screen', async () => {
        await ReactTestRenderer.act(async () => {
            useSettingsStore.setState({ chatNotificationsEnabled: false, chatNotificationPreview: true });
            currentRenderer = ReactTestRenderer.create(<MeScreen />);
        });
        const rows = currentRenderer!.root.findAllByType(SettingsRow);
        const entry = rows.filter(row => row.props.title === '通知');
        expect(entry).toHaveLength(1);
        expect(rows.some(row => row.props.toggle)).toBe(false);
        await ReactTestRenderer.act(async () => entry[0].props.onPress());
        expect(mockNavigate).toHaveBeenCalledWith('NotificationSettings');

        await ReactTestRenderer.act(async () => currentRenderer!.update(<NotificationSettingsScreen />));
        const [enabled, preview] = currentRenderer!.root.findAllByType(SettingsRow);
        expect([enabled.props.title, preview.props.title]).toEqual(['消息通知', '显示消息预览']);
        expect([enabled.props.toggle.value, preview.props.toggle.value]).toEqual([false, true]);
        await ReactTestRenderer.act(async () => enabled.props.toggle.onChange(true));
        expect(setChatNotificationPermission).toHaveBeenCalledWith(true);
        await ReactTestRenderer.act(async () => preview.props.toggle.onChange(false));
        expect(useSettingsStore.getState().chatNotificationPreview).toBe(false);
    });

    it('MeScreen 不再显示日志导出入口，关于保持为卡片最后一行', async () => {
        await ReactTestRenderer.act(async () => {
            currentRenderer = ReactTestRenderer.create(<MeScreen />);
        });
        const rows = currentRenderer!.root.findAllByType(SettingsRow);
        expect(rows.some(row => row.props.title === '导出连接日志' || row.props.title === '导出诊断日志')).toBe(false);
        const about = rows.find(row => row.props.title === '关于');
        expect(about).toBeDefined();
        expect(about!.props.last).toBe(true);
    });

    it('AboutScreen 在应用信息下方提供导出诊断日志，直接保存本地存储并展示反馈', async () => {
        jest.useFakeTimers();
        try {
            useAssistantStore.setState({ connectionState: 'disconnected', serverUrl: '' });
            const exportSpy = jest.spyOn(diagnosticLog, 'exportDiagnosticLogToFile');
            const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

            await ReactTestRenderer.act(async () => {
                currentRenderer = ReactTestRenderer.create(<AboutScreen />);
            });

            const root = currentRenderer!.root;
            const exportRow = root
                .findAllByType(TouchableOpacity)
                .find(node => node.findAllByType(Text).some(text => text.props.children === '导出诊断日志'));
            expect(exportRow).toBeDefined();

            exportSpy.mockResolvedValueOnce({
                status: 'saved',
                fileName: 'lvtian-diagnostics-20261122-173000.txt',
                uri: 'content://saved/log.txt',
            });
            await ReactTestRenderer.act(async () => {
                await exportRow!.props.onPress();
            });
            expect(alertSpy).not.toHaveBeenCalled();
            const toastComp = root.findByType(SettingsToast);
            expect(toastComp.props.message).toBe('文件已保存为：lvtian-diagnostics-20261122-173000.txt');

            exportSpy.mockResolvedValueOnce({ status: 'cancelled' });
            await ReactTestRenderer.act(async () => {
                await exportRow!.props.onPress();
            });
            expect(alertSpy).not.toHaveBeenCalled();

            exportSpy.mockResolvedValueOnce({ status: 'error', code: 'DOWNLOADS_FOLDER_RESTRICTED' });
            await ReactTestRenderer.act(async () => {
                await exportRow!.props.onPress();
            });
            expect(alertSpy).toHaveBeenLastCalledWith(
                '导出诊断日志失败',
                expect.stringContaining('新建子文件夹'),
            );

            exportSpy.mockResolvedValueOnce({ status: 'error', code: 'EXPORT_FAILED' });
            await ReactTestRenderer.act(async () => {
                await exportRow!.props.onPress();
            });
            expect(alertSpy).toHaveBeenLastCalledWith('导出诊断日志失败', '诊断日志导出失败，请重试');
        } finally {
            await ReactTestRenderer.act(async () => {
                jest.runOnlyPendingTimers();
            });
            jest.useRealTimers();
        }
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
