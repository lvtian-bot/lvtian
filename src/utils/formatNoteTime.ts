import { TFunction } from 'i18next';


/**
 * 将闪念笔记的 "YYYY-MM-DD HH:mm:ss" 时间戳格式化为分层显示：
 * 今天 → HH:mm；昨天 → 昨天 HH:mm；其余 → YYYY-MM-DD HH:mm
 */
export const formatNoteTimestamp = (timestamp: string, t: TFunction): string => {
    const match = timestamp.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (!match) return timestamp;

    const [, y, mo, d, h, mi] = match;
    const noteDate = new Date(Number(y), Number(mo) - 1, Number(d));
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dayDiff = Math.round((startOfToday.getTime() - noteDate.getTime()) / 86400000);
    const hhmm = `${h}:${mi}`;

    if (dayDiff === 0) return hhmm;
    if (dayDiff === 1) return `${t('timeline.yesterday')} ${hhmm}`;
    if (noteDate.getFullYear() === now.getFullYear()) return `${mo}-${d} ${hhmm}`;
    return `${y}-${mo}-${d} ${hhmm}`;
};
