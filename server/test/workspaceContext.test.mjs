import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import yaml from 'yaml';
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt, { renderPrompt, renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt';
import { buildWorkspaceContext } from '../dist/workspaceContext.js';
import { apply } from '../dist/workspaceContextPlugin.js';
import { prepareWorkspaceContextOverlay } from '../dist/workspaceContextConfig.js';

function workspace(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lvtian-context-'));
    fs.mkdirSync(path.join(root, 'memory'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return root;
}

test('核心档案与今日昨日自动加载；旧日记和 AGENTS 不重复加载', t => {
    const root = workspace(t);
    for (const [name, value] of Object.entries({ 'SOUL.md': '语气甲', 'USER.md': '偏好乙', 'MEMORY.md': '事实丙', 'AGENTS.md': '原生独立指令' })) fs.writeFileSync(path.join(root, name), value);
    for (const date of ['2026-11-06', '2026-11-05', '2026-11-04']) fs.writeFileSync(path.join(root, 'memory', `${date}.md`), `每日${date}`);
    const snapshot = buildWorkspaceContext(root, { now: new Date(2026, 10, 6) });
    for (const value of ['语气甲', '偏好乙', '事实丙', '每日2026-11-06', '每日2026-11-05']) assert.ok(snapshot.includes(value));
    assert.ok(!snapshot.includes('每日2026-11-04'));
    assert.ok(!snapshot.includes('原生独立指令'));
    assert.match(snapshot, /## IDENTITY.md\n\[文件不存在\]/);
});

test('每次装配读取最新文件，删除和清空提供明确失效状态', t => {
    const root = workspace(t);
    const file = path.join(root, 'MEMORY.md');
    fs.writeFileSync(file, '旧事实');
    assert.match(buildWorkspaceContext(root), /旧事实/);
    fs.writeFileSync(file, '新事实');
    assert.match(buildWorkspaceContext(root), /新事实/);
    fs.writeFileSync(file, '');
    assert.match(buildWorkspaceContext(root), /## MEMORY.md\n\[文件为空\]/);
    fs.unlinkSync(file);
    assert.match(buildWorkspaceContext(root), /## MEMORY.md\n\[文件不存在\]/);
});

test('预算包含截断标记和框架，保留首尾，不破坏 Unicode，磁盘原文不变', t => {
    const root = workspace(t);
    const content = '首部' + '🌿'.repeat(25_000) + '尾部';
    for (const name of ['SOUL.md', 'USER.md', 'MEMORY.md']) fs.writeFileSync(path.join(root, name), content);
    const snapshot = buildWorkspaceContext(root);
    assert.ok(snapshot.length <= 60_000);
    const user = snapshot.split('## USER.md\n')[1].split('\n## ')[0].trimEnd();
    assert.ok(user.length <= 4_000);
    assert.ok(user.startsWith('首部'));
    assert.ok(user.endsWith('尾部'));
    assert.ok(snapshot.includes('内容已截断'));
    assert.equal(snapshot.isWellFormed(), true);
    assert.equal(fs.readFileSync(path.join(root, 'USER.md'), 'utf8'), content);
    const small = buildWorkspaceContext(root, { maxChars: 128, totalMaxChars: 1024 });
    assert.ok(small.length <= 1024);
    assert.throws(() => buildWorkspaceContext(root, { totalMaxChars: 0 }), /invalid_budget/);
});

test('跨月按本地日历找昨日；非法 UTF-8 和过大源文件显式标明未加载', t => {
    const root = workspace(t);
    fs.writeFileSync(path.join(root, 'memory', '2026-10-31.md'), '跨月记录');
    fs.writeFileSync(path.join(root, 'USER.md'), Buffer.from([0xff, 0xfe]));
    fs.writeFileSync(path.join(root, 'MEMORY.md'), 'a'.repeat(1_048_577));
    const snapshot = buildWorkspaceContext(root, { now: new Date(2026, 10, 1) });
    assert.match(snapshot, /跨月记录/);
    assert.match(snapshot, /文件读取失败/);
    assert.match(snapshot, /文件超过读取上限/);
});

test('Linux 无写入者的命名管道不会阻塞上下文加载', { skip: process.platform !== 'linux' }, t => {
    const root = workspace(t);
    const fifo = path.join(root, 'IDENTITY.md');
    const created = spawnSync('mkfifo', [fifo], { timeout: 5_000, encoding: 'utf8' });
    assert.equal(created.status, 0, created.stderr);
    // 在子进程验证，避免实现退化后阻塞整个测试进程。
    const moduleUrl = new URL('../dist/workspaceContext.js', import.meta.url).href;
    const script = `import { buildWorkspaceContext } from ${JSON.stringify(moduleUrl)}; process.stdout.write(buildWorkspaceContext(process.argv[1]));`;
    const loaded = spawnSync(process.execPath, ['--input-type=module', '-e', script, root], { timeout: 5_000, encoding: 'utf8' });
    assert.equal(loaded.error, undefined);
    assert.equal(loaded.status, 0, loaded.stderr);
    assert.match(loaded.stdout, /## IDENTITY.md\n\[不是普通文件；未自动加载\]/);
});

test('DSH 正式组装接口分别承载固定系统规则和可编辑快照，子代理不自动注入', async t => {
    const root = workspace(t);
    fs.writeFileSync(path.join(root, 'MEMORY.md'), '个人事实甲 {{literal}}');
    const ctx = new Context();
    t.after(() => ctx.fiber.dispose());
    await ctx.plugin(SystemPrompt, {});
    apply(ctx, { workspace: root });
    const agent = { session: { header: {} } };
    const first = await ctx.systemPrompt.assemble({ scope: agent, agent });
    const system = renderPrompt(first);
    assert.match(system, /写入记忆之前先读取原文件/);
    assert.ok(!system.includes('个人事实甲'));
    assert.match(renderContextSnapshot(first), /个人事实甲 \{\{literal\}\}/);
    fs.writeFileSync(path.join(root, 'MEMORY.md'), '个人事实乙');
    const refreshed = ctx.systemPrompt.refreshContext(first, { scope: agent, agent });
    assert.match(renderContextSnapshot(refreshed), /个人事实乙/);
    for (const header of [{ parentSession: 'parent' }, { origin: 'subagent' }, { delegationDepth: 1 }]) {
        const child = { session: { header } };
        const assembly = await ctx.systemPrompt.assemble({ scope: child, agent: child });
        assert.equal(renderContextSnapshot(assembly), '');
    }
    assert.equal(renderContextSnapshot(await ctx.systemPrompt.assemble()), '');
});

test('配置挂载项目插件且保留原配置，重复启动幂等，冲突不静默覆盖', async t => {
    const root = workspace(t);
    const target = await prepareWorkspaceContextOverlay(root, root);
    const config = yaml.parse(fs.readFileSync(target, 'utf8'));
    const plugin = config[0].insert[0];
    assert.equal(plugin.id, 'lvtian-workspace-context');
    assert.equal(plugin.config.workspace, root);
    assert.ok(plugin.name.endsWith('workspaceContextPlugin.js'));
    assert.equal(await prepareWorkspaceContextOverlay(root, root), target);
    const anotherWorkspace = path.join(root, 'another');
    const changed = await prepareWorkspaceContextOverlay(root, anotherWorkspace);
    assert.notEqual(changed, target);
    assert.equal(yaml.parse(fs.readFileSync(changed, 'utf8'))[0].insert[0].config.workspace, anotherWorkspace);
    assert.equal(yaml.parse(fs.readFileSync(target, 'utf8'))[0].insert[0].config.workspace, root);
    fs.writeFileSync(target, '# 已有自定义内容');
    await assert.rejects(prepareWorkspaceContextOverlay(root, root), /overlay_conflict/);
    assert.equal(fs.readFileSync(target, 'utf8'), '# 已有自定义内容');
});
