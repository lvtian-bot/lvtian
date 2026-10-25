import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { SessionManager } from '../dist/sessionManager.js';
import { ContextConsolidator, resolveProviderConfig } from '../dist/contextConsolidator.js';
import { AcpEngineManager } from '../dist/acpEngineManager.js';
import { MemoryManager } from '../dist/memoryManager.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createTempDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanupTempDir(dir) {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch {
        // ignore
    }
}

/** 进程内轻量模拟引擎，记录 session/new、session/resume 与 session/prompt 调用 */
function createMockEngine(tracker = {}) {
    const knownSessions = new Set();
    const activeSessions = new Set();
    tracker.prompts = [];
    tracker.createdSessions = [];
    tracker.resumedSessions = [];

    return acp.agent({ name: 'mock-rotation-engine' })
        .onRequest(acp.methods.agent.initialize, () => ({
            protocolVersion: acp.PROTOCOL_VERSION,
            agentCapabilities: {},
        }))
        .onRequest(acp.methods.agent.authenticate, () => ({}))
        .onRequest(acp.methods.agent.session.new, () => {
            const sessionId = `engine-${globalThis.crypto.randomUUID().slice(0, 8)}`;
            knownSessions.add(sessionId);
            activeSessions.add(sessionId);
            tracker.createdSessions.push(sessionId);
            return { sessionId };
        })
        .onRequest(acp.methods.agent.session.resume, (c) => {
            tracker.resumedSessions.push(c.params.sessionId);
            // 模拟引擎对损坏旧会话的自愈：resume 请求 A，返回的却是全新会话 B
            if (tracker.resumeReplacementId) {
                const replacementId = tracker.resumeReplacementId;
                knownSessions.add(replacementId);
                activeSessions.add(replacementId);
                return { sessionId: replacementId };
            }
            if (!knownSessions.has(c.params.sessionId)) {
                throw new acp.RequestError(-32002, 'session not found');
            }
            activeSessions.add(c.params.sessionId);
            return { sessionId: c.params.sessionId };
        })
        .onRequest(acp.methods.agent.session.prompt, async (c) => {
            const promptText = c.params.prompt?.[0]?.text ?? '';
            tracker.prompts.push({
                sessionId: c.params.sessionId,
                text: promptText,
            });
            if (tracker.onPrompt) {
                await tracker.onPrompt(c);
            }
            await c.client.notify(acp.methods.client.session.update, {
                sessionId: c.params.sessionId,
                update: {
                    sessionUpdate: 'agent_message_chunk',
                    content: { type: 'text', text: 'response to prompt' },
                },
            });
            return { stopReason: 'end_turn' };
        });
}

function connectMockEngine(mockApp) {
    return async (clientApp) => {
        let resolveContext;
        let resolveStop;
        const contextReady = new Promise((resolve) => { resolveContext = resolve; });
        const stopSignal = new Promise((resolve) => { resolveStop = resolve; });
        const run = clientApp.connectWith(mockApp, async (ctx) => {
            resolveContext(ctx);
            await stopSignal;
        });
        const closed = run.catch(() => undefined);
        return {
            context: await contextReady,
            closed,
            close: async () => {
                resolveStop();
                await closed;
            },
        };
    };
}

// ------------------------------------------------------------------
// SessionManager 认知模型与双重门禁基础测试
// ------------------------------------------------------------------

test('SessionManager 维护真实交互时间 lastActiveAt 与上下文用量统计', () => {
    const tmpDir = createTempDir('lvtian-session-test-');
    try {
        const sm = new SessionManager(tmpDir);
        const session = sm.getOrCreateSession('main');
        assert.strictEqual(session.lastActiveAt, undefined);

        const now = Date.now();
        sm.recordActivity('main', now);
        assert.strictEqual(sm.getLastActiveAt('main'), now);

        sm.setUsage('main', 32000, 128000);
        const usage = sm.getUsage('main');
        assert.strictEqual(usage.tokens, 32000);
        assert.strictEqual(usage.windowSize, 128000);
        assert.strictEqual(usage.ratio, 0.25);
    } finally {
        cleanupTempDir(tmpDir);
    }
});

test('SessionManager 双重门禁判定（时间 3h AND 容量 20% 复合判定）', () => {
    const tmpDir = createTempDir('lvtian-gate-test-');
    try {
        const sm = new SessionManager(tmpDir);
        const idleThreshold = 100; // 测试用 100ms
        const capacityThreshold = 0.2; // 20%
        const now = Date.now();

        // 状态 1: 心流温热期 (< 100ms), 低容量 (5%)
        sm.recordActivity('main', now);
        sm.setUsage('main', 5000, 100000);
        assert.strictEqual(sm.isRotationEligible('main', idleThreshold, capacityThreshold), false);

        // 状态 2: 心流温热期 (< 100ms), 高容量 (50%) -> 绝不切断，心流保持
        sm.setUsage('main', 50000, 100000);
        assert.strictEqual(sm.isRotationEligible('main', idleThreshold, capacityThreshold), false);

        // 状态 3: 深度静默 (>= 100ms), 但轻载状态 (< 20%) -> 免切断，继续沿用
        sm.recordActivity('main', now - 200);
        sm.setUsage('main', 10000, 100000);
        assert.strictEqual(sm.isIdle('main', idleThreshold), true);
        assert.strictEqual(sm.isCapacityOver('main', capacityThreshold), false);
        assert.strictEqual(sm.isRotationEligible('main', idleThreshold, capacityThreshold), false);

        // 状态 4: 深度静默 (>= 100ms) AND 重载状态 (>= 20%) -> 命中双重门禁！
        sm.setUsage('main', 25000, 100000);
        assert.strictEqual(sm.isIdle('main', idleThreshold), true);
        assert.strictEqual(sm.isCapacityOver('main', capacityThreshold), true);
        assert.strictEqual(sm.isRotationEligible('main', idleThreshold, capacityThreshold), true);
    } finally {
        cleanupTempDir(tmpDir);
    }
});

test('SessionManager 关键原文物理锚定规则（Verbatim Anchoring）倒序追加与字数截断', () => {
    const tmpDir = createTempDir('lvtian-verbatim-test-');
    try {
        const sm = new SessionManager(tmpDir);
        for (let i = 1; i <= 10; i++) {
            sm.addMessage('main', {
                id: `u-${i}`,
                role: 'user',
                content: `这是第${i}轮主人的提问，探讨方案与细节`,
                timestamp: Date.now() + i,
                status: 'sent',
            });
            sm.addMessage('main', {
                id: `a-${i}`,
                role: 'assistant',
                content: `这是第${i}轮助手的回答，确认最终状态与事实`,
                timestamp: Date.now() + i + 1,
                status: 'done',
            });
        }

        // 回溯最近 4 轮交互
        const excerpts = sm.getVerbatimExcerpts('main', 4, 1800);
        assert.ok(excerpts.includes('第10轮主人的提问'));
        assert.ok(excerpts.includes('第7轮主人的提问'));
        assert.ok(!excerpts.includes('第3轮主人的提问')); // 超出 4 轮被过滤

        // 字数硬顶截断
        const tightExcerpts = sm.getVerbatimExcerpts('main', 8, 100);
        assert.ok(tightExcerpts.length <= 100);
        assert.ok(tightExcerpts.includes('第10轮'));
    } finally {
        cleanupTempDir(tmpDir);
    }
});

test('SessionManager pending_background.txt 原子读写与重启持久化', () => {
    const tmpDir = createTempDir('lvtian-bg-test-');
    try {
        const sm1 = new SessionManager(tmpDir);
        sm1.recordActivity('main', 1234567890);
        sm1.setUsage('main', 40000, 128000);
        sm1.setPendingBackground('main', '### 1. 核心共识\n确立底层会话轮换机制');

        assert.strictEqual(sm1.hasPendingBackground('main'), true);
        assert.ok(sm1.getPendingBackground('main')?.includes('确立底层会话轮换机制'));

        // 模拟服务端重启，重新加载事件日志
        const sm2 = new SessionManager(tmpDir);
        assert.strictEqual(sm2.getLastActiveAt('main'), 1234567890);
        assert.strictEqual(sm2.getUsage('main').tokens, 40000);
        assert.strictEqual(sm2.hasPendingBackground('main'), true);
        assert.ok(sm2.getPendingBackground('main')?.includes('确立底层会话轮换机制'));

        sm2.clearPendingBackground('main');
        assert.strictEqual(sm2.hasPendingBackground('main'), false);
        assert.strictEqual(sm2.getPendingBackground('main'), null);
    } finally {
        cleanupTempDir(tmpDir);
    }
});

// ------------------------------------------------------------------
// ContextConsolidator 直发模型提炼服务测试
// ------------------------------------------------------------------

test('ContextConsolidator 直发模型 API（自发自解、不走 DSH、原子写入提要）', async () => {
    const tmpDir = createTempDir('lvtian-consolidation-test-');
    try {
        const sm = new SessionManager(tmpDir);
        sm.addMessage('main', {
            id: 'u-1',
            role: 'user',
            content: '我们确定将会话轮换改为 3 小时空闲加 20% 上下文双重门禁',
            timestamp: Date.now(),
            status: 'sent',
        });
        sm.addMessage('main', {
            id: 'a-1',
            role: 'assistant',
            content: '好的，核心共识已确立，下一步实施服务端直发模型提炼。',
            timestamp: Date.now() + 1,
            status: 'done',
        });

        let capturedRequest = null;
        const mockFetch = async (url, init) => {
            capturedRequest = { url, body: JSON.parse(init.body), headers: init.headers };
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    choices: [
                        {
                            message: {
                                content: `### 1. 核心共识与最终盘面
- 确立 3 小时空闲加 20% 容量双重门禁。

### 2. 悬置事项与下一步
- 下一步实施服务端直调 API 预生成背景提要。`,
                            },
                        },
                    ],
                }),
            };
        };

        const consolidator = new ContextConsolidator(sm, {
            apiKey: 'test-key-123',
            baseUrl: 'https://api.deepseek.com',
            fetchFn: mockFetch,
        });

        const result = await consolidator.consolidate('main');
        assert.ok(result);
        assert.ok(result.includes('核心共识与最终盘面'));
        assert.ok(sm.hasPendingBackground('main'));
        assert.strictEqual(sm.getPendingBackground('main'), result);

        // 验证请求格式符合标准 OpenAI/DeepSeek 兼容接口
        assert.strictEqual(capturedRequest.url, 'https://api.deepseek.com/v1/chat/completions');
        assert.strictEqual(capturedRequest.headers.Authorization, 'Bearer test-key-123');
        assert.strictEqual(capturedRequest.body.model, 'deepseek-flash');
        assert.ok(capturedRequest.body.messages[1].content.includes('3 小时空闲加 20%'));
    } finally {
        cleanupTempDir(tmpDir);
    }
});

test('ContextConsolidator 容错性：API 错误或无 API Key 时静默记录、不崩溃', async () => {
    const tmpDir = createTempDir('lvtian-consolidation-fail-');
    try {
        const sm = new SessionManager(tmpDir);
        sm.addMessage('main', { id: 'u-1', role: 'user', content: 'test', timestamp: Date.now(), status: 'sent' });

        // 无 API Key 场景
        const noKeyConsolidator = new ContextConsolidator(sm, { apiKey: '', fetchFn: async () => {} });
        const resNoKey = await noKeyConsolidator.consolidate('main');
        assert.strictEqual(resNoKey, null);
        assert.strictEqual(sm.hasPendingBackground('main'), false);

        // 网络超时/异常场景
        const failingConsolidator = new ContextConsolidator(sm, {
            apiKey: 'key',
            fetchFn: async () => {
                throw new Error('Network timeout');
            },
        });
        const resFail = await failingConsolidator.consolidate('main');
        assert.strictEqual(resFail, null);
        assert.strictEqual(sm.hasPendingBackground('main'), false);
    } finally {
        cleanupTempDir(tmpDir);
    }
});

test('ContextConsolidator scanAllSessions 扫描多个会话并仅提炼符合双重门禁的会话', async () => {
    const tmpDir = createTempDir('lvtian-scan-test-');
    try {
        const sm = new SessionManager(tmpDir);
        // 会话 1: 命中条件 (idle + capacity)
        sm.addMessage('s1', { id: 'u-1', role: 'user', content: '会话1对话', timestamp: Date.now(), status: 'sent' });
        sm.recordActivity('s1', Date.now() - 200);
        sm.setUsage('s1', 30000, 100000);

        // 会话 2: 未超时 (心流中)
        sm.addMessage('s2', { id: 'u-2', role: 'user', content: '会话2对话', timestamp: Date.now(), status: 'sent' });
        sm.recordActivity('s2', Date.now());
        sm.setUsage('s2', 30000, 100000);

        // 会话 3: 已存在 pendingBackground (无需重复)
        sm.addMessage('s3', { id: 'u-3', role: 'user', content: '会话3对话', timestamp: Date.now(), status: 'sent' });
        sm.recordActivity('s3', Date.now() - 200);
        sm.setUsage('s3', 30000, 100000);
        sm.setPendingBackground('s3', '已有提要');

        const mockFetch = async () => ({
            ok: true,
            status: 200,
            json: async () => ({
                choices: [{ message: { content: '新提要' } }],
            }),
        });

        const consolidator = new ContextConsolidator(sm, {
            apiKey: 'key',
            idleTimeoutMs: 100,
            minCapacityRatio: 0.2,
            fetchFn: mockFetch,
        });

        const consolidated = await consolidator.scanAllSessions();
        assert.deepStrictEqual(consolidated, ['s1']);
        assert.strictEqual(sm.hasPendingBackground('s1'), true);
        assert.strictEqual(sm.hasPendingBackground('s2'), false);
        assert.strictEqual(sm.getPendingBackground('s3'), '已有提要');
    } finally {
        cleanupTempDir(tmpDir);
    }
});

// ------------------------------------------------------------------
// AcpEngineManager 会话轮换完整端到端测试
// ------------------------------------------------------------------

test('AcpEngineManager 心流温热期持续复用底层 DSH 会话（不切断、KV Cache 保温）', async () => {
    const tmpDir = createTempDir('lvtian-engine-warm-');
    try {
        const mm = new MemoryManager(tmpDir);
        const sm = new SessionManager(tmpDir);
        const tracker = {};
        const mockApp = createMockEngine(tracker);

        const engine = new AcpEngineManager(tmpDir, mm, sm, {
            connectEngine: connectMockEngine(mockApp),
        });

        // 第一轮发问
        await engine.execute('main', 'asst-1', '你好，今天天气不错', {
            onDelta: () => {},
            onToolCall: () => {},
            onStatusChange: () => {},
        });
        const firstSessionId = sm.getDshSessionId('main');
        assert.ok(firstSessionId);
        assert.strictEqual(tracker.createdSessions.length, 1);

        // 第二轮发问（温热期内直接续聊）
        await engine.execute('main', 'asst-2', '我们继续刚才的话题', {
            onDelta: () => {},
            onToolCall: () => {},
            onStatusChange: () => {},
        });

        // 会话未新建，直接复用
        assert.strictEqual(sm.getDshSessionId('main'), firstSessionId);
        assert.strictEqual(tracker.createdSessions.length, 1);
        assert.strictEqual(tracker.prompts.length, 2);
        // 普通 Prompt 保持简洁格式
        assert.ok(tracker.prompts[1].text.includes('[系统人设与主人记忆背景]'));
        assert.ok(!tracker.prompts[1].text.includes('[前序交流心智接力提要'));

        await engine.stopAll();
    } finally {
        cleanupTempDir(tmpDir);
    }
});

test('AcpEngineManager 存在 pendingBackground 时清爽唤醒并切新 DSH 会话', async () => {
    const tmpDir = createTempDir('lvtian-engine-rotate-');
    try {
        const mm = new MemoryManager(tmpDir);
        const sm = new SessionManager(tmpDir);
        const tracker = {};
        const mockApp = createMockEngine(tracker);

        const engine = new AcpEngineManager(tmpDir, mm, sm, {
            connectEngine: connectMockEngine(mockApp),
        });

        // 建立初始会话并记录交流历史
        sm.addMessage('main', { id: 'u-1', role: 'user', content: '初始问题：请规划架构方案', timestamp: Date.now(), status: 'sent' });
        await engine.execute('main', 'asst-1', '初始问题', {
            onDelta: () => {},
            onToolCall: () => {},
            onStatusChange: () => {},
        });
        sm.addMessage('main', { id: 'asst-1', role: 'assistant', content: '初始回答：建议基于认知记忆模型分层设计', timestamp: Date.now() + 1, status: 'done' });
        const initialDshSession = sm.getDshSessionId('main');
        assert.strictEqual(tracker.createdSessions.length, 1);

        // 模拟深度静默期间后台已写入 pending_background.txt（同时把活跃时间推到 3h 前）
        const memoContent = `### 1. 核心共识与最终盘面
- 服务端会话轮换方案定案。`;
        sm.setPendingBackground('main', memoContent);
        sm.setUsage('main', 40000, 128000);
        sm.recordActivity('main', Date.now() - 4 * 60 * 60 * 1000);
        assert.strictEqual(sm.hasPendingBackground('main'), true);

        // 主人再次唤醒（发送新消息）
        await engine.execute('main', 'asst-2', '刚才那个方案做好了吗？', {
            onDelta: () => {},
            onToolCall: () => {},
            onStatusChange: () => {},
        });

        // 1. 底层已新建全新的 DSH 会话，旧会话已轮换封存
        const rotatedDshSession = sm.getDshSessionId('main');
        assert.notStrictEqual(rotatedDshSession, initialDshSession);
        assert.strictEqual(tracker.createdSessions.length, 2);

        // 2. Prompt 成功注入心智接力提要与关键原文锚定
        const secondPrompt = tracker.prompts[1].text;
        assert.ok(secondPrompt.includes('[前序交流心智接力提要 (上次静默期归档)]'));
        assert.ok(secondPrompt.includes('服务端会话轮换方案定案'));
        assert.ok(secondPrompt.includes('[未竟事项与关键交互原文锚定'));
        assert.ok(secondPrompt.includes('刚才那个方案做好了吗？'));

        // 3. pendingBackground 被消费并清理
        assert.strictEqual(sm.hasPendingBackground('main'), false);

        // 4. 新一轮紧接着继续发问时，继续复用新会话（温热期）
        await engine.execute('main', 'asst-3', '再追问一个问题', {
            onDelta: () => {},
            onToolCall: () => {},
            onStatusChange: () => {},
        });
        assert.strictEqual(sm.getDshSessionId('main'), rotatedDshSession);
        assert.strictEqual(tracker.createdSessions.length, 2);

        await engine.stopAll();
    } finally {
        cleanupTempDir(tmpDir);
    }
});

test('AcpEngineManager 消费 usage_update 并按双重门禁在唤醒时切新会话', async () => {
    const tmpDir = createTempDir('lvtian-engine-dual-gate-');
    try {
        const mm = new MemoryManager(tmpDir);
        const sm = new SessionManager(tmpDir);
        const tracker = {
            onPrompt: async (c) => {
                // 报告当前已占用 35000 / 128000 tokens (约 27.3% > 20%)
                await c.client.notify(acp.methods.client.session.update, {
                    sessionId: c.params.sessionId,
                    update: {
                        sessionUpdate: 'usage_update',
                        used: 35000,
                        size: 128000,
                    },
                });
            },
        };

        const mockApp = createMockEngine(tracker);

        const engine = new AcpEngineManager(tmpDir, mm, sm, {
            idleTimeoutMs: 50, // 50ms 门禁
            minCapacityRatio: 0.2, // 20% 门禁
            connectEngine: connectMockEngine(mockApp),
        });

        // 第一轮执行
        await engine.execute('main', 'asst-1', '测试消息1', {
            onDelta: () => {},
            onToolCall: () => {},
            onStatusChange: () => {},
        });
        const firstSession = sm.getDshSessionId('main');
        assert.strictEqual(sm.getUsage('main').tokens, 35000);

        // 模拟经过了 60ms 深度静默 (>= 50ms 门禁)
        await delay(60);

        // 第二轮执行：命中双重门禁（时间 >= 50ms AND 容量 >= 20%）
        await engine.execute('main', 'asst-2', '测试消息2', {
            onDelta: () => {},
            onToolCall: () => {},
            onStatusChange: () => {},
        });

        // 自动轮换至全新会话
        const secondSession = sm.getDshSessionId('main');
        assert.notStrictEqual(secondSession, firstSession);
        assert.strictEqual(tracker.createdSessions.length, 2);
        // 重点：轮换后当轮引擎上报的真实用量（35000）被完整保留，未被后置 reset 错误清零
        assert.strictEqual(sm.getUsage('main').tokens, 35000);

        await engine.stopAll();
    } finally {
        cleanupTempDir(tmpDir);
    }
});

test('resolveProviderConfig 成组绑定提供方：OPENAI 凭据与 DeepSeek 严格隔离', () => {
    const prevEnv = { ...process.env };
    try {
        // 场景 1: 仅配置 OPENAI_API_KEY，严禁向 DeepSeek 地址错位发送
        delete process.env.DEEPSEEK_API_KEY;
        delete process.env.DEEPSEEK_BASE_URL;
        delete process.env.DEEPSEEK_MODEL;
        process.env.OPENAI_API_KEY = 'sk-openai-secret';

        const openAiConfig = resolveProviderConfig();
        assert.ok(openAiConfig);
        assert.strictEqual(openAiConfig.apiKey, 'sk-openai-secret');
        assert.strictEqual(openAiConfig.baseUrl, 'https://api.openai.com');
        assert.strictEqual(openAiConfig.model, 'gpt-4o-mini');

        // 场景 2: 配置 DEEPSEEK_API_KEY，成组解析 DeepSeek 地址与模型
        process.env.DEEPSEEK_API_KEY = 'sk-deepseek-secret';
        const deepseekConfig = resolveProviderConfig();
        assert.ok(deepseekConfig);
        assert.strictEqual(deepseekConfig.apiKey, 'sk-deepseek-secret');
        assert.strictEqual(deepseekConfig.baseUrl, 'https://api.deepseek.com');
        assert.strictEqual(deepseekConfig.model, 'deepseek-flash');

        // 场景 3: 显式传入 apiKey 且带有 openai/gpt 特征时正确归属
        const customOpenAi = resolveProviderConfig({
            apiKey: 'sk-custom',
            model: 'gpt-4o',
        });
        assert.strictEqual(customOpenAi?.baseUrl, 'https://api.openai.com');
        assert.strictEqual(customOpenAi?.model, 'gpt-4o');
    } finally {
        process.env = prevEnv;
    }
});

test('ContextConsolidator 在提炼等待期间发生新交互或轮换时丢弃过时结果，杜绝污染温热期新会话', async () => {
    const tmpDir = createTempDir('lvtian-consolidation-race-');
    try {
        const sm = new SessionManager(tmpDir);
        sm.addMessage('main', { id: 'u-1', role: 'user', content: '先前的交流记录', timestamp: 1000, status: 'sent' });
        sm.recordActivity('main', 1000);

        let resolveFetch;
        const fetchGate = new Promise((resolve) => { resolveFetch = resolve; });

        const mockFetch = async () => {
            await fetchGate;
            return {
                ok: true,
                status: 200,
                json: async () => ({
                    choices: [{ message: { content: '过时的旧对话提炼备忘录' } }],
                }),
            };
        };

        const consolidator = new ContextConsolidator(sm, {
            apiKey: 'test-key',
            fetchFn: mockFetch,
        });

        // 启动异步提炼（在 mockFetch 处挂起等待）
        const consolidationPromise = consolidator.consolidate('main');

        // 在网络请求等待期间，用户发送了新消息并刷新了真实活跃时间
        await delay(10);
        sm.addMessage('main', { id: 'u-2', role: 'user', content: '用户回来了并提问', timestamp: 2000, status: 'sent' });
        sm.recordActivity('main', 2000);

        // 此时网络请求返回
        resolveFetch();
        const result = await consolidationPromise;

        // 结果应被识别为过时并丢弃，不写入 pending_background.txt
        assert.strictEqual(result, null);
        assert.strictEqual(sm.hasPendingBackground('main'), false);
    } finally {
        cleanupTempDir(tmpDir);
    }
});

test('SessionManager 原文锚定（Verbatim Anchoring）对超长消息执行有界截取并排除当前轮输入', () => {
    const tmpDir = createTempDir('lvtian-verbatim-bounds-');
    try {
        const sm = new SessionManager(tmpDir);

        // 历史消息 1
        sm.addMessage('main', { id: 'u-1', role: 'user', content: '较早的问题', timestamp: 100, status: 'sent' });
        sm.addMessage('main', { id: 'a-1', role: 'assistant', content: '较早的回答', timestamp: 101, status: 'done' });

        // 超长消息（模拟用户粘贴的 60,000 字符长文）
        const hugeContent = '长文本内容'.repeat(12000); // 60,000 字符
        sm.addMessage('main', { id: 'u-2', role: 'user', content: hugeContent, timestamp: 200, status: 'sent' });

        // 1. 测试单条超长消息截断：上限 1800 字符，且不得绕过字符限制
        const excerpt = sm.getVerbatimExcerpts('main', 8, 1800);
        assert.ok(excerpt.length <= 1800, `实际字符数 ${excerpt.length} 超过预算 1800`);
        assert.ok(excerpt.endsWith('...'));

        // 2. 测试排除当前指令选项：当前指令不应在关键原文锚定与当前提问中重复出现
        const excerptExcludingPrompt = sm.getVerbatimExcerpts('main', 8, 1800, {
            excludePrompt: hugeContent,
        });
        assert.ok(!excerptExcludingPrompt.includes('长文本内容'));
        assert.ok(excerptExcludingPrompt.includes('较早的问题'));
        assert.ok(excerptExcludingPrompt.includes('较早的回答'));
    } finally {
        cleanupTempDir(tmpDir);
    }
});

test('SessionManager resetSessionUsage 设定 activeSessionStartSeq，无上报时动态累加新会话增量', () => {
    const tmpDir = createTempDir('lvtian-usage-reset-');
    try {
        const sm = new SessionManager(tmpDir);

        // 旧会话累积了若干历史消息
        sm.addMessage('main', { id: 'u-1', role: 'user', content: '旧消息1 (历史长文本) '.repeat(50), timestamp: 100, status: 'sent' });
        sm.addMessage('main', { id: 'a-1', role: 'assistant', content: '旧回复1 (历史长文本) '.repeat(50), timestamp: 101, status: 'done' });

        // 此时估算 Token 包含了旧消息
        const oldEstimate = sm.getUsage('main').tokens;
        assert.ok(oldEstimate > 200);

        // 轮换至新 DSH 实例：重置用量
        sm.resetSessionUsage('main');
        assert.strictEqual(sm.getUsage('main').tokens, 0);

        // 新会话产生第一轮交互
        sm.addMessage('main', { id: 'u-2', role: 'user', content: '新会话第一轮提问：测试估算逻辑', timestamp: 200, status: 'sent' });
        sm.addMessage('main', { id: 'a-2', role: 'assistant', content: '新会话第一轮回答：成功返回', timestamp: 201, status: 'done' });

        // 此时在无 usage_update 上报的情况下，估算 Token 仅统计新会话增量，不混入旧会话的 200+ tokens
        const newEstimate = sm.getUsage('main').tokens;
        assert.ok(newEstimate > 0);
        assert.ok(newEstimate < oldEstimate);
    } finally {
        cleanupTempDir(tmpDir);
    }
});

test('提炼覆盖整段会话：最早的结论不会因为消息条数被丢掉', async () => {
    const tmpDir = createTempDir('lvtian-span-dialogue-');
    try {
        const sm = new SessionManager(tmpDir);
        // 第一条就埋下关键结论，后面堆 40 条闲聊把窗口挤出「最近 30 条」
        sm.addMessage('main', { id: 'u-1', role: 'user', content: '定案：方案采用 A 路线，暗号赤松', timestamp: 1, status: 'sent' });
        for (let i = 2; i <= 41; i++) {
            sm.addMessage('main', { id: `u-${i}`, role: 'user', content: `闲聊第 ${i} 条`, timestamp: i, status: 'sent' });
            sm.addMessage('main', { id: `a-${i}`, role: 'assistant', content: `回应第 ${i} 条`, timestamp: i, status: 'done' });
        }
        sm.recordActivity('main', Date.now() - 4 * 60 * 60 * 1000);
        sm.setUsage('main', 40000, 128000);

        let captured = '';
        const consolidator = new ContextConsolidator(sm, {
            apiKey: 'sk-test',
            fetchFn: async (_url, init) => {
                captured = JSON.parse(init.body).messages[1].content;
                return new Response(JSON.stringify({
                    choices: [{ message: { content: '整段会话提要' } }],
                }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            },
        });

        await consolidator.consolidate('main');
        assert.ok(captured.includes('暗号赤松'), '第一条消息里的结论必须进入提炼输入');
        assert.ok(captured.includes('闲聊第 41 条'), '最后一条也要在');
    } finally {
        cleanupTempDir(tmpDir);
    }
});

test('提炼读取服务端全部历史：轮换前的对话不会被排除', async () => {
    const tmpDir = createTempDir('lvtian-history-dialogue-');
    try {
        const sm = new SessionManager(tmpDir);
        sm.addMessage('main', { id: 'u-old', role: 'user', content: '很早以前定下的暗号是青竹', timestamp: 1, status: 'sent' });
        sm.addMessage('main', { id: 'a-old', role: 'assistant', content: '记住了', timestamp: 2, status: 'done' });
        // 模拟发生了一次轮换：之后的提炼若按 activeSessionStartSeq 截断，就会漏掉上面的历史
        sm.resetSessionUsage('main', 99);
        sm.addMessage('main', { id: 'u-new', role: 'user', content: '轮换后的新话题', timestamp: 3, status: 'sent' });
        sm.recordActivity('main', Date.now() - 4 * 60 * 60 * 1000);
        sm.setUsage('main', 40000, 128000);

        let captured = '';
        const consolidator = new ContextConsolidator(sm, {
            apiKey: 'sk-test',
            fetchFn: async (_url, init) => {
                captured = JSON.parse(init.body).messages[1].content;
                return new Response(JSON.stringify({
                    choices: [{ message: { content: '完整历史提要' } }],
                }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            },
        });

        await consolidator.consolidate('main');
        assert.ok(captured.includes('暗号是青竹'), '轮换前的历史必须进入提炼输入');
        assert.ok(captured.includes('轮换后的新话题'));
    } finally {
        cleanupTempDir(tmpDir);
    }
});

test('超长会话分段提炼再合并：不截断、不丢中间内容', async () => {
    const tmpDir = createTempDir('lvtian-span-chunk-');
    try {
        const sm = new SessionManager(tmpDir);
        for (let i = 1; i <= 6; i++) {
            sm.addMessage('main', {
                id: `u-${i}`,
                role: 'user',
                content: `第${i}段关键内容` + 'x'.repeat(150),
                timestamp: i,
                status: 'sent',
            });
        }
        sm.recordActivity('main', Date.now() - 4 * 60 * 60 * 1000);
        sm.setUsage('main', 40000, 128000);

        const calls = [];
        const consolidator = new ContextConsolidator(sm, {
            apiKey: 'sk-test',
            maxDialogueChars: 200,
            fetchFn: async (_url, init) => {
                calls.push(JSON.parse(init.body).messages[1].content);
                return new Response(JSON.stringify({
                    choices: [{ message: { content: `局部备忘 ${calls.length}` } }],
                }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            },
        });

        const result = await consolidator.consolidate('main');
        assert.ok(result, '应产出合并后的提要');
        assert.ok(calls.length > 2, `应发生多次调用，实际 ${calls.length}`);
        const joined = calls.join('\n');
        for (let i = 1; i <= 6; i++) {
            assert.ok(joined.includes(`第${i}段关键内容`), `第 ${i} 段不能丢`);
        }
        assert.ok(calls[calls.length - 1].includes('合并'), '最后一步应是合并');
        assert.strictEqual(sm.getPendingBackground('main'), result);
    } finally {
        cleanupTempDir(tmpDir);
    }
});

test('ContextConsolidator 排除正在执行 (processing/awaiting_approval) 的会话', async () => {
    const tmpDir = createTempDir('lvtian-consolidate-running-');
    try {
        const sm = new SessionManager(tmpDir);
        sm.addMessage('main', { id: 'u-1', role: 'user', content: '之前的问题', timestamp: 100, status: 'sent' });
        // 上次真实交互时间为 4 小时前，但当前任务正在运行中（例如长时工具调用跨过 3 小时）
        sm.recordActivity('main', Date.now() - 4 * 60 * 60 * 1000);
        sm.setUsage('main', 40000, 128000);
        sm.setTaskState('main', 'processing');

        const consolidator = new ContextConsolidator(sm, {
            apiKey: 'test-key',
            fetchFn: async () => ({
                ok: true,
                status: 200,
                json: async () => ({ choices: [{ message: { content: '提要内容' } }] }),
            }),
        });

        // isEligible 与 consolidate 直接拦截排除运行中的会话
        assert.strictEqual(consolidator.isEligible('main'), false);
        const res = await consolidator.consolidate('main');
        assert.strictEqual(res, null);
        assert.strictEqual(sm.hasPendingBackground('main'), false);

        // scanAllSessions 也跳过运行中的会话
        const scanned = await consolidator.scanAllSessions();
        assert.deepStrictEqual(scanned, []);
    } finally {
        cleanupTempDir(tmpDir);
    }
});

test('AcpEngineManager 轮换首轮请求异常时保留 pendingBackground 支持重试注入', async () => {
    const tmpDir = createTempDir('lvtian-engine-retry-memo-');
    try {
        const mm = new MemoryManager(tmpDir);
        const sm = new SessionManager(tmpDir);
        let shouldFailPrompt = true;

        const prompts = [];
        const mockEngine = acp.agent({ name: 'mock-failing-engine' })
            .onRequest(acp.methods.agent.initialize, () => ({
                protocolVersion: acp.PROTOCOL_VERSION,
                agentCapabilities: {},
            }))
            .onRequest(acp.methods.agent.authenticate, () => ({}))
            .onRequest(acp.methods.agent.session.new, () => ({ sessionId: 'engine-new-1' }))
            .onRequest(acp.methods.agent.session.prompt, async (c) => {
                prompts.push(c.params.prompt?.[0]?.text ?? '');
                if (shouldFailPrompt) {
                    throw new Error('Connection reset by peer');
                }
                return { stopReason: 'end_turn' };
            });

        const engine = new AcpEngineManager(tmpDir, mm, sm, {
            connectEngine: connectMockEngine(mockEngine),
        });

        // 预设背景提要（活跃时间推到 3h 前以满足轮换门禁）
        const memo = '### 1. 核心共识\n重要备忘录';
        sm.setPendingBackground('main', memo);
        sm.setUsage('main', 40000, 128000);
        sm.recordActivity('main', Date.now() - 4 * 60 * 60 * 1000);
        assert.strictEqual(sm.hasPendingBackground('main'), true);

        // 首轮请求触发轮换，但在发送 prompt 时失败
        await engine.execute('main', 'asst-1', '你好', {
            onDelta: () => {},
            onToolCall: () => {},
            onStatusChange: () => {},
        });

        // 重点：请求失败后提要文件依然保留在磁盘上（支持重试注入）
        assert.strictEqual(sm.hasPendingBackground('main'), true);
        assert.strictEqual(sm.getPendingBackground('main'), memo);

        // 用户发起重试：底层连接恢复
        shouldFailPrompt = false;
        await engine.execute('main', 'asst-2', '你好（重试）', {
            onDelta: () => {},
            onToolCall: () => {},
            onStatusChange: () => {},
        });

        // 重试时摘要必须重新注入，不能因为用量已重置而被当成「提前回来」丢弃
        assert.strictEqual(prompts.length, 2);
        assert.ok(prompts[1].includes('上次静默期归档'), '重试 prompt 应包含提要标题');
        assert.ok(prompts[1].includes(memo), '重试 prompt 应包含提要正文');
        // 成功交接后提要被正常消费清理，交接标记也清除
        assert.strictEqual(sm.hasPendingBackground('main'), false);
        assert.strictEqual(sm.isHandoffPending('main'), false);

        await engine.stopAll();
    } finally {
        cleanupTempDir(tmpDir);
    }
});

// ------------------------------------------------------------------
// 提前量、提前唤醒丢弃与断档接管
// ------------------------------------------------------------------

test('ContextConsolidator 预生成提前量：早于「门禁-提前量」不提炼，进入提前窗口才提炼', async () => {
    const tmpDir = createTempDir('lvtian-lead-');
    try {
        const sm = new SessionManager(tmpDir);
        sm.addMessage('main', { id: 'u-1', role: 'user', content: '讨论轮换方案', timestamp: Date.now(), status: 'sent' });
        sm.addMessage('main', { id: 'a-1', role: 'assistant', content: '好的', timestamp: Date.now(), status: 'done' });
        sm.setUsage('main', 40000, 128000); // 31% > 20%

        // 轮换门禁 10s，提前量 2s => 从第 8s 起开始预生成
        const consolidator = new ContextConsolidator(sm, {
            idleTimeoutMs: 10_000,
            consolidationLeadMs: 2_000,
            apiKey: 'sk-test',
            fetchFn: async () => new Response(JSON.stringify({
                choices: [{ message: { content: '预生成提要内容' } }],
            }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
        });

        sm.recordActivity('main', Date.now() - 7_500);
        assert.strictEqual(consolidator.isEligible('main'), false, '7.5s 未进入提前窗口');

        sm.recordActivity('main', Date.now() - 8_200);
        assert.strictEqual(consolidator.isEligible('main'), true, '8.2s 已进入提前窗口');

        const scanned = await consolidator.scanAllSessions();
        assert.deepStrictEqual(scanned, ['main']);
        assert.strictEqual(sm.hasPendingBackground('main'), true);
    } finally {
        cleanupTempDir(tmpDir);
    }
});

test('预生成后主人提前回来：丢弃提要、保持原 DSH 会话，不提前轮换', async () => {
    const tmpDir = createTempDir('lvtian-early-return-');
    try {
        const mm = new MemoryManager(tmpDir);
        const sm = new SessionManager(tmpDir);
        const tracker = {};
        const engine = new AcpEngineManager(tmpDir, mm, sm, {
            idleTimeoutMs: 3 * 60 * 60 * 1000,
            minCapacityRatio: 0.2,
            connectEngine: connectMockEngine(createMockEngine(tracker)),
        });

        sm.addMessage('main', { id: 'u-1', role: 'user', content: '第一轮', timestamp: Date.now(), status: 'sent' });
        await engine.execute('main', 'asst-1', '第一轮', {
            onDelta: () => {},
            onToolCall: () => {},
            onStatusChange: () => {},
        });
        const firstSession = sm.getDshSessionId('main');
        sm.setUsage('main', 40000, 128000); // 容量过线

        // 2h58m：提前窗口内已生成提要，但还没满 3h
        sm.setPendingBackground('main', '预生成但尚未生效的提要');
        sm.recordActivity('main', Date.now() - (2 * 60 + 58) * 60 * 1000);

        await engine.execute('main', 'asst-2', '我回来了', {
            onDelta: () => {},
            onToolCall: () => {},
            onStatusChange: () => {},
        });

        // 不换会话，提要作废
        assert.strictEqual(sm.getDshSessionId('main'), firstSession, '未满 3h 不应轮换');
        assert.strictEqual(tracker.createdSessions.length, 1);
        assert.strictEqual(sm.hasPendingBackground('main'), false, '提前回来应丢弃预生成提要');
        assert.ok(!tracker.prompts[1].text.includes('预生成但尚未生效的提要'));

        await engine.stopAll();
    } finally {
        cleanupTempDir(tmpDir);
    }
});

test('日志快照轮换写入 v2 完整 state：压缩后会话状态不丢', () => {
    const tmpDir = createTempDir('lvtian-snapshot-v2-');
    const prevThreshold = process.env.LVTIAN_SESSION_ROTATE_BYTES;
    try {
        process.env.LVTIAN_SESSION_ROTATE_BYTES = '400';
        const sm = new SessionManager(tmpDir);
        for (let i = 0; i < 4; i++) {
            sm.addMessage('main', {
                id: `m${i}`,
                role: 'user',
                content: `消息-${i}-` + 'x'.repeat(200),
                timestamp: Date.now(),
                status: 'sent',
            });
        }
        sm.recordActivity('main', 1234567890);
        sm.setUsage('main', 40000, 128000);
        // 再写一条，触发快照轮换，确保快照覆盖刚写入的活跃时间与用量
        sm.addMessage('main', {
            id: 'm-trigger',
            role: 'user',
            content: '触发轮换-' + 'y'.repeat(200),
            timestamp: Date.now(),
            status: 'sent',
        });

        const activeRaw = fs.readFileSync(path.join(tmpDir, 'sessions', 'main', 'events.jsonl'), 'utf8');
        const first = JSON.parse(activeRaw.slice(0, activeRaw.indexOf('\n')));
        assert.strictEqual(first.v, 2);
        assert.strictEqual(first.state.messages.length, 5);
        assert.strictEqual(first.state.lastActiveAt, 1234567890);
        assert.strictEqual(first.state.contextTokens, 40000);

        const sm2 = new SessionManager(tmpDir);
        assert.strictEqual(sm2.getReconcileData('main', 0).messages.length, 5);
        assert.strictEqual(sm2.getUsage('main').tokens, 40000);
    } finally {
        if (prevThreshold === undefined) delete process.env.LVTIAN_SESSION_ROTATE_BYTES;
        else process.env.LVTIAN_SESSION_ROTATE_BYTES = prevThreshold;
        cleanupTempDir(tmpDir);
    }
});

test('底层 resume 返回另一个会话时按断档处理：注入原文锚定而非静默丢上下文', async () => {
    const tmpDir = createTempDir('lvtian-resume-replaced-');
    try {
        const mm = new MemoryManager(tmpDir);
        const sm = new SessionManager(tmpDir);
        const tracker = {};
        const engine1 = new AcpEngineManager(tmpDir, mm, sm, {
            connectEngine: connectMockEngine(createMockEngine(tracker)),
        });
        sm.addMessage('main', { id: 'u-1', role: 'user', content: '请记住暗号是青竹', timestamp: Date.now(), status: 'sent' });
        await engine1.execute('main', 'asst-1', '请记住暗号是青竹', {
            onDelta: () => {},
            onToolCall: () => {},
            onStatusChange: () => {},
        });
        sm.addMessage('main', { id: 'a-1', role: 'assistant', content: '记住了，暗号是青竹', timestamp: Date.now(), status: 'done' });
        const firstSession = sm.getDshSessionId('main');
        await engine1.stopAll();

        // 换一个引擎连接，模拟 resume 时旧会话损坏被替换成全新会话
        const tracker2 = { resumeReplacementId: 'engine-replacement-1' };
        const engine2 = new AcpEngineManager(tmpDir, mm, sm, {
            connectEngine: connectMockEngine(createMockEngine(tracker2)),
        });
        await engine2.execute('main', 'asst-2', '暗号是什么？', {
            onDelta: () => {},
            onToolCall: () => {},
            onStatusChange: () => {},
        });

        assert.notStrictEqual(sm.getDshSessionId('main'), firstSession);
        assert.strictEqual(sm.getDshSessionId('main'), 'engine-replacement-1');
        const prompt = tracker2.prompts[0].text;
        assert.ok(prompt.includes('[未竟事项与关键交互原文锚定'), '断档时应补注原文锚定');
        assert.ok(prompt.includes('青竹'), '应带回上一轮的关键内容');

        await engine2.stopAll();
    } finally {
        cleanupTempDir(tmpDir);
    }
});

test('工作区记忆文件每轮重读：MEMORY.md 修改后下一轮 prompt 立即生效', async () => {
    const tmpDir = createTempDir('lvtian-memory-refresh-');
    try {
        const mm = new MemoryManager(tmpDir);
        const sm = new SessionManager(tmpDir);
        const tracker = {};
        const engine = new AcpEngineManager(tmpDir, mm, sm, {
            connectEngine: connectMockEngine(createMockEngine(tracker)),
        });

        fs.writeFileSync(path.join(tmpDir, 'MEMORY.md'), '# 旧记忆\n- 当前暗号：青竹\n', 'utf8');
        await engine.execute('main', 'asst-1', '第一轮', {
            onDelta: () => {},
            onToolCall: () => {},
            onStatusChange: () => {},
        });
        assert.ok(tracker.prompts[0].text.includes('当前暗号：青竹'));

        // 引擎进程不重启，模拟用户在会话进行中修改记忆文件
        fs.writeFileSync(path.join(tmpDir, 'MEMORY.md'), '# 新记忆\n- 当前暗号：赤松\n', 'utf8');
        await engine.execute('main', 'asst-2', '第二轮', {
            onDelta: () => {},
            onToolCall: () => {},
            onStatusChange: () => {},
        });
        assert.ok(tracker.prompts[1].text.includes('当前暗号：赤松'), '下一轮应加载最新记忆');
        assert.ok(!tracker.prompts[1].text.includes('当前暗号：青竹'), '不应继续使用旧副本');

        await engine.stopAll();
    } finally {
        cleanupTempDir(tmpDir);
    }
});
