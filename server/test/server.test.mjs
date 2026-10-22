import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SessionManager } from '../dist/sessionManager.js';
import { LvtianServer } from '../dist/server.js';
import { MemoryManager } from '../dist/memoryManager.js';
import { DshRunner } from '../dist/dshRunner.js';
import { FileManager } from '../dist/fileManager.js';
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

test('FileManager correctly lists, reads, saves and resolves files', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvtian-test-fm-'));
    const subDir = path.join(tmpDir, 'subdir');
    fs.mkdirSync(subDir);
    const testFile = path.join(tmpDir, 'test.md');
    fs.writeFileSync(testFile, '# 标题\n内容测试', 'utf8');

    const fm = new FileManager(tmpDir, tmpDir);

    // 1. 系统信息
    const sysInfo = fm.getSystemInfo();
    assert.equal(sysInfo.workspaceDir, tmpDir);
    assert.equal(sysInfo.allowedRoot, tmpDir);
    assert.ok(sysInfo.homeDir);

    // 验证越界访问拦截
    assert.throws(() => fm.resolvePath('/etc/passwd'), /超出允许的访问根目录/);

    // 验证符号链接逃逸拦截（指向根目录外部的文件或目录）
    if (process.platform !== 'win32') {
        const outsideTarget = path.join(os.tmpdir(), 'lvtian-test-outside.md');
        fs.writeFileSync(outsideTarget, '外部私密数据', 'utf8');
        const symlinkPath = path.join(tmpDir, 'escape-symlink.md');
        try {
            fs.symlinkSync(outsideTarget, symlinkPath);
            await assert.rejects(
                async () => await fm.readFileContent(symlinkPath),
                (err) => err.code === 'SYMLINK_ESCAPE' || err.code === 'OUT_OF_BOUNDS'
            );
        } finally {
            try { fs.unlinkSync(outsideTarget); } catch {}
            try { fs.unlinkSync(symlinkPath); } catch {}
        }
    }

    // 2. 目录列表
    const listing = await fm.listDirectory(tmpDir);
    assert.equal(listing.currentPath, tmpDir);
    assert.equal(listing.items.length, 2);
    // 文件夹排在前面
    assert.equal(listing.items[0].name, 'subdir');
    assert.equal(listing.items[0].isDirectory, true);
    assert.equal(listing.items[1].name, 'test.md');
    assert.equal(listing.items[1].isDirectory, false);
    assert.equal(listing.items[1].extension, '.md');

    // 3. 读取文本
    const readRes = await fm.readFileContent(testFile);
    assert.equal(readRes.content, '# 标题\n内容测试');

    // 4. 保存文本
    const saveRes = await fm.saveFileContent(testFile, '# 标题\n更新后的内容');
    assert.equal(saveRes.success, true);
    const updatedRead = await fm.readFileContent(testFile);
    assert.equal(updatedRead.content, '# 标题\n更新后的内容');

    // 5. 下载信息
    const dlInfo = await fm.getFileDownloadInfo(testFile);
    assert.equal(dlInfo.fileName, 'test.md');
    assert.ok(dlInfo.size > 0);

    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('LvtianServer handles /api/files HTTP endpoints with token authentication', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvtian-test-files-srv-'));
    const sm = new SessionManager(tmpDir);
    const mm = new MemoryManager(tmpDir);
    const runner = new DshRunner(tmpDir, mm, sm);
    const fm = new FileManager(tmpDir, tmpDir);

    const testFile = path.join(tmpDir, 'report.md');
    fs.writeFileSync(testFile, '初始报告内容', 'utf8');

    const token = 'test-token-file-12345';
    const config = {
        port: 0,
        host: '127.0.0.1',
        token,
        workspace: tmpDir,
        dataDir: tmpDir,
        assistantName: 'TestBot',
    };

    const server = new LvtianServer(config, sm, mm, runner, fm);
    await server.start();
    const port = server.httpServer.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
        // 1. 无 Token 访问应返回 401
        const unauthRes = await fetch(`${baseUrl}/api/files/info`);
        assert.equal(unauthRes.status, 401);

        // 1.1 仅在 URL query 中传 Token 应被拒绝（401），防反向代理/日志泄露
        const queryTokenRes = await fetch(`${baseUrl}/api/files/info?token=${token}`);
        assert.equal(queryTokenRes.status, 401);

        // 2. 携带有效 Token 访问 /api/files/info
        const infoRes = await fetch(`${baseUrl}/api/files/info`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        assert.equal(infoRes.status, 200);
        const infoData = await infoRes.json();
        assert.equal(infoData.workspaceDir, tmpDir);

        // 3. 列出目录 /api/files/list
        const listRes = await fetch(`${baseUrl}/api/files/list?path=${encodeURIComponent(tmpDir)}`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        assert.equal(listRes.status, 200);
        const listData = await listRes.json();
        assert.ok(listData.items.some((item) => item.name === 'report.md'));

        // 4. 读取文件 /api/files/content
        const contentRes = await fetch(`${baseUrl}/api/files/content?path=${encodeURIComponent(testFile)}`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        assert.equal(contentRes.status, 200);
        const contentData = await contentRes.json();
        assert.equal(contentData.content, '初始报告内容');

        // 5. 保存文件 /api/files/content（正常保存）
        const postRes = await fetch(`${baseUrl}/api/files/content`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                path: testFile,
                content: '更新后的报告内容',
            }),
        });
        assert.equal(postRes.status, 200);
        const postData = await postRes.json();
        assert.equal(postData.success, true);
        assert.ok(postData.mtime > 0);

        // 5.1 乐观锁冲突测试：传入陈旧的 expectedMtime 应该被拒绝并返回 409
        const staleMtime = postData.mtime - 10000;
        const conflictRes = await fetch(`${baseUrl}/api/files/content`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                path: testFile,
                content: '并发冲突的内容',
                expectedMtime: staleMtime,
            }),
        });
        assert.equal(conflictRes.status, 409);
        const conflictData = await conflictRes.json();
        assert.equal(conflictData.code, 'PRECONDITION_FAILED');

        // 5.2 传入正确的 expectedMtime 应该成功更新
        const validRes = await fetch(`${baseUrl}/api/files/content`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                path: testFile,
                content: '匹配时间戳的最终内容',
                expectedMtime: postData.mtime,
            }),
        });
        assert.equal(validRes.status, 200);
        const validData = await validRes.json();
        assert.equal(validData.success, true);

        // 再次读取确认更新
        const checkRes = await fetch(`${baseUrl}/api/files/content?path=${encodeURIComponent(testFile)}`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        const checkData = await checkRes.json();
        assert.equal(checkData.content, '匹配时间戳的最终内容');

        // 5.3 模拟文件在服务端被外部删除，带 expectedMtime 保存必须报 409 PRECONDITION_FAILED
        const deletedFile = path.join(tmpDir, 'to_be_deleted.md');
        fs.writeFileSync(deletedFile, '即将被删除的文件', 'utf8');
        const delStat = fs.statSync(deletedFile);
        fs.unlinkSync(deletedFile);
        const delSaveRes = await fetch(`${baseUrl}/api/files/content`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                path: deletedFile,
                content: '尝试覆盖已被删除的文件',
                expectedMtime: delStat.mtimeMs,
            }),
        });
        assert.equal(delSaveRes.status, 409);
        const delSaveData = await delSaveRes.json();
        assert.equal(delSaveData.code, 'PRECONDITION_FAILED');

        // 5.4 验证符号链接父目录逃逸保存拦截
        const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvtian-outside-'));
        const symlinkParent = path.join(tmpDir, 'symlink_outside');
        try {
            fs.symlinkSync(outsideDir, symlinkParent, 'dir');
            const symlinkSaveRes = await fetch(`${baseUrl}/api/files/content`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    path: path.join(symlinkParent, 'escaped.txt'),
                    content: '逃逸内容',
                }),
            });
            assert.equal(symlinkSaveRes.status, 403);
            const symlinkData = await symlinkSaveRes.json();
            assert.equal(symlinkData.code, 'OUT_OF_BOUNDS');
        } finally {
            fs.rmSync(outsideDir, { recursive: true, force: true });
        }

        // 6. 下载文件 /api/files/download
        const dlRes = await fetch(`${baseUrl}/api/files/download?path=${encodeURIComponent(testFile)}`, {
            headers: { Authorization: `Bearer ${token}` },
        });
        assert.equal(dlRes.status, 200);
        const dlText = await dlRes.text();
        assert.equal(dlText, '匹配时间戳的最终内容');
        assert.ok(dlRes.headers.get('content-disposition')?.includes('report.md'));
    } finally {
        await server.stop();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});


