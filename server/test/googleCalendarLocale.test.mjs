import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleGoogleCalendarCallback } from '../dist/googleCalendarHttp.js';

const cases = [
    ['zh-CN, en;q=0.8', 'zh', '请返回绿天 App 查看连接状态。'],
    ['zh;q=0.4, en-US;q=0.9', 'en', 'Return to Lvtian to check the connection status.'],
    ['fr, zh;q=0', 'en', 'Return to Lvtian to check the connection status.'],
    [undefined, 'en', 'Return to Lvtian to check the connection status.'],
];
for (const [preference, language, text] of cases) {
    test(`callback uses ${language} for ${preference ?? 'missing language header'}`, async () => {
        const headers = new Map();
        let status, body;
        await handleGoogleCalendarCallback({ method: 'GET', url: '/oauth/google-calendar/callback',
            socket: { remoteAddress: '127.0.0.1' }, headers: {
                host: 'example.com', 'x-forwarded-proto': 'https', 'accept-language': preference,
            } }, {
            setHeader: (key, value) => headers.set(key, value),
            writeHead: value => { status = value; }, end: value => { body = value; },
        }, { redirectUri: 'https://example.com/oauth/google-calendar/callback' }, false);
        assert.equal(status, 200);
        assert.equal(headers.get('Content-Language'), language);
        assert.equal(headers.get('Vary'), 'Accept-Language');
        assert.equal(headers.get('Cache-Control'), 'no-store');
        assert.equal(body, text);
    });
}
