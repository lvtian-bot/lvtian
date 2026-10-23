import { getChatListEndOffset } from '../src/utils/chatScrollMetrics';

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
