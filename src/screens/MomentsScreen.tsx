import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useFocusEffect, useScrollToTop } from '@react-navigation/native';
import { ActivityIndicator, Alert, AppState, FlatList, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { ChatMarkdownBubble } from '../components/ChatMarkdownBubble';
import { EmptyState } from '../components/EmptyState';
import { useSettingsFont } from '../components/settings/useSettingsFont';
import { MOMENTS_REFRESH_INTERVAL, momentsCache, momentsIdentity, type MomentsSnapshot } from '../services/MomentsCache';
import { momentsService, type Moment, type MomentsConnection, type MomentsPage } from '../services/MomentsService';
import { useAssistantStore } from '../store/useAssistantStore';
import { auxFontSizes, type FontSizeMetrics } from '../utils/fontSize';
import { colors, radius, spacing } from '../utils/theme';

function Action({ label, onPress, metrics, disabled, destructive }: {
    label: string; onPress: () => void; metrics: FontSizeMetrics; disabled?: boolean; destructive?: boolean;
}) {
    return (
        <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress} style={styles.action}>
            <Text style={[
                styles.actionLabel,
                { fontSize: metrics.chatBody },
                destructive && styles.destructive,
                disabled && styles.muted,
            ]}>{label}</Text>
        </Pressable>
    );
}

function splitSummary(summary: string) {
    // Telegram uses the first non-empty line as the title, stripping Markdown heading markers.
    const text = summary.trim();
    const lineEnd = text.indexOf('\n');
    const heading = lineEnd === -1 ? text : text.slice(0, lineEnd);
    return {
        title: heading.trim().replace(/^#{1,6}\s+/, ''),
        body: lineEnd === -1 ? '' : text.slice(lineEnd + 1).trim(),
    };
}

const minute = 60_000;
type ReadRequest = { cursor: string | null; controller: AbortController };

function Feed({ connection, identity }: { connection: MomentsConnection; identity: string }) {
    const { t } = useTranslation();
    const metrics = useSettingsFont();
    const listRef = useRef<FlatList<Moment>>(null);
    useScrollToTop(listRef);
    const [page, setPage] = useState<MomentsPage>();
    const [loading, setLoading] = useState<'refresh' | 'more'>();
    const [failure, setFailure] = useState<{ cursor: string | null }>();
    const [editing, setEditing] = useState<string>();
    const [now, setNow] = useState(Date.now);
    const snapshot = useRef<MomentsSnapshot | undefined>(undefined);
    const cacheRead = useRef<Promise<MomentsSnapshot | undefined> | undefined>(undefined);
    const activeRead = useRef<ReadRequest | null>(null);
    const activeEdit = useRef<AbortController | null>(null);
    const queuedRefresh = useRef(false);
    const focused = useRef(false);
    const appState = useRef(AppState.currentState);

    const isCurrentConnection = useCallback(() => {
        const current = useAssistantStore.getState();
        return current.credentialsStatus === 'ready'
            && current.serverUrl === connection.serverUrl && current.serverToken === connection.serverToken;
    }, [connection]);
    const isForeground = useCallback(() => (
        focused.current && appState.current === 'active' && isCurrentConnection()
    ), [isCurrentConnection]);

    const saveSnapshot = useCallback((next: MomentsSnapshot) => {
        snapshot.current = next;
        momentsCache.write(identity, next);
    }, [identity]);

    const load = useCallback(async (cursor: string | null) => {
        if (!isForeground()) return;
        if (activeEdit.current) {
            if (!cursor) queuedRefresh.current = true;
            return;
        }
        if (activeRead.current) {
            if (cursor || !activeRead.current.cursor) return;
            activeRead.current.controller.abort();
        }
        const controller = new AbortController();
        const request = { cursor, controller };
        activeRead.current = request;
        setLoading(cursor ? 'more' : 'refresh');
        setFailure(undefined);
        try {
            const next = await momentsService.list(connection, cursor, controller.signal);
            if (controller.signal.aborted || !isForeground()) return;
            if (cursor) {
                setPage(previous => {
                    if (!previous) return next;
                    const ids = new Set(previous.items.map(item => item.id));
                    return { ...next, items: [...previous.items, ...next.items.filter(item => !ids.has(item.id))] };
                });
            } else {
                const refreshedAt = Date.now();
                setPage(next);
                setNow(refreshedAt);
                saveSnapshot({ page: next, refreshedAt });
            }
        } catch {
            if (!controller.signal.aborted && isForeground()) setFailure({ cursor });
        } finally {
            if (activeRead.current === request) {
                activeRead.current = null;
                setLoading(undefined);
            }
        }
    }, [connection, isForeground, saveSnapshot]);

    const enter = useCallback(async (manual = false) => {
        if (!isForeground()) return;
        if (!snapshot.current) {
            cacheRead.current ??= momentsCache.read(identity);
            const cached = await cacheRead.current;
            if (!isForeground()) return;
            if (cached && !snapshot.current) {
                snapshot.current = cached;
                setPage(cached.page);
            }
        }
        const age = snapshot.current ? Date.now() - snapshot.current.refreshedAt : Infinity;
        if (manual || age < 0 || age >= MOMENTS_REFRESH_INTERVAL) load(null);
    }, [identity, isForeground, load]);

    useFocusEffect(useCallback(() => {
        focused.current = true;
        appState.current = AppState.currentState;
        const stopReading = () => {
            activeRead.current?.controller.abort();
            activeRead.current = null;
            queuedRefresh.current = false;
            setLoading(undefined);
        };
        const updateTime = () => {
            if (isForeground()) setNow(Date.now());
        };
        updateTime();
        enter();
        const clock = setInterval(updateTime, minute);
        const subscription = AppState.addEventListener('change', next => {
            const wasActive = appState.current === 'active';
            appState.current = next;
            if (next === 'active' && !wasActive) {
                updateTime();
                enter();
            } else if (wasActive && next !== 'active') {
                stopReading();
            }
        });
        return () => {
            focused.current = false;
            clearInterval(clock);
            subscription.remove();
            stopReading();
        };
    }, [enter, isForeground]));

    React.useEffect(() => () => { activeEdit.current?.abort(); }, []);

    const updateCard = (id: string, replacement?: Moment) => {
        const update = (current: MomentsPage) => ({
            ...current,
            items: replacement ? current.items.map(card => card.id === id ? replacement : card)
                : current.items.filter(card => card.id !== id),
        });
        setPage(previous => previous && update(previous));
        if (snapshot.current?.page.items.some(card => card.id === id)) {
            saveSnapshot({ ...snapshot.current, page: update(snapshot.current.page) });
        }
    };

    const edit = async (item: Moment, action: 'rewrite' | 'delete') => {
        if (!isForeground() || !page?.canEditSummary || activeRead.current || activeEdit.current) return;
        const controller = new AbortController();
        activeEdit.current = controller;
        setEditing(item.id);
        try {
            if (action === 'rewrite') {
                const result = await momentsService.rewrite(connection, item, controller.signal);
                if (controller.signal.aborted || !isCurrentConnection()) return;
                updateCard(item.id, result.item);
                if (result.status === 'upload_failed') Alert.alert(t('editor.uploadFailedTitle'), t('editor.savedSuccessfully'));
            } else {
                const status = await momentsService.delete(connection, item, controller.signal);
                if (controller.signal.aborted || !isCurrentConnection()) return;
                updateCard(item.id);
                if (status === 'delete_failed') Alert.alert(t('common.error'), t('moments.cloudDeleteFailed'));
            }
        } catch {
            if (!controller.signal.aborted && isCurrentConnection()) {
                Alert.alert(t('common.error'), t(action === 'delete' ? 'browser.deleteFailed' : 'workRecords.failed'));
            }
        } finally {
            if (activeEdit.current === controller) {
                activeEdit.current = null;
                setEditing(undefined);
                if (queuedRefresh.current) {
                    queuedRefresh.current = false;
                    load(null);
                }
            }
        }
    };

    const clippedTime = (clippedAt: number) => {
        const minutes = Math.floor((now - clippedAt) / minute);
        if (minutes < 1) return t('moments.justNow');
        if (minutes < 60) return t('moments.minutesAgo', { count: minutes });
        if (minutes < 1440) return t('moments.hoursAgo', { count: Math.floor(minutes / 60) });
        return t('moments.daysAgo', { count: Math.floor(minutes / 1440) });
    };

    const renderItem = ({ item }: { item: Moment }) => {
        const { title, body } = splitSummary(item.summary);
        const source = item.sourceUrl;
        const disabled = !page?.canEditSummary || !!editing || !!loading;
        const confirmDelete = () => Alert.alert(t('common.delete'), t('browser.confirmDelete', { fileName: title || item.title }), [
            { text: t('common.cancel'), style: 'cancel' },
            { text: t('common.delete'), style: 'destructive', onPress: () => { edit(item, 'delete'); } },
        ]);
        return (
            <View style={styles.card} testID="moments-card">
                {!!title && <Text accessibilityRole={source ? 'link' : 'header'}
                    onPress={source ? () => { Linking.openURL(source).catch(() => Alert.alert(t('common.error'))); } : undefined}
                    style={[styles.title, source && styles.titleLink, { fontSize: metrics.chatHeading2 }]}>{title}</Text>}
                {!!body && <ChatMarkdownBubble text={body} metrics={metrics} plain />}
                <View style={styles.footer}>
                    <Text style={styles.time}>{clippedTime(item.clippedAt)}</Text>
                    <View style={styles.actions}>
                        {editing === item.id && <ActivityIndicator color={colors.primaryDark} />}
                        <Action label={t('moments.rewrite')} metrics={metrics} disabled={disabled}
                            onPress={() => { edit(item, 'rewrite'); }} />
                        <Action label={t('common.delete')} metrics={metrics} disabled={disabled} destructive onPress={confirmDelete} />
                    </View>
                </View>
            </View>
        );
    };

    const loadMore = () => { if (page?.nextCursor) load(page.nextCursor); };
    return (
        <View style={styles.feed}>
            <FlatList
                ref={listRef}
                testID="moments-feed"
                contentContainerStyle={styles.list}
                data={page?.items ?? []}
                keyExtractor={item => item.id}
                renderItem={renderItem}
                refreshing={false}
                onRefresh={() => { enter(true); }}
                onEndReached={failure ? undefined : loadMore}
                onEndReachedThreshold={0.3}
                ListHeaderComponent={page?.canEditSummary === false && page.items.length > 0
                    ? <Text style={styles.status}>{t('common.actions')} · {t('connectors.status.unsupported')}</Text> : undefined}
                ListEmptyComponent={page && loading !== 'refresh' && !failure
                    ? <EmptyState text={t('browser.emptyTitle')} /> : undefined}
                ListFooterComponent={failure
                    ? <View style={styles.listStatus}>
                        <Text style={styles.status}>{t('browser.loadingFailedTitle')}</Text>
                        <Action label={t('common.retry')} metrics={metrics} onPress={() => { load(failure.cursor); }} />
                    </View>
                    : loading === 'more' ? <ActivityIndicator color={colors.primaryDark} />
                        : page?.nextCursor ? <Action label={t('common.loadMore')} metrics={metrics} disabled={!!editing || !!loading} onPress={loadMore} /> : undefined}
            />
            {loading === 'refresh' && <View pointerEvents="none" style={styles.refresh}>
                <ActivityIndicator testID="moments-refresh" size="small" color={colors.textSecondary} />
            </View>}
        </View>
    );
}

export function MomentsScreen() {
    const { t } = useTranslation();
    const serverUrl = useAssistantStore(state => state.serverUrl);
    const serverToken = useAssistantStore(state => state.serverToken);
    const credentialsStatus = useAssistantStore(state => state.credentialsStatus);
    const connection = useMemo(() => ({ serverUrl, serverToken }), [serverUrl, serverToken]);
    const identity = useMemo(() => momentsIdentity(connection), [connection]);
    if (credentialsStatus === 'loading') return <ActivityIndicator style={styles.feed} color={colors.primaryDark} />;
    if (credentialsStatus !== 'ready' || !serverUrl || !serverToken) return <EmptyState text={t('assistant.notConnectedTitle')} />;
    return <Feed key={identity} connection={connection} identity={identity} />;
}

const styles = StyleSheet.create({
    feed: { flex: 1, backgroundColor: colors.background },
    list: { padding: spacing.md, gap: spacing.md },
    card: { backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.md, gap: spacing.sm },
    title: { color: colors.text, fontWeight: '700' },
    titleLink: { color: colors.primaryDark },
    time: { color: colors.textSecondary, fontSize: auxFontSizes.caption, flexShrink: 1 },
    footer: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', columnGap: spacing.sm,
        borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
    actions: { flexDirection: 'row', alignItems: 'center', columnGap: spacing.md, marginLeft: 'auto' },
    action: { minHeight: 44, justifyContent: 'center' },
    actionLabel: { color: colors.primaryDark, fontWeight: '600' },
    destructive: { color: colors.dangerStrong },
    muted: { color: colors.textTertiary },
    listStatus: { alignItems: 'center' },
    status: { color: colors.textSecondary, fontSize: auxFontSizes.caption, textAlign: 'center' },
    refresh: { position: 'absolute', top: spacing.xs, alignSelf: 'center' },
});
