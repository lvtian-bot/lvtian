import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { LvtianServer } from '../dist/server.js';
import { SessionManager } from '../dist/sessionManager.js';
import { MemoryManager } from '../dist/memoryManager.js';
import { AcpEngineManager } from '../dist/acpEngineManager.js';

const completeSummary = '### 一、第一段\n\n完整内容 **保留粗体**。\n\n---\n\n### 二、最后一段\n\n摘要末尾。';
const articleBody = '正文不在列表中。\n\n---\n\n正文第二段，原样保留。\n';
const markdown = (created, summary, body = articleBody, nl = '\n') => (
    `---\nnote_type: "文献笔记"\ncontent_type: "新闻报道"\ncreated: "${created}"\npublished: "2023-06-01"\nsource: "https://example.com/article?tracking=123#top"\n---\n\n# 总结提炼\n${summary ? summary + '\n' : ''}\n\n---\n\n${body}`.replaceAll('\n', nl)
);

async function fixture(t, companionHandler) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'lvtian-moments-'));
    const data = path.join(root, 'data');
    await mkdir(data);
    t.after(async () => { await rm(root, { force: true, recursive: true }); });
    const sm = new SessionManager(data);
    const mm = new MemoryManager(data);
    const engine = new AcpEngineManager(data, mm, sm, { connectEngine: async () => { throw new Error('Must not start main chat'); } });

    let companion;
    if (companionHandler) {
        companion = http.createServer(companionHandler);
        await new Promise(resolve => companion.listen(0, '127.0.0.1', resolve));
        t.after(async () => { await new Promise(resolve => companion.close(resolve)); });
    }
    const originalUrl = process.env.LVTIAN_WEB_CLIPPER_API_URL;
    const originalToken = process.env.LVTIAN_WEB_CLIPPER_API_TOKEN;
    delete process.env.LVTIAN_WEB_CLIPPER_API_URL;
    delete process.env.LVTIAN_WEB_CLIPPER_API_TOKEN;
    if (companion) {
        process.env.LVTIAN_WEB_CLIPPER_API_URL = `http://127.0.0.1:${companion.address().port}`;
        process.env.LVTIAN_WEB_CLIPPER_API_TOKEN = 'clipper-test-token';
    }
    let server;
    try {
        server = new LvtianServer({ port: 0, host: '127.0.0.1', token: 'green-test-token', workspace: root, dataDir: data, assistantName: 'Test' }, sm, mm, engine);
    } finally {
        if (originalUrl !== undefined) process.env.LVTIAN_WEB_CLIPPER_API_URL = originalUrl;
        else delete process.env.LVTIAN_WEB_CLIPPER_API_URL;
        if (originalToken !== undefined) process.env.LVTIAN_WEB_CLIPPER_API_TOKEN = originalToken;
        else delete process.env.LVTIAN_WEB_CLIPPER_API_TOKEN;
    }
    await server.start();
    t.after(async () => { await server.stop(); });
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    const request = (route = '', opts = {}) => fetch(origin + '/api/moments' + route, {
        ...opts, headers: { Authorization: 'Bearer green-test-token', 'Content-Type': 'application/json', ...opts.headers },
    });
    const create = async (id, contents) => {
        const file = path.join(root, 'moments', ...id.split('/'));
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, contents);
        return file;
    };
    return { root, request, create };
}

test('动态列表使用实际工作区和剪藏时间，保留完整摘要并分页读取历史', async t => {
    const { root, request, create } = await fixture(t);
    assert.equal((await request('', { headers: { Authorization: '' } })).status, 401);
    assert.deepEqual(await (await request()).json(), { items: [], nextCursor: null, canEditSummary: false });
    assert.equal((await request('?cursor=invalid')).status, 400);
    assert.equal((await request('/summary', { method: 'POST', body: '{}' })).status, 503);
    assert.equal((await request('/delete', { method: 'POST', body: '{}' })).status, 503);
    await create('2025/12/最早.md', markdown('2025-12-31T22:00:00', '早期摘要'));
    for (let day = 1; day <= 20; day++) {
        const captured = `2026-01-${String(day).padStart(2, '0')}T22:00:00`;
        await create(`2026/01/剪藏-${day}.md`, markdown(captured, day === 20 ? completeSummary : '', articleBody, '\r\n'));
    }
    await create('2026/01/其他.md', '## unrelated file');
    const privateFile = path.join(root, 'unrelated.md');
    await writeFile(privateFile, markdown('2026-01-31', '归档外的文档'));
    await symlink(privateFile, path.join(root, 'moments/2026/01/链接.md'));

    const first = await (await request()).json();
    assert.equal(first.items.length, 20);
    assert.equal(first.items[0].title, '剪藏-20');
    assert.equal(first.items[0].clippedAt, Date.parse('2026-01-20T22:00:00'));
    assert.equal(first.items[0].summary, completeSummary.replaceAll('\n', '\r\n'));
    assert.equal(first.items[1].summary, '');
    assert.equal(first.items[0].sourceUrl, 'https://example.com/article');
    assert.deepEqual(Object.keys(first.items[0]).sort(), ['clippedAt', 'id', 'revision', 'sourceUrl', 'summary', 'title']);
    assert.ok(!JSON.stringify(first).includes('正文不在列表中'));
    await create('2026/01/刚剪藏.md', markdown('2026-01-21T22:00:00', '新文章'));
    const next = await (await request('?cursor=' + first.nextCursor)).json();
    assert.deepEqual(next.items.map(item => item.title), ['最早']);
    assert.equal(next.nextCursor, null);
});

test('跨月剪藏按同一时间基准排序', async t => {
    const { request, create } = await fixture(t);
    await create('2025/12/跨年.md', markdown('2025-12-31T23:30:00-02:00', 'UTC 一月一日 01:30'));
    await create('2026/01/另一篇.md', markdown('2026-01-01T00:15:00Z', 'UTC 一月一日 00:15'));
    const page = await (await request()).json();
    assert.deepEqual(page.items.map(item => item.title), ['跨年', '另一篇']);
});

test('归档月份早于文件创建时间的剪藏仍可在分页中找到', async t => {
    const { request, create } = await fixture(t);
    for (let i = 0; i < 21; i++) {
        await create(`2025/11/${i}.md`, markdown('2025-11-28T09:00:00Z', '最近的归档目录'));
    }
    await create('2025/01/创建时间回退.md', markdown('invalid', '实际文件创建于归档月份之后'));
    const first = await (await request()).json();
    assert.equal(first.items[0].title, '创建时间回退');
    const next = await (await request('?cursor=' + first.nextCursor)).json();
    assert.equal(first.items.length, 20);
    assert.equal(next.items.length, 2);
    assert.equal(new Set([...first.items, ...next.items].map(item => item.id)).size, 22);
    assert.equal(next.nextCursor, null);
});

test('重写沿用摘要接口，更新卡片并保留工作区正文和时间', async t => {
    const id = '2026/11/同名-1.md';
    const captured = '2026-11-28T12:20:00+08:00';
    let file;
    const calls = [];
    const { request, create } = await fixture(t, async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        calls.push({ url: req.url, authorization: req.headers.authorization, body });
        await writeFile(file, markdown(captured, '替换后的完整摘要'));
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ status: 'upload_failed' }));
    });
    file = await create(id, markdown(captured, completeSummary));
    const page = await (await request()).json();
    assert.equal(page.canEditSummary, true);
    const [initial] = page.items;
    const update = (body) => request('/summary', { method: 'POST', body: JSON.stringify(body) });
    assert.equal((await update({ id, revision: initial.revision, action: 'delete' })).status, 400);
    assert.equal((await update({ id, revision: '0'.repeat(64), action: 'regenerate' })).status, 409);
    assert.equal(calls.length, 0);

    const body = { id, revision: initial.revision, action: 'regenerate' };
    const regenerated = await (await update(body)).json();
    assert.equal(regenerated.status, 'upload_failed');
    assert.equal(regenerated.item.summary, '替换后的完整摘要');
    assert.equal(regenerated.item.clippedAt, initial.clippedAt);
    assert.notEqual(regenerated.item.revision, initial.revision);
    assert.equal(await readFile(file, 'utf8'), markdown(captured, '替换后的完整摘要'));
    assert.deepEqual(calls, [{ url: '/api/moments/summary', authorization: 'Bearer clipper-test-token', body }]);
});

test('整篇删除通过配对接口提交准确归档和版本，远端失败时保留本地删除结果', async t => {
    const captured = '2026-11-28T12:20:00+08:00';
    const id = '2026/11/剪藏.md';
    let file;
    const calls = [];
    let outcome;
    const { request, create } = await fixture(t, async (req, res) => {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        calls.push({ url: req.url, authorization: req.headers.authorization, body });
        if (!outcome) {
            res.writeHead(404).end();
            return;
        }
        await unlink(file);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ status: outcome }));
    });
    file = await create(id, markdown(captured, completeSummary));
    const other = await create('2026/10/剪藏.md', markdown('2026-10-28', '其他月份同名'));
    const [item] = (await (await request()).json()).items;
    const remove = (body, headers) => request('/delete', { method: 'POST', body: JSON.stringify(body), headers });
    const body = { id, revision: item.revision };
    assert.equal((await remove(body, { Authorization: '' })).status, 401);
    assert.equal((await remove({ ...body, id: '../unrelated.md' })).status, 400);
    assert.equal((await remove({ ...body, revision: '0'.repeat(64) })).status, 409);
    assert.equal(calls.length, 0);
    assert.equal((await remove(body)).status, 502);
    assert.equal(await readFile(file, 'utf8'), markdown(captured, completeSummary));

    for (const status of ['deleted', 'delete_failed']) {
        outcome = status;
        assert.deepEqual(await (await remove(body)).json(), { status });
        await assert.rejects(readFile(file), { code: 'ENOENT' });
        const remaining = await (await request()).json();
        assert.deepEqual(remaining.items.map(item => item.id), ['2026/10/剪藏.md']);
        if (status === 'deleted') await create(id, markdown(captured, completeSummary));
    }
    assert.deepEqual(calls, Array.from({ length: 3 }, () => ({
        url: '/api/moments/delete', authorization: 'Bearer clipper-test-token', body,
    })));
    assert.equal(await readFile(other, 'utf8'), markdown('2026-10-28', '其他月份同名'));
});
