import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { automaticTaskService as service, AutomaticTaskError } from '../services/AutomaticTaskService';
import type { AutomaticTask, AutomaticTaskDelivery, AutomaticTaskHistory, AutomaticTaskResult } from '../types/automaticTasks';
import { useSettingsStore } from '../store/useSettingsStore';
import { getFontSizeMetrics } from '../utils/fontSize';
import { taskDateTime, taskFrequency, taskResultStatus, taskTimeZone } from '../utils/automaticTaskPresentation';
import { theme } from '../utils/theme';

type HistoryPage = Exclude<AutomaticTaskHistory, { code: string }>;
type Receipt = AutomaticTaskDelivery & { readonly prompt?: string };

function ActivityRow({ task, receipt, latest, revision }: { task: AutomaticTask; receipt: Receipt; latest: boolean; revision: number }) {
    const { t, i18n } = useTranslation();
    const metrics = getFontSizeMetrics(useSettingsStore(state => state.fontSize));
    const body = { fontSize: metrics.flashBody, lineHeight: metrics.flashLineHeight };
    const [result, setResult] = useState<AutomaticTaskResult>();
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string>();
    const [expanded, setExpanded] = useState(false);
    const request = useRef<AbortController | undefined>(undefined);
    const requested = useRef(false);
    const load = useCallback(async () => {
        requested.current = true;
        request.current?.abort();
        const controller = new AbortController();
        request.current = controller;
        setLoading(true); setError(undefined);
        try {
            const response = await service.getResult(task.id, { signal: controller.signal, messageId: receipt.messageId });
            if (controller.signal.aborted) return;
            if (response.generation !== service.generation) throw new AutomaticTaskError('connection_changed');
            setResult(response.result);
        } catch (failure: unknown) {
            if (!controller.signal.aborted) setError(failure instanceof AutomaticTaskError && failure.code === 'not_found'
                ? 'automaticTasks.resultUnavailable' : 'automaticTasks.resultFailed');
        } finally {
            if (!controller.signal.aborted) setLoading(false);
        }
    }, [task.id, receipt.messageId]);
    useEffect(() => {
        if (latest || requested.current) load();
        return () => { request.current?.abort(); };
    }, [latest, load, revision]);
    const status = result ? taskResultStatus(result) : 'triggered';
    const text = result?.assistantText.filter(part => part.trim()).join('\n\n');
    return <View style={styles.event}>
        <View style={styles.track} accessible={false}>
            <View style={[styles.dot, status === 'completed' && styles.successDot, status === 'failed' && styles.failedDot]} />
            <View style={styles.line} />
        </View>
        <View style={styles.eventBody}>
            <Text style={[body, styles.eventTitle]}>{t(`automaticTasks.${status}`)}</Text>
            <Text style={[body, styles.secondary]}>{taskDateTime(receipt.deliveredAt, i18n.language, taskTimeZone(task))}</Text>
            {receipt.prompt !== undefined && receipt.prompt !== task.prompt && <View style={styles.savedInstruction}>
                <Text style={[body, styles.secondary]}>{t('automaticTasks.savedInstruction')}</Text>
                <Text selectable style={[body, styles.text]}>{receipt.prompt}</Text>
            </View>}
            {loading && <ActivityIndicator accessibilityLabel={t('automaticTasks.loadingResult')} color={theme.colors.primaryDark} />}
            {error && <Text accessibilityRole="alert" style={[body, styles.secondary]}>{t(error)}</Text>}
            {!!text && <Text selectable={expanded} numberOfLines={expanded ? undefined : 3} style={[body, styles.text]}>{text}</Text>}
            {result && !text && <Text style={[body, styles.secondary]}>{t('automaticTasks.noResultText')}</Text>}
            {result?.truncated && <Text style={[body, styles.secondary]}>{t('automaticTasks.truncated')}</Text>}
            {text ? <TouchableOpacity accessibilityRole="button" accessibilityLabel={t(expanded ? 'automaticTasks.collapse' : 'automaticTasks.expandResult')}
                accessibilityState={{ expanded }} style={styles.action} onPress={() => { setExpanded(value => !value); }}>
                <Text style={[body, styles.link]}>{t(expanded ? 'automaticTasks.collapse' : 'automaticTasks.expandResult')}</Text>
            </TouchableOpacity> : !loading && <TouchableOpacity accessibilityRole="button" accessibilityLabel={t(error ? 'automaticTasks.retryResult' : 'automaticTasks.result')}
                style={styles.action} onPress={() => { load(); }}>
                <Text style={[body, styles.link]}>{t(error ? 'automaticTasks.retryResult' : 'automaticTasks.result')}</Text>
            </TouchableOpacity>}
        </View>
    </View>;
}

export function AutomaticTaskDetail({ task, onClose }: { task: AutomaticTask; onClose: () => void }) {
    const { t, i18n } = useTranslation();
    const metrics = getFontSizeMetrics(useSettingsStore(state => state.fontSize));
    const body = { fontSize: metrics.flashBody, lineHeight: metrics.flashLineHeight };
    const [history, setHistory] = useState<HistoryPage>();
    const [revision, setRevision] = useState(0);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string>();
    const failedCursor = useRef<string | undefined>(undefined);
    const request = useRef<AbortController | undefined>(undefined);
    const load = useCallback(async (before?: string) => {
        request.current?.abort();
        const controller = new AbortController();
        request.current = controller;
        failedCursor.current = before;
        if (!before) setRevision(value => value + 1);
        setLoading(true); setError(undefined);
        try {
            const response = await service.history(task.id, { limit: 20, before }, { signal: controller.signal });
            if (controller.signal.aborted) return;
            if (response.generation !== service.generation) throw new AutomaticTaskError('connection_changed');
            const page = response.history;
            if ('code' in page) {
                if (page.code === 'delivery_cursor_not_found') failedCursor.current = undefined;
                setError(`automaticTasks.${page.code}`);
            } else setHistory(previous => ({ ...page, records: before && previous
                ? [...previous.records, ...page.records.filter(row => !previous.records.some(old => old.messageId === row.messageId))]
                : page.records }));
        } catch {
            if (!controller.signal.aborted) setError('automaticTasks.historyFailed');
        } finally {
            if (!controller.signal.aborted) setLoading(false);
        }
    }, [task.id]);
    useEffect(() => {
        load();
        return () => { request.current?.abort(); };
    }, [load, task]);
    const records = history?.records ?? (task.lastDelivery ? [task.lastDelivery] : []);
    const zone = taskTimeZone(task);
    return <SafeAreaView style={styles.container}>
        <View style={styles.header}>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('automaticTasks.back')} style={styles.back} onPress={onClose}>
                <Text style={[body, styles.link]}>{t('automaticTasks.back')}</Text>
            </TouchableOpacity>
            <Text accessibilityRole="header" style={[body, styles.headerTitle]}>{t('automaticTasks.detail')}</Text>
            <View style={styles.headerBalance} />
        </View>
        <FlatList data={records} keyExtractor={row => row.messageId} style={styles.container}
            contentContainerStyle={styles.content} refreshing={loading} onRefresh={() => { load(); }}
            ListHeaderComponent={<View>
                <Text accessibilityRole="header" style={[body, styles.taskTitle]}>{task.title}</Text>
                <Text accessibilityRole="header" style={[body, styles.sectionTitle]}>{t('automaticTasks.instruction')}</Text>
                <Text selectable style={[body, styles.text]}>{task.prompt}</Text>
                <View style={styles.schedule}>
                    <Text accessibilityRole="header" style={[body, styles.sectionTitle]}>{t('automaticTasks.schedule')}</Text>
                    <Text style={[body, styles.text]}>{taskFrequency(task, t)}</Text>
                    <Text style={[body, styles.secondary]}>{t('automaticTasks.nextRun', { time: taskDateTime(task.scheduledAt, i18n.language, zone) })}</Text>
                    <Text style={[body, styles.secondary]}>{zone ? t('automaticTasks.timeZone', { zone }) : t('automaticTasks.deviceTimeZone')}</Text>
                    {task.kind === 'cron' && <Text selectable style={[body, styles.secondary]}>{t('automaticTasks.ruleCron', { expression: task.expression })}</Text>}
                </View>
                <Text accessibilityRole="header" style={[body, styles.sectionTitle]}>{t('automaticTasks.activity')}</Text>
                {error && <View style={styles.notice}>
                    <Text accessibilityRole="alert" style={[body, styles.secondary]}>{t(error)}</Text>
                    <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('automaticTasks.retryHistory')} style={styles.action}
                        onPress={() => { load(failedCursor.current); }}>
                        <Text style={[body, styles.link]}>{t('automaticTasks.retryHistory')}</Text>
                    </TouchableOpacity>
                </View>}
                {loading && !history && <ActivityIndicator accessibilityLabel={t('automaticTasks.loadingHistory')} color={theme.colors.primaryDark} />}
            </View>}
            ListEmptyComponent={!loading && !error ? <Text style={[body, styles.secondary]}>{t('automaticTasks.noHistory')}</Text> : undefined}
            renderItem={({ item, index }) => <ActivityRow key={item.messageId} task={task} receipt={item} latest={index === 0} revision={revision} />}
            ListFooterComponent={<View>
                {history?.nextBefore && !error && <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('automaticTasks.loadMore')}
                    accessibilityState={{ disabled: loading }} disabled={loading} style={styles.action} onPress={() => { load(history.nextBefore); }}>
                    <Text style={[body, styles.link]}>{t('automaticTasks.loadMore')}</Text>
                </TouchableOpacity>}
                {history && !history.nextBefore && (history.earlierRecordsPruned || history.earlierRecordsUnavailable) && <Text style={[body, styles.secondary]}>{t('automaticTasks.earlierUnavailable')}</Text>}
            </View>} />
    </SafeAreaView>;
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.colors.surface },
    header: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.divider, paddingHorizontal: theme.spacing.sm },
    back: { minWidth: 64, minHeight: 48, justifyContent: 'center', paddingHorizontal: theme.spacing.sm },
    headerTitle: { flex: 1, textAlign: 'center', fontWeight: '600', color: theme.colors.text },
    headerBalance: { width: 64 },
    content: { padding: theme.spacing.lg, paddingBottom: theme.spacing.xxl, flexGrow: 1 },
    taskTitle: { fontWeight: '700', fontSize: 26, lineHeight: 36, color: theme.colors.text, marginBottom: theme.spacing.lg },
    sectionTitle: { fontWeight: '600', color: theme.colors.text, marginBottom: theme.spacing.sm },
    text: { color: theme.colors.text },
    secondary: { color: theme.colors.textSecondary },
    schedule: { paddingVertical: theme.spacing.lg, marginVertical: theme.spacing.lg, borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.divider, gap: theme.spacing.xs },
    event: { flexDirection: 'row' },
    track: { width: 24, alignItems: 'center', paddingTop: 7 },
    dot: { height: 10, width: 10, borderRadius: 5, backgroundColor: theme.colors.border },
    successDot: { backgroundColor: theme.colors.success },
    failedDot: { backgroundColor: theme.colors.danger },
    line: { width: 1, flex: 1, backgroundColor: theme.colors.divider, marginTop: theme.spacing.xs },
    eventBody: { flex: 1, minWidth: 0, paddingLeft: theme.spacing.sm, paddingBottom: theme.spacing.lg, gap: theme.spacing.xs },
    eventTitle: { color: theme.colors.text, fontWeight: '600' },
    savedInstruction: { paddingVertical: theme.spacing.sm, gap: theme.spacing.xs },
    action: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start', paddingVertical: theme.spacing.sm },
    link: { color: theme.colors.primaryDark },
    notice: { paddingBottom: theme.spacing.md },
});
