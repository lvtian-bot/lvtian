import { colors, theme } from '../src/utils/theme';

describe('应用主题配色', () => {
    it('保留原有主蓝色及其浅色、深色层次', () => {
        expect({
            primary: theme.colors.primary,
            primaryLight: theme.colors.primaryLight,
            primaryDark: theme.colors.primaryDark,
        }).toEqual({
            primary: '#60A5FA',
            primaryLight: '#EBF5FF',
            primaryDark: '#3B82F6',
        });
        expect(theme.colors).toBe(colors);
    });
});
