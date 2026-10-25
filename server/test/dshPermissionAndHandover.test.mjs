import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import yaml from 'yaml';
import * as acp from '@agentclientprotocol/sdk';
import {
    getDshPermissionMode,
    setDshPermissionMode,
    DEFAULT_PERMISSION_MODE,
} from '../dist/dshConfigManager.js';
import { SessionManager } from '../dist/sessionManager.js';
import { MemoryManager } from '../dist/memoryManager.js';
import { AcpEngineManager } from '../dist/acpEngineManager.js';
import { ContextConsolidator } from '../dist/contextConsolidator.js';
import { FileManager } from '../dist/fileManager.js';
import { LvtianServer } from '../dist/server.js';

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

test('DshConfigManager: 默认权限、读写原子性与其它 Patch 保护', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvtian-dsh-config-test-'));
    try {
        // 1. 空目录默认返回 workspace-write
        assert.equal(getDshPermissionMode(tmpDir), DEFAULT_PERMISSION_MODE);

        // 2. 模拟文件中已存在其它插件 patch
        const patchFile = path.join(tmpDir, 'cordis.patch.yml');
        const initialPatches = [
            { id: 'custom-logger', config: { level: 'debug' } },
        ];
        fs.writeFileSync(patchFile, yaml.stringify(initialPatches), 'utf8');

        // 3. 设置为 danger-full-access
        setDshPermissionMode('danger-full-access', tmpDir);
        assert.equal(getDshPermissionMode(tmpDir), 'danger-full-access');

        // 验证原有的 custom-logger 是否完好保留
        const afterSet = yaml.parse(fs.readFileSync(patchFile, 'utf8'));
        assert.equal(afterSet.length, 2);
        assert.equal(afterSet[0].id, 'custom-logger');
        assert.equal(afterSet[1].id, 'sandboxPolicy');
        assert.equal(afterSet[1].config.mode, 'danger-full-access');

        // 4. 切回 workspace-write
        setDshPermissionMode('workspace-write', tmpDir);
        assert.equal(getDshPermissionMode(tmpDir), 'workspace-write');

        const afterRevert = yaml.parse(fs.readFileSync(patchFile, 'utf8'));
        assert.equal(afterRevert.length, 2);
        assert.equal(afterRevert[1].config.mode, 'workspace-write');

        // 5. 损坏或非法 YAML 保护：抛出异常并保留原始文件内容，禁止静默覆盖清空
        const corruptedContent = ':::invalid:yaml:content:::';
        fs.writeFileSync(patchFile, corruptedContent, 'utf8');
        assert.throws(
            () => setDshPermissionMode('danger-full-access', tmpDir),
            /读取或解析现有 DSH 配置文件失败/
        );
        assert.equal(fs.readFileSync(patchFile, 'utf8'), corruptedContent);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('AcpEngineManager: triggerHandover 即时提炼、重置底层绑定并无缝接力新会话', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvtian-handover-test-'));
    try {
        const workspaceDir = path.join(tmpDir, 'workspace');
        const dataDir = path.join(tmpDir, 'data');
        fs.mkdirSync(workspaceDir, { recursive: true });
        fs.mkdirSync(dataDir, { recursive: true });

        const sessionManager = new SessionManager(dataDir);
        const memoryManager = new MemoryManager(workspaceDir);

        // 初始化一条有历史对话的会话
        sessionManager.getOrCreateSession('main');
        sessionManager.addMessage('main', {
            id: 'user-msg-1',
            role: 'user',
            content: '请帮我排查一下服务器端口',
            timestamp: Date.now(),
            status: 'sent',
        });
        sessionManager.addMessage('main', {
            id: 'asst-msg-1',
            role: 'assistant',
            content: '好的，已确认端口 3000 正常运行，下一步可以配置反向代理。',
            timestamp: Date.now(),
            status: 'done',
        });
        sessionManager.setDshSessionId('main', 'engine-old-session-123');

        // 构造 mock ContextConsolidator，返回确定的提炼备忘录
        let consolidateCalled = false;
        const mockConsolidator = {
            consolidateNow: async (sid) => {
                consolidateCalled = true;
                sessionManager.setPendingBackground(
                    sid,
                    '### 1. 核心共识\n已确认端口3000运行。\n\n### 2. 下一步\n配置反代。'
                );
                return '### 1. 核心共识\n已确认端口3000运行。';
            },
        };

        let lastPrompt = '';
        let engineSessionCounter = 0;
        const knownSessions = new Set();
        const activeSessions = new Set();

        const mockApp = acp.agent({ name: 'mock-engine' })
            .onRequest(acp.methods.agent.initialize, () => ({
                protocolVersion: acp.PROTOCOL_VERSION,
                agentCapabilities: {},
            }))
            .onRequest(acp.methods.agent.authenticate, () => ({}))
            .onRequest(acp.methods.agent.session.new, () => {
                const sessionId = `engine-new-session-${++engineSessionCounter}`;
                knownSessions.add(sessionId);
                activeSessions.add(sessionId);
                return { sessionId };
            })
            .onRequest(acp.methods.agent.session.resume, (c) => {
                if (!knownSessions.has(c.params.sessionId)) {
                    throw new acp.RequestError(-32002, 'session not found');
                }
                activeSessions.add(c.params.sessionId);
                return { sessionId: c.params.sessionId };
            })
            .onRequest(acp.methods.agent.session.prompt, async (c) => {
                lastPrompt = c.params.prompt?.[0]?.text ?? '';
                await c.client.notify(acp.methods.client.session.update, {
                    sessionId: c.params.sessionId,
                    update: {
                        sessionUpdate: 'agent_message_chunk',
                        content: { type: 'text', text: 'response' },
                    },
                });
                return { stopReason: 'end_turn' };
            });

        const engine = new AcpEngineManager(workspaceDir, memoryManager, sessionManager, {
            connectEngine: connectMockEngine(mockApp),
            contextConsolidator: mockConsolidator,
        });

        // 触发统一会话交接流水线
        await engine.triggerHandover('main', 'permission_switch_to_danger');

        // 验证交接状态
        assert.equal(consolidateCalled, true);
        assert.equal(sessionManager.isHandoffPending('main'), true);
        assert.equal(sessionManager.getDshSessionId('main'), '');
        assert.ok(sessionManager.hasPendingBackground('main'));

        // 发送下一轮交互
        const asstMsg = sessionManager.addMessage('main', {
            id: 'asst-msg-2',
            role: 'assistant',
            content: '',
            timestamp: Date.now(),
            status: 'processing',
        });
        await engine.execute('main', asstMsg.id, '继续执行下一步', {
            onDelta: () => {},
            onStatusChange: () => {},
            onToolCall: () => {},
        });

        // 验证新 DSH 会话已绑定，且首轮 Prompt 注入了心智备忘录
        assert.equal(sessionManager.getDshSessionId('main'), 'engine-new-session-1');
        assert.ok(lastPrompt.includes('核心共识') || lastPrompt.includes('3小时前归档'));
        assert.ok(lastPrompt.includes('配置反代'));
        assert.ok(lastPrompt.includes('继续执行下一步'));

        // 交互成功后，待交接标记和临时提要已被清理
        assert.equal(sessionManager.isHandoffPending('main'), false);
        assert.equal(sessionManager.hasPendingBackground('main'), false);

        await engine.stopAll();
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('Server API: GET/POST /api/permission 接口鉴权、参数校验与联动', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvtian-server-perm-test-'));
    try {
        const workspaceDir = path.join(tmpDir, 'workspace');
        const dataDir = path.join(tmpDir, 'data');
        const dshProfileDir = path.join(tmpDir, 'dsh', 'profiles', 'acp');
        fs.mkdirSync(workspaceDir, { recursive: true });
        fs.mkdirSync(dataDir, { recursive: true });
        fs.mkdirSync(dshProfileDir, { recursive: true });

        const sessionManager = new SessionManager(dataDir);
        const memoryManager = new MemoryManager(workspaceDir);
        const fileManager = new FileManager(workspaceDir);
        const contextConsolidator = new ContextConsolidator(sessionManager);

        let handoverTriggered = false;
        const mockEngine = {
            isRunning: () => false,
            stop: () => false,
            stopAll: async () => {},
            rebuildSystemPrompt: () => false,
            execute: async () => {},
            handleApproval: () => false,
            triggerHandover: async (sid, reason) => {
                handoverTriggered = true;
            },
        };

        const config = {
            host: '127.0.0.1',
            port: 0,
            token: 'test-secret-token-12345',
            workspace: workspaceDir,
            dataDir,
            assistantName: '绿天',
            dshProfileDir,
        };

        const server = new LvtianServer(
            config,
            sessionManager,
            memoryManager,
            mockEngine,
            fileManager,
            contextConsolidator
        );

        await server.start();
        const port = server.httpServer.address().port;
        assert.ok(port > 0);

        const baseUrl = `http://127.0.0.1:${port}`;

        // 1. 未授权访问拒绝 (401)
        const unauthRes = await fetch(`${baseUrl}/api/permission`);
        assert.equal(unauthRes.status, 401);

        // 2. 带 token 获取权限 (初始为 workspace-write)
        const getRes = await fetch(`${baseUrl}/api/permission`, {
            headers: { Authorization: `Bearer ${config.token}` },
        });
        assert.equal(getRes.status, 200);
        const getData = await getRes.json();
        assert.equal(getData.permissionMode, 'workspace-write');

        // 3. /api/info 接口返回 permissionMode
        const infoRes = await fetch(`${baseUrl}/api/info`, {
            headers: { Authorization: `Bearer ${config.token}` },
        });
        assert.equal(infoRes.status, 200);
        const infoData = await infoRes.json();
        assert.equal(infoData.permissionMode, 'workspace-write');

        // 4. POST 非法参数返回 400
        const badPostRes = await fetch(`${baseUrl}/api/permission`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${config.token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ permissionMode: 'root' }),
        });
        assert.equal(badPostRes.status, 400);

        // 5. POST 正确切换至 danger-full-access
        let handoverCount = 0;
        mockEngine.triggerHandover = async () => {
            handoverCount++;
        };
        const postRes = await fetch(`${baseUrl}/api/permission`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${config.token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ permissionMode: 'danger-full-access' }),
        });
        assert.equal(postRes.status, 200);
        const postData = await postRes.json();
        assert.equal(postData.success, true);
        assert.equal(postData.permissionMode, 'danger-full-access');
        assert.equal(postData.changed, true);
        assert.equal(handoverCount, 1);

        // 6. 相同模式再次 POST：应幂等返回 changed: false，且不触发 handover
        const postSameRes = await fetch(`${baseUrl}/api/permission`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${config.token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ permissionMode: 'danger-full-access' }),
        });
        assert.equal(postSameRes.status, 200);
        const postSameData = await postSameRes.json();
        assert.equal(postSameData.success, true);
        assert.equal(postSameData.changed, false);
        assert.equal(handoverCount, 1);

        // 7. 再次 GET 确认更新
        const getUpdated = await fetch(`${baseUrl}/api/permission`, {
            headers: { Authorization: `Bearer ${config.token}` },
        });
        const updatedData = await getUpdated.json();
        assert.equal(updatedData.permissionMode, 'danger-full-access');

        await server.stop();
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});
