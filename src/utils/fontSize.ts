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
        chatBody: 15,
        chatLineHeight: 22,
        chatHeading1: 18,
        chatHeading2: 16,
        chatHeading3: 15,
        chatCode: 13,
        chatInput: 15,
        flashBody: 16,
        flashLineHeight: 22,
        editorFontSize: 15,
        scale: 1.0,
    },
    standard: {
        chatBody: 17,
        chatLineHeight: 25,
        chatHeading1: 20,
        chatHeading2: 18,
        chatHeading3: 17,
        chatCode: 14,
        chatInput: 16,
        flashBody: 18,
        flashLineHeight: 25,
        editorFontSize: 17,
        scale: 1.13,
    },
    large: {
        chatBody: 19,
        chatLineHeight: 28,
        chatHeading1: 22,
        chatHeading2: 20,
        chatHeading3: 19,
        chatCode: 15,
        chatInput: 18,
        flashBody: 20,
        flashLineHeight: 28,
        editorFontSize: 19,
        scale: 1.27,
    },
};

export const getFontSizeMetrics = (preference?: FontSizePreference): FontSizeMetrics => {
    return FONT_SIZE_METRICS[preference || 'standard'] || FONT_SIZE_METRICS.standard;
};
