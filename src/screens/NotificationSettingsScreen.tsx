import React, { useState } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { SettingsGroup, SettingsRow } from '../components/settings';
import { setChatNotificationPermission } from '../services/chatNotifications';
import { useSettingsStore } from '../store/useSettingsStore';
import { theme } from '../utils/theme';

export const NotificationSettingsScreen = () => {
    const { t } = useTranslation();
    const { chatNotificationsEnabled, chatNotificationPreview, setChatNotificationPreview } = useSettingsStore();
    const [busy, setBusy] = useState(false);

    async function changeNotifications(enabled: boolean): Promise<void> {
        setBusy(true);
        try { await setChatNotificationPermission(enabled); }
        catch { /* System permission settings can be unavailable. */ }
        finally { setBusy(false); }
    }

    return (
        <ScrollView style={styles.container} contentContainerStyle={styles.content}>
            <SettingsGroup>
                <SettingsRow
                    title={t('chatNotifications.enabled')}
                    icon="bell-outline"
                    toggle={{ value: chatNotificationsEnabled, onChange: changeNotifications }}
                    busy={busy}
                />
                <SettingsRow
                    title={t('chatNotifications.preview')}
                    icon="message-text-outline"
                    toggle={{ value: chatNotificationPreview, onChange: setChatNotificationPreview }}
                    last
                />
            </SettingsGroup>
        </ScrollView>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: theme.colors.background,
    },
    content: {
        padding: 16,
    },
});
