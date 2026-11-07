import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import yaml from 'yaml';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { apply as applyTitle } from '@deepseek-ai/dsh-session-title-first-prompt-llm';
import { prepareSessionTitleOverlay } from '../dist/sessionTitleConfig.js';

const require = createRequire(import.meta.url);
const launcher = path.join(path.dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib/bin.js');

async function setup(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lvtian-title-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const overlay = await prepareSessionTitleOverlay(root);
    return { root, overlay };
}

function dump(root, patches) {
    const result = spawnSync(process.execPath, [launcher, '--profile', 'acp', ...patches.flatMap(p => ['--patch', p]), '--dump-config'], {
        env: { ...process.env, DSH_HOME: path.join(root, '.dsh') }, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(result.status, 0, result.stderr);
    // 保留未执行的 !!js 表达式；本测试只断言静态标题和模型配置。
    return yaml.parse(result.stdout, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] });
}

function entries(tree) {
    return tree.flatMap(entry => [entry, ...(Array.isArray(entry.config) ? entries(entry.config) : [])]);
}

test('服务端启动将标题 overlay 作为最后的 ACP patch 挂载', async () => {
    const source = await fs.readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
    assert.match(source, /const titleOverlay = await prepareSessionTitleOverlay\(config\.dataDir\)/);
    assert.match(source, /additionalPatches: \[contextOverlay, \.\.\.\(taskOverlay \? \[taskOverlay\] : \[\]\), titleOverlay\]/);
});

test('真实 DSH 合成配置：显式启用上游标题、保留默认控制且不跟随主模型切换', async t => {
    const { root, overlay } = await setup(t);
    assert.equal(await prepareSessionTitleOverlay(root), overlay);
    assert.equal(entries(dump(root, [])).find(e => e.id === 'session-title-llm').disabled, true);
    for (const [provider, model] of [['deepseek-official', 'deepseek-flash'], ['openai-codex', 'gpt-6.1-sol']]) {
        const profile = path.join(root, 'chat.patch.yml');
        const original = yaml.stringify(['acp', 'agent-default-model'].map(id => ({ id, config: { provider, model } })));
        await fs.writeFile(profile, original);
        const tree = entries(dump(root, [profile, overlay]));
        const title = tree.find(e => e.id === 'session-title-llm');
        assert.equal(title.disabled, false);
        assert.equal(title.name, '@deepseek-ai/dsh-session-title-first-prompt-llm');
        assert.deepEqual(title.config, {
            targetWords: 5, targetCjkCharacters: 10, maxInputBytes: 65536,
            maxOutputTokens: 4096, timeoutMs: 60000, provider: 'deepseek-official', model: 'deepseek-flash',
        });
        assert.equal(tree.find(e => e.id === 'acp').config.provider, provider);
        assert.equal(tree.find(e => e.id === 'agent-default-model').config.model, model);
        assert.equal(await fs.readFile(profile, 'utf8'), original);
    }
    await fs.writeFile(overlay, 'tampered');
    await assert.rejects(prepareSessionTitleOverlay(root), /session_title_overlay_conflict/);
});

test('真实上游标题插件：长接力完整传入官方路由，超预算在调用前拒绝', async t => {
    const { root, overlay } = await setup(t);
    const config = entries(dump(root, [overlay])).find(e => e.id === 'session-title-llm').config;
    const ctx = new Context();
    t.after(() => ctx.fiber.dispose());
    await ctx.plugin(LlmRuntime);
    const requests = [];
    class LocalAdapter extends LlmAdapter {
        async resolveModel(provider, model) { return { provider, id: model, name: model }; }
        async *stream(options) {
            requests.push(options);
            yield { type: 'block-start', index: 0, blockType: 'text' };
            yield { type: 'text-delta', index: 0, text: '会话接力与标题' };
            yield { type: 'block-end', index: 0, block: { type: 'text', text: '会话接力与标题' } };
            yield { type: 'finish', reason: { kind: 'stop' } };
        }
    }
    ctx.llm.registerAdapter(['deepseek-official'], new LocalAdapter());
    let provider;
    applyTitle({ sessionTitle: { register(value) { provider = value; } }, llm: ctx.llm }, config);
    const events = [];
    const first = { seq: 1, text: '前序交流背景提要\n' + '已确认决定与未完成事项。'.repeat(900) + '\n当前请求：继续实现标题配置' };
    const request = {
        session: { id: 'title-test', append(type, data) { events.push({ type, data }); } },
        route: { provider: 'openai-codex', model: 'gpt-6.1-sol' },
        messages: [first], signal: new AbortController().signal,
    };
    assert.ok(Buffer.byteLength(JSON.stringify([first])) > 4096);
    assert.equal((await provider.generate(request)).title, '会话接力与标题');
    assert.equal(requests.length, 1);
    assert.ok(requests[0].messages[0].content[0].text.endsWith(JSON.stringify([first])));
    assert.deepEqual(events[0].data.route, { provider: 'deepseek-official', model: 'deepseek-flash' });
    await assert.rejects(provider.generate({ ...request, messages: [{ seq: 2, text: '中'.repeat(23_000) }] }), /exceeding maxInputBytes 65536/);
    assert.equal(requests.length, 1);
});
