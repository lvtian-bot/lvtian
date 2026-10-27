import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeTaskClient, NativeTaskClientError } from '../dist/nativeTaskClient.js';

const options = { origin: 'http://127.0.0.1:49152', bootToken: 'SECRET_BOOT_TOKEN', timeoutMs: 100 };
const ok = value => ({ ok: true, value });
function fixture(overrides = {}) {
  const calls = [];
  let transport;
  let disposeCount = 0;
  const remote = {
    schedule: Object.fromEntries(['catalog', 'list', 'history', 'update', 'delete'].map(name => [name, async (...args) => { calls.push([name, ...args]); return ok(name === 'catalog' ? [] : { name }); }])),
    session: Object.fromEntries(['create', 'prompt', 'projections', 'page'].map(name => [name, async (...args) => { calls.push([name, ...args]); return ok({ name }); }])),
    dispose: async () => { disposeCount++; },
  };
  const fetchCalls = [];
  const dependencies = {
    fetch: async (input, init) => {
      fetchCalls.push([input, init]);
      return new URL(input).pathname === '/connect'
        ? new Response(null, { status: 302, headers: { 'set-cookie': 'dsh_cookie=SECRET_COOKIE; Path=/; HttpOnly' } })
        : new Response('{}', { status: 200 });
    },
    factory: async hooks => { transport = hooks; return remote; },
    ...overrides,
  };
  return { remote, dependencies, calls, fetchCalls, get transport() { return transport; }, get disposeCount() { return disposeCount; } };
}
const safeError = (code, operation, unknown = false) => error => {
  assert.ok(error instanceof NativeTaskClientError);
  assert.equal(error.code, code);
  assert.equal(error.operation, operation);
  assert.equal(error.outcomeUnknown, unknown);
  assert.doesNotMatch(`${error.stack} ${JSON.stringify(error)}`, /SECRET|token=|Cookie=/);
  assert.equal(error.cause, undefined);
  return true;
};

test('official control stream wakes cold reconciliation and aborts without writing tasks', async () => {
  const f = fixture();
  const controller = new AbortController();
  let signals = 0;
  f.remote.session.control = async function* (signal) {
    yield { type: 'baseline', value: { projections: {} } };
    yield { type: 'projection', sessionId: 'owned', key: 'status', value: {}, seq: 12 };
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  };
  const client = await NativeTaskClient.connect(options, f.dependencies);
  const watched = client.watchChanges(() => { if (++signals === 2) queueMicrotask(() => controller.abort()); }, controller.signal);
  await watched;
  assert.equal(signals, 2);
  assert.deepEqual(f.calls.map(call => call[0]), ['catalog']);
  await client.dispose();
});

test('rejects public, ambiguous, credential-bearing and non-origin URLs before I/O', async () => {
  for (const origin of ['https://example.com', 'http://localhost:123', 'http://127.0.0.1.evil', 'http://user:password@127.0.0.1', 'http://127.0.0.1/path', 'http://127.0.0.1?token=SECRET', 'http://127.0.0.1/#SECRET', 'http://2130706433', 'file:///tmp/socket']) {
    const f = fixture();
    await assert.rejects(NativeTaskClient.connect({ ...options, origin }, f.dependencies), safeError('invalid_endpoint', 'connect'));
    assert.equal(f.fetchCalls.length, 0);
  }
});

test('validates token and timeout without echoing input', async () => {
  await assert.rejects(NativeTaskClient.connect({ ...options, bootToken: 'SECRET\n' }), safeError('invalid_token', 'connect'));
  await assert.rejects(NativeTaskClient.connect({ ...options, timeoutMs: 0 }), safeError('invalid_endpoint', 'connect'));
});

test('exchanges token with redirect disabled and probes catalog before ready', async () => {
  const f = fixture();
  const client = await NativeTaskClient.connect(options, f.dependencies);
  const [url, init] = f.fetchCalls[0];
  assert.equal(url.pathname, '/connect');
  assert.equal(url.searchParams.get('token'), options.bootToken);
  assert.equal(url.searchParams.get('interactions'), 'none');
  assert.equal(init.redirect, 'manual');
  assert.equal(f.calls[0][0], 'catalog');
  assert.equal(f.transport.streamBaseUrl, options.origin);
  await client.dispose();
});

test('accepts explicit IPv6 loopback origin', async () => {
  const f = fixture();
  const client = await NativeTaskClient.connect({ ...options, origin: 'http://[::1]:1234' }, f.dependencies);
  await client.dispose();
});

test('rejects unsuccessful or malformed cookie exchange without mounting', async () => {
  for (const response of [new Response(null, { status: 401 }), new Response(null, { status: 302 }), new Response(null, { status: 302, headers: { 'set-cookie': 'invalid' } })]) {
    let mounted = false;
    await assert.rejects(NativeTaskClient.connect(options, { fetch: async () => response, factory: async () => { mounted = true; throw new Error('SECRET'); } }), safeError('authentication_failed', 'connect'));
    assert.equal(mounted, false);
  }
});

test('redacts raw fetch and factory exceptions', async () => {
  await assert.rejects(NativeTaskClient.connect(options, { fetch: async () => { throw new Error('SECRET_BOOT_TOKEN'); } }), safeError('connection_failed', 'connect'));
  const f = fixture({ factory: async () => { throw new Error('SECRET_COOKIE'); } });
  await assert.rejects(NativeTaskClient.connect(options, f.dependencies), safeError('connection_failed', 'connect'));
});

test('fails and disposes if initial catalog returns !ok', async () => {
  const f = fixture();
  f.remote.schedule.catalog = async () => ({ ok: false, error: new Error('SECRET') });
  await assert.rejects(NativeTaskClient.connect(options, f.dependencies), safeError('connection_failed', 'connect'));
  assert.equal(f.disposeCount, 1);
});

test('forwards all narrow methods and unwraps successful results', async () => {
  const f = fixture();
  const client = await NativeTaskClient.connect(options, f.dependencies);
  for (const [method, expected] of [['list', 'list'], ['history', 'history'], ['update', 'update'], ['delete', 'delete'], ['createSession', 'create'], ['prompt', 'prompt'], ['projections', 'projections'], ['page', 'page']]) {
    const request = { sessionId: 'test-session' };
    assert.deepEqual(await client[method](request), { name: expected });
    const call = f.calls.at(-1);
    assert.equal(call[0], expected);
    assert.equal(call[1], request);
  }
  assert.deepEqual(await client.catalog(), []);
  await client.dispose();
});

test('never exposes native !ok payload and never retries writes', async () => {
  const f = fixture();
  const client = await NativeTaskClient.connect(options, f.dependencies);
  let count = 0;
  f.remote.schedule.update = async () => { count++; return { ok: false, error: { message: 'SECRET_COOKIE', details: { token: 'SECRET_BOOT_TOKEN' } } }; };
  await assert.rejects(client.update({}), safeError('remote_failed', 'update', true));
  assert.equal(count, 1);
  await client.dispose();
});

test('thrown RPC failure invalidates connection and marks write outcome unknown', async () => {
  const f = fixture();
  const client = await NativeTaskClient.connect(options, f.dependencies);
  f.remote.session.prompt = async () => { throw new Error('SECRET_COOKIE'); };
  await assert.rejects(client.prompt({}), safeError('connection_failed', 'prompt', true));
  await assert.rejects(client.catalog(), safeError('connection_failed', 'catalog'));
  await client.dispose();
});

test('timeout bounds hung calls, invalidates and does not retry', async () => {
  const f = fixture();
  const client = await NativeTaskClient.connect({ ...options, timeoutMs: 15 }, f.dependencies);
  f.remote.session.create = () => new Promise(() => {});
  await assert.rejects(client.createSession({}), safeError('timeout', 'createSession', true));
  await assert.rejects(client.catalog(), safeError('timeout', 'catalog'));
  await client.dispose();
});

test('timeout disposes a factory that completes after cancellation', async () => {
  const f = fixture();
  let finish;
  f.dependencies.factory = () => new Promise(resolve => { finish = () => resolve(f.remote); });
  await assert.rejects(NativeTaskClient.connect({ ...options, timeoutMs: 10 }, f.dependencies), safeError('timeout', 'connect'));
  finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.disposeCount, 1);
});

test('authenticated transport scopes Cookie to origin and forbids redirect following', async () => {
  const f = fixture();
  const client = await NativeTaskClient.connect(options, f.dependencies);
  await f.transport.fetch('/api', { method: 'POST' });
  const [url, init] = f.fetchCalls.at(-1);
  assert.equal(url.origin, options.origin);
  assert.equal(init.headers.get('cookie'), 'dsh_cookie=SECRET_COOKIE');
  assert.equal(init.redirect, 'manual');
  const before = f.fetchCalls.length;
  await assert.rejects(f.transport.fetch('http://example.com/api'), safeError('connection_failed', 'transport'));
  assert.equal(f.fetchCalls.length, before);
  await client.dispose();
});

test('expired authentication invalidates the instance and erases access', async () => {
  let expired = false;
  const f = fixture({ fetch: async () => expired ? new Response(null, { status: 401 }) : new Response(null, { status: 302, headers: { 'set-cookie': 'dsh_cookie=SECRET_COOKIE' } }) });
  const client = await NativeTaskClient.connect(options, f.dependencies);
  expired = true;
  await assert.rejects(f.transport.fetch('/api'), safeError('authentication_failed', 'transport'));
  await assert.rejects(client.catalog(), safeError('authentication_failed', 'catalog'));
  await client.dispose();
});

test('socket factory receives cookie only for matching WS origin and dispose closes sockets', async () => {
  let closes = 0;
  let args;
  const socket = { readyState: 1, send() {}, close() { closes++; }, addEventListener() {}, removeEventListener() {} };
  const f = fixture({ createWebSocket: (...input) => { args = input; return socket; } });
  const client = await NativeTaskClient.connect(options, f.dependencies);
  assert.equal(f.transport.createWebSocket('ws://127.0.0.1:49152/events'), socket);
  assert.deepEqual(args, ['ws://127.0.0.1:49152/events', 'dsh_cookie=SECRET_COOKIE']);
  assert.throws(() => f.transport.createWebSocket('ws://example.com/events'), safeError('connection_failed', 'transport'));
  await client.dispose();
  await client.dispose();
  assert.equal(closes, 1);
  assert.equal(f.disposeCount, 1);
  await assert.rejects(client.catalog(), safeError('disposed', 'catalog'));
});

test('dispose cancels pending writes and redacts cleanup errors', async () => {
  const f = fixture();
  const client = await NativeTaskClient.connect(options, f.dependencies);
  f.remote.session.prompt = () => new Promise(() => {});
  const pending = assert.rejects(client.prompt({}), safeError('disposed', 'prompt', true));
  await client.dispose();
  await pending;
  const g = fixture();
  const other = await NativeTaskClient.connect(options, g.dependencies);
  g.remote.dispose = async () => { throw new Error('SECRET_COOKIE'); };
  await assert.rejects(other.dispose(), safeError('dispose_failed', 'dispose'));
});
