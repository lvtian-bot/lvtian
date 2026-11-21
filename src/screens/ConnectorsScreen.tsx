import React from 'react';
import { Alert, RefreshControl, ScrollView, StyleSheet, Text } from 'react-native';
import { useTranslation } from 'react-i18next';
import { SettingsGroup, SettingsRow, SettingsStatusCard } from '../components/settings';
import { useGoogleCalendarConnector } from '../hooks/useGoogleCalendarConnector';
import { auxFontSizes } from '../utils/fontSize';
import { theme } from '../utils/theme';

export function ConnectorsScreen() {
    const { t } = useTranslation();
    const { availability, snapshot, busy, failure, refresh, connect, disconnect } = useGoogleCalendarConnector();
    const status = snapshot?.status;
    const showConnect = status === 'disconnected' || status === 'connected' || status === 'needs_reauth' || status === 'authorizing';
    const verificationUnavailable = status === 'verification_unavailable';
    const showDisconnect = status === 'connected' || status === 'needs_reauth' || status === 'authorizing' || verificationUnavailable;
    const note = availability === 'offline'
        ? t('settings.agentOfflineDesc')
        : verificationUnavailable ? t('connectors.errors.statusFailed')
            : status === 'unavailable' || status === 'unsupported' || status === 'authorizing'
                ? t(`connectors.notes.${status}`) : undefined;
    const confirmDisconnect = () => {
        if (!disconnect) return;
        Alert.alert(
            t('connectors.disconnectTitle'),
            t('connectors.disconnectDescription'),
            [
                { text: t('common.cancel'), style: 'cancel' },
                { text: t('connectors.disconnect'), style: 'destructive', onPress: disconnect },
            ],
        );
    };
    const badge = status ? t(`connectors.status.${verificationUnavailable ? 'unknown' : status}`)
        : availability === 'offline' ? undefined
            : failure && !busy ? t('connectors.status.unknown') : t('assistant.remoteValuePending');
    const showRetry = Boolean((failure || verificationUnavailable) && refresh);
    const showRefresh = showRetry || status === 'authorizing';

    return (
        <ScrollView
            style={styles.container}
            contentContainerStyle={styles.content}
            refreshControl={refresh ? <RefreshControl refreshing={busy === 'refresh'} onRefresh={refresh} /> : undefined}
        >
            <SettingsStatusCard
                icon="calendar-month-outline"
                tone={status === 'connected' ? 'success' : 'muted'}
                title={t('connectors.googleCalendar')}
                subtitle={status !== 'unavailable' && status !== 'unsupported' ? snapshot?.account : undefined}
                badge={badge}
            />
            {note ? <Text style={styles.note}>{note}</Text> : null}
            {failure ? <Text style={styles.note} accessibilityLiveRegion="polite">{t(`connectors.errors.${failure}`)}</Text> : null}
            {showConnect || showDisconnect || showRefresh ? (
                <SettingsGroup>
                    {showConnect ? (
                        <SettingsRow
                            icon="open-in-new"
                            title={t(status === 'disconnected' ? 'connectors.connect' : 'connectors.reauthorize')}
                            onPress={busy && busy !== 'refresh' ? undefined : connect}
                            busy={busy === 'connect'}
                            last={!showDisconnect && !showRefresh}
                        />
                    ) : null}
                    {showDisconnect ? (
                        <SettingsRow
                            icon="link-variant-off"
                            title={t('connectors.disconnect')}
                            onPress={busy && busy !== 'refresh' ? undefined : confirmDisconnect}
                            busy={busy === 'disconnect'}
                            last={!showRefresh}
                        />
                    ) : null}
                    {showRefresh ? (
                        <SettingsRow
                            icon="refresh"
                            title={t(showRetry ? 'common.retry' : 'browser.refresh')}
                            onPress={busy ? undefined : refresh}
                            last
                        />
                    ) : null}
                </SettingsGroup>
            ) : null}
        </ScrollView>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: theme.colors.background },
    content: { padding: 16, gap: 12 },
    note: { color: theme.colors.textSecondary, fontSize: auxFontSizes.secondary, marginHorizontal: 4 },
});
