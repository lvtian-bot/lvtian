import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as acp from '@agentclientprotocol/sdk';
import { SessionManager } from '../dist/sessionManager.js';
import { LvtianServer } from '../dist/server.js';
import { MemoryManager } from '../dist/memoryManager.js';
import { AcpEngineManager } from '../dist/acpEngineManager.js';
import { FileManager } from '../dist/fileManager.js';
import WebSocket from 'ws';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    const engine = new AcpEngineManager(tmpDir, mm, sm, {
        connectEngine: async () => {
            throw new Error('该测试不触发聊天，不应启动引擎');
        },
    });

    const config = {
        port: 0, // 动态随机端口
        host: '127.0.0.1',
        token: 'test-token-12345678901234567890',
        workspace: tmpDir,
        dataDir: tmpDir,
        assistantName: 'TestBot',
    };

    const server = new LvtianServer(config, sm, mm, engine);
    await server.start();

    const assignedPort = server.httpServer.address().port;

    // 客户端发送超过 maxPayload (5MB) 的超大报文，切实触发服务端 accepted socket 的 RangeError
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error('超大报文未在预期时间内触发连接关闭'));
        }, 5000);
        const ws = new WebSocket(`ws://127.0.0.1:${assignedPort}`);
        ws.on('open', () => {
            const oversized = Buffer.alloc(5 * 1024 * 1024 + 1024);
            ws.send(oversized);
        });
        ws.on('error', () => {
            // 客户端侧网络重置
        });
        ws.on('close', () => {
            clearTimeout(timer);
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

test('MemoryManager loads context from workspace directory and preserves existing content', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvtian-test-mm-'));
    // 写入预置工作区文件
    fs.writeFileSync(path.join(tmpDir, 'SOUL.md'), '# 自定义灵魂准则\n忠诚敏锐');
    fs.writeFileSync(path.join(tmpDir, 'MEMORY.md'), '# 自定义长期记忆\n偏好中文交流');
    fs.writeFileSync(path.join(tmpDir, 'USER.md'), '# 主人档案\n称呼：先生');

    const mm = new MemoryManager(tmpDir);
    assert.equal(mm.getBaseDir(), tmpDir);

    const ctx = mm.loadContext();
    assert.equal(ctx.soul, '# 自定义灵魂准则\n忠诚敏锐');
    assert.equal(ctx.memory, '# 自定义长期记忆\n偏好中文交流');
    assert.equal(ctx.user, '# 主人档案\n称呼：先生');

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

test('MemoryManager preserves existing Git-cloned workspace files and normalizes permissions', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvtian-test-git-workspace-'));
    // 模拟用户通过 Git 将已有仓库克隆到工作区，生成普通 0644 权限文件
    const soulPath = path.join(tmpDir, 'SOUL.md');
    const memoryPath = path.join(tmpDir, 'MEMORY.md');
    const userPath = path.join(tmpDir, 'USER.md');

    fs.writeFileSync(soulPath, '# 历史积累灵魂\n忠诚果断', { mode: 0o644 });
    fs.writeFileSync(memoryPath, '# 历史沉淀长期记忆\n偏好自然语言', { mode: 0o644 });
    fs.writeFileSync(userPath, '# 历史主人档案\n称呼：先生', { mode: 0o644 });

    const mm = new MemoryManager(tmpDir);
    const ctx = mm.loadContext();

    // 验证完全直接使用 Git 检出的老机器人记忆，未被默认模板覆盖
    assert.equal(ctx.soul, '# 历史积累灵魂\n忠诚果断');
    assert.equal(ctx.memory, '# 历史沉淀长期记忆\n偏好自然语言');
    assert.equal(ctx.user, '# 历史主人档案\n称呼：先生');

    // 验证权限已安全收紧为 0600（Windows 不支持 POSIX 三段权限位，做跨平台兼容判断）
    if (process.platform !== 'win32') {
        const stat = fs.statSync(soulPath);
        assert.equal((stat.mode & 0o777), 0o600);
    }

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

    // 验证保存路径中的符号链接祖先在创建任何目录前即被拦截（不得在外部目录创建新子目录）
    if (process.platform !== 'win32') {
        const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvtian-test-outside-dir-'));
        const linkDir = path.join(tmpDir, 'escape-link-dir');
        try {
            fs.symlinkSync(outsideDir, linkDir, 'dir');
            const targetPath = path.join(linkDir, 'new-subdir', 'file.md');
            await assert.rejects(
                async () => await fm.saveFileContent(targetPath, '不应写入的越界内容'),
                (err) => err.code === 'OUT_OF_BOUNDS' || err.code === 'SYMLINK_ESCAPE'
            );
            assert.equal(fs.existsSync(path.join(outsideDir, 'new-subdir')), false);
        } finally {
            fs.rmSync(outsideDir, { recursive: true, force: true });
            try { fs.unlinkSync(linkDir); } catch {}
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
    const engine = new AcpEngineManager(tmpDir, mm, sm, {
        connectEngine: async () => {
            throw new Error('该测试不触发聊天，不应启动引擎');
        },
    });
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

    const server = new LvtianServer(config, sm, mm, engine, fm);
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

test('SessionManager event log persists and replays session state across restart', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvtian-test-elog-'));
    const sm = new SessionManager(tmpDir);

    sm.addMessage('main', { id: 'u1', role: 'user', content: '帮我查日程', timestamp: Date.now(), status: 'sent' });
    sm.addMessage('main', { id: 'a1', role: 'assistant', content: '', timestamp: Date.now(), status: 'processing' });
    sm.appendDelta('main', 'a1', '第一段');
    sm.appendDelta('main', 'a1', '第二段');
    sm.setToolCall('main', 'a1', { id: 't1', name: 'read_file', status: 'done', summary: '读取日程文件' });
    // 工具调用后继续流式输出，验证事件顺序（msg 全量事件与 delta 增量事件交错）
    sm.appendDelta('main', 'a1', '第三段');
    sm.setTaskState('main', 'completed');
    sm.setDshSessionId('main', 'dsh-abc-123');
    // 正常收尾消息状态，避免重启修复流程按设计将其标错
    sm.updateMessage('main', 'a1', (m) => {
        m.status = 'done';
    }, false);

    const before = sm.getReconcileData('main', 0);
    // 冲刷防抖窗口内的流式增量，模拟优雅停机
    sm.persistSession(sm.getOrCreateSession('main'));

    // 重启：新实例从事件日志重放
    const sm2 = new SessionManager(tmpDir);
    const after = sm2.getReconcileData('main', 0);
    assert.equal(after.currentSeq, before.currentSeq);
    assert.equal(after.taskState, 'completed');
    const a1 = after.messages.find((m) => m.id === 'a1');
    assert.ok(a1);
    assert.equal(a1.content, '第一段第二段第三段');
    assert.equal(a1.toolCalls?.[0]?.name, 'read_file');
    assert.equal(sm2.getDshSessionId('main'), 'dsh-abc-123');

    // 增量对账：按重启前的旧 seq 过滤能取回最新内容
    const inc = sm2.getReconcileData('main', 1);
    assert.ok(inc.messages.some((m) => m.id === 'a1'));

    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('SessionManager repairs interrupted streaming message on restart', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvtian-test-repair-'));
    const sm = new SessionManager(tmpDir);
    sm.addMessage('main', { id: 'a1', role: 'assistant', content: '流式中途', timestamp: Date.now(), status: 'processing' });
    sm.appendDelta('main', 'a1', '的部分输出');
    sm.setTaskState('main', 'processing');
    const seqBefore = sm.getReconcileData('main', 0).currentSeq;
    sm.persistSession(sm.getOrCreateSession('main'));

    // 模拟崩溃后重启
    const sm2 = new SessionManager(tmpDir);
    const r = sm2.getReconcileData('main', 0);
    assert.equal(r.taskState, 'stopped');
    assert.ok(r.currentSeq > seqBefore);
    const a1 = r.messages.find((m) => m.id === 'a1');
    assert.equal(a1.status, 'error');
    assert.ok(a1.content.includes('任务中断'));

    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('SessionManager rotates oversized log into immutable segments and tolerates torn tail', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvtian-test-rotate-'));
    process.env.LVTIAN_SESSION_ROTATE_BYTES = '65536';
    const sm = new SessionManager(tmpDir);
    delete process.env.LVTIAN_SESSION_ROTATE_BYTES;

    for (let i = 0; i < 6; i++) {
        sm.addMessage('main', {
            id: `m${i}`,
            role: 'assistant',
            content: `msg-${i}-` + 'x'.repeat(16 * 1024),
            timestamp: Date.now(),
            status: 'sent',
        });
    }

    const sessionDir = path.join(tmpDir, 'sessions', 'main');
    const files = fs.readdirSync(sessionDir);
    assert.ok(files.some((f) => f.startsWith('seg.') && f.endsWith('.jsonl')), '应产生轮换分段');

    const activeRaw = fs.readFileSync(path.join(sessionDir, 'events.jsonl'), 'utf8');
    const firstLine = activeRaw.slice(0, activeRaw.indexOf('\n'));
    assert.equal(JSON.parse(firstLine).t, 'snapshot');

    const sm2 = new SessionManager(tmpDir);
    const r = sm2.getReconcileData('main', 0);
    assert.equal(r.messages.length, 6);
    assert.ok(r.messages[5].content.startsWith('msg-5-'));

    // 模拟末行撕裂：截断清理并正常衔接新事件
    fs.appendFileSync(path.join(sessionDir, 'events.jsonl'), '{"t":"msg","at":1,"seq":99,"m":{"id":"torn"');
    const sm3 = new SessionManager(tmpDir);
    const r3 = sm3.getReconcileData('main', 0);
    assert.equal(r3.messages.length, 6);

    sm3.addMessage('main', {
        id: 'after-torn',
        role: 'user',
        content: '撕裂恢复后新消息',
        timestamp: Date.now(),
        status: 'sent',
    });
    const sm4 = new SessionManager(tmpDir);
    const r4 = sm4.getReconcileData('main', 0);
    assert.equal(r4.messages.length, 7);
    assert.equal(r4.messages[6].id, 'after-torn');

    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('SessionManager handles interrupted rotation and invalid session ID cleanly', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvtian-test-edge-'));
    const sm = new SessionManager(tmpDir);

    // 1. 测试非法 session ID 严格拦截报错（杜绝非预期路径穿越或静默别名错乱）
    assert.throws(
        () => sm.addMessage('bad/../id', {
            id: 'u-safe',
            role: 'user',
            content: '非法路径字符输入测试',
            timestamp: Date.now(),
            status: 'sent',
        }),
        /非法会话 ID/
    );

    // 2. 模拟轮换中途崩溃（events.jsonl 已移走为分段，仅留下 events.jsonl.tmp）
    sm.getOrCreateSession('main');
    const sessionDir = path.join(tmpDir, 'sessions', 'main');
    const activePath = path.join(sessionDir, 'events.jsonl');
    const tmpPath = path.join(sessionDir, 'events.jsonl.tmp');
    const segPath = path.join(sessionDir, 'seg.000000.jsonl');

    fs.renameSync(activePath, segPath);
    // 写入一个合法的 tmp 快照文件
    const tmpSnapshot = JSON.stringify({
        t: 'snapshot',
        at: Date.now(),
        seq: 10,
        taskState: 'idle',
        msgs: [{ id: 'u-tmp', seq: 10, role: 'user', content: '临时快照内容', timestamp: Date.now(), status: 'sent' }],
    }) + '\n';
    fs.writeFileSync(tmpPath, tmpSnapshot, { encoding: 'utf8' });

    // 重启：应该转正 tmp 文件，而不是误删导致历史丢失
    const sm2 = new SessionManager(tmpDir);
    const r2 = sm2.getReconcileData('main', 0);
    assert.ok(r2.messages.some((m) => m.id === 'u-tmp'));
    assert.ok(fs.existsSync(activePath), 'events.jsonl 应已由 tmp 转正');

    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('SessionManager does not duplicate buffered deltas when rotation lands mid-flush', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvtian-test-dup-'));
    // 阈值取“大增量落盘触发轮换、其后的小增量与 seq 事件不再触发”的区间
    process.env.LVTIAN_SESSION_ROTATE_BYTES = '300';
    const sm = new SessionManager(tmpDir);
    delete process.env.LVTIAN_SESSION_ROTATE_BYTES;

    sm.addMessage('main', { id: 'm1', role: 'assistant', content: 'x'.repeat(10), timestamp: Date.now(), status: 'sent' });
    sm.addMessage('main', { id: 'm2', role: 'assistant', content: 'y'.repeat(10), timestamp: Date.now(), status: 'sent' });
    sm.appendDelta('main', 'm1', 'A'.repeat(400));
    sm.appendDelta('main', 'm2', 'B');
    // nextSeq 冲刷两条待落盘增量：m1 的落盘应触发轮换，m2 的增量必须在轮换快照之后仍不重复
    sm.nextSeq('main');

    const sm2 = new SessionManager(tmpDir);
    const m2 = sm2.getReconcileData('main', 0).messages.find((m) => m.id === 'm2');
    assert.ok(m2);
    // m2 处于流式状态，重启修复会按设计追加中断标记，故只校验增量不重复
    assert.ok(m2.content.startsWith('y'.repeat(10) + 'B'), `增量丢失: ${m2.content}`);
    assert.ok(!m2.content.includes('BB'), `重放后增量被重复计入: ${m2.content}`);

    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('SessionManager truncates corrupted middle record so later appends survive restart', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvtian-test-midbad-'));
    const sm = new SessionManager(tmpDir);
    sm.addMessage('main', { id: 'u1', role: 'user', content: '坏记录之前的消息', timestamp: Date.now(), status: 'sent' });
    sm.persistSession(sm.getOrCreateSession('main'));

    // 在日志中段插入一行坏记录（模拟局部磁盘损坏），其后补一行合法事件
    const sessionDir = path.join(tmpDir, 'sessions', 'main');
    const activePath = path.join(sessionDir, 'events.jsonl');
    const original = fs.readFileSync(activePath, 'utf8');
    const firstLineEnd = original.indexOf('\n') + 1;
    const badLine = '{"t":"msg","at":1,"seq":2,"m":{"id":"corrupt"' + '\u0000'.repeat(8);
    fs.writeFileSync(activePath, original.slice(0, firstLineEnd) + badLine + '\n' + original.slice(firstLineEnd));

    // 重启：坏记录被截断，其后新追加的消息在再次重启后仍能找回
    const sm2 = new SessionManager(tmpDir);
    const r2 = sm2.getReconcileData('main', 0);
    assert.ok(!r2.messages.some((m) => m.id === 'corrupt'));

    sm2.addMessage('main', { id: 'after-bad', role: 'user', content: '坏记录之后的新消息', timestamp: Date.now(), status: 'sent' });
    const sm3 = new SessionManager(tmpDir);
    const r3 = sm3.getReconcileData('main', 0);
    assert.ok(
        r3.messages.some((m) => m.id === 'after-bad'),
        '坏记录截断后追加的新消息不应在重启后丢失'
    );

    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('SessionManager appends newline after last valid record missing its terminator', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvtian-test-nl-'));
    const sm = new SessionManager(tmpDir);
    sm.addMessage('main', { id: 'u1', role: 'user', content: '第一条', timestamp: Date.now(), status: 'sent' });
    sm.persistSession(sm.getOrCreateSession('main'));

    // 模拟崩溃：末条事件 JSON 完整但换行符未写入
    const activePath = path.join(tmpDir, 'sessions', 'main', 'events.jsonl');
    const raw = fs.readFileSync(activePath, 'utf8');
    fs.writeFileSync(activePath, raw.slice(0, -1));

    // 第一次重启：恢复正常，且应补齐末行换行符
    const sm2 = new SessionManager(tmpDir);
    assert.equal(sm2.getReconcileData('main', 0).messages.length, 1);
    assert.ok(fs.readFileSync(activePath, 'utf8').endsWith('\n'), '重启后应补齐末行换行符');

    // 新事件追加后再次重启：两条消息都必须还在
    sm2.addMessage('main', { id: 'u2', role: 'user', content: '第二条', timestamp: Date.now(), status: 'sent' });
    const r3 = new SessionManager(tmpDir).getReconcileData('main', 0);
    assert.equal(r3.messages.length, 2, '缺换行符场景下新旧消息都不应丢失');

    fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 接线层集成测试：LvtianServer + WebSocket + 进程内模拟 ACP 引擎，
// 覆盖聊天事件广播、审批卡下发与应答、停止与审批超时终态的广播链路
// ---------------------------------------------------------------------------

/**
 * 进程内模拟 ACP 引擎（仅覆盖接线测试所需路径）：
 * prompt → chunkCount 个文本增量 →（可选）一次审批请求 → 终态 end_turn
 */
function createMockEngine(options = {}) {
    return acp.agent({ name: 'mock-engine' })
        .onRequest(acp.methods.agent.initialize, () => ({
            protocolVersion: acp.PROTOCOL_VERSION,
            agentCapabilities: {},
        }))
        .onRequest(acp.methods.agent.session.new, () => ({ sessionId: globalThis.crypto.randomUUID() }))
        .onRequest(acp.methods.agent.session.prompt, async (c) => {
            const sessionId = c.params.sessionId;
            const notify = (update) =>
                c.client.notify(acp.methods.client.session.update, { sessionId, update });
            for (let i = 0; i < (options.chunkCount ?? 1); i++) {
                if (options.chunkDelayMs) await delay(options.chunkDelayMs);
                await notify({
                    sessionUpdate: 'agent_message_chunk',
                    content: { type: 'text', text: `chunk-${i + 1}` },
                });
            }
            if (options.enablePermission) {
                const permission = await c.client.request(acp.methods.client.session.requestPermission, {
                    sessionId,
                    toolCall: { toolCallId: 'permission-tool', title: 'Permission tool', kind: 'shell' },
                    options: [
                        { kind: 'allow_once', name: 'Allow once', optionId: 'allow' },
                        { kind: 'reject_once', name: 'Reject once', optionId: 'reject' },
                    ],
                });
                await notify({
                    sessionUpdate: 'agent_message_chunk',
                    content: { type: 'text', text: `permission-${permission.outcome.outcome}-${permission.outcome.optionId ?? ''}` },
                });
            }
            if (options.doublePermission) {
                // 同一会话并发两个审批请求（模拟重叠工具各自请求审批）
                const askPermission = (toolCallId) => c.client.request(acp.methods.client.session.requestPermission, {
                    sessionId,
                    toolCall: { toolCallId, title: `Permission ${toolCallId}`, kind: 'shell' },
                    options: [
                        { kind: 'allow_once', name: 'Allow once', optionId: 'allow' },
                        { kind: 'reject_once', name: 'Reject once', optionId: 'reject' },
                    ],
                });
                const [p1, p2] = await Promise.all([askPermission('perm-a'), askPermission('perm-b')]);
                await notify({
                    sessionUpdate: 'agent_message_chunk',
                    content: { type: 'text', text: `double-${p1.outcome.outcome}-${p2.outcome.outcome}` },
                });
            }
            return { stopReason: 'end_turn' };
        })
        .onNotification(acp.methods.agent.session.cancel, () => {});
}

/** 构造接入模拟引擎的服务端套件 */
async function buildWiredServer(engineOptions = {}, managerOptions = {}) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lvtian-wire-test-'));
    const memoryManager = new MemoryManager(tmp);
    const sessionManager = new SessionManager(tmp);
    const connectEngine = async (app) => {
        let resolveContext;
        let resolveStop;
        const contextReady = new Promise((resolve) => { resolveContext = resolve; });
        const stopSignal = new Promise((resolve) => { resolveStop = resolve; });
        const run = app.connectWith(createMockEngine(engineOptions), async (ctx) => {
            resolveContext(ctx);
            await stopSignal;
        });
        const closed = run.catch(() => undefined);
        return {
            context: await contextReady,
            closed,
            close: async () => { resolveStop(); await closed; },
        };
    };
    const engine = new AcpEngineManager(tmp, memoryManager, sessionManager, { connectEngine, ...managerOptions });
    const config = {
        port: 0,
        host: '127.0.0.1',
        token: 'test-token-wired-12345',
        workspace: tmp,
        dataDir: tmp,
        assistantName: 'TestBot',
    };
    const server = new LvtianServer(config, sessionManager, memoryManager, engine);
    await server.start();
    const port = server.httpServer.address().port;
    return { server, sessionManager, tmp, port };
}

function waitForMsg(received, predicate, desc, timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
        const timer = setInterval(() => {
            const found = received.find(predicate);
            if (found) {
                clearInterval(timer);
                resolve(found);
            }
        }, 10);
        setTimeout(() => {
            clearInterval(timer);
            reject(new Error(`等待消息超时: ${desc}`));
        }, timeoutMs);
    });
}

/** 建立已认证的 WebSocket 客户端，服务端广播按到达顺序收进 received */
async function openAuthenticatedClient(port, token, received) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on('message', (raw) => received.push(JSON.parse(raw.toString('utf8'))));
    await new Promise((resolve, reject) => {
        ws.on('error', reject);
        ws.on('open', () => {
            ws.send(JSON.stringify({ type: 'auth', token }));
            resolve();
        });
    });
    await waitForMsg(received, (m) => m.type === 'auth_result' && m.success, 'auth_result');
    return ws;
}

test('聊天报文经接线层完整广播：受理回执、流式增量与完成终态', async () => {
    const { server, sessionManager, tmp, port } = await buildWiredServer({ chunkCount: 2 });
    const received = [];
    const ws = await openAuthenticatedClient(port, 'test-token-wired-12345', received);

    ws.send(JSON.stringify({ type: 'chat', sessionId: 'main', messageId: 'u1', content: '你好' }));

    const ack = await waitForMsg(received, (m) => m.type === 'message_ack', 'message_ack');
    assert.equal(ack.messageId, 'u1');
    assert.equal(ack.role, 'user');
    assert.equal(ack.content, '你好');

    const placeholderIdx = received.findIndex((m) => m.type === 'event_chunk' && m.delta === '');
    assert.ok(placeholderIdx >= 0, '应广播助理占位 event_chunk');
    const firstDelta = await waitForMsg(received, (m) => m.type === 'event_chunk' && m.delta === 'chunk-1', '首个增量');
    assert.ok(received.indexOf(firstDelta) > placeholderIdx, '流式增量应在占位之后');

    const done = await waitForMsg(received, (m) => m.type === 'task_status' && m.state === 'completed', '完成终态');
    assert.ok(
        received.findIndex((m) => m.type === 'event_chunk' && m.delta === 'chunk-2') < received.indexOf(done),
        '终态应在全部增量之后'
    );

    const session = sessionManager.getOrCreateSession('main');
    assert.equal(session.taskState, 'completed');
    const asstMsg = session.messages.find((m) => m.id.startsWith('asst-'));
    assert.equal(asstMsg.status, 'done');
    assert.equal(asstMsg.content, 'chunk-1chunk-2');
    assert.ok(sessionManager.getDshSessionId('main'), '引擎侧会话绑定应持久化');

    ws.close();
    await server.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('审批卡下发与应答：approval_request 转发、允许后任务恢复执行并完成', async () => {
    const { server, sessionManager, tmp, port } = await buildWiredServer({ chunkCount: 1, enablePermission: true });
    const received = [];
    const ws = await openAuthenticatedClient(port, 'test-token-wired-12345', received);

    ws.send(JSON.stringify({ type: 'chat', sessionId: 'main', messageId: 'u1', content: '执行操作' }));

    const approval = await waitForMsg(received, (m) => m.type === 'approval_request', 'approval_request');
    assert.ok(approval.approvalId, '审批卡应带 ID');
    assert.equal(approval.toolName, 'shell');
    assert.ok(approval.prompt.includes('Permission tool'));

    ws.send(JSON.stringify({ type: 'approval_response', approvalId: approval.approvalId, approved: true }));

    const resumed = await waitForMsg(received, (m) => m.type === 'task_status' && m.state === 'processing' && m.seq > approval.seq, '应答后恢复执行中');
    assert.ok(resumed.seq > approval.seq, '恢复执行中的 seq 应推进');

    await waitForMsg(received, (m) => m.type === 'task_status' && m.state === 'completed', '完成终态');

    const allDeltas = received.filter((m) => m.type === 'event_chunk' && m.delta).map((m) => m.delta).join('');
    assert.ok(allDeltas.includes('permission-selected-allow'), '允许应答应选中 allow 选项');

    const session = sessionManager.getOrCreateSession('main');
    assert.equal(session.taskState, 'completed');
    assert.equal(session.pendingApproval, undefined, '应答后待审批登记应清空');

    ws.close();
    await server.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('审批拒绝后任务不终止：状态恢复执行中并由引擎正常收尾', async () => {
    const { server, sessionManager, tmp, port } = await buildWiredServer({ chunkCount: 1, enablePermission: true });
    const received = [];
    const ws = await openAuthenticatedClient(port, 'test-token-wired-12345', received);

    ws.send(JSON.stringify({ type: 'chat', sessionId: 'main', messageId: 'u1', content: '执行操作' }));

    const approval = await waitForMsg(received, (m) => m.type === 'approval_request', 'approval_request');
    ws.send(JSON.stringify({ type: 'approval_response', approvalId: approval.approvalId, approved: false }));

    await waitForMsg(received, (m) => m.type === 'task_status' && m.state === 'processing' && m.seq > approval.seq, '拒绝后恢复执行中');
    await waitForMsg(received, (m) => m.type === 'task_status' && m.state === 'completed', '完成终态');

    const allDeltas = received.filter((m) => m.type === 'event_chunk' && m.delta).map((m) => m.delta).join('');
    assert.ok(allDeltas.includes('permission-selected-reject'), '拒绝应答应选中 reject 选项');

    const session = sessionManager.getOrCreateSession('main');
    assert.equal(session.taskState, 'completed', '拒绝审批不终止任务，引擎正常收尾');

    ws.close();
    await server.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('停止报文广播 stopped 终态并停止后续增量广播', async () => {
    const { server, sessionManager, tmp, port } = await buildWiredServer({ chunkCount: 3, chunkDelayMs: 100 });
    const received = [];
    const ws = await openAuthenticatedClient(port, 'test-token-wired-12345', received);

    ws.send(JSON.stringify({ type: 'chat', sessionId: 'main', messageId: 'u1', content: '长任务' }));
    await waitForMsg(received, (m) => m.type === 'event_chunk' && m.delta === 'chunk-1', '首个增量');

    ws.send(JSON.stringify({ type: 'stop', sessionId: 'main' }));

    const stopped = await waitForMsg(received, (m) => m.type === 'task_status' && m.state === 'stopped', '停止终态');
    assert.equal(stopped.error, 'task_stopped', '停止终态应携带稳定错误码');

    await delay(400); // 覆盖剩余 chunk 的原定到达窗口
    assert.ok(
        !received.some((m) => m.type === 'event_chunk' && (m.delta === 'chunk-2' || m.delta === 'chunk-3')),
        '停止后不应再广播增量'
    );

    const session = sessionManager.getOrCreateSession('main');
    assert.equal(session.taskState, 'stopped');
    const asstMsg = session.messages.find((m) => m.id.startsWith('asst-'));
    assert.equal(asstMsg.status, 'error');
    assert.equal(asstMsg.errorMessage, 'task_stopped');

    ws.close();
    await server.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('审批超时自动拒绝：广播 stopped 终态并携带稳定错误码', async () => {
    const { server, sessionManager, tmp, port } = await buildWiredServer(
        { chunkCount: 1, enablePermission: true },
        { approvalTimeoutMs: 100 }
    );
    const received = [];
    const ws = await openAuthenticatedClient(port, 'test-token-wired-12345', received);

    ws.send(JSON.stringify({ type: 'chat', sessionId: 'main', messageId: 'u1', content: '执行操作' }));
    await waitForMsg(received, (m) => m.type === 'approval_request', 'approval_request');
    // 不应答，等待服务端审批超时

    const stopped = await waitForMsg(received, (m) => m.type === 'task_status' && m.state === 'stopped', '审批超时终态');
    assert.equal(stopped.error, 'approval_timeout', '超时终态应携带稳定错误码');

    const session = sessionManager.getOrCreateSession('main');
    assert.equal(session.taskState, 'stopped');
    const asstMsg = session.messages.find((m) => m.id.startsWith('asst-'));
    assert.equal(asstMsg.errorMessage, 'approval_timeout');
    assert.equal(session.pendingApprovals.length, 0, '超时后待审批登记应清空');

    ws.close();
    await server.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('同一会话并发审批：两卡独立下发、各自应答互不丢弃', async () => {
    const { server, sessionManager, tmp, port } = await buildWiredServer({ doublePermission: true });
    const received = [];
    const ws = await openAuthenticatedClient(port, 'test-token-wired-12345', received);

    ws.send(JSON.stringify({ type: 'chat', sessionId: 'main', messageId: 'u1', content: '并发审批任务' }));

    // 两个审批卡先后到达（并发请求经服务端逐个广播）
    await waitForMsg(received, (m) => m.type === 'approval_request' && m.prompt.includes('perm-a'), 'perm-a 审批卡');
    await waitForMsg(received, (m) => m.type === 'approval_request' && m.prompt.includes('perm-b'), 'perm-b 审批卡');
    const approvals = received.filter((m) => m.type === 'approval_request');
    assert.equal(approvals.length, 2, '两张审批卡都应下发到客户端');
    assert.notEqual(approvals[0].approvalId, approvals[1].approvalId, '并发审批 ID 必须独立');

    const session = sessionManager.getOrCreateSession('main');
    assert.equal(session.pendingApprovals.length, 2, '服务端待审批队列应同时登记两项');

    // 先应答第二张卡，再应答第一张卡：先答者不得因登记顺序被丢弃
    ws.send(JSON.stringify({ type: 'approval_response', approvalId: approvals[1].approvalId, approved: false }));
    ws.send(JSON.stringify({ type: 'approval_response', approvalId: approvals[0].approvalId, approved: true }));

    await waitForMsg(received, (m) => m.type === 'task_status' && m.state === 'completed', '完成终态');
    const allDeltas = received.filter((m) => m.type === 'event_chunk' && m.delta).map((m) => m.delta).join('');
    assert.ok(allDeltas.includes('double-selected-selected'), '两个审批都应送达引擎各自的授权选择');
    assert.equal(session.pendingApprovals.length, 0, '全部应答后待审批队列应清空');

    ws.close();
    await server.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('服务端优雅停机：向所有在线客户端广播 service_upgrading 并平滑退出', async () => {
    const { server, tmp, port } = await buildWiredServer();
    const token = 'test-token-wired-12345';
    const received1 = [];
    const received2 = [];
    const ws1 = await openAuthenticatedClient(port, token, received1);
    const ws2 = await openAuthenticatedClient(port, token, received2);

    // 触发优雅停机
    await server.gracefulDrainAndStop({
        estimatedSeconds: 5,
        targetVersion: 'v0.3.5-test',
    });

    // 两个客户端均应收到 service_upgrading 广播
    const upg1 = received1.find((m) => m.type === 'service_upgrading');
    const upg2 = received2.find((m) => m.type === 'service_upgrading');
    assert.ok(upg1, '客户端 1 必须收到 service_upgrading 报文');
    assert.ok(upg2, '客户端 2 必须收到 service_upgrading 报文');
    assert.equal(upg1.estimatedSeconds, 5);
    assert.equal(upg1.targetVersion, 'v0.3.5-test');
    assert.equal(upg2.estimatedSeconds, 5);

    // 验证服务端标记进入排空退出状态
    assert.ok(server.isShuttingDownOrDraining());

    fs.rmSync(tmp, { recursive: true, force: true });
});

test('服务端优雅停机避让：等待活跃任务完成后再广播升级与停机', async () => {
    // 模拟一个包含耗时分块的执行引擎（总耗时约 300ms，以产生真实避让窗口）
    const { server, tmp, port } = await buildWiredServer({
        chunkCount: 2,
        chunkDelayMs: 150,
    });
    const token = 'test-token-wired-12345';
    const received = [];
    const ws = await openAuthenticatedClient(port, token, received);

    // 发送任务
    ws.send(JSON.stringify({ type: 'chat', sessionId: 'main', messageId: 'u-drain-1', content: '测试排空' }));

    // 等待任务已进入执行状态
    await delay(30);

    // 此时触发优雅停机（应避让等待本任务完成）
    const drainPromise = server.gracefulDrainAndStop({
        estimatedSeconds: 3,
        timeoutMs: 5000,
    });

    // 排空期间新任务应该被拒绝
    const receivedReject = [];
    const ws2 = await openAuthenticatedClient(port, token, receivedReject);
    ws2.send(JSON.stringify({ type: 'chat', sessionId: 'main', messageId: 'u-drain-2', content: '排空中被拒' }));
    await waitForMsg(receivedReject, (m) => m.type === 'message_ack' && m.status === 'error', '排空期拒绝回执');
    const rejAck = receivedReject.find((m) => m.type === 'message_ack' && m.messageId === 'u-drain-2');
    assert.equal(rejAck?.error, 'service_upgrading', '排空期拒绝回执应使用可国际化的稳定错误码');

    await drainPromise;

    // 验证先前正在执行的任务完整跑完，且收到提前与收尾的 service_upgrading 广播
    const completedMsg = received.find((m) => m.type === 'task_status' && m.state === 'completed');
    const upgradingMsgs = received.filter((m) => m.type === 'service_upgrading');
    assert.ok(completedMsg, '先前执行的任务必须顺利执行完毕 (completed)');
    assert.ok(upgradingMsgs.length >= 2, '避让流程开始与收尾阶段均应广播 service_upgrading');

    const firstUpgradeIdx = received.indexOf(upgradingMsgs[0]);
    const lastUpgradeIdx = received.lastIndexOf(upgradingMsgs[upgradingMsgs.length - 1]);
    const completedIdx = received.indexOf(completedMsg);
    assert.ok(firstUpgradeIdx < completedIdx, '升级预告必须在避让流程开始时第一时间送达客户端');
    assert.ok(completedIdx < lastUpgradeIdx, '活跃任务必须在最终关停升级广播之前完整收尾（执行避让）');

    fs.rmSync(tmp, { recursive: true, force: true });
});

test('并发发送消息自动排队，前序任务完成后按序流水推进', async () => {
    const { server, sessionManager, tmp, port } = await buildWiredServer({ chunkCount: 2, chunkDelayMs: 60 });
    const received = [];
    const ws = await openAuthenticatedClient(port, 'test-token-wired-12345', received);

    // 1. 发送第一条消息
    ws.send(JSON.stringify({ type: 'chat', sessionId: 'main', messageId: 'u1', content: '第一条指令' }));
    await waitForMsg(received, (m) => m.type === 'message_ack' && m.messageId === 'u1', 'u1 ack');

    // 2. 在第一条正在执行时，连续发送第二条与第三条消息
    ws.send(JSON.stringify({ type: 'chat', sessionId: 'main', messageId: 'u2', content: '第二条指令' }));
    ws.send(JSON.stringify({ type: 'chat', sessionId: 'main', messageId: 'u3', content: '第三条指令' }));

    // 验证第二条和第三条消息收到排队回执 status: 'queued'
    const ack2 = await waitForMsg(received, (m) => m.type === 'message_ack' && m.messageId === 'u2' && m.status === 'queued', 'u2 排队回执');
    const ack3 = await waitForMsg(received, (m) => m.type === 'message_ack' && m.messageId === 'u3' && m.status === 'queued', 'u3 排队回执');
    assert.ok(ack2);
    assert.ok(ack3);

    // 3. 等待第一条任务自然完成
    await waitForMsg(received, (m) => m.type === 'task_status' && m.state === 'completed', '首个任务完成');

    // 4. 第一条完成后，第二条应自动开始执行（广播 message_ack 状态更新为 sent 并开始 thinking）
    const u2Started = await waitForMsg(received, (m) => m.type === 'message_ack' && m.messageId === 'u2' && m.status === 'sent', 'u2 开始执行');
    assert.ok(u2Started);

    // 5. 等待第二条完成，第三条也自动开始执行
    const secondDone = await waitForMsg(
        received,
        (m, idx) => m.type === 'task_status' && m.state === 'completed' && idx > received.indexOf(u2Started),
        '第二条完成'
    );
    assert.ok(secondDone);

    const u3Started = await waitForMsg(received, (m) => m.type === 'message_ack' && m.messageId === 'u3' && m.status === 'sent', 'u3 开始执行');
    assert.ok(u3Started);

    // 6. 等待第三条任务完成
    await waitForMsg(
        received,
        (m, idx) => m.type === 'task_status' && m.state === 'completed' && idx > received.indexOf(u3Started),
        '第三条完成'
    );

    const session = sessionManager.getOrCreateSession('main');
    // 验证所有排队消息均已顺利完成，无残留排队
    assert.equal(session.messages.filter((m) => m.status === 'queued').length, 0);

    ws.close();
    await server.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('撤销排队消息：cancel_queued 将排队中消息彻底删除并广播 message_deleted 且不执行', async () => {
    const { server, sessionManager, tmp, port } = await buildWiredServer({ chunkCount: 3, chunkDelayMs: 80 });
    const received = [];
    const ws = await openAuthenticatedClient(port, 'test-token-wired-12345', received);

    // 发送第一条
    ws.send(JSON.stringify({ type: 'chat', sessionId: 'main', messageId: 'u1', content: '正在执行' }));
    await waitForMsg(received, (m) => m.type === 'message_ack' && m.messageId === 'u1', 'u1 ack');

    // 发送第二条进入排队
    ws.send(JSON.stringify({ type: 'chat', sessionId: 'main', messageId: 'u2', content: '待撤销的排队消息' }));
    await waitForMsg(received, (m) => m.type === 'message_ack' && m.messageId === 'u2' && m.status === 'queued', 'u2 排队');

    // 发送撤销排队报文
    ws.send(JSON.stringify({ type: 'cancel_queued', sessionId: 'main', messageId: 'u2' }));

    // 验证收到删除广播回执
    const deleteMsg = await waitForMsg(
        received,
        (m) => m.type === 'message_deleted' && m.messageId === 'u2',
        'u2 删除广播回执'
    );
    assert.ok(deleteMsg);

    // 等待第一条任务自然结束
    await waitForMsg(received, (m) => m.type === 'task_status' && m.state === 'completed', '首个任务完成');

    // 等待一段时间，确保 u2 不会被意外启动
    await delay(200);
    assert.ok(!received.some((m) => m.type === 'message_ack' && m.messageId === 'u2' && m.status === 'sent'));

    const session = sessionManager.getOrCreateSession('main');
    const u2 = session.messages.find((m) => m.id === 'u2');
    assert.equal(u2, undefined, '排队消息应被物理删除，不在会话记录中');

    ws.close();
    await server.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('撤销排队消息：目标非排队态时返回 cancel_failed 回执且不删除消息', async () => {
    const { server, sessionManager, tmp, port } = await buildWiredServer({ chunkCount: 2, chunkDelayMs: 60 });
    const received = [];
    const ws = await openAuthenticatedClient(port, 'test-token-wired-12345', received);

    // 1. 对不存在的消息发送撤销
    ws.send(JSON.stringify({ type: 'cancel_queued', sessionId: 'main', messageId: 'not-exist' }));
    const failedNotFound = await waitForMsg(
        received,
        (m) => m.type === 'cancel_failed' && m.messageId === 'not-exist',
        'not_found cancel_failed'
    );
    assert.equal(failedNotFound.reason, 'not_found');

    // 2. 发送正在执行的消息
    ws.send(JSON.stringify({ type: 'chat', sessionId: 'main', messageId: 'u-running', content: '正在执行的任务' }));
    await waitForMsg(received, (m) => m.type === 'message_ack' && m.messageId === 'u-running' && m.status === 'sent', 'u-running sent');

    // 尝试对已处于执行中的消息撤销排队
    ws.send(JSON.stringify({ type: 'cancel_queued', sessionId: 'main', messageId: 'u-running' }));
    const failedStarted = await waitForMsg(
        received,
        (m) => m.type === 'cancel_failed' && m.messageId === 'u-running',
        'already_started cancel_failed'
    );
    assert.equal(failedStarted.reason, 'already_started');

    // 等待任务执行结束
    await waitForMsg(received, (m) => m.type === 'task_status' && m.state === 'completed', '任务完成');

    // 验证消息依然保留在会话中
    const session = sessionManager.getOrCreateSession('main');
    assert.ok(session.messages.some((m) => m.id === 'u-running'), '正在执行的消息未被误删除');

    ws.close();
    await server.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('手动终止 stop：同时终止运行中任务与排队中的消息', async () => {
    const { server, sessionManager, tmp, port } = await buildWiredServer({ chunkCount: 4, chunkDelayMs: 80 });
    const received = [];
    const ws = await openAuthenticatedClient(port, 'test-token-wired-12345', received);

    ws.send(JSON.stringify({ type: 'chat', sessionId: 'main', messageId: 'u1', content: '执行中' }));
    await waitForMsg(received, (m) => m.type === 'message_ack' && m.messageId === 'u1', 'u1 ack');

    // 入队两个消息
    ws.send(JSON.stringify({ type: 'chat', sessionId: 'main', messageId: 'u2', content: '排队1' }));
    ws.send(JSON.stringify({ type: 'chat', sessionId: 'main', messageId: 'u3', content: '排队2' }));
    await waitForMsg(received, (m) => m.type === 'message_ack' && m.messageId === 'u3' && m.status === 'queued', 'u3 排队');

    // 点击停止
    ws.send(JSON.stringify({ type: 'stop', sessionId: 'main' }));

    await waitForMsg(received, (m) => m.type === 'task_status' && m.state === 'stopped', '停止终态');

    const session = sessionManager.getOrCreateSession('main');
    assert.equal(session.taskState, 'stopped');
    const u2 = session.messages.find((m) => m.id === 'u2');
    const u3 = session.messages.find((m) => m.id === 'u3');
    assert.equal(u2.status, 'error');
    assert.equal(u2.errorMessage, 'task_stopped');
    assert.equal(u3.status, 'error');
    assert.equal(u3.errorMessage, 'task_stopped');

    ws.close();
    await server.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('SessionManager repairAfterLoad：服务重启时未执行的排队消息标记为 service_restarted', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvtian-test-sm-queue-'));
    const sm = new SessionManager(tmpDir);

    sm.addMessage('test-session', {
        id: 'u-queued',
        role: 'user',
        content: '排队中但在重启时未执行的消息',
        timestamp: Date.now(),
        status: 'queued',
    });

    // 重新创建 SessionManager 模拟重启加载
    const sm2 = new SessionManager(tmpDir);
    const session = sm2.getOrCreateSession('test-session');
    const msg = session.messages.find((m) => m.id === 'u-queued');
    assert.equal(msg.status, 'error');
    assert.equal(msg.errorMessage, 'service_restarted');

    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('SessionManager: getHistoryDialogue 与 getVerbatimExcerpts 自动过滤 queued 状态消息', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvtian-test-sm-filter-'));
    const sm = new SessionManager(tmpDir);

    sm.addMessage('test-session', {
        id: 'u1',
        role: 'user',
        content: '第一条指令',
        timestamp: Date.now(),
        status: 'done',
    });
    sm.addMessage('test-session', {
        id: 'a1',
        role: 'assistant',
        content: '第一条回复',
        timestamp: Date.now() + 1,
        status: 'done',
    });
    sm.addMessage('test-session', {
        id: 'u2-queued',
        role: 'user',
        content: '排队中的未来指令',
        timestamp: Date.now() + 2,
        status: 'queued',
    });

    const history = sm.getHistoryDialogue('test-session');
    assert.ok(history.includes('第一条指令'));
    assert.ok(history.includes('第一条回复'));
    assert.ok(!history.includes('排队中的未来指令'), '未执行的排队消息不应出现在历史对话中');

    const verbatim = sm.getVerbatimExcerpts('test-session');
    assert.ok(verbatim.includes('第一条指令'));
    assert.ok(verbatim.includes('第一条回复'));
    assert.ok(!verbatim.includes('排队中的未来指令'), '未执行的排队消息不应出现在物理锚定摘要中');

    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('排队保序：队列中有未处理消息时，新到达消息保持 queued 状态而不插队', async () => {
    const { server, sessionManager, tmp, port } = await buildWiredServer({ chunkCount: 3, chunkDelayMs: 60 });
    const received = [];
    const ws = await openAuthenticatedClient(port, 'test-token-wired-12345', received);

    // 1. 发送 u1，并在执行期间发送 u2 排队
    ws.send(JSON.stringify({ type: 'chat', sessionId: 'main', messageId: 'u1', content: '任务1' }));
    await waitForMsg(received, (m) => m.type === 'message_ack' && m.messageId === 'u1', 'u1 ack');

    ws.send(JSON.stringify({ type: 'chat', sessionId: 'main', messageId: 'u2', content: '任务2' }));
    await waitForMsg(received, (m) => m.type === 'message_ack' && m.messageId === 'u2' && m.status === 'queued', 'u2 queued');

    // 2. 发送 u3，验证即使此时队列有待处理消息 u2，u3 必须入队而非插队直接执行
    ws.send(JSON.stringify({ type: 'chat', sessionId: 'main', messageId: 'u3', content: '任务3' }));
    const ack3 = await waitForMsg(received, (m) => m.type === 'message_ack' && m.messageId === 'u3', 'u3 ack');
    assert.equal(ack3.status, 'queued', 'u3 应进入排队而不是插队直接执行');

    ws.close();
    await server.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('SessionManager: addMessage 落盘失败时回滚内存队列与序号', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvtian-test-sm-rollback-'));
    const sm = new SessionManager(tmpDir);

    const session = sm.getOrCreateSession('test-session');
    const initialSeq = session.currentSeq;

    // 篡改 appendEvent 模拟磁盘写入失败
    sm.appendEvent = () => false;

    assert.throws(
        () => {
            sm.addMessage('test-session', {
                id: 'fail-msg',
                role: 'user',
                content: '写入失败的消息',
                timestamp: Date.now(),
                status: 'queued',
            });
        },
        /持久化会话消息失败/
    );

    // 验证内存中该失败消息已被回滚移出，序号未递增
    assert.equal(session.messages.length, 0);
    assert.equal(session.currentSeq, initialSeq);

    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('排队幂等去重：相同 messageId 重复到达时不重复追加排队项', async () => {
    const { server, sessionManager, tmp, port } = await buildWiredServer({ chunkCount: 2, chunkDelayMs: 60 });
    const received = [];
    const ws = await openAuthenticatedClient(port, 'test-token-wired-12345', received);

    // 1. 发送 u1 启动任务
    ws.send(JSON.stringify({ type: 'chat', sessionId: 'main', messageId: 'u1', content: '正在执行' }));
    await waitForMsg(received, (m) => m.type === 'message_ack' && m.messageId === 'u1', 'u1 ack');

    // 2. 发送排队消息 u2
    ws.send(JSON.stringify({ type: 'chat', sessionId: 'main', messageId: 'u2', content: '排队指令' }));
    await waitForMsg(received, (m) => m.type === 'message_ack' && m.messageId === 'u2' && m.status === 'queued', 'u2 排队首发');

    // 3. 模拟弱网重发相同 messageId: u2
    ws.send(JSON.stringify({ type: 'chat', sessionId: 'main', messageId: 'u2', content: '排队指令' }));
    await delay(100);

    const session = sessionManager.getOrCreateSession('main');
    const u2Matches = session.messages.filter((m) => m.id === 'u2');
    assert.equal(u2Matches.length, 1, '相同 messageId 绝不能在会话中重复插入两条记录');

    // 4. 等待第一条和第二条均顺利执行完成，验证不会因重复项引发死循环
    await waitForMsg(received, (m) => m.type === 'task_status' && m.state === 'completed', '首个任务完成');
    await waitForMsg(received, (m) => m.type === 'message_ack' && m.messageId === 'u2' && m.status === 'sent', 'u2 开始执行');
    await waitForMsg(
        received,
        (m, idx) => m.type === 'task_status' && m.state === 'completed' && idx > received.findIndex((x) => x.messageId === 'u2' && x.status === 'sent'),
        'u2 完成'
    );

    assert.equal(session.messages.filter((m) => m.status === 'queued').length, 0);

    ws.close();
    await server.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('SessionManager deleteMessage 推进序列号并纳入 getReconcileData 增量对账与重启重放', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvtian-test-sm-del-'));
    const sm = new SessionManager(tmpDir);

    const m1 = sm.addMessage('test-session', {
        id: 'u-1',
        role: 'user',
        content: '第一条消息',
        timestamp: Date.now(),
        status: 'queued',
    });
    const lastSeq = m1.seq;

    // 删除排队消息
    const deleted = sm.deleteMessage('test-session', 'u-1');
    assert.equal(deleted, true);

    // 增量对账：lastSeq 后的删除记录应包含 u-1
    const reconcile = sm.getReconcileData('test-session', lastSeq);
    assert.deepEqual(reconcile.deletedMessageIds, ['u-1']);
    assert.ok(reconcile.currentSeq > lastSeq, '删除操作推进了序列号');

    // 模拟服务端重启重放
    const smRestarted = new SessionManager(tmpDir);
    const session = smRestarted.getOrCreateSession('test-session');
    assert.equal(session.messages.find((m) => m.id === 'u-1'), undefined);
    const reconcileAfterRestart = smRestarted.getReconcileData('test-session', lastSeq);
    assert.deepEqual(reconcileAfterRestart.deletedMessageIds, ['u-1']);

    fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('SessionManager deleteMessage 超过100条时完整保留删除历史，不截断', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvtian-test-sm-del-many-'));
    const sm = new SessionManager(tmpDir);

    const m0 = sm.addMessage('test-session', {
        id: 'msg-init',
        role: 'user',
        content: '初始基准消息',
        timestamp: Date.now(),
        status: 'sent',
    });
    const baseSeq = m0.seq;
    for (let i = 0; i < 120; i++) {
        sm.addMessage('test-session', {
            id: `msg-${i}`,
            role: 'user',
            content: `内容 ${i}`,
            timestamp: Date.now(),
            status: 'queued',
        });
        sm.deleteMessage('test-session', `msg-${i}`);
    }

    const session = sm.getOrCreateSession('test-session');
    assert.equal(session.deletedMessages?.length, 120, '120条删除历史全部完整保留');
    const reconcile = sm.getReconcileData('test-session', baseSeq);
    assert.equal(reconcile.deletedMessageIds?.length, 120, '对账时返回全部120条删除ID');

    fs.rmSync(tmpDir, { recursive: true, force: true });
});

