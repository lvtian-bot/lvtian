import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import { useAgentRemoteSetting } from '../src/hooks/useAgentRemoteSetting';
import { useAssistantStore } from '../src/store/useAssistantStore';

describe('useAgentRemoteSetting 核对稳定性', () => {
    test('definition 含每次渲染重建的内联回调时，连接后仅核对一次，不因响应写入进入请求循环', async () => {
        let fetchCalls = 0;
        const fetchModel = async (): Promise<{ provider: string; model: string }> => {
            fetchCalls++;
            // 模拟真实路径：成功响应每次写入新分配的清单数组，触发 store 订阅方重渲染
            useAssistantStore.getState().setAgentModelOptions([{ provider: 'deepseek-official', model: 'deepseek-flash' }]);
            return { provider: 'openai-codex', model: 'gpt-6.1-sol' };
        };

        useAssistantStore.setState({
            serverUrl: 'http://127.0.0.1:3000',
            serverToken: 'token-a',
            connectionState: 'connected',
            agentModelSelection: null,
            agentModelOptions: [],
        });

        // 故意每次渲染重建 definition 全部回调与文案对象（真实页面的写法）
        const Probe = () => {
            const setting = useAgentRemoteSetting<{ provider: string; model: string }>({
                readLocal: () => useAssistantStore.getState().agentModelSelection,
                writeLocal: (selection) => useAssistantStore.getState().setAgentModelSelection(selection),
                fetchRemote: fetchModel,
                applyRemote: async () => ({ success: true }),
                isSameValue: (a, b) => a.model === b.model,
                texts: {
                    valueLabel: (v) => v.model,
                    noticeTitle: '提示',
                    successTitle: '成功',
                    unconfiguredNotice: 'x',
                    taskRunning: 'x',
                    applySuccess: 'x',
                    applyFailed: 'x',
                    applyUnconfirmed: 'x',
                    applySettledDifferent: (label) => label,
                },
            });
            return <Text>{setting.value ? setting.value.model : 'none'}</Text>;
        };

        let renderer: ReactTestRenderer.ReactTestRenderer | null = null;
        await act(async () => {
            renderer = ReactTestRenderer.create(<Probe />);
        });
        // 等待 fetch promise 与级联渲染完全落定后再断言
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
        });

        expect(fetchCalls).toBe(1);
        expect(useAssistantStore.getState().agentModelSelection?.model).toBe('gpt-6.1-sol');

        // 额外重渲染若干次：核对 effect 仍不重跑
        await act(async () => {
            renderer?.update(<Probe />);
        });
        await act(async () => {
            renderer?.update(<Probe />);
        });
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
        });
        expect(fetchCalls).toBe(1);

        const instance = renderer as ReactTestRenderer.ReactTestRenderer | null;
        act(() => {
            instance?.unmount();
        });
    });
});
