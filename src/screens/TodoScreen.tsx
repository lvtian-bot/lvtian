import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, FlatList, Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import * as Network from 'expo-network';
import { useTranslation } from 'react-i18next';
import { automaticTaskService as service, AutomaticTaskError } from '../services/AutomaticTaskService';
import type { AutomaticTask } from '../types/automaticTasks';
import { AutomaticTaskDetail } from '../components/AutomaticTaskDetail';
import { useAssistantStore } from '../store/useAssistantStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { getFontSizeMetrics } from '../utils/fontSize';
import { taskDateTime, taskFrequency, taskTimeZone, taskZoneLabel } from '../utils/automaticTaskPresentation';
import { theme } from '../utils/theme';

const TaskSeparator = () => <View style={styles.separator} />;

export const TodoScreen = () => {
    const { t, i18n } = useTranslation();
    const navigation = useNavigation();
    const metrics = getFontSizeMetrics(useSettingsStore(state => state.fontSize));
    const body = { fontSize: metrics.flashBody, lineHeight: metrics.flashLineHeight };
    const [tasks, setTasks] = useState<AutomaticTask[]>([]);
    const [loading, setLoading] = useState(true);
    const [loaded, setLoaded] = useState(false);
    const [error, setError] = useState<string>();
    const [selectedId, setSelectedId] = useState<string>();
    const [catalogRevision, setCatalogRevision] = useState(0);
    const request = useRef<AbortController | undefined>(undefined);
    const focused = useRef(false);
    const selected = tasks.find(task => task.id === selectedId);

    useLayoutEffect(() => { navigation.setOptions({ title: t('tabs.todo') }); }, [navigation, t]);
    const closeDetail = useCallback(() => { setSelectedId(undefined); }, []);
    const refresh = useCallback(async (clear = false) => {
        request.current?.abort();
        const controller = new AbortController();
        request.current = controller;
        if (clear) { setTasks([]); setLoaded(false); setSelectedId(undefined); }
        setLoading(true); setError(undefined);
        try {
            const response = await service.catalog({ signal: controller.signal });
            if (controller.signal.aborted || !focused.current) return;
            if (response.generation !== service.generation) throw new AutomaticTaskError('connection_changed');
            const active = response.tasks.filter(task => task.status === 'active');
            setTasks(active);
            setCatalogRevision(value => value + 1);
            setSelectedId(previous => active.some(task => task.id === previous) ? previous : undefined);
            setLoaded(true);
        } catch (failure: unknown) {
            if (!controller.signal.aborted && focused.current) setError(failure instanceof AutomaticTaskError && failure.code === 'native_tasks_unavailable'
                ? 'automaticTasks.disabled' : 'automaticTasks.connectionFailed');
        } finally {
            if (!controller.signal.aborted && focused.current) setLoading(false);
        }
    }, []);

    useFocusEffect(useCallback(() => {
        focused.current = true;
        refresh(true);
        const stop = useAssistantStore.subscribe((next, previous) => {
            const changed = next.serverUrl !== previous.serverUrl || next.serverToken !== previous.serverToken
                || next.hasHydrated !== previous.hasHydrated;
            if (changed || (next.connectionState === 'connected' && previous.connectionState !== 'connected')) refresh(changed);
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
            request.current?.abort();
            // Unmount detail readers even if the navigator keeps the list screen mounted off-tab.
            setSelectedId(undefined);
            stop(); app.remove(); network.remove();
        };
    }, [refresh]));

    return <View style={styles.container}>
        <FlatList data={tasks} keyExtractor={task => task.id} contentContainerStyle={styles.content}
            refreshing={loading} onRefresh={() => { refresh(); }}
            ItemSeparatorComponent={TaskSeparator}
            ListHeaderComponent={<View>
                {loading && !loaded && <ActivityIndicator accessibilityLabel={t('automaticTasks.loading')} color={theme.colors.primaryDark} />}
                {error && <View style={styles.notice}>
                    <Text accessibilityRole="alert" style={[body, styles.secondary]}>{t(error)}</Text>
                    <TouchableOpacity accessibilityRole="button" accessibilityLabel={t('automaticTasks.retry')} style={styles.action} onPress={() => { refresh(); }}>
                        <Text style={[body, styles.link]}>{t('automaticTasks.retry')}</Text>
                    </TouchableOpacity>
                </View>}
            </View>}
            ListEmptyComponent={!loading && loaded && !error ? <View style={styles.empty}>
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
                catalogRevision={catalogRevision} catalogRefreshing={loading} catalogError={error} onRefreshCatalog={() => { refresh(); }} />}
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
