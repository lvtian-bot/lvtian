import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { AutonomousJobReplyBridge } from '../dist/autonomousJobReplyBridge.js';

const frame = data => JSON.stringify(data) + '\n';
const owner = (bridge, engineSessionId, id, autonomous = false) => {
    bridge.receive(JSON.stringify({ kind: 'ownership', engineSessionId, id, autonomous }));
};
const route = (bridge, session, id, apply, bytes = 64) => bridge.route(session, id, apply, () => bytes);

test('ownership frames arriving after ACP updates keep job text out of the user response', async () => {
    const stream = new PassThrough();
    const forwarded = [];
    const reports = [];
    const bridge = new AutonomousJobReplyBridge(report => reports.push(report));
    bridge.attach(stream);
    route(bridge, 'session', 'job-message', () => forwarded.push('wrong: job text in user response'));
    route(bridge, 'session', 'user-message', () => forwarded.push('user response'));
    const drained = bridge.drain('session');
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
    route(bridge, 'session', 'unknown', () => assert.fail('unexpected update'));
    const drained = bridge.drain('session');
    stream.write('not a frame\n');
    await assert.rejects(drained, /ownership stream unavailable/);
    stream.destroy();
});

test('known user ownership delivers 1,200 ACP chunks immediately; a pipe race preserves chunk order', async () => {
    const bridge = new AutonomousJobReplyBridge(() => assert.fail('unexpected report'));
    const forwarded = [];
    owner(bridge, 'session', 'early');
    for (let index = 0; index < 1200; index++) {
        bridge.route('session', 'early', () => forwarded.push(index), () => assert.fail('classified frames must not queue'));
        assert.equal(forwarded.length, index + 1);
    }
    for (let index = 0; index < 1200; index++) route(bridge, 'session', 'late', () => forwarded.push(index));
    assert.equal(forwarded.length, 1200);
    const drained = bridge.drain('session');
    owner(bridge, 'session', 'late');
    await drained;
    const expected = Array.from({ length: 1200 }, (_, index) => index);
    assert.deepEqual(forwarded, [...expected, ...expected]);
});

test('race-buffer overflow fails only the affected prompt and the same session recovers', async () => {
    const bridge = new AutonomousJobReplyBridge(() => assert.fail('unexpected report'));
    const forwarded = [];
    const rejected = () => assert.fail('overflowed or autonomous data must never reach the prompt');
    route(bridge, 'other', 'other-user', () => forwarded.push('other user'));
    for (let index = 0; index < 3; index++) route(bridge, 'session', 'overflowed', rejected, 1024 * 1024);
    owner(bridge, 'session', 'overflowed');
    route(bridge, 'session', 'overflowed', rejected);
    await assert.rejects(bridge.drain('session'), /queue overflow/);
    owner(bridge, 'other', 'other-user');
    await bridge.drain('other');
    bridge.release('session');
    route(bridge, 'session', 'late-job', rejected);
    route(bridge, 'session', 'next-user', () => forwarded.push('next user'));
    owner(bridge, 'session', 'next-user');
    owner(bridge, 'session', 'late-job', true);
    await bridge.drain('session');
    assert.deepEqual(forwarded, ['other user', 'next user']);
});

test('missing ownership times out only this prompt and queued updates do not leak to its successor', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const bridge = new AutonomousJobReplyBridge(() => assert.fail('unexpected report'));
    route(bridge, 'session', 'unknown', () => assert.fail('timed-out update must never be applied'));
    const drained = assert.rejects(bridge.drain('session'), /ownership timed out/);
    t.mock.timers.tick(3000);
    await drained;
    bridge.release('session');
    owner(bridge, 'session', 'unknown');
    owner(bridge, 'session', 'next');
    let received = false;
    route(bridge, 'session', 'next', () => { received = true; });
    await bridge.drain('session');
    assert.equal(received, true);
});
