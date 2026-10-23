export function getChatListEndOffset(
    contentHeight: number,
    viewportHeight: number,
    bottomInset: number,
): number {
    return Math.max(0, contentHeight - viewportHeight + bottomInset);
}
