import { getFontSizeMetrics, type FontSizeMetrics } from '../../utils/fontSize';
import { useSettingsStore } from '../../store/useSettingsStore';

/**
 * 设置页组件的字号来源：跟随「App 设置 → 字体大小」档位，
 * 主文字取档位正文（默认 16），辅助小字由各组件固定，不随档位缩放。
 */
export const useSettingsFont = (): FontSizeMetrics =>
    getFontSizeMetrics(useSettingsStore((state) => state.fontSize));
