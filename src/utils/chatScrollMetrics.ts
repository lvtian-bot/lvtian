export function getChatListEndOffset(
    contentHeight: number,
    viewportHeight: number,
    bottomInset: number,
): number {
    return Math.max(0, contentHeight - viewportHeight + bottomInset);
}

export function getInvertedChatScrollTarget(topInset = 0): number {
    const inset = Math.max(0, topInset);
    return inset === 0 ? 0 : -inset;
}

export function getInvertedDistanceFromBottom(offsetY: number, topInset = 0): number {
    return offsetY + Math.max(0, topInset);
}
