export const colors = {
    primary: '#0066FF', // Vibrant Blue
    secondary: '#6C757D',
    success: '#28A745',
    danger: '#DC3545',
    warning: '#FFC107',
    info: '#17A2B8',
    light: '#F8F9FA',
    dark: '#343A40',
    white: '#FFFFFF',
    black: '#000000',
    background: '#F0F2F5',
    surface: '#FFFFFF',
    text: '#212529',
    textSecondary: '#6C757D',
    border: '#DEE2E6',
    orange: '#FD7E14', // For unsynced files
};

export const spacing = {
    xs: 4,
    s: 8,
    m: 16,
    l: 24,
    xl: 32,
    xxl: 48,
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
    typography,
};
