import { AssistantClient } from '../src/services/AssistantClient';
import { fsService } from '../src/services/FileSystemService';
import { useAssistantStore } from '../src/store/useAssistantStore';
import type { ChatAttachment, ClientMessage } from '../src/types/assistantProtocol';
import i18n from '../src/i18n';

describe('AssistantClient attachment budget across retry hydration', () => {
    const client = AssistantClient.getInstance();
    let sendRaw: jest.SpyInstance;
    beforeEach(() => {
        useAssistantStore.setState({ messages: [], pendingSendQueue: [], taskState: 'idle',
            isServerUpgrading: false, connectionState: 'connected' });
        sendRaw = jest.spyOn(client as unknown as { sendRaw: (message: ClientMessage) => boolean }, 'sendRaw').mockReturnValue(true);
    });
    afterEach(() => { jest.restoreAllMocks(); });

    it('rejects direct oversize encoded sends before changing local messages or queues', () => {
        const attachments: ChatAttachment[] = [{ type: 'file', name: 'escaped.txt', content: '\u0000'.repeat(4 * 1024 * 1024) }];
        expect(() => client.sendMessage('keep me', attachments)).toThrow(i18n.t('chat.attachmentTooLarge'));
        expect(sendRaw).not.toHaveBeenCalled();
        expect(useAssistantStore.getState().messages).toEqual([]);
        expect(useAssistantStore.getState().pendingSendQueue).toEqual([]);
    });

    it.each(['text', 'image'] as const)('checks aggregate %s bytes after reading URI-only queued attachments and advances later messages', async (kind) => {
        const attachments: ChatAttachment[] = [1, 2].map((id) => ({ type: kind === 'image' ? 'image' : 'file',
            name: `${id}.txt`, uri: `file:///${id}`, size: 1 })); // stale persisted sizes cannot lower the budget
        jest.spyOn(fsService, 'readAttachment').mockResolvedValue(kind === 'text'
            ? { content: '\t'.repeat(6 * 1024 * 1024), size: 6 * 1024 * 1024 }
            : { data: 'a'.repeat(11 * 1024 * 1024), size: 8 * 1024 * 1024 });
        useAssistantStore.setState({ pendingSendQueue: [
            { messageId: 'oversize', sessionId: 'main', content: 'original', attachments },
            { messageId: 'later', sessionId: 'main', content: 'next' },
        ] });
        await client.flushPendingSendQueue();
        expect(fsService.readAttachment).toHaveBeenCalledTimes(2);
        expect(sendRaw).toHaveBeenCalledTimes(1);
        expect(sendRaw).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'later' }));
        expect(useAssistantStore.getState().messages).toEqual([expect.objectContaining({
            id: 'oversize', content: 'original', attachments, status: 'error', errorMessage: i18n.t('chat.attachmentTooLarge'),
        })]);
        expect(useAssistantStore.getState().pendingSendQueue.map((item) => item.messageId)).toEqual(['oversize', 'later']);
    });

    it('keeps the same guard for already hydrated queued attachments', async () => {
        const attachments: ChatAttachment[] = [{ type: 'file', name: 'large.txt', content: '\\'.repeat(11 * 1024 * 1024) }];
        const read = jest.spyOn(fsService, 'readAttachment');
        useAssistantStore.setState({ pendingSendQueue: [{ messageId: 'old', sessionId: 'main', content: 'old', attachments }] });
        await client.flushPendingSendQueue();
        expect(read).not.toHaveBeenCalled();
        expect(sendRaw).not.toHaveBeenCalled();
        expect(useAssistantStore.getState().messages[0].status).toBe('error');
    });

    it('does not send a queued attachment whose original file is unavailable', async () => {
        const attachments: ChatAttachment[] = [{ type: 'file', name: 'missing.txt' }];
        useAssistantStore.setState({ pendingSendQueue: [{ messageId: 'missing', sessionId: 'main', content: 'file', attachments }] });
        await client.flushPendingSendQueue();
        expect(sendRaw).not.toHaveBeenCalled();
        expect(useAssistantStore.getState().messages[0]).toMatchObject({ id: 'missing', status: 'error' });
        expect(useAssistantStore.getState().pendingSendQueue[0].messageId).toBe('missing');
    });
});
