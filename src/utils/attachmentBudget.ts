import type { ChatAttachment } from '../types/assistantProtocol';

export const ATTACHMENT_ENCODED_BUDGET = 20 * 1024 * 1024;

/** Count the actual JSON payload, including metadata, escaping and array separators.
 * Do not depend on TextEncoder/Buffer being available in the native runtime.
 */
export function getSerializedAttachmentBytes(attachments: readonly ChatAttachment[]): number {
    const json = JSON.stringify(attachments);
    let bytes = 0;
    for (let i = 0; i < json.length; i++) {
        const code = json.charCodeAt(i);
        if (code < 0x80) bytes++;
        else if (code < 0x800) bytes += 2;
        else if (code >= 0xd800 && code <= 0xdbff &&
            json.charCodeAt(i + 1) >= 0xdc00 && json.charCodeAt(i + 1) <= 0xdfff) {
            bytes += 4;
            i++;
        } else bytes += 3;
    }
    return bytes;
}

export function isAttachmentBudgetExceeded(attachments: readonly ChatAttachment[] | undefined): boolean {
    return Boolean(attachments?.length && getSerializedAttachmentBytes(attachments) > ATTACHMENT_ENCODED_BUDGET);
}
