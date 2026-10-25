import { getFontSizeMetrics, FONT_SIZE_METRICS } from '../src/utils/fontSize';
import { useSettingsStore } from '../src/store/useSettingsStore';

describe('FontSize & Settings', () => {
    beforeEach(() => {
        useSettingsStore.setState({
            fontSize: 'standard',
            markdownTheme: 'default',
        });
    });

    test('getFontSizeMetrics returns correct values for small, standard and large', () => {
        const smallMetrics = getFontSizeMetrics('small');
        expect(smallMetrics.chatBody).toBe(14);
        expect(smallMetrics.chatInput).toBe(14);
        expect(smallMetrics.flashBody).toBe(14);
        expect(smallMetrics.editorFontSize).toBe(14);
        expect(smallMetrics.scale).toBe(0.88);

        const standardMetrics = getFontSizeMetrics('standard');
        expect(standardMetrics.chatBody).toBe(16);
        expect(standardMetrics.chatInput).toBe(16);
        expect(standardMetrics.flashBody).toBe(16);
        expect(standardMetrics.editorFontSize).toBe(16);
        expect(standardMetrics.scale).toBe(1.0);

        const largeMetrics = getFontSizeMetrics('large');
        expect(largeMetrics.chatBody).toBe(18);
        expect(largeMetrics.chatInput).toBe(18);
        expect(largeMetrics.flashBody).toBe(18);
        expect(largeMetrics.editorFontSize).toBe(18);
        expect(largeMetrics.scale).toBe(1.13);
    });

    test('getFontSizeMetrics defaults to standard for undefined or invalid inputs', () => {
        const fallback = getFontSizeMetrics(undefined);
        expect(fallback).toEqual(FONT_SIZE_METRICS.standard);

        // @ts-expect-error testing invalid input fallback
        const invalidFallback = getFontSizeMetrics('non-existent');
        expect(invalidFallback).toEqual(FONT_SIZE_METRICS.standard);
    });

    test('useSettingsStore correctly updates fontSize state', () => {
        expect(useSettingsStore.getState().fontSize).toBe('standard');

        useSettingsStore.getState().setFontSize('large');
        expect(useSettingsStore.getState().fontSize).toBe('large');

        useSettingsStore.getState().setFontSize('small');
        expect(useSettingsStore.getState().fontSize).toBe('small');
    });
});
