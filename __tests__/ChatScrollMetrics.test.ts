import {
    getChatListEndOffset,
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
    it('无键盘/Android 端 topInset 为 0 时回到偏移量 0', () => {
        expect(getInvertedChatScrollTarget(0)).toBe(0);
        expect(getInvertedDistanceFromBottom(0, 0)).toBe(0);
        expect(getInvertedDistanceFromBottom(200, 0)).toBe(200);
    });

    it('iOS 键盘展开产生 topInset 时，目标滚动位置补偿为负 inset 并正确计算视口距底距离', () => {
        // 键盘产生了 320px 的 topInset
        expect(getInvertedChatScrollTarget(320)).toBe(-320);
        // 当前正处于最新消息（iOS 原生 contentOffset.y 为 -320）
        expect(getInvertedDistanceFromBottom(-320, 320)).toBe(0);
        // 用户往上翻阅历史到了 contentOffset.y 为 50
        expect(getInvertedDistanceFromBottom(50, 320)).toBe(370);
    });
});
