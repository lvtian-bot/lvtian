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


