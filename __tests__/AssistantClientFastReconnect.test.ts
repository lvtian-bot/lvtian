import { AssistantClient } from '../src/services/AssistantClient';
import { useAssistantStore } from '../src/store/useAssistantStore';
import { ServerMessage } from '../src/types/assistantProtocol';

describe('AssistantClient 极速重连与热启动唤醒', () => {
    let client: AssistantClient;

    beforeEach(() => {
        client = AssistantClient.getInstance();
        useAssistantStore.setState({
            serverUrl: 'http://127.0.0.1:3000',
            serverToken: 'in-memory-token',
            connectionState: 'disconnected',
            isServerUpgrading: false,
            messages: [],
            pendingSendQueue: [],
            currentSeq: 0,
            clearedSeq: 0,
        });
    });

    afterEach(() => {
        client.disconnect();
    });

    test('优先读取内存凭据，不调用 loadSavedCredentials', async () => {
        const spyLoad = jest.spyOn(useAssistantStore.getState(), 'loadSavedCredentials');

        // 内存中已有 serverUrl 和 serverToken
        await client.connect();

        expect(spyLoad).not.toHaveBeenCalled();
        spyLoad.mockRestore();
    });

    test('切回前台 handleAppForeground 立即推倒旧假死连接并触发 0ms 重连', () => {
        const spyConnect = jest.spyOn(client, 'connect').mockImplementation(async () => {});

        // 模拟后台切入超过 3 秒
        const internalClient = client as unknown as {
            lastBackgroundTimestamp: number;
            reconnectAttempts: number;
            reconnectTimer: ReturnType<typeof setTimeout> | null;
        };
        internalClient.lastBackgroundTimestamp = Date.now() - 5000;
        internalClient.reconnectAttempts = 5;
        internalClient.reconnectTimer = setTimeout(() => {}, 10000);

        client.handleAppForeground();

        // 验证定时器已清除，尝试计数已重置为 0，并且强制触发重连
        expect(internalClient.reconnectTimer).toBeNull();
        expect(internalClient.reconnectAttempts).toBe(0);
        expect(spyConnect).toHaveBeenCalledWith(true);

        spyConnect.mockRestore();
    });

    test('收到服务端任何下行消息时清除心跳假死超时熔断计时器', () => {
        const internalClient = client as unknown as {
            pongTimeoutTimer: ReturnType<typeof setTimeout> | null;
            handleServerMessage: (msg: ServerMessage) => void;
        };

        // 模拟挂载了熔断计时器
        internalClient.pongTimeoutTimer = setTimeout(() => {}, 3500);
        expect(internalClient.pongTimeoutTimer).not.toBeNull();

        // 收到服务端 pong 报文
        internalClient.handleServerMessage({ type: 'pong' });

        // 熔断计时器已立即清除
        expect(internalClient.pongTimeoutTimer).toBeNull();
    });
});
