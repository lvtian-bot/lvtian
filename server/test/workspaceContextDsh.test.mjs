import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Readable, Writable } from 'node:stream';
import yaml from 'yaml';
import * as acp from '@agentclientprotocol/sdk';
import { Context } from '@deepseek-ai/cordis';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native';
import { apply } from '../dist/workspaceContextPlugin.js';
import { prepareWorkspaceContextOverlay } from '../dist/workspaceContextConfig.js';

// 使用真实 DSH 循环和会话投影，仅模型适配器为本地合成响应，无联网和凭据。
class CaptureAdapter extends LlmAdapter {
    requests = [];
    async resolveModel(provider, model) {
        return { provider, id: model, name: model, systemPromptUpdate: 'in-history' };
    }
    async *stream(options) {
        this.requests.push(options);
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: '已完成' };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: '已完成' } };
        yield { type: 'finish', reason: { kind: 'stop' } };
    }
}

async function harness(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lvtian-dsh-context-'));
    fs.mkdirSync(path.join(root, 'memory'));
    fs.writeFileSync(path.join(root, 'MEMORY.md'), '当前计划：青竹');
    const ctx = new Context();
    t.after(async () => {
        await ctx.fiber.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });
    for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, SystemPrompt, ToolRuntime, NativeToolExecutor, AgentRegistry]) await ctx.plugin(plugin);
    await ctx.plugin(AgentLoop, { agents: [] });
    apply(ctx, { workspace: root });
    const adapter = new CaptureAdapter();
    ctx.llm.registerAdapter(['local-test'], adapter);
    const agent = await ctx.agentLoop.create(SessionId('context-root'), { provider: 'local-test', model: 'synthetic' });
    async function send(text) {
        agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }));
        await agent.whenIdle();
    }
    return { root, ctx, agent, adapter, send };
}

const contextEvents = agent => agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source?.kind === 'runtime-context');
const text = message => message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');

test('真实 DSH 请求：固定指令为 system，档案独立于提问，未变化不新增快照', async t => {
    const h = await harness(t);
    await h.send('第一问');
    await h.send('第二问');
    assert.equal(h.adapter.requests.length, 2);
    const request = h.adapter.requests[1];
    assert.ok(request.messages.some(message => message.role === 'system' && text(message).includes('写入记忆之前先读取原文件')));
    assert.deepEqual(request.messages.filter(message => message.source?.kind === 'user').map(text), ['第一问', '第二问']);
    assert.equal(contextEvents(h.agent).length, 1);
    assert.match(text(contextEvents(h.agent)[0].data), /当前计划：青竹/);
    assert.deepEqual(fs.readdirSync(path.join(h.root, 'memory')), []);
});

test('真实 DSH 请求：修改、删除及投影压缩丢失后恢复，无需重启引擎', async t => {
    const h = await harness(t);
    await h.send('开始');
    fs.writeFileSync(path.join(h.root, 'MEMORY.md'), '当前计划：赤松');
    await h.send('继续');
    assert.equal(contextEvents(h.agent).length, 2);
    assert.match(text(contextEvents(h.agent).at(-1).data), /当前计划：赤松/);
    fs.unlinkSync(path.join(h.root, 'MEMORY.md'));
    await h.send('再继续');
    assert.match(text(contextEvents(h.agent).at(-1).data), /## MEMORY.md\n\[文件不存在\]/);
    const seq = contextEvents(h.agent).at(-1).seq;
    h.agent.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: '压缩后的历史摘要' }], source: { kind: 'user' },
    }), { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] });
    await h.send('压缩后继续');
    assert.equal(contextEvents(h.agent).length, 4);
    assert.match(text(contextEvents(h.agent).at(-1).data), /## MEMORY.md\n\[文件不存在\]/);
    assert.equal(h.ctx.agents.list().length, 1);
});

test('真实 ACP 子进程挂载独立配置：本地合成路由收到系统规则和最新档案', { timeout: 25_000 }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lvtian-acp-context-'));
    const captureFile = path.join(root, 'captured.jsonl');
    const overlay = await prepareWorkspaceContextOverlay(root, root);
    fs.writeFileSync(path.join(root, 'MEMORY.md'), '子进程事实甲');
    const synthetic = path.join(root, 'synthetic.patch.yml');
    fs.writeFileSync(synthetic, yaml.stringify([
        { id: 'acp', config: { provider: 'lvtian-context-test', model: 'synthetic' } },
        { id: 'agent-default-model', config: { provider: 'lvtian-context-test', model: 'synthetic' } },
        { id: 'session-log-deepseek', disabled: true },
        { id: 'session-telemetry-otel', disabled: true },
        { insert: [{ id: 'local-context-capture', name: fileURLToPath(new URL('./fixtures/contextCapturePlugin.mjs', import.meta.url)), config: { captureFile } }] },
    ]));
    const require = createRequire(import.meta.url);
    const launcher = path.join(path.dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js');
    const env = {
        PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
        HOME: root, USERPROFILE: root, TEMP: root, TMP: root,
        DSH_HOME: path.join(root, '.dsh'), DSH_AGENTS_HOME: path.join(root, '.agents'),
    };
    const child = spawn(process.execPath, [launcher, '--profile', 'acp', '--patch', synthetic, '--patch', overlay], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.stdin.on('error', () => {});
    const exited = new Promise(resolve => child.once('exit', resolve));
    const app = acp.client({ name: 'lvtian-context-test' });
    const run = app.connectWith(acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)), async context => {
        await context.request('initialize', { protocolVersion: acp.PROTOCOL_VERSION, clientInfo: { name: 'context-test', version: '1' } });
        const created = await context.request('session/new', { cwd: root, mcpServers: {} });
        for (const prompt of ['第一问', '第二问', '第三问']) {
            if (prompt === '第三问') fs.writeFileSync(path.join(root, 'MEMORY.md'), '子进程事实乙');
            const result = await context.request('session/prompt', { sessionId: created.sessionId, prompt: [{ type: 'text', text: prompt }] });
            assert.equal(result.stopReason, 'end_turn');
        }
        child.kill();
    });
    t.after(async () => {
        child.kill();
        await exited;
        await run.catch(() => {});
        fs.rmSync(root, { recursive: true, force: true });
    });
    const timer = setTimeout(() => child.kill(), 20_000);
    try { await run; }
    catch (error) { throw new Error(`ACP 本地验证失败：${error.message}\n${stderr.slice(-2000)}`); }
    finally { clearTimeout(timer); }
    const requests = fs.readFileSync(captureFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(requests.length, 3);
    assert.ok(requests[0].some(message => message.role === 'system' && text(message).includes('写入记忆之前先读取原文件')));
    const snapshots = messages => messages.filter(message => message.source?.kind === 'runtime-context' && text(message).includes('# 当前工作区上下文'));
    assert.equal(snapshots(requests[0]).length, 1);
    assert.equal(snapshots(requests[1]).length, 1);
    assert.equal(snapshots(requests[2]).length, 2);
    assert.match(text(snapshots(requests[2]).at(-1)), /子进程事实乙/);
    const inputs = requests[2].filter(message => message.source?.kind === 'user').map(text);
    assert.deepEqual(inputs, ['第一问', '第二问', '第三问']);
});
