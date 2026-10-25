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

/** Only an intentional history drag can reveal the button; layout events cannot. */
export function shouldShowChatScrollBottom(
    visible: boolean,
    distance: number,
    isDragging: boolean,
    dragStartDistance: number,
): boolean {
    if (distance <= 32) return false;
    if (visible) return true;
    return isDragging && distance > 100 && distance - dragStartDistance > 100;
}
