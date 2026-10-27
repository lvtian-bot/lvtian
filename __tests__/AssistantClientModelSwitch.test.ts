import { AssistantClient } from '../src/services/AssistantClient';

describe('AssistantClient 模型切换请求的结果分类', () => {
    const fetchMock = jest.fn();

    beforeEach(() => {
        (global as { fetch?: unknown }).fetch = fetchMock;
        fetchMock.mockReset();
    });

    test('服务端确认切换成功时返回 changed', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ success: true, changed: true }),
        });
        const res = await AssistantClient.updateModelSelection(
            'http://127.0.0.1:3000',
            'token-a',
            'deepseek-official',
            'deepseek-flash'
        );
        expect(res.success).toBe(true);
        expect(res.changed).toBe(true);
        expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:3000/api/model');
    });

    test('请求超时中止归类为 REQUEST_UNCONFIRMED 而非失败', async () => {
        // 服务端在触发会话交接前已写入新配置，超时只代表结果未确认
        fetchMock.mockRejectedValueOnce(new Error('Aborted'));
        const res = await AssistantClient.updateModelSelection(
            'http://127.0.0.1:3000',
            'token-a',
            'openai-codex',
            'gpt-6.1-sol'
        );
        expect(res.success).toBe(false);
        expect(res.code).toBe('REQUEST_UNCONFIRMED');
    });

    test('权限切换请求超时中止同样归类为 REQUEST_UNCONFIRMED（与模型切换共用分类）', async () => {
        fetchMock.mockRejectedValueOnce(new Error('Aborted'));
        const res = await AssistantClient.updatePermissionMode(
            'http://127.0.0.1:3000',
            'token-a',
            'danger-full-access'
        );
        expect(res.success).toBe(false);
        expect(res.code).toBe('REQUEST_UNCONFIRMED');
    });

    test('其他网络异常仍归类为 NETWORK_ERROR', async () => {
        fetchMock.mockRejectedValueOnce(new TypeError('Network request failed'));
        const res = await AssistantClient.updateModelSelection(
            'http://127.0.0.1:3000',
            'token-a',
            'openai-codex',
            'gpt-6.1-sol'
        );
        expect(res.success).toBe(false);
        expect(res.code).toBe('NETWORK_ERROR');
    });

    test('服务端业务拒绝时透传错误码（如 TASK_RUNNING）', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: false,
            json: async () => ({ code: 'TASK_RUNNING', error: '当前有正在执行的任务' }),
        });
        const res = await AssistantClient.updateModelSelection(
            'http://127.0.0.1:3000',
            'token-a',
            'openai-codex',
            'gpt-6.1-sol'
        );
        expect(res.success).toBe(false);
        expect(res.code).toBe('TASK_RUNNING');
    });
});
