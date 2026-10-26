import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, FlatList, Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import * as Network from 'expo-network';
import { useTranslation } from 'react-i18next';
import { automaticTaskService as service, AutomaticTaskError } from '../services/AutomaticTaskService';
import { automaticTaskCache, TASK_CACHE_TTL_MS, type TaskCatalogSnapshot } from '../services/AutomaticTaskCache';
import type { AutomaticTask } from '../types/automaticTasks';
import { AutomaticTaskDetail } from '../components/AutomaticTaskDetail';
import { useAssistantStore } from '../store/useAssistantStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { getFontSizeMetrics } from '../utils/fontSize';
import { taskDateTime, taskFrequency, taskTimeZone, taskZoneLabel } from '../utils/automaticTaskPresentation';
import { theme } from '../utils/theme';

const TaskSeparator = () => <View style={styles.separator} />;
const connectionIdentity = () => {
    const state = useAssistantStore.getState();
    return JSON.stringify([state.serverUrl, state.serverToken, state.hasHydrated]);
};
type RefreshMode = 'normal' | 'force' | 'manual';

export const TodoScreen = () => {
    const { t, i18n } = useTranslation();
    const navigation = useNavigation();
    const metrics = getFontSizeMetrics(useSettingsStore(state => state.fontSize));
    const body = { fontSize: metrics.flashBody, lineHeight: metrics.flashLineHeight };
    const renderIdentity = useAssistantStore(state => JSON.stringify([state.serverUrl, state.serverToken, state.hasHydrated]));
    const [tasks, setTasks] = useState<AutomaticTask[]>([]);
    const [viewIdentity, setViewIdentity] = useState(renderIdentity);
    const [loading, setLoading] = useState(true);
    const [manualRefreshing, setManualRefreshing] = useState(false);
    const [loaded, setLoaded] = useState(false);
    const [error, setError] = useState<string>();
    const [selectedId, setSelectedId] = useState<string>();
    const [catalogRevision, setCatalogRevision] = useState(0);
    const request = useRef<{ controller: AbortController; identity: string; force: boolean } | undefined>(undefined);
    const snapshot = useRef<(TaskCatalogSnapshot & { identity: string }) | undefined>(undefined);
    const focused = useRef(false);
    const selectedRef = useRef(selectedId);
    selectedRef.current = selectedId;
    // Also hide old data immediately when identity changes while this tab is unfocused.
    const visibleTasks = viewIdentity === renderIdentity ? tasks : [];
    const selected = visibleTasks.find(task => task.id === selectedId);

    useLayoutEffect(() => { navigation.setOptions({ title: t('tabs.todo') }); }, [navigation, t]);
    const closeDetail = useCallback(() => { setSelectedId(undefined); }, []);
    const refresh = useCallback(async (mode: RefreshMode = 'normal') => {
        const identity = connectionIdentity();
        if (request.current?.identity === identity && mode !== 'manual') {
            if (mode === 'force') request.current.force = true;
            return;
        }
        request.current?.controller.abort();
        const controller = new AbortController();
        const current = { controller, identity, force: mode !== 'normal' };
        request.current = current;
        const valid = () => !controller.signal.aborted && focused.current && connectionIdentity() === identity;
        if (snapshot.current?.identity !== identity) {
            snapshot.current = undefined;
            setTasks([]); setLoaded(false); setSelectedId(undefined); setViewIdentity(identity);
        }
        setLoading(true); setManualRefreshing(mode === 'manual'); setError(undefined);
        try {
            const state = useAssistantStore.getState();
            if (!state.hasHydrated) throw new AutomaticTaskError('connection_not_ready');
            const { serverUrl, serverToken } = useAssistantStore.getState();
            if (!snapshot.current) {
                const cached = await automaticTaskCache.read(serverUrl, serverToken);
                if (!valid()) return;
                if (cached) {
                    snapshot.current = { ...cached, identity };
                    setTasks(cached.tasks); setLoaded(true);
                }
            }
            const cachedAt = snapshot.current?.fetchedAt;
            if (!current.force && cachedAt !== undefined && cachedAt > 0 && Date.now() >= cachedAt && Date.now() - cachedAt < TASK_CACHE_TTL_MS) return;
            const response = await service.catalog({ signal: controller.signal });
            if (!valid()) return;
            if (response.generation !== service.generation) throw new AutomaticTaskError('connection_changed');
            const active = response.tasks.filter(task => task.status === 'active');
            const next = { tasks: active, fetchedAt: Date.now() };
            snapshot.current = { ...next, identity };
            setTasks(active);
            setCatalogRevision(value => value + 1);
            setSelectedId(previous => active.some(task => task.id === previous) ? previous : undefined);
            setLoaded(true);
            automaticTaskCache.write(serverUrl, serverToken, next);
        } catch (failure: unknown) {
            if (valid()) {
                if (snapshot.current) {
                    snapshot.current = { ...snapshot.current, fetchedAt: 0 };
                    const { serverUrl, serverToken } = useAssistantStore.getState();
                    automaticTaskCache.write(serverUrl, serverToken, snapshot.current);
                }
                setError(failure instanceof AutomaticTaskError && failure.code === 'native_tasks_unavailable'
                    ? 'automaticTasks.disabled' : 'automaticTasks.connectionFailed');
            }
        } finally {
            if (valid() && request.current === current) {
                request.current = undefined;
                setLoading(false); setManualRefreshing(false);
            }
        }
    }, []);

    useFocusEffect(useCallback(() => {
        focused.current = true;
        refresh();
        const stop = useAssistantStore.subscribe((next, previous) => {
            const changed = next.serverUrl !== previous.serverUrl || next.serverToken !== previous.serverToken
                || next.hasHydrated !== previous.hasHydrated;
            if (changed) refresh();
            else if (next.connectionState === 'connected' && previous.connectionState !== 'connected') refresh('force');
        });
        let appState = AppState.currentState;
        const app = AppState.addEventListener('change', next => {
            if (next === 'active' && appState !== 'active') refresh(selectedRef.current ? 'force' : 'normal');
            appState = next;
        });
        let wasOnline: boolean | undefined;
        const network = Network.addNetworkStateListener(state => {
            const online = state.isConnected === true && state.isInternetReachable !== false;
            if (online && wasOnline === false) refresh('force');
            wasOnline = online;
        });
        return () => {
            focused.current = false;
            request.current?.controller.abort();
            request.current = undefined;
            setLoading(false); setManualRefreshing(false);
            // Unmount detail readers even if the navigator keeps the list screen mounted off-tab.
            setSelectedId(undefined);
            stop(); app.remove(); network.remove();
        };
    }, [refresh]));

    return <View style={styles.container}>
        <FlatList data={visibleTasks} keyExtractor={task => task.id} contentContainerStyle={styles.content}
            refreshing={manualRefreshing} onRefresh={() => { refresh('manual'); }}
            ItemSeparatorComponent={TaskSeparator}
            ListHeaderComponent={<View>
                {loading && !loaded && !manualRefreshing && <ActivityIndicator accessibilityLabel={t('automaticTasks.loading')} color={theme.colors.primaryDark} />}
                {error && <View style={styles.notice}>
                    <Text accessibilityRole="alert" style={[body, styles.secondary]}>{t(error)}</Text>
                    <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('automaticTasks.retry')} style={styles.action} onPress={() => { refresh('force'); }}>
                        <Text style={[body, styles.link]}>{t('automaticTasks.retry')}</Text>
                    </TouchableOpacity>
                </View>}
            </View>}
            ListEmptyComponent={viewIdentity === renderIdentity && loaded && !error ? <View style={styles.empty}>
                <Text style={[body, styles.title]}>{t('automaticTasks.empty')}</Text>
                <Text style={[body, styles.secondary, styles.emptyHint]}>{t('automaticTasks.emptyHint')}</Text>
            </View> : undefined}
            renderItem={({ item }) => <TouchableOpacity accessibilityRole="button" accessibilityLabel={item.title}
                accessibilityHint={t('automaticTasks.openDetail')} style={styles.row} onPress={() => { setSelectedId(item.id); }}>
                <View style={styles.rowContent}>
                    <Text numberOfLines={2} style={[body, styles.title]}>{item.title}</Text>
                    <Text style={[body, styles.secondary]}>{t('automaticTasks.frequencyWithZone', { frequency: taskFrequency(item, t), zone: taskZoneLabel(item, i18n.language) })}</Text>
                    <Text style={[body, styles.secondary]}>{t('automaticTasks.nextRun', { time: taskDateTime(item.scheduledAt, i18n.language, taskTimeZone(item)) })}</Text>
                </View>
                <Text accessible={false} style={styles.chevron}>›</Text>
            </TouchableOpacity>} />
        <Modal visible={!!selected} animationType="slide" onRequestClose={closeDetail}>
            {selected && <AutomaticTaskDetail key={`${service.generation}:${selected.id}`} task={selected} onClose={closeDetail}
                catalogRevision={catalogRevision} catalogRefreshing={manualRefreshing} catalogError={error} onRefreshCatalog={() => { refresh('manual'); }} />}
        </Modal>
    </View>;
};

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.colors.surface },
    content: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.xl, flexGrow: 1 },
    row: { flexDirection: 'row', alignItems: 'center', paddingVertical: theme.spacing.lg, minHeight: 88 },
    rowContent: { flex: 1, minWidth: 0, gap: theme.spacing.xs },
    title: { color: theme.colors.text, fontWeight: '600' },
    secondary: { color: theme.colors.textSecondary },
    chevron: { color: theme.colors.textSecondary, fontSize: 28, paddingLeft: theme.spacing.md },
    separator: { height: StyleSheet.hairlineWidth, backgroundColor: theme.colors.divider },
    notice: { paddingTop: theme.spacing.md },
    action: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start', paddingVertical: theme.spacing.sm },
    link: { color: theme.colors.primaryDark },
    empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: theme.spacing.xxl },
    emptyHint: { textAlign: 'center', marginTop: theme.spacing.sm },
});
