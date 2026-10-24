import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { SessionManager } from '../dist/sessionManager.js';
import { ContextConsolidator } from '../dist/contextConsolidator.js';
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
            if (!knownSessions.has(c.params.sessionId)) {
                throw new acp.RequestError(-32002, 'session not found');
            }
            activeSessions.add(c.params.sessionId);
            tracker.resumedSessions.push(c.params.sessionId);
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
        assert.strictEqual(capturedRequest.body.model, 'deepseek-chat');
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

        // 模拟深度静默期间后台已写入 pending_background.txt
        const memoContent = `### 1. 核心共识与最终盘面
- 服务端会话轮换方案定案。`;
        sm.setPendingBackground('main', memoContent);
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
        assert.ok(secondPrompt.includes('[前序交流心智接力提要 (3小时前归档)]'));
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

        await engine.stopAll();
    } finally {
        cleanupTempDir(tmpDir);
    }
});
