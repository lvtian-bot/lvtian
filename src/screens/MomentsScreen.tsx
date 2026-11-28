import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { ChatMarkdownBubble } from '../components/ChatMarkdownBubble';
import { EmptyState } from '../components/EmptyState';
import { useSettingsFont } from '../components/settings/useSettingsFont';
import { momentsService, type Moment, type MomentsConnection, type MomentsPage, type SummaryAction } from '../services/MomentsService';
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

type RequestState = { connection: MomentsConnection; controller: AbortController };
type FeedState = { connection: MomentsConnection; page?: MomentsPage; loading?: 'first' | 'more'; failure?: { cursor: string | null } };

function Feed({ connection }: { connection: MomentsConnection }) {
    const { t, i18n } = useTranslation();
    const metrics = useSettingsFont();
    const [feed, setFeed] = useState<FeedState>();
    const [editing, setEditing] = useState<{ connection: MomentsConnection; id: string }>();
    const activeRead = useRef<RequestState | null>(null);
    const activeEdit = useRef<RequestState | null>(null);
    const focused = useRef(false);
    const visible = feed?.connection === connection ? feed : undefined;
    const page = visible?.page;
    const busy = editing?.connection === connection;
    const formatTime = useMemo(() => new Intl.DateTimeFormat(i18n.language, {
        year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    }), [i18n.language]);

    const load = useCallback(async (cursor: string | null) => {
        if (!focused.current || activeRead.current || activeEdit.current) return;
        const controller = new AbortController();
        const request = { connection, controller };
        activeRead.current = request;
        setFeed(previous => ({
            connection, page: previous?.connection === connection ? previous.page : undefined,
            loading: cursor ? 'more' : 'first',
        }));
        try {
            const next = await momentsService.list(connection, cursor, controller.signal);
            if (!controller.signal.aborted) setFeed(previous => ({
                connection,
                page: cursor && previous?.connection === connection && previous.page
                    ? { ...next, items: [...previous.page.items, ...next.items] } : next,
            }));
        } catch {
            if (!controller.signal.aborted) setFeed(previous => ({
                connection, page: previous?.connection === connection ? previous.page : undefined, failure: { cursor },
            }));
        } finally {
            if (activeRead.current === request) activeRead.current = null;
        }
    }, [connection]);

    useFocusEffect(useCallback(() => {
        focused.current = true;
        load(null);
        return () => {
            focused.current = false;
            activeRead.current?.controller.abort();
            activeRead.current = null;
            // 同连接切换标签时保留正在进行的写操作，回到动态时继续接收结果。
        };
    }, [load]));

    React.useEffect(() => () => {
        const request = activeEdit.current;
        if (request?.connection === connection) {
            request.controller.abort();
            activeEdit.current = null;
        }
    }, [connection]);

    const edit = async (item: Moment, action: SummaryAction) => {
        const current = useAssistantStore.getState();
        if (!focused.current || !page?.canEditSummary || activeRead.current || activeEdit.current
            || current.serverUrl !== connection.serverUrl || current.serverToken !== connection.serverToken) return;
        const controller = new AbortController();
        const request = { connection, controller };
        activeEdit.current = request;
        setEditing({ connection, id: item.id });
        try {
            const result = await momentsService.updateSummary(connection, item, action, controller.signal);
            if (controller.signal.aborted) return;
            setFeed(previous => previous?.connection === connection && previous.page ? {
                ...previous,
                page: { ...previous.page, items: previous.page.items.map(card => card.id === item.id ? result.item : card) },
            } : previous);
            if (result.status === 'upload_failed') {
                Alert.alert(t('editor.uploadFailedTitle'), t('editor.savedSuccessfully'));
            }
        } catch {
            if (!controller.signal.aborted) Alert.alert(t('common.error'), t('workRecords.failed'));
        } finally {
            if (activeEdit.current === request) {
                activeEdit.current = null;
                setEditing(undefined);
            }
        }
    };

    const renderItem = ({ item }: { item: Moment }) => {
        const pending = busy && editing?.id === item.id;
        const disabled = !page?.canEditSummary || busy || !!visible?.loading;
        return (
            <View style={styles.card} testID="moments-card">
                <Text accessibilityRole="header" selectable style={[styles.title, { fontSize: metrics.chatHeading2 }]}>{item.title}</Text>
                <Text style={styles.time}>{formatTime.format(item.clippedAt)}</Text>
                {!!item.summary && <ChatMarkdownBubble text={item.summary} metrics={metrics} plain />}
                <View style={styles.actions}>
                    <Action label={t('moments.regenerateSummary')} metrics={metrics} disabled={disabled}
                        onPress={() => { edit(item, 'regenerate'); }} />
                    {!!item.summary && <Action label={t('moments.deleteSummary')} metrics={metrics} disabled={disabled}
                        destructive onPress={() => { edit(item, 'delete'); }} />}
                    {pending && <ActivityIndicator color={colors.primaryDark} />}
                </View>
            </View>
        );
    };

    const loadMore = () => { if (page?.nextCursor) load(page.nextCursor); };
    return (
        <FlatList
            testID="moments-feed"
            style={styles.feed}
            contentContainerStyle={styles.list}
            data={page?.items ?? []}
            keyExtractor={item => item.id}
            renderItem={renderItem}
            refreshing={!!page && visible?.loading === 'first'}
            onRefresh={() => { load(null); }}
            onEndReached={visible?.failure ? undefined : loadMore}
            onEndReachedThreshold={0.3}
            ListHeaderComponent={page?.canEditSummary === false && page.items.length > 0
                ? <Text style={styles.status}>{t('common.actions')} · {t('connectors.status.unsupported')}</Text> : undefined}
            ListEmptyComponent={page
                ? <EmptyState text={t('browser.emptyTitle')} />
                : visible?.failure ? undefined : <ActivityIndicator color={colors.primaryDark} />}
            ListFooterComponent={visible?.failure
                ? <View style={styles.listStatus}>
                    <Text style={styles.status}>{t('browser.loadingFailedTitle')}</Text>
                    <Action label={t('common.retry')} metrics={metrics} onPress={() => {
                        load(visible.failure?.cursor ?? null);
                    }} />
                </View>
                : visible?.loading === 'more' ? <ActivityIndicator color={colors.primaryDark} />
                    : page?.nextCursor ? <Action label={t('common.loadMore')} metrics={metrics} disabled={busy || !!visible?.loading} onPress={loadMore} /> : undefined}
        />
    );
}

export function MomentsScreen() {
    const { t } = useTranslation();
    const serverUrl = useAssistantStore(state => state.serverUrl);
    const serverToken = useAssistantStore(state => state.serverToken);
    const credentialsStatus = useAssistantStore(state => state.credentialsStatus);
    const connection = useMemo(() => ({ serverUrl, serverToken }), [serverUrl, serverToken]);
    if (credentialsStatus === 'loading') return <ActivityIndicator style={styles.feed} color={colors.primaryDark} />;
    if (credentialsStatus !== 'ready' || !serverUrl || !serverToken) return <EmptyState text={t('assistant.notConnectedTitle')} />;
    return <Feed key={serverUrl} connection={connection} />;
}

const styles = StyleSheet.create({
    feed: { flex: 1, backgroundColor: colors.background },
    list: { padding: spacing.md, gap: spacing.md },
    card: { backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.md, gap: spacing.sm },
    title: { color: colors.text, fontWeight: '700' },
    time: { color: colors.textSecondary, fontSize: auxFontSizes.caption },
    actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: spacing.md,
        borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
    action: { minHeight: 44, justifyContent: 'center' },
    actionLabel: { color: colors.primaryDark, fontWeight: '600' },
    destructive: { color: colors.dangerStrong },
    muted: { color: colors.textTertiary },
    listStatus: { alignItems: 'center' },
    status: { color: colors.textSecondary, fontSize: auxFontSizes.caption, textAlign: 'center' },
});
