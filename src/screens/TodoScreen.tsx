import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, FlatList, Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import * as Network from 'expo-network';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { automaticTaskService as service, AutomaticTaskError } from '../services/AutomaticTaskService';
import type { AutomaticTask, AutomaticTaskHistory, AutomaticTaskResult } from '../types/automaticTasks';
import { useAssistantStore } from '../store/useAssistantStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { getFontSizeMetrics } from '../utils/fontSize';
import { theme } from '../utils/theme';

type Detail = { task: AutomaticTask; mode: 'history' | 'result' };
type HistoryPage = Exclude<AutomaticTaskHistory, { code: string }>;

export const TodoScreen = () => {
    const { t } = useTranslation();
    const navigation = useNavigation();
    const fontSize = useSettingsStore(state => state.fontSize);
    const metrics = getFontSizeMetrics(fontSize);
    const body = { fontSize: metrics.flashBody, lineHeight: metrics.flashLineHeight, color: theme.colors.text };
    const [tasks, setTasks] = useState<AutomaticTask[]>([]);
    const [loading, setLoading] = useState(true);
    const [loaded, setLoaded] = useState(false);
    const [error, setError] = useState<string>();
    const [detail, setDetail] = useState<Detail>();
    const [history, setHistory] = useState<HistoryPage>();
    const [result, setResult] = useState<AutomaticTaskResult>();
    const [detailLoading, setDetailLoading] = useState(false);
    const [detailError, setDetailError] = useState<string>();
    const catalogRequest = useRef<AbortController | undefined>(undefined);
    const detailRequest = useRef<AbortController | undefined>(undefined);
    const focused = useRef(false);

    useLayoutEffect(() => { navigation.setOptions({ title: t('tabs.todo') }); }, [navigation, t]);

    const errorKey = (failure: unknown) => failure instanceof AutomaticTaskError && failure.code === 'native_tasks_unavailable'
        ? 'automaticTasks.disabled' : 'automaticTasks.connectionFailed';

    const closeDetail = useCallback(() => {
        detailRequest.current?.abort();
        setDetail(undefined);
        setHistory(undefined);
        setResult(undefined);
        setDetailError(undefined);
        setDetailLoading(false);
    }, []);

    const refresh = useCallback(async (clear = false) => {
        catalogRequest.current?.abort();
        closeDetail();
        const controller = new AbortController();
        catalogRequest.current = controller;
        if (clear) { setTasks([]); setLoaded(false); }
        setLoading(true);
        setError(undefined);
        try {
            const response = await service.catalog({ signal: controller.signal });
            if (!controller.signal.aborted && focused.current && response.generation !== service.generation) throw new AutomaticTaskError('connection_changed');
            if (!controller.signal.aborted && focused.current && response.generation === service.generation) {
                setTasks(response.tasks.filter(task => task.status === 'active'));
                setLoaded(true);
            }
        } catch (failure: unknown) {
            if (!controller.signal.aborted && focused.current) setError(errorKey(failure));
        } finally {
            if (!controller.signal.aborted && focused.current) setLoading(false);
        }
    }, [closeDetail]);

    useFocusEffect(useCallback(() => {
        focused.current = true;
        refresh(true);
        const stop = useAssistantStore.subscribe((next, previous) => {
            const changed = next.serverUrl !== previous.serverUrl || next.serverToken !== previous.serverToken
                || next.hasHydrated !== previous.hasHydrated;
            if (changed || (next.connectionState === 'connected' && previous.connectionState !== 'connected')) {
                refresh(changed);
            }
        });
        let appState = AppState.currentState;
        const app = AppState.addEventListener('change', next => {
            if (next === 'active' && appState !== 'active') refresh();
            appState = next;
        });
        let wasOnline: boolean | undefined;
        const network = Network.addNetworkStateListener(state => {
            const online = state.isConnected === true && state.isInternetReachable !== false;
            if (online && wasOnline === false) refresh();
            wasOnline = online;
        });
        return () => {
            focused.current = false;
            catalogRequest.current?.abort();
            detailRequest.current?.abort();
            stop(); app.remove(); network.remove();
        };
    }, [refresh]));

    const loadDetail = async (selection: Detail, before?: string) => {
        detailRequest.current?.abort();
        const controller = new AbortController();
        detailRequest.current = controller;
        setDetail(selection);
        if (!before) { setHistory(undefined); setResult(undefined); }
        setDetailLoading(true);
        setDetailError(undefined);
        const valid = (generation: number) => {
            if (controller.signal.aborted || !focused.current) return false;
            if (generation !== service.generation) throw new AutomaticTaskError('connection_changed');
            return true;
        };
        try {
            if (selection.mode === 'result') {
                const response = await service.getResult(selection.task.id, { signal: controller.signal });
                if (valid(response.generation)) setResult(response.result);
            } else {
                const response = await service.history(selection.task.id, { limit: 20, before }, { signal: controller.signal });
                if (valid(response.generation)) {
                    const page = response.history;
                    if ('code' in page) setDetailError(`automaticTasks.${page.code}`);
                    else setHistory(previous => ({ ...page, records: before && previous
                        ? [...previous.records, ...page.records.filter(row => !previous.records.some(old => old.messageId === row.messageId))]
                        : page.records }));
                }
            }
        } catch (failure: unknown) {
            if (!controller.signal.aborted && focused.current) setDetailError(errorKey(failure));
        } finally {
            if (!controller.signal.aborted && focused.current) setDetailLoading(false);
        }
    };

    const button = (label: string, onPress: () => void, disabled = false) => (
        <TouchableOpacity accessibilityRole="button" accessibilityLabel={label} onPress={onPress} disabled={disabled} style={styles.button}>
            <Text style={[body, styles.action]}>{label}</Text>
        </TouchableOpacity>
    );
    const rule = (task: AutomaticTask) => {
        switch (task.kind) {
            case 'at': return t('automaticTasks.ruleAt');
            case 'after': return t('automaticTasks.ruleAfter', { seconds: task.afterSeconds });
            case 'every': return t('automaticTasks.ruleEvery', { seconds: task.everySeconds });
            case 'daily': return t('automaticTasks.ruleDaily', { time: task.time });
            case 'weekly': return t('automaticTasks.ruleWeekly', { time: task.time,
                days: task.weekdays.map(day => t(`automaticTasks.weekday${day}`)).join(t('automaticTasks.separator')) });
            case 'cron': return t('automaticTasks.ruleCron', { expression: task.expression });
        }
    };
    const resultStatus = result && (result.status === 'ended'
        ? result.endReason === 'completed' ? 'completed' : 'ended'
        : result.status === 'not_delivered' ? 'notDelivered' : 'unknown');

    return (
        <View style={styles.container}>
            <FlatList data={tasks} keyExtractor={task => task.id} contentContainerStyle={styles.content}
                refreshing={loading} onRefresh={() => { refresh(); }}
                ListHeaderComponent={<View>
                    <Text style={[body, styles.secondary]}>{t('automaticTasks.readOnly')}</Text>
                    {button(t('automaticTasks.refresh'), () => { refresh(); })}
                    {loading && <ActivityIndicator accessibilityLabel={t('automaticTasks.loading')} color={theme.colors.primary} />}
                    {error && <Text accessibilityRole="alert" style={[body, styles.secondary]}>{t(error)}</Text>}
                    {error && button(t('automaticTasks.retry'), () => { refresh(); })}
                </View>}
                ListEmptyComponent={!loading && loaded && !error ? <Text style={body}>{t('automaticTasks.empty')}</Text> : undefined}
                renderItem={({ item }) => <View style={styles.card}>
                    <Text style={[body, styles.title]}>{item.title}</Text>
                    <Text style={[body, styles.secondary]}>{t(`automaticTasks.${item.status}`)}</Text>
                    <Text selectable style={body}>{item.prompt}</Text>
                    <Text style={body}>{rule(item)}</Text>
                    <Text selectable style={body}>{t('automaticTasks.timeZone', { zone: 'timeZone' in item ? item.timeZone : t('automaticTasks.timestampZone') })}</Text>
                    <Text selectable style={body}>{t('automaticTasks.scheduledAt', { time: item.scheduledAt })}</Text>
                    <View style={styles.actions}>
                        {button(t('automaticTasks.history'), () => { loadDetail({ task: item, mode: 'history' }); })}
                        {button(t('automaticTasks.result'), () => { loadDetail({ task: item, mode: 'result' }); })}
                    </View>
                </View>} />
            <Modal visible={!!detail} animationType="slide" onRequestClose={closeDetail}>
                <SafeAreaView style={styles.container}>
                <ScrollView contentContainerStyle={styles.content} style={styles.container}>
                    {button(t('automaticTasks.close'), closeDetail)}
                    <Text style={[body, styles.title]}>{detail?.task.title}</Text>
                    <Text style={[body, styles.title]}>{t(detail?.mode === 'history' ? 'automaticTasks.history' : 'automaticTasks.result')}</Text>
                    {detailLoading && <ActivityIndicator accessibilityLabel={t('automaticTasks.loading')} color={theme.colors.primary} />}
                    {detailError && <Text accessibilityRole="alert" style={body}>{t(detailError)}</Text>}
                    {detailError && detail && button(t('automaticTasks.retry'), () => { loadDetail(detail, history?.nextBefore); })}
                    {result && <View style={styles.card}>
                        <Text style={body}>{t(`automaticTasks.${resultStatus}`)}</Text>
                        {result.assistantText.map((text, index) => <Text selectable key={index} style={body}>{text}</Text>)}
                        {result.assistantText.length === 0 && <Text style={body}>{t('automaticTasks.noResultText')}</Text>}
                        {result.truncated && <Text style={[body, styles.secondary]}>{t('automaticTasks.truncated')}</Text>}
                    </View>}
                    {history && <View>
                        <Text style={[body, styles.secondary]}>{t('automaticTasks.deliveryOnly')}</Text>
                        <Text style={[body, styles.secondary]}>{t('automaticTasks.retention', history.retention)}</Text>
                        {(history.earlierRecordsPruned || history.earlierRecordsUnavailable) && <Text style={body}>{t('automaticTasks.earlierUnavailable')}</Text>}
                        {history.records.length === 0 && <Text style={body}>{t('automaticTasks.noHistory')}</Text>}
                        {history.records.map(row => <View key={row.messageId} style={styles.card}>
                            <Text style={body}>{t('automaticTasks.delivered')}</Text>
                            <Text selectable style={body}>{t('automaticTasks.scheduledAt', { time: row.scheduledAt })}</Text>
                            <Text selectable style={body}>{t('automaticTasks.deliveredAt', { time: row.deliveredAt })}</Text>
                        </View>)}
                        {history.nextBefore && detail && button(t('automaticTasks.loadMore'), () => { loadDetail(detail, history.nextBefore); }, detailLoading)}
                    </View>}
                </ScrollView>
                </SafeAreaView>
            </Modal>
        </View>
    );
};

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.colors.background },
    content: { padding: theme.spacing.md, paddingBottom: theme.spacing.xl, flexGrow: 1 },
    card: { backgroundColor: theme.colors.surface, borderRadius: theme.radius.md, padding: theme.spacing.md, marginVertical: theme.spacing.sm, gap: theme.spacing.sm },
    title: { color: theme.colors.text, fontWeight: 'bold' },
    secondary: { color: theme.colors.textSecondary },
    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm },
    button: { paddingVertical: theme.spacing.sm, paddingHorizontal: theme.spacing.sm, minHeight: 44, flexShrink: 1 },
    action: { color: theme.colors.primaryDark },
});
