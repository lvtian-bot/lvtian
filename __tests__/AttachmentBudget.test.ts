import type { ChatAttachment } from '../src/types/assistantProtocol';
import { ATTACHMENT_ENCODED_BUDGET, getSerializedAttachmentBytes, isAttachmentBudgetExceeded } from '../src/utils/attachmentBudget';

describe('serialized attachment UTF-8 budget', () => {
    it.each(['\t\\\n\r\b\f\u0000"', '中文附件', '😀𠮷', '\ud800'])('counts JSON escaping and UTF-8 exactly: %p', (content) => {
        const attachments: ChatAttachment[] = [{ type: 'file', name: '中文\\".txt', uri: 'file:///测试', content }];
        expect(getSerializedAttachmentBytes(attachments)).toBe(Buffer.byteLength(JSON.stringify(attachments), 'utf8'));
    });

    it('includes metadata and array separators at the 20MiB boundary', () => {
        const attachments: ChatAttachment[] = [{ type: 'image', name: 'a', data: '' }, { type: 'file', name: 'b', content: '' }];
        attachments[0].data = 'a'.repeat(ATTACHMENT_ENCODED_BUDGET - getSerializedAttachmentBytes(attachments));
        expect(getSerializedAttachmentBytes(attachments)).toBe(ATTACHMENT_ENCODED_BUDGET);
        expect(isAttachmentBudgetExceeded(attachments)).toBe(false);
        attachments[1].content = '中';
        expect(isAttachmentBudgetExceeded(attachments)).toBe(true);
    });
});
