import { FontSizePreference } from '../store/useSettingsStore';

export interface FontSizeMetrics {
    /** 对话区正文 (Markdown & Bubble) */
    chatBody: number;
    /** 对话区行高 */
    chatLineHeight: number;
    /** 对话区一级标题 */
    chatHeading1: number;
    /** 对话区二级标题 */
    chatHeading2: number;
    /** 对话区三级标题 */
    chatHeading3: number;
    /** 对话区内联代码 & 代码块 */
    chatCode: number;
    /** 底部输入框字号 */
    chatInput: number;
    /** 闪念列表卡片正文 */
    flashBody: number;
    /** 闪念正文行高 */
    flashLineHeight: number;
    /** CodeMirror 6 嵌入式编辑器字号 */
    editorFontSize: number;
    /** 比例系数 */
    scale: number;
}

export const FONT_SIZE_METRICS: Record<FontSizePreference, FontSizeMetrics> = {
    small: {
        chatBody: 14,
        chatLineHeight: 20,
        chatHeading1: 18,
        chatHeading2: 16,
        chatHeading3: 15,
        chatCode: 12,
        chatInput: 14,
        flashBody: 14,
        flashLineHeight: 20,
        editorFontSize: 14,
        scale: 0.88,
    },
    standard: {
        chatBody: 16,
        chatLineHeight: 24,
        chatHeading1: 20,
        chatHeading2: 18,
        chatHeading3: 16,
        chatCode: 13,
        chatInput: 16,
        flashBody: 16,
        flashLineHeight: 24,
        editorFontSize: 16,
        scale: 1.0,
    },
    large: {
        chatBody: 18,
        chatLineHeight: 26,
        chatHeading1: 22,
        chatHeading2: 20,
        chatHeading3: 18,
        chatCode: 15,
        chatInput: 18,
        flashBody: 18,
        flashLineHeight: 26,
        editorFontSize: 18,
        scale: 1.13,
    },
};

export const getFontSizeMetrics = (preference?: FontSizePreference): FontSizeMetrics => {
    return FONT_SIZE_METRICS[preference || 'standard'] || FONT_SIZE_METRICS.standard;
};

/** 全 App 辅助字号；正文与标题字号由 FontSizeMetrics 按字体档位动态提供 */
export const auxFontSizes = {
    badge: 10,
    caption: 12,
    secondary: 13,
} as const;
