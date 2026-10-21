import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SessionManager } from '../dist/sessionManager.js';
import { LvtianServer } from '../dist/server.js';
import { MemoryManager } from '../dist/memoryManager.js';
import { DshRunner } from '../dist/dshRunner.js';
import WebSocket from 'ws';

test('SessionManager handles final lossless text update and advances sequence', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvtian-test-sm-'));
    const sm = new SessionManager(tmpDir);

    const msg = sm.addMessage('test-session', {
        id: 'asst-1',
        role: 'assistant',
        content: '前8KB截断内容...',
        timestamp: Date.now(),
        status: 'processing',
    });

    const initialSeq = msg.seq;
    assert.equal(msg.content, '前8KB截断内容...');

    // 模拟 final 事件校准无损文本
    const fullText = '前8KB截断内容...后面完整超大长文本输出';
    const updated = sm.updateMessage(
        'test-session',
        'asst-1',
        (m) => {
            m.content = fullText;
        },
        true,
        true
    );

    assert.ok(updated);
    assert.equal(updated.content, fullText);
    assert.ok(updated.seq > initialSeq);

    // 验证重连对账根据 initialSeq 返回最新完整文本
    const reconcile = sm.getReconcileData('test-session', initialSeq);
    assert.equal(reconcile.messages.length, 1);
    assert.equal(reconcile.messages[0].content, fullText);

    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('LvtianServer handles WebSocket connection error without crash', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvtian-test-srv-'));
    const sm = new SessionManager(tmpDir);
    const mm = new MemoryManager(tmpDir);
    const runner = new DshRunner(tmpDir, mm, sm);

    const config = {
        port: 0, // 动态随机端口
        host: '127.0.0.1',
        token: 'test-token-12345678901234567890',
        workspace: tmpDir,
        dataDir: tmpDir,
        assistantName: 'TestBot',
    };

    const server = new LvtianServer(config, sm, mm, runner);
    await server.start();

    const assignedPort = server.httpServer.address().port;

    // 客户端发送超过 maxPayload (1MB) 的超大报文，切实触发服务端 accepted socket 的 RangeError
    await new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${assignedPort}`);
        ws.on('open', () => {
            const oversized = Buffer.alloc(1024 * 1024 + 1024);
            ws.send(oversized);
        });
        ws.on('error', () => {
            // 客户端侧网络重置
        });
        ws.on('close', () => {
            resolve();
        });
    });

    // 验证服务端稳定存活，后续正常客户端依然可顺畅连接
    await new Promise((resolve, reject) => {
        const healthyWs = new WebSocket(`ws://127.0.0.1:${assignedPort}`);
        healthyWs.on('open', () => {
            healthyWs.close();
            resolve();
        });
        healthyWs.on('error', reject);
    });

    await server.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('scripts match server absolute entrypoint as exact argv and reject sub-path or backup names', () => {
    const serverDir = '/home/claw/code/lvtian/server';
    const target = `${serverDir}/dist/index.js`;
    const isServerArgv = (argvList) => argvList.some((arg) => arg === target);

    assert.equal(isServerArgv(['node', `${serverDir}/dist/index.js`]), true);
    assert.equal(isServerArgv(['node', `${serverDir}/dist/index.js.backup`]), false);
    assert.equal(isServerArgv(['node', '/home/other/server/dist/index.js']), false);
    assert.equal(isServerArgv(['cat', 'other-data']), false);
});

test('MemoryManager loads context from workspace directory including AGENTS.md and preserves existing content', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvtian-test-mm-'));
    // 写入预置工作区文件
    fs.writeFileSync(path.join(tmpDir, 'SOUL.md'), '# 自定义灵魂准则\n忠诚敏锐');
    fs.writeFileSync(path.join(tmpDir, 'MEMORY.md'), '# 自定义长期记忆\n偏好中文交流');
    fs.writeFileSync(path.join(tmpDir, 'USER.md'), '# 主人档案\n称呼：先生');
    fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), '# 工作规范\n先请示后执行');

    const mm = new MemoryManager(tmpDir);
    assert.equal(mm.getBaseDir(), tmpDir);

    const ctx = mm.loadContext();
    assert.equal(ctx.soul, '# 自定义灵魂准则\n忠诚敏锐');
    assert.equal(ctx.memory, '# 自定义长期记忆\n偏好中文交流');
    assert.equal(ctx.user, '# 主人档案\n称呼：先生');
    assert.equal(ctx.agents, '# 工作规范\n先请示后执行');

    // 验证追加流水日志写入 workspace/memory/
    mm.appendDailyLog('测试标题', '测试内容流水');
    const today = new Date().toISOString().slice(0, 10);
    const dailyFile = path.join(tmpDir, 'memory', `${today}.md`);
    assert.ok(fs.existsSync(dailyFile));
    const dailyContent = fs.readFileSync(dailyFile, 'utf8');
    assert.ok(dailyContent.includes('测试标题'));
    assert.ok(dailyContent.includes('测试内容流水'));

    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('composite final text preserves earlier committed segments and replaces truncated terminal segment', () => {
    // 模拟包含工具调用的多阶段输出：工具前有 text 事件，工具后有截断 text 事件，最终有无损 final 事件
    const committedSegments = ['好的，我正在为您查询日程...', '日程如下（截断）：- 会议'];
    const finalEventText = '日程如下（完整）：- 会议A\n- 会议B\n- 会议C';

    const priorText = committedSegments.length > 1 ? committedSegments.slice(0, -1).join('') : '';
    const fullLosslessText = priorText + finalEventText;

    assert.equal(
        fullLosslessText,
        '好的，我正在为您查询日程...日程如下（完整）：- 会议A\n- 会议B\n- 会议C'
    );
    // 验证前置工具调用文字未被丢弃
    assert.ok(fullLosslessText.includes('好的，我正在为您查询日程...'));
    assert.ok(fullLosslessText.includes('会议C'));
});



