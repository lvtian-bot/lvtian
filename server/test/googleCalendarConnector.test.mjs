import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { GoogleCalendarConnector } from '../dist/googleCalendarConnector.js';
import { loadGoogleCalendarConfig } from '../dist/googleCalendarConfig.js';

const redirectUri = 'https://example.com/oauth/google-calendar/callback';
const state = 'a'.repeat(43);
const scopes = 'openid email https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/calendar.readonly';

async function fixture(t) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lvtian-calendar-test-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const config = { dir, gogPath: process.execPath, redirectUri, account: 'calendar@example.com',
        clientId: 'test.apps.googleusercontent.com', clientSecret: 'fixture-not-a-secret', keyringPassword: 'fixture-only-'.repeat(3) };
    let verify = 0;
    let exchanges = 0;
    let extraScope = '';
    const connector = new GoogleCalendarConnector(config, async ({ cwd, env, args, input }) => {
        assert.equal(env.HOME, cwd);
        assert.ok(cwd.startsWith(dir + path.sep));
        assert.equal(env.GOG_ACCOUNT, undefined);
        assert.ok(args.includes('--readonly'));
        assert.ok(args.includes('--client=lvtian-calendar'));
        if (args.includes('credentials')) {
            assert.ok(input.includes('fixture-not-a-secret'));
            assert.ok(!args.some(a => a.includes('fixture-not-a-secret')));
        }
        if (args.includes('--step=1')) {
            const params = new URLSearchParams({ client_id: config.clientId, redirect_uri: redirectUri, response_type: 'code', access_type: 'offline', prompt: 'consent', scope: scopes + extraScope, state, code_challenge_method: 'S256', code_challenge: 'b'.repeat(43) });
            return { code: 0, stdout: JSON.stringify({ auth_url: `https://accounts.google.com/o/oauth2/auth?${params}`, state_reused: false }) };
        }
        if (args.includes('--step=2')) exchanges += 1;
        return { code: args.includes('calendars') ? verify : 0 };
    });
    return { connector, config, setVerify: v => { verify = v; }, exchanges: () => exchanges, extraScope: s => { extraScope = s; } };
}

test('connect verifies backend, consumes state once, and disconnect discards connection', async t => {
    const { connector, exchanges, setVerify } = await fixture(t);
    assert.deepEqual(await connector.status(), { status: 'disconnected' });
    const started = await connector.connect();
    assert.equal(new URL(started.authorizationUrl).searchParams.get('scope'), scopes);
    assert.deepEqual(await connector.status(), { status: 'authorizing' });
    assert.equal(await connector.callback('z'.repeat(43), 'synthetic-code'), false);
    assert.equal(await connector.callback(state, 'synthetic-code'), true);
    assert.equal(await connector.callback(state, 'synthetic-code'), false);
    assert.equal(exchanges(), 1);
    assert.deepEqual(await connector.status(), { status: 'connected', account: 'calendar@example.com' });
    setVerify(4);
    assert.equal((await connector.status()).status, 'needs_reauth');
    assert.deepEqual(await connector.disconnect(), { status: 'disconnected' });
    assert.deepEqual(await connector.status(), { status: 'disconnected' });
});

test('rejects an extra scope and preserves a verified connection when consent is declined', async t => {
    const { connector, extraScope } = await fixture(t);
    extraScope(' https://www.googleapis.com/auth/calendar');
    await assert.rejects(connector.connect(), /connector_operation_failed/);
    extraScope('');
    await connector.connect();
    assert.equal(await connector.callback(state, 'synthetic-code'), true);
    await connector.connect();
    assert.equal(await connector.callback(state), false);
    assert.equal((await connector.status()).status, 'connected');
});

test('credentials cannot be configured within the file browser root', { skip: !process.getuid }, async t => {
    const { config } = await fixture(t);
    const { dir, ...json } = config;
    const file = path.join(dir, 'runtime.json');
    await fs.writeFile(file, JSON.stringify(json), { mode: 0o600 });
    assert.equal(loadGoogleCalendarConfig(dir, [path.dirname(dir)]), undefined);
    assert.equal(loadGoogleCalendarConfig(dir, [] )?.account, config.account);
    await fs.chmod(file, 0o644);
    assert.equal(loadGoogleCalendarConfig(dir, []), undefined);
});
