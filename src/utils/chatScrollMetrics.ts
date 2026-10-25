import { Platform } from 'react-native';

export function getChatListEndOffset(
    contentHeight: number,
    viewportHeight: number,
    bottomInset: number,
): number {
    return Math.max(0, contentHeight - viewportHeight + bottomInset);
}

export function getInvertedChatScrollTarget(topInset = 0, platform: string = Platform.OS): number {
    if (platform === 'android') {
        return 0;
    }
    const inset = Math.max(0, topInset);
    return inset === 0 ? 0 : -inset;
}

export function getInvertedDistanceFromBottom(offsetY: number, topInset = 0, platform: string = Platform.OS): number {
    if (platform === 'android') {
        return Math.max(0, offsetY);
    }
    return offsetY + Math.max(0, topInset);
}
