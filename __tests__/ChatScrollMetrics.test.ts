import {
    getChatListEndOffset,
    shouldShowChatScrollBottom,
    getInvertedChatScrollTarget,
    getInvertedDistanceFromBottom,
} from '../src/utils/chatScrollMetrics';

describe('getChatListEndOffset', () => {
    it('includes the effective bottom inset in the target offset', () => {
        expect(getChatListEndOffset(1000, 500, 320)).toBe(820);
    });

    it('uses the ordinary content end when no bottom inset is present', () => {
        expect(getChatListEndOffset(1000, 500, 0)).toBe(500);
    });

    it('clamps the target to the start for short content', () => {
        expect(getChatListEndOffset(200, 500, 0)).toBe(0);
    });
});

describe('getInvertedChatScrollTarget and getInvertedDistanceFromBottom', () => {
    it('Android 端无论键盘是否展开产生 topInset，距底距离仅由真实 offsetY 决定，避免键盘弹起误触回到底部按钮', () => {
        // 键盘弹起产生 320px 的 topInset，但用户仍在最新消息（offsetY = 0）
        expect(getInvertedDistanceFromBottom(0, 320, 'android')).toBe(0);
        // Android 目标滚动位置恒为 0
        expect(getInvertedChatScrollTarget(320, 'android')).toBe(0);

        // 用户往上翻阅历史超过 160px（offsetY = 200）
        expect(getInvertedDistanceFromBottom(200, 320, 'android')).toBe(200);
    });

    it('iOS 键盘展开产生 topInset 时，目标滚动位置补偿为负 inset 并正确计算视口距底距离', () => {
        // 键盘产生了 320px 的 topInset
        expect(getInvertedChatScrollTarget(320, 'ios')).toBe(-320);
        // 当前正处于最新消息（iOS 原生 contentOffset.y 为 -320）
        expect(getInvertedDistanceFromBottom(-320, 320, 'ios')).toBe(0);
        // 用户往上翻阅历史到了 contentOffset.y 为 50
        expect(getInvertedDistanceFromBottom(50, 320, 'ios')).toBe(370);
    });
});

describe('scroll-to-bottom visibility', () => {
    it('ignores keyboard and programmatic movement', () => {
        expect(shouldShowChatScrollBottom(false, 340, false, 0)).toBe(false);
    });
    it('requires an intentional history drag beyond 100 logical pixels', () => {
        expect(shouldShowChatScrollBottom(false, 380, true, 320)).toBe(false);
        expect(shouldShowChatScrollBottom(false, 100, true, 0)).toBe(false);
        expect(shouldShowChatScrollBottom(false, 421, true, 320)).toBe(true);
    });
    it('retains the button during layout changes while reading history', () => {
        expect(shouldShowChatScrollBottom(true, 200, false, 0)).toBe(true);
    });
    it('hides near the latest messages and avoids boundary flicker', () => {
        expect(shouldShowChatScrollBottom(true, 32, false, 0)).toBe(false);
        expect(shouldShowChatScrollBottom(true, 80, true, 200)).toBe(true);
    });
});
