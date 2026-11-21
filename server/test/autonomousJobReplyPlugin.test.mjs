import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { text } from 'node:stream/consumers';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(new URL('./fixtures/autonomousJobReplyHarness.mjs', import.meta.url));

test('真实 DSH：后台作业唤醒只汇报最终正文，混合用户轮不重复发送', { timeout: 15_000 }, async () => {
    const child = spawn(process.execPath, [fixture], {
        env: { ...process.env, LVTIAN_AUTONOMOUS_JOB_REPLY_FD: '3' },
        stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
        timeout: 12_000,
    });
    const [[code, signal], stdout, stderr, wire] = await Promise.all([
        once(child, 'close'), text(child.stdout), text(child.stderr), text(child.stdio[3]),
    ]);
    assert.equal(code, 0, `fixture failed (signal=${signal}): ${stderr}`);
    assert.match(wire, /\n$/u, 'FD frames must end with a newline');
    const { ids } = JSON.parse(stdout);
    assert.equal(ids.length, 4);
    const engineSessionId = 'fixture-main';
    const ownership = (id, autonomous) => ({ kind: 'ownership', engineSessionId, id, autonomous });
    assert.deepEqual(wire.trimEnd().split('\n').map(JSON.parse), [
        ownership(ids[0], true),
        ownership('fixture-tool-call', true),
        ownership(ids[1], true),
        { kind: 'reply', engineSessionId, turn: 1, text: '已完成，结果如下：\n第二行。' },
        ownership(ids[2], false),
        ownership(ids[3], false),
    ]);
});
