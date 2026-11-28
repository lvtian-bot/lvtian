import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CHAT_NOTIFICATION_CHANNEL, ChatSyncPush, readSystemNotification } from '../dist/chatSyncPush.js';

function setupPush(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvtian-chat-sync-push-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const sent = [];
    const sender = {
        sendEachForMulticast: async message => {
            sent.push(message);
            return { responses: message.tokens.map(() => ({ success: true })), failureCount: 0 };
        },
    };
    return { dir, sent, sender, push: new ChatSyncPush(dir, sender) };
}

async function flushMicrotasks() {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

test('readSystemNotification validates preview flag and channel whitelist', () => {
    const routeId = 'ab'.repeat(16);
    assert.deepEqual(readSystemNotification({
        routeId,
        language: 'zh',
        scope: 'chat',
        preview: true,
        channelId: CHAT_NOTIFICATION_CHANNEL,
    }), {
        routeId,
        language: 'zh',
        scope: 'chat',
        preview: true,
        channelId: CHAT_NOTIFICATION_CHANNEL,
    });

    assert.deepEqual(readSystemNotification({
        routeId,
        language: 'en',
        scope: 'chat',
        preview: 'yes',
        channelId: 'untrusted-channel',
    }), {
        routeId,
        language: 'en',
        scope: 'chat',
        preview: undefined,
        channelId: undefined,
    });
});

test('sends formatted 110-char preview on standard channel when enabled and falls back cleanly otherwise', async t => {
    const { dir, sent, sender, push } = setupPush(t);
    const previewDevice = 'test-fcm:preview-enabled-token-123456';
    const hiddenDevice = 'test-fcm:preview-disabled-token-123456';
    const legacyDevice = 'test-fcm:legacy-client-token-1234567';

    push.register(previewDevice, readSystemNotification({
        routeId: '11'.repeat(16),
        language: 'zh',
        scope: 'chat',
        preview: true,
        channelId: CHAT_NOTIFICATION_CHANNEL,
    }));
    push.register(hiddenDevice, readSystemNotification({
        routeId: '22'.repeat(16),
        language: 'zh',
        scope: 'chat',
        preview: false,
        channelId: CHAT_NOTIFICATION_CHANNEL,
    }));
    push.register(legacyDevice, readSystemNotification({
        routeId: '33'.repeat(16),
        language: 'zh',
        scope: 'chat',
    }));

    const longContent = '# 周报标题\n\n' + '甲'.repeat(120);
    const reloaded = new ChatSyncPush(dir, sender);
    reloaded.wakeDevices('msg-1', { kind: 'chat', content: longContent });
    await flushMicrotasks();

    assert.equal(sent.length, 4);
    assert.deepEqual(sent[0].tokens, [previewDevice]);
    assert.deepEqual(sent[0].notification, { title: '绿天', body: '周报标题 ' + '甲'.repeat(105) + '…' });
    assert.equal(sent[0].android.notification.channelId, CHAT_NOTIFICATION_CHANNEL);
    assert.equal(sent[0].android.notification.visibility, undefined);

    assert.deepEqual(sent[1].tokens, [hiddenDevice]);
    assert.deepEqual(sent[1].notification, { title: '绿天', body: '你有一条新消息' });
    assert.equal(sent[1].android.notification.channelId, CHAT_NOTIFICATION_CHANNEL);
    assert.equal(sent[1].android.notification.visibility, undefined);

    assert.deepEqual(sent[2].tokens, [legacyDevice]);
    assert.deepEqual(sent[2].notification, { title: '绿天', body: '你有一条新消息' });
    assert.equal(sent[2].android.notification.channelId, 'chat-messages');
    assert.equal(sent[2].android.notification.visibility, undefined);
});
