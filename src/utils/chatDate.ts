import type { TFunction } from 'i18next';

export function localDayKey(timestamp: number): string | null {
    const date = new Date(timestamp);
    return Number.isFinite(date.getTime())
        ? `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}` : null;
}

export function startsChatDay(timestamp: number, previous?: number): boolean {
    const day = localDayKey(timestamp);
    return day !== null && (previous === undefined || day !== localDayKey(previous));
}

export function formatChatDate(timestamp: number, now: number, locale: string, t: TFunction): string {
    const day = localDayKey(timestamp);
    if (!day) return '';
    if (day === localDayKey(now)) return t('assistant.dateToday');
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    if (day === localDayKey(yesterday.getTime())) return t('assistant.dateYesterday');
    return new Date(timestamp).toLocaleDateString(locale, {
        ...(new Date(timestamp).getFullYear() !== new Date(now).getFullYear() ? { year: 'numeric' as const } : {}),
        month: 'long', day: 'numeric',
    });
}

export function formatChatTime(timestamp: number, locale?: string): string {
    return localDayKey(timestamp) === null ? '' : new Date(timestamp).toLocaleTimeString(locale, {
        hour: '2-digit', minute: '2-digit', hour12: false,
    });
}

/** Rich blocks retain Markdown rendering and get a separate, safe footer row. */
export function isPlainChatText(text: string): boolean {
    return !/[`*_[\]<>~|\\]|^\s*(?:#{1,6}\s|[-+]\s|\d+[.)]\s|[-=]{3,}\s*$)/m.test(text);
}
