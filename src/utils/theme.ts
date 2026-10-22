export const colors = {
    background: '#F5F5F7',
    surface: '#FFFFFF',
    primary: '#3B82F6',
    primaryLight: '#DBEAFE',
    primaryDark: '#2563EB',
    secondary: '#FF9F1C',
    text: '#1F2933',
    textSecondary: '#6B7280',
    mutedText: '#6B7280',
    border: '#E5E7EB',
    divider: '#EBEBEB',
    skeleton: '#F0F0F0',
    inputBg: '#F3F4F6',
    danger: '#EF4444',
    dangerStrong: '#D32F2F',
    dangerBg: '#FFEBEE',
    dangerText: '#C62828',
    error: '#EF4444',
    success: '#10B981',
    successBg: '#E8F5E9',
    successText: '#2E7D32',
    successBorder: '#C8E6C9',
    warning: '#FFC107',
    warnBg: '#FFF8E1',
    warnBgStrong: '#FFF3E0',
    warnText: '#E65100',
    warnBorder: '#FFE0B2',
    info: '#17A2B8',
    white: '#FFFFFF',
    black: '#000000',
    orange: '#FF9F1C',
};

export const spacing = {
    xs: 4,
    sm: 8,
    s: 8,  // Keep for backward compatibility
    md: 16,
    m: 16, // Keep for backward compatibility
    lg: 24,
    l: 24, // Keep for backward compatibility
    xl: 32,
    xxl: 48,
};

export const radius = {
    sm: 8,
    md: 16,
    lg: 24,
};

export const typography = {
    h1: { fontSize: 32, fontWeight: 'bold' },
    h2: { fontSize: 24, fontWeight: 'bold' },
    h3: { fontSize: 20, fontWeight: 'bold' },
    body: { fontSize: 16 },
    caption: { fontSize: 12, color: colors.textSecondary },
};

export const theme = {
    colors,
    spacing,
    radius,
    typography,
};
