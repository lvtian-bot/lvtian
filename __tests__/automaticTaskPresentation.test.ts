import i18next from 'i18next';
import zh from '../src/locales/zh.json';
import en from '../src/locales/en.json';
import { taskDateTime, taskFrequency, taskResultStatus, taskTimeZone } from '../src/utils/automaticTaskPresentation';
import type { AutomaticTask, AutomaticTaskResult } from '../src/types/automaticTasks';

const base = { id: 'task', sessionId: 'session', title: 'Task', prompt: 'Instruction', status: 'active' as const, scheduledAt: '2026-11-01T06:30:00Z' };
const i18n = i18next.createInstance();
beforeAll(async () => { await i18n.init({ lng: 'zh-CN', fallbackLng: 'zh', resources: { zh: { translation: zh }, en: { translation: en } } }); });

describe('automatic task presentation', () => {
    it('formats the saved instant in the explicit zone across DST overlap without rescheduling', () => {
        const early = taskDateTime('2026-11-01T05:30:00Z', 'en-US', 'America/New_York');
        const late = taskDateTime('2026-11-01T06:30:00Z', 'en-US', 'America/New_York');
        expect(early).toBe(late);
        expect(late).toContain('01:30');
        expect(taskDateTime('2026-11-01T06:30:00Z', 'en-US', 'Asia/Shanghai')).toContain('14:30');
    });
    it('uses locale date conventions, rejects invalid dates and labels invalid-zone fallback UTC', () => {
        const value = base.scheduledAt;
        expect(taskDateTime(value, 'zh-CN', 'UTC')).toContain('2026年');
        expect(taskDateTime(value, 'en-US', 'UTC')).toContain('Nov');
        expect(taskDateTime('invalid', 'zh-CN')).toBe('—');
        expect(taskDateTime(value, 'en-US', 'Invalid/Zone')).toBe('2026-11-01 06:30:00 UTC');
    });
    it('sorts weekly ISO weekdays without mutating source and preserves stored clock precision', () => {
        const weekdays = [7, 1, 5];
        const task: AutomaticTask = { ...base, kind: 'weekly', time: '09:00:01.250', timeZone: 'Asia/Shanghai', weekdays };
        expect(taskFrequency(task, i18n.getFixedT('zh-CN'))).toBe('每周 周一、周五、周日 09:00:01.250');
        expect(weekdays).toEqual([7, 1, 5]);
        expect(taskTimeZone(task)).toBe('Asia/Shanghai');
        expect(taskTimeZone({ ...base, kind: 'at' })).toBeUndefined();
    });
    it('renders elapsed intervals with real plural-aware translations', () => {
        expect(taskFrequency({ ...base, kind: 'every', everySeconds: 3600 }, i18n.getFixedT('en'))).toBe('Every 1 hour');
        expect(taskFrequency({ ...base, kind: 'every', everySeconds: 7200 }, i18n.getFixedT('en'))).toBe('Every 2 hours');
        expect(taskFrequency({ ...base, kind: 'every', everySeconds: 7200 }, i18n.getFixedT('zh'))).toBe('每 2 小时');
        expect(taskFrequency({ ...base, kind: 'every', everySeconds: 120 }, i18n.getFixedT('zh'))).toBe('每 2 分钟');
        expect(taskFrequency({ ...base, kind: 'every', everySeconds: 61 }, i18n.getFixedT('zh'))).toBe('每 61 秒');
    });
    it.each([
        ['ended', 'completed', 'completed'], ['ended', 'failed', 'failed'], ['ended', 'error', 'failed'],
        ['ended', 'cancelled', 'ended'], ['ended', undefined, 'ended'], ['unknown', 'completed', 'unknown'],
        ['running', 'completed', 'unknown'], ['not_delivered', 'completed', 'notDelivered'],
    ] as const)('maps only actual terminal evidence: %s / %s', (status, endReason, expected) => {
        const result: AutomaticTaskResult = { taskId: base.id, status, endReason, assistantText: [], truncated: false };
        expect(taskResultStatus(result)).toBe(expected);
    });
});
