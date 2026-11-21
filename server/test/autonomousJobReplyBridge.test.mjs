import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { AutonomousJobReplyBridge } from '../dist/autonomousJobReplyBridge.js';

const frame = data => JSON.stringify(data) + '\n';

test('ownership frames arriving after ACP updates keep job text out of the user response', async () => {
    const stream = new PassThrough();
    const forwarded = [];
    const reports = [];
    const bridge = new AutonomousJobReplyBridge(report => reports.push(report));
    bridge.attach(stream);
    bridge.route('session', 'job-message', () => forwarded.push('wrong: job text in user response'));
    bridge.route('session', 'user-message', () => forwarded.push('user response'));
    const drained = bridge.drain();
    const user = { kind: 'ownership', engineSessionId: 'session', id: 'user-message', autonomous: false };
    const job = { kind: 'ownership', engineSessionId: 'session', id: 'job-message', autonomous: true };
    stream.write(frame(user));
    assert.deepEqual(forwarded, []);
    stream.write(frame(job).slice(0, 10));
    stream.write(frame(job).slice(10));
    await drained;
    assert.deepEqual(forwarded, ['user response']);
    stream.write(frame({ kind: 'reply', engineSessionId: 'session', turn: 2, text: '后台结果' }));
    assert.deepEqual(reports, [{ engineSessionId: 'session', turn: 2, text: '后台结果' }]);
    stream.destroy();
});

test('a malformed frame fails closed, including queued unclassified text', async () => {
    const stream = new PassThrough();
    const bridge = new AutonomousJobReplyBridge(() => assert.fail('unexpected report'));
    bridge.attach(stream);
    bridge.route('session', 'unknown', () => assert.fail('unexpected update'));
    const drained = bridge.drain();
    stream.write('not a frame\n');
    await assert.rejects(drained, /ownership stream unavailable/);
    stream.destroy();
});
