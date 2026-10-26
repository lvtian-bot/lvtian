import type { TFunction } from 'i18next';
import type { AutomaticTask, AutomaticTaskResult } from '../types/automaticTasks';

/** Display only: never compute a new execution target or reinterpret a saved wall-clock rule. */
export function taskDateTime(value: string, language: string, timeZone?: string): string {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '—';
    try {
        return new Intl.DateTimeFormat(language, {
            year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
            hourCycle: 'h23', ...(timeZone ? { timeZone } : {}),
        }).format(date);
    } catch {
        // Invalid/unsupported saved zone: explicitly identify the fallback, not the original zone.
        return `${date.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '')} UTC`;
    }
}

export function taskTimeZone(task: AutomaticTask): string | undefined {
    return 'timeZone' in task ? task.timeZone : undefined;
}

export function taskZoneLabel(task: AutomaticTask, language: string): string {
    const timeZone = taskTimeZone(task);
    try {
        return new Intl.DateTimeFormat(language, { timeZone, timeZoneName: 'longGeneric' })
            .formatToParts(new Date(task.scheduledAt)).find(part => part.type === 'timeZoneName')?.value ?? timeZone ?? 'UTC';
    } catch { return timeZone ?? 'UTC'; }
}

export function taskFrequency(task: AutomaticTask, t: TFunction): string {
    switch (task.kind) {
        case 'at': case 'after': return t('automaticTasks.ruleAt');
        case 'every': {
            if (task.everySeconds % 3600 === 0) return t('automaticTasks.ruleEveryHours', { count: task.everySeconds / 3600 });
            if (task.everySeconds % 60 === 0) return t('automaticTasks.ruleEveryMinutes', { count: task.everySeconds / 60 });
            return t('automaticTasks.ruleEvery', { seconds: task.everySeconds });
        }
        case 'daily': return t('automaticTasks.ruleDaily', { time: task.time });
        case 'weekly': return t('automaticTasks.ruleWeekly', {
            time: task.time,
            days: [...task.weekdays].sort((a, b) => a - b).map(day => t(`automaticTasks.weekday${day}`)).join(t('automaticTasks.separator')),
        });
        case 'cron': return t('automaticTasks.ruleCustom');
    }
}

export function taskResultStatus(result: AutomaticTaskResult): string {
    if (result.status === 'not_delivered') return 'notDelivered';
    if (result.status !== 'ended') return 'unknown';
    if (result.endReason === 'completed') return 'completed';
    if (result.endReason === 'failed' || result.endReason === 'error') return 'failed';
    return 'ended';
}
